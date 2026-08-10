#if os(macOS)
import AppKit
import MDECore

/// AppKit callbacks a host can observe without taking the `NSTextViewDelegate` slot.
public protocol MarkdownTextViewDelegate: AnyObject {
    /// A `Hit` decoration was clicked — a task checkbox, a mention chip.
    func markdownTextView(_ view: MarkdownTextView, didTap decoration: Decoration, source: String)
    /// Command-click requested navigation without taking normal clicks away from editing.
    func markdownTextView(_ view: MarkdownTextView, didRequestOpenLink destination: String)
    func markdownTextViewDidChange(_ view: MarkdownTextView)
    /// The caret or selection moved. Hosts that decorate from the caret's position —
    /// a focus mode, a live outline — recompute here and push a layer (DESIGN §5.3).
    func markdownTextViewDidChangeSelection(_ view: MarkdownTextView)
}

public extension MarkdownTextViewDelegate {
    func markdownTextView(_: MarkdownTextView, didTap _: Decoration, source _: String) {}
    func markdownTextView(_: MarkdownTextView, didRequestOpenLink _: String) {}
    func markdownTextViewDidChange(_: MarkdownTextView) {}
    func markdownTextViewDidChangeSelection(_: MarkdownTextView) {}
}

/// An `NSTextView` on TextKit 1's incremental layout manager that renders markdown inline.
///
/// The decoration logic is `DecorationApplier`, shared verbatim with the UIKit host —
/// which is the point: reveal policy, paint ordering, conceal, widget substitution and
/// the `moved`-does-not-repaint rule are decided once, not twice.
public final class MarkdownTextView: NSTextView {
    public var engine: MarkdownEngine { applier.engine }
    public weak var markdownDelegate: (any MarkdownTextViewDelegate)?

    public var widgetProvider: (any WidgetProvider)? {
        get { applier.widgetProvider }
        set { applier.widgetProvider = newValue }
    }

    /// Resolves references (`![a](photo.jpg)`) to views. See `ResourceResolver` — the
    /// document holds the reference, never the content.
    public var resourceResolver: (any ResourceResolver)? {
        get { applier.resources.resolver }
        set { applier.resources.resolver = newValue }
    }

    /// Sizes of resources that have already resolved, keyed by reference.
    ///
    /// Persist these and set them back on the next launch. `reservedSize` is otherwise
    /// a guess, and a wrong guess shifts the document once when the resource lands;
    /// seeding known sizes means that shift happens at most once per asset ever.
    public var resourceSizes: [String: CGSize] {
        get { applier.resources.known }
        set { applier.resources.remember(newValue) }
    }

    public var theme: Theme {
        get { applier.theme }
        set {
            applier.theme = newValue
            refreshPainting()
        }
    }

    /// Bounds syntax painting for pathological paragraphs without changing wrapping.
    ///
    /// The AppKit host uses the incremental TextKit 1 layout manager and keeps only a
    /// small window around the viewport styled when a paragraph reaches the safety
    /// threshold. Source, wrapping, selection offsets, and decorations stay exact. Set
    /// this to `false` to eagerly paint every style in pathological paragraphs.
    public var optimizesLongParagraphLayout = true {
        didSet {
            updateLongParagraphLayout()
            usesViewportPainting = (textStorage?.length ?? 0) > Self.eagerPaintLimit
                || longParagraphAnchor != nil
            refreshPainting()
        }
    }

    private let applier: DecorationApplier
    /// Observes the same source storage so shared TextKit 2 paragraph projections can
    /// still be tested against the AppKit host without owning its shipping layout manager.
    let contentStorage: NSTextContentStorage
    private lazy var ownUndoManager = DisabledUndoManager()
    private var isRewinding = false
    private static let eagerPaintLimit = 256 * 1024
    private static let longParagraphThreshold = 8 * 1024
    private var longParagraphAnchor: Int?
    private var clipBoundsObserver: NSObjectProtocol?
    var isOptimizingLongParagraph: Bool { longParagraphAnchor != nil }
    private var usesViewportPainting = false
    private var paintedRanges: [NSRange] = []
    private var viewportPaintScheduled = false
    private var pendingPaintLocation: Int?
    private var lastReportedSelection: NSRange?
    private var hasReportedSelection = false
    private var widgetOverlays: [UInt64: WidgetContainer] = [:]
    private var widgetLayoutScheduled = false
    var pluginInstallations: [MarkdownPluginInstallation] = []

    deinit {
        if let clipBoundsObserver { NotificationCenter.default.removeObserver(clipBoundsObserver) }
        uninstallAllPlugins()
    }

    // MARK: - Init

    public convenience init(manifest: String? = nil, theme: Theme = Theme()) {
        self.init(engine: MarkdownEngine(manifest: manifest) ?? MarkdownEngine()!, theme: theme)
    }

    public init(engine: MarkdownEngine, theme: Theme = Theme()) {
        applier = DecorationApplier(engine: engine, theme: theme)

        let contentStorage = NSTextContentStorage()
        let storage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        let container = NSTextContainer(
            size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        )
        container.widthTracksTextView = true
        storage.addLayoutManager(layoutManager)
        layoutManager.addTextContainer(container)
        contentStorage.textStorage = storage
        self.contentStorage = contentStorage

        super.init(frame: .zero, textContainer: container)
        layoutManager.delegate = self
        layoutManager.allowsNonContiguousLayout = true

        applier.openLink = { [weak self] destination in
            guard let self else { return }
            self.markdownDelegate?.markdownTextView(self, didRequestOpenLink: destination)
        }
        applier.resources.onResolved = { [weak self] reference in
            self?.repaintNodes(referencing: reference)
            self?.scheduleWidgetLayout()
        }
        textStorage?.delegate = self
        contentStorage.delegate = self
        delegate = self

        isEditable = true
        isRichText = false
        isAutomaticQuoteSubstitutionEnabled = false
        isAutomaticDashSubstitutionEnabled = false
        isAutomaticTextReplacementEnabled = false
        allowsUndo = false // history lives in the core
        textContainerInset = NSSize(width: 16, height: 20)
        typingAttributes = theme.baseAttributes
        backgroundColor = .platformBackground
        isVerticallyResizable = true
        isHorizontallyResizable = false
        autoresizingMask = [.width]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    override public func layout() {
        super.layout()
        scheduleViewportPaint()
        scheduleWidgetLayout()
    }

    override public func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        if let clipBoundsObserver {
            NotificationCenter.default.removeObserver(clipBoundsObserver)
            self.clipBoundsObserver = nil
        }
        guard let clipView = enclosingScrollView?.contentView else { return }
        clipView.postsBoundsChangedNotifications = true
        clipBoundsObserver = NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification,
            object: clipView,
            queue: .main
        ) { [weak self] _ in
            self?.scheduleViewportPaint()
            self?.scheduleWidgetLayout()
        }
    }

    override public func scrollRangeToVisible(_ range: NSRange) {
        super.scrollRangeToVisible(range)
        pendingPaintLocation = range.location
        scheduleViewportPaint()
        scheduleWidgetLayout()
    }

    /// Same reasoning as UIKit: `NSTextView`'s undo manager sees keystrokes, not
    /// markdown structure (DESIGN §9).
    override public var undoManager: UndoManager? { ownUndoManager }

    // MARK: - Document

    public var markdown: String { string }

    /// Every decoration currently in effect, reveal already applied. Useful for hosts
    /// that want to act on the document's structure — collect all task checkboxes,
    /// find every mention — without re-parsing it.
    public var decorations: [Decoration] { applier.decorations }

    public func setMarkdown(_ text: String) {
        guard let storage = textStorage else { return }
        updateLongParagraphLayout(in: text as NSString)
        // TextKit may ask for presentation paragraphs synchronously while replacing
        // storage. Drop old-document widget ranges first so they can never be sliced
        // from the new, possibly shorter buffer.
        applier.reset()
        widgetOverlays.values.forEach { $0.removeFromSuperview() }
        widgetOverlays.removeAll()
        isRewinding = true
        storage.setAttributedString(
            NSAttributedString(string: text, attributes: theme.baseAttributes)
        )
        isRewinding = false

        applier.ingest(engine.reset(text))
        hasReportedSelection = false
        usesViewportPainting = storage.length > Self.eagerPaintLimit
            || longParagraphAnchor != nil
        paintedRanges.removeAll()
        refreshPainting()
        pluginsDidChangeMarkdown()
    }

    private static func longParagraph(in source: NSString) -> NSRange? {
        var location = 0
        while location < source.length {
            let paragraph = source.paragraphRange(
                for: NSRange(location: location, length: 0)
            )
            if paragraph.length >= longParagraphThreshold { return paragraph }
            let next = paragraph.upperBound
            guard next > location else { break }
            location = next
        }
        return nil
    }

    private func updateLongParagraphLayout() {
        guard let storage = textStorage else { return }
        updateLongParagraphLayout(in: storage.string as NSString)
    }

    private func updateLongParagraphLayout(in source: NSString) {
        let paragraph = optimizesLongParagraphLayout ? Self.longParagraph(in: source) : nil
        setLongParagraphLayout(anchor: paragraph?.location)
    }

    private func updateLongParagraphLayout(afterEditAt location: Int, delta: Int) {
        guard let storage = textStorage else { return }
        let source = storage.string as NSString
        guard optimizesLongParagraphLayout else {
            setLongParagraphLayout(anchor: nil)
            return
        }

        if let anchor = longParagraphAnchor, source.length > 0 {
            let shifted = anchor >= location ? max(0, anchor + delta) : anchor
            let safe = min(shifted, source.length - 1)
            let paragraph = source.paragraphRange(for: NSRange(location: safe, length: 0))
            if paragraph.length >= Self.longParagraphThreshold {
                setLongParagraphLayout(anchor: paragraph.location)
                return
            }
        } else if source.length > 0 {
            let safe = min(location, source.length - 1)
            let paragraph = source.paragraphRange(for: NSRange(location: safe, length: 0))
            if paragraph.length >= Self.longParagraphThreshold {
                setLongParagraphLayout(anchor: paragraph.location)
                return
            }
        }
        setLongParagraphLayout(anchor: Self.longParagraph(in: source)?.location)
    }

    private func setLongParagraphLayout(anchor: Int?) {
        longParagraphAnchor = optimizesLongParagraphLayout ? anchor : nil
    }

    // MARK: - Undo

    public var canUndo: Bool { engine.canUndo }
    public var canRedo: Bool { engine.canRedo }

    @discardableResult
    public func performUndo() -> Bool { rewind(engine.undo()) }

    @discardableResult
    public func performRedo() -> Bool { rewind(engine.redo()) }

    public func closeUndoGroup() { engine.boundary() }

    // MARK: - Browsable history (DESIGN §9)

    /// The whole timeline, oldest first, including revisions that have been undone.
    public var revisions: [Revision] { engine.revisions() }

    /// How many revisions are applied — the caret's position in the timeline.
    public var historyPosition: Int { engine.historyPosition }

    /// Move to any point in the timeline. Undo and redo are the two-button view of this.
    @discardableResult
    public func jump(to target: Int) -> Bool { rewind(engine.jump(to: target)) }

    private func rewind(_ rewind: Rewind?) -> Bool {
        guard let rewind, let storage = textStorage else { return false }
        isRewinding = true
        storage.beginEditing()
        for edit in rewind.edits.sorted(by: { $0.range.location > $1.range.location }) {
            storage.replaceCharacters(
                in: edit.range,
                with: NSAttributedString(string: edit.text, attributes: theme.baseAttributes)
            )
        }
        storage.endEditing()
        isRewinding = false

        updateLongParagraphLayout()
        applier.ingest(rewind.patch)
        refreshPainting()
        if let sel = rewind.selection, sel.upperBound <= storage.length {
            setSelectedRange(sel)
        }
        pluginsDidChangeMarkdown()
        markdownDelegate?.markdownTextViewDidChange(self)
        return true
    }

    // MARK: - Selection

    private func reportSelection() {
        guard window?.firstResponder === self else { return }
        let selection = selectedRange()
        guard !hasReportedSelection || lastReportedSelection != selection else { return }
        lastReportedSelection = selection
        hasReportedSelection = true
        applyPatch(engine.setSelection(selection))
        pluginsDidChangeSelection()
        markdownDelegate?.markdownTextViewDidChangeSelection(self)
    }

    override public func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { DispatchQueue.main.async { [weak self] in self?.reportSelection() } }
        return ok
    }

    override public func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        // Blur collapses the document back to its rendered form.
        if ok {
            hasReportedSelection = false
            lastReportedSelection = nil
            applyPatch(engine.setSelection(nil))
        }
        return ok
    }

    // MARK: - Hit testing

    override public func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let index = characterIndexForInsertion(at: point)
        if event.modifierFlags.contains(.command),
           requestOpenLink(at: index) {
            return
        }
        if let hit = applier.hit(at: index) {
            let source = (string as NSString).substring(with: hit.range)
            markdownDelegate?.markdownTextView(self, didTap: hit, source: source)
        }
        super.mouseDown(with: event)
    }

    /// Ask the host to open the link label at a UTF-16 offset. Command-click calls
    /// this; hosts may also expose it from a menu or keyboard command.
    @discardableResult
    public func requestOpenLink(at offset: Int) -> Bool {
        guard let link = applier.link(at: offset),
              let destination = engine.payload(for: link.key)
        else { return false }
        markdownDelegate?.markdownTextView(self, didRequestOpenLink: destination)
        return true
    }

    public func toggleTask(at decoration: Decoration) {
        guard let storage = textStorage else { return }
        let ns = string as NSString
        guard decoration.range.upperBound <= ns.length else { return }
        let replacement = ns.substring(with: decoration.range).lowercased().contains("x")
            ? "[ ]" : "[x]"
        engine.boundary()
        storage.replaceCharacters(in: decoration.range, with: replacement)
        engine.boundary()
    }

    // MARK: - Host decoration layers (DESIGN §5.3)

    /// Replace a named layer's decorations and repaint what changed.
    ///
    /// This is the seam an extension builds on. The editor knows nothing about *why* a
    /// range matters — only that the host wants it decorated with a role the theme can
    /// style. Focus mode and the parts-of-speech highlighter are written entirely
    /// against this method and are not part of the editor at all.
    public func setLayer(_ name: String, _ spans: [LayerSpan]) {
        applyPatch(engine.setLayer(name, spans))
    }

    public func clearLayer(_ name: String) {
        applyPatch(engine.clearLayer(name))
    }

    /// Get (or create) a role id for a name, so an extension can decorate with roles no
    /// manifest declared. The theme styles them by name.
    public func internRole(_ name: String) -> UInt32 {
        engine.internRole(name)
    }

    // MARK: - Painting

    private func applyPatch(_ patch: Patch, alsoDirty: NSRange? = nil) {
        guard let storage = textStorage, !patch.isEmpty || alsoDirty != nil else { return }
        // Disjoint ranges, not a bounding box: see `dirtyRanges`.
        let dirty = applier.dirtyRanges(for: patch, alsoDirty: alsoDirty)
        applier.ingest(patch)
        if usesViewportPainting, alsoDirty != nil { paintedRanges.removeAll() }
        for range in dirty {
            applier.repaint(range, in: storage)
            rememberPainted(range)
        }
        scheduleViewportPaint()
        scheduleWidgetLayout()
    }

    private func repaintAll() {
        guard let storage = textStorage else { return }
        applier.repaint(NSRange(location: 0, length: storage.length), in: storage)
        paintedRanges = [NSRange(location: 0, length: storage.length)]
        scheduleWidgetLayout()
    }

    private func refreshPainting() {
        paintedRanges.removeAll()
        if usesViewportPainting { scheduleViewportPaint() } else { repaintAll() }
    }

    private func scheduleViewportPaint() {
        guard usesViewportPainting, !viewportPaintScheduled else { return }
        viewportPaintScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.viewportPaintScheduled = false
            self.repaintViewport()
        }
    }

    private func repaintViewport() {
        guard usesViewportPainting,
              let storage = textStorage,
              let layoutManager,
              let textContainer,
              storage.length > 0
        else { return }
        let origin = textContainerOrigin
        let viewportRect = visibleRect.offsetBy(dx: -origin.x, dy: -origin.y)
        let viewportGlyphs = layoutManager.glyphRange(
            forBoundingRect: viewportRect,
            in: textContainer
        )
        let viewportCharacters = layoutManager.characterRange(
            forGlyphRange: viewportGlyphs,
            actualGlyphRange: nil
        )
        let viewportTop = viewportCharacters.location
        let viewportBottom = viewportCharacters.upperBound
        let target = pendingPaintLocation
        pendingPaintLocation = nil
        let top = target ?? viewportTop
        let bottom = target ?? viewportBottom
        let paintRadius = longParagraphAnchor == nil ? 4096 : 256
        let minimumPaint = longParagraphAnchor == nil ? 8192 : 512
        let from = max(0, min(top, bottom) - paintRadius)
        let to = min(
            storage.length,
            max(max(top, bottom) + paintRadius, from + minimumPaint)
        )
        let range = NSRange(location: from, length: max(0, to - from))
        guard !paintedRanges.contains(where: {
            $0.location <= range.location && $0.upperBound >= range.upperBound
        }) else { return }
        applier.repaint(range, in: storage)
        rememberPainted(range)
    }

    private func rememberPainted(_ range: NSRange) {
        guard usesViewportPainting else { return }
        paintedRanges = DecorationApplier.merged(paintedRanges + [range])
    }

    private func repaintNodes(referencing reference: String) {
        guard let storage = textStorage else { return }
        for range in applier.ranges(referencing: reference) {
            applier.repaint(range, in: storage)
        }
    }

    private func scheduleWidgetLayout() {
        guard !widgetLayoutScheduled else { return }
        widgetLayoutScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.widgetLayoutScheduled = false
            self.layoutWidgetOverlays()
        }
    }

    /// TextKit 1 can reserve widget geometry without changing the backing characters,
    /// but unlike TextKit 2 it does not host arbitrary views for those control glyphs.
    /// Keep a small overlay set for the visible glyph range; the attachment owns all
    /// sizing and cache decisions, so this is only projection and positioning.
    func layoutWidgetOverlays() {
        guard let storage = textStorage,
              let layoutManager,
              let textContainer,
              storage.length > 0
        else {
            widgetOverlays.values.forEach { $0.removeFromSuperview() }
            widgetOverlays.removeAll()
            return
        }

        let origin = textContainerOrigin
        let viewport = visibleRect
            .insetBy(dx: -bounds.width, dy: -bounds.height)
            .offsetBy(dx: -origin.x, dy: -origin.y)
        let glyphs = layoutManager.glyphRange(forBoundingRect: viewport, in: textContainer)
        guard glyphs.length > 0 else { return }
        let characters = layoutManager.characterRange(
            forGlyphRange: glyphs,
            actualGlyphRange: nil
        )
        var visibleKeys = Set<UInt64>()
        storage.enumerateAttribute(
            DecorationApplier.widgetAttachmentAttribute,
            in: characters,
            options: []
        ) { value, range, _ in
            guard let attachment = value as? WidgetAttachment else { return }
            let widgetGlyphs = layoutManager.glyphRange(
                forCharacterRange: NSRange(location: range.location, length: 1),
                actualCharacterRange: nil
            )
            guard widgetGlyphs.length > 0 else { return }
            var frame = layoutManager.boundingRect(
                forGlyphRange: widgetGlyphs,
                in: textContainer
            )
            let requested = attachment.attachmentBounds(
                for: textContainer,
                proposedLineFragment: frame,
                glyphPosition: frame.origin,
                characterIndex: range.location
            )
            let lineMidY = frame.midY
            frame.size = requested.size
            frame.origin.y = attachment.isInline
                ? lineMidY - requested.height / 2
                : frame.minY
            frame.origin.x += origin.x
            frame.origin.y += origin.y
            guard frame.width > 0, frame.height > 0 else { return }

            visibleKeys.insert(attachment.key)
            let overlay: WidgetContainer
            if let existing = widgetOverlays[attachment.key], !existing.subviews.isEmpty {
                overlay = existing
            } else {
                widgetOverlays.removeValue(forKey: attachment.key)?.removeFromSuperview()
                overlay = WidgetContainer(
                    hosting: attachment.makeView(),
                    wantsTouches: attachment.roleName == "table"
                        || (attachment.provider?.widgetWantsTouches(
                            roleName: attachment.roleName
                        ) ?? false)
                )
                widgetOverlays[attachment.key] = overlay
                addSubview(overlay)
            }
            overlay.frame = frame
        }

        for key in widgetOverlays.keys.filter({ !visibleKeys.contains($0) }) {
            widgetOverlays.removeValue(forKey: key)?.removeFromSuperview()
        }
    }
}

// MARK: - Widget attachments

extension MarkdownTextView: NSTextContentStorageDelegate {
    public func textContentStorage(
        _ textContentStorage: NSTextContentStorage,
        textParagraphWith range: NSRange
    ) -> NSTextParagraph? {
        guard let backing = textContentStorage.textStorage else { return nil }
        return applier.substituteWidgets(
            in: range,
            backing: backing,
            containerWidth: textContainer?.size.width ?? bounds.width
        )
    }
}

// MARK: - TextKit 1 widget geometry

extension MarkdownTextView: NSLayoutManagerDelegate {
    public func layoutManager(
        _ layoutManager: NSLayoutManager,
        shouldGenerateGlyphs glyphs: UnsafePointer<CGGlyph>,
        properties props: UnsafePointer<NSLayoutManager.GlyphProperty>,
        characterIndexes charIndexes: UnsafePointer<Int>,
        font aFont: NSFont,
        forGlyphRange glyphRange: NSRange
    ) -> Int {
        guard let storage = layoutManager.textStorage else { return 0 }
        var generatedGlyphs = Array(
            UnsafeBufferPointer(start: glyphs, count: glyphRange.length)
        )
        var generatedProps = Array(
            UnsafeBufferPointer(start: props, count: glyphRange.length)
        )
        let generatedIndexes = Array(
            UnsafeBufferPointer(start: charIndexes, count: glyphRange.length)
        )
        guard let first = generatedIndexes.min(),
              let last = generatedIndexes.max(),
              first < storage.length
        else { return 0 }
        var widgetCharacters = Set<Int>()
        storage.enumerateAttribute(
            DecorationApplier.widgetAttachmentAttribute,
            in: NSRange(
                location: first,
                length: min(storage.length - first, last - first + 1)
            ),
            options: []
        ) { value, range, _ in
            if value is WidgetAttachment { widgetCharacters.insert(range.location) }
        }
        guard !widgetCharacters.isEmpty else { return 0 }
        var changed = false
        for index in generatedProps.indices {
            guard widgetCharacters.contains(generatedIndexes[index]) else { continue }
            generatedGlyphs[index] = 0
            generatedProps[index].insert(.controlCharacter)
            changed = true
        }
        guard changed else { return 0 }
        generatedGlyphs.withUnsafeBufferPointer { glyphBuffer in
            generatedProps.withUnsafeBufferPointer { propertyBuffer in
                generatedIndexes.withUnsafeBufferPointer { indexBuffer in
                    layoutManager.setGlyphs(
                        glyphBuffer.baseAddress!,
                        properties: propertyBuffer.baseAddress!,
                        characterIndexes: indexBuffer.baseAddress!,
                        font: aFont,
                        forGlyphRange: glyphRange
                    )
                }
            }
        }
        return glyphRange.length
    }

    public func layoutManager(
        _ layoutManager: NSLayoutManager,
        shouldUse action: NSLayoutManager.ControlCharacterAction,
        forControlCharacterAt charIndex: Int
    ) -> NSLayoutManager.ControlCharacterAction {
        guard layoutManager.textStorage?.attribute(
            DecorationApplier.widgetAttachmentAttribute,
            at: charIndex,
            effectiveRange: nil
        ) is WidgetAttachment else { return action }
        return .whitespace
    }

    public func layoutManager(
        _ layoutManager: NSLayoutManager,
        boundingBoxForControlGlyphAt glyphIndex: Int,
        for textContainer: NSTextContainer,
        proposedLineFragment proposedRect: NSRect,
        glyphPosition: NSPoint,
        characterIndex charIndex: Int
    ) -> NSRect {
        guard let attachment = layoutManager.textStorage?.attribute(
            DecorationApplier.widgetAttachmentAttribute,
            at: charIndex,
            effectiveRange: nil
        ) as? WidgetAttachment else { return .zero }
        attachment.fittingWidth = max(textContainer.size.width, 1)
        let bounds = attachment.attachmentBounds(
            for: textContainer,
            proposedLineFragment: proposedRect,
            glyphPosition: glyphPosition,
            characterIndex: charIndex
        )
        return NSRect(
            x: glyphPosition.x,
            y: proposedRect.minY + bounds.origin.y,
            width: bounds.width,
            height: bounds.height
        )
    }

    public func layoutManager(
        _ layoutManager: NSLayoutManager,
        shouldSetLineFragmentRect lineFragmentRect: UnsafeMutablePointer<NSRect>,
        lineFragmentUsedRect: UnsafeMutablePointer<NSRect>,
        baselineOffset: UnsafeMutablePointer<CGFloat>,
        in textContainer: NSTextContainer,
        forGlyphRange glyphRange: NSRange
    ) -> Bool {
        guard let storage = layoutManager.textStorage else { return false }
        let characters = layoutManager.characterRange(
            forGlyphRange: glyphRange,
            actualGlyphRange: nil
        )
        var desiredHeight = lineFragmentUsedRect.pointee.height
        var hasWidget = false
        storage.enumerateAttribute(
            DecorationApplier.widgetAttachmentAttribute,
            in: characters,
            options: []
        ) { value, range, _ in
            guard let attachment = value as? WidgetAttachment else { return }
            attachment.fittingWidth = max(textContainer.size.width, 1)
            let bounds = attachment.attachmentBounds(
                for: textContainer,
                proposedLineFragment: lineFragmentRect.pointee,
                glyphPosition: .zero,
                characterIndex: range.location
            )
            desiredHeight = max(desiredHeight, bounds.height)
            hasWidget = true
        }
        guard hasWidget, desiredHeight > lineFragmentUsedRect.pointee.height else { return false }
        let growth = desiredHeight - lineFragmentUsedRect.pointee.height
        lineFragmentRect.pointee.size.height = max(
            lineFragmentRect.pointee.height,
            desiredHeight
        )
        lineFragmentUsedRect.pointee.size.height = desiredHeight
        baselineOffset.pointee += growth / 2
        return true
    }
}

// MARK: - Text storage

extension MarkdownTextView: NSTextStorageDelegate {
    public func textStorage(
        _ storage: NSTextStorage,
        didProcessEditing editedMask: NSTextStorageEditActions,
        range editedRange: NSRange,
        changeInLength delta: Int
    ) {
        guard editedMask.contains(.editedCharacters), !applier.isRepainting, !isRewinding else {
            return
        }

        let oldRange = NSRange(
            location: editedRange.location,
            length: max(0, editedRange.length - delta)
        )
        let inserted = (storage.string as NSString).substring(with: editedRange)

        do {
            let patch = try engine.apply(
                [TextEdit(range: oldRange, text: inserted)],
                documentLength: storage.length
            )
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.updateLongParagraphLayout(
                    afterEditAt: editedRange.location,
                    delta: delta
                )
                self.applyPatch(patch, alsoDirty: editedRange)
                self.reportSelection()
                self.pluginsDidChangeMarkdown()
                self.markdownDelegate?.markdownTextViewDidChange(self)
            }
        } catch EngineError.desync {
            let text = storage.string
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.applier.reset()
                self.applier.ingest(self.engine.reset(text))
                self.refreshPainting()
                self.pluginsDidChangeMarkdown()
            }
        } catch {
            assertionFailure("unexpected engine error: \(error)")
        }
    }
}

// MARK: - NSTextViewDelegate

extension MarkdownTextView: NSTextViewDelegate {
    public func textViewDidChangeSelection(_ notification: Notification) {
        reportSelection()
    }
}

/// `allowsUndo = false` already stops `NSTextView` registering, but the responder
/// chain still reaches for an undo manager; hand it an inert one so ⌘Z cannot bypass
/// the core's history.
final class DisabledUndoManager: UndoManager {
    override func registerUndo(withTarget target: Any, selector: Selector, object: Any?) {}
    override var canUndo: Bool { false }
    override var canRedo: Bool { false }
    override func undo() {}
    override func redo() {}
}
#endif
