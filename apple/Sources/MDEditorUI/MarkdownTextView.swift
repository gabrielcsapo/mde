#if !os(macOS)
import MDECore
import MDEPluginKit
import CoreText
import UIKit

/// UIKit callbacks a host can observe without taking the `UITextViewDelegate` slot,
/// which this view needs for itself.
public protocol MarkdownTextViewDelegate: AnyObject {
    /// A `Hit` decoration was tapped — a task checkbox, a mention chip.
    func markdownTextView(_ view: MarkdownTextView, didTap decoration: Decoration, source: String)
    /// A long-pressed link label requested navigation without stealing ordinary taps
    /// from source editing.
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

private final class UIKitPluginPresentationRecord {
    var presentation: MarkdownPluginPresentation
    let focusWasEditor: Bool

    init(presentation: MarkdownPluginPresentation, focusWasEditor: Bool) {
        self.presentation = presentation
        self.focusWasEditor = focusWasEditor
    }
}

/// A `UITextView` on TextKit 1's incremental layout manager that renders markdown inline.
///
/// The text storage stays exactly the markdown source — no substitution, no separate
/// model. Everything visible is an attribute or an attachment applied over that
/// source, driven by decoration patches from the core. All the decoration logic lives
/// in `DecorationApplier`, shared with the AppKit host.
public final class MarkdownTextView: UITextView {
    public var engine: MarkdownEngine { applier.engine }
    public weak var markdownDelegate: (any MarkdownTextViewDelegate)?
    /// Optional host-backed persistence for namespaced plugin state.
    public var pluginStateStore: (any MarkdownPluginStateStore)?

    public var widgetProvider: (any WidgetProvider)? {
        get { applier.widgetProvider }
        set { applier.widgetProvider = newValue }
    }

    /// Resolves references (`![a](photo.jpg)`) to views. See `ResourceResolver` — the
    /// document holds the reference, never the content.
    public var resourceResolver: (any ResourceResolver)? {
        get { pluginResourceBaseResolver }
        set { pluginResourceBaseResolver = newValue; refreshPluginResourceResolver() }
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
    /// The incremental layout manager and a small painted viewport keep hostile input
    /// responsive while source, selection offsets, and decorations remain exact.
    public var optimizesLongParagraphLayout = true {
        didSet {
            updateLongParagraphLayout()
            usesViewportPainting = textStorage.length > Self.eagerPaintLimit
                || longParagraphAnchor != nil
            refreshPainting()
        }
    }

    private let applier: DecorationApplier
    private let contentStorage: NSTextContentStorage
    private lazy var ownUndoManager = DisabledUndoManager()
    private static let eagerPaintLimit = 256 * 1024
    private static let longParagraphThreshold = 8 * 1024
    private var longParagraphAnchor: Int?
    private var usesViewportPainting = false
    private var paintedRanges: [NSRange] = []
    private var viewportPaintScheduled = false
    private var pendingPaintLocation: Int?
    private var widgetOverlays: [UInt64: WidgetContainer] = [:]
    private var widgetLayoutScheduled = false
    private var presentationSuspended = false
    var pluginInstallations: [MarkdownPluginInstallation] = []
    var pluginResourceBaseResolver: (any ResourceResolver)?
    var pluginResourceContributions: [String: MarkdownPluginResourceRegistration] = [:]
    private var pluginCommands: [String: MarkdownPluginCommandRegistration] = [:]
    private var pluginCommandOrder: [String] = []
    private var pluginPresentations: [String: UIKitPluginPresentationRecord] = [:]
    private var pluginPresentationOrder: [String] = []

    /// Set while an undo is written into the storage, so it is not reported back to the
    /// core as a fresh edit.
    private var isRewinding = false

    deinit { uninstallAllPlugins() }

    func applyPluginResourceResolver(_ resolver: (any ResourceResolver)?) {
        applier.resources.reset()
        applier.resources.resolver = resolver
        refreshPainting()
    }

    // MARK: - Init

    /// A manifest that fails to parse falls back to no extensions rather than trapping.
    /// Check it with `MarkdownEngine(manifest:)` at startup to fail loudly instead.
    public convenience init(manifest: String? = nil, theme: Theme = Theme()) {
        self.init(engine: MarkdownEngine(manifest: manifest) ?? MarkdownEngine()!, theme: theme)
    }

    public init(engine: MarkdownEngine, theme: Theme = Theme()) {
        applier = DecorationApplier(engine: engine, theme: theme)

        // Assemble TextKit 1 explicitly so UIKit and AppKit share the same incremental
        // layout behavior and control-glyph widget geometry.
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

        applier.widgetProvider = nil
        applier.openLink = { [weak self] destination in
            guard let self else { return }
            self.markdownDelegate?.markdownTextView(self, didRequestOpenLink: destination)
        }
        applier.resources.onResolved = { [weak self] reference in
            self?.repaintNodes(referencing: reference)
            self?.scheduleWidgetLayout()
        }
        textStorage.delegate = self
        contentStorage.delegate = self
        delegate = self

        isEditable = true
        isScrollEnabled = true
        alwaysBounceVertical = true
        autocorrectionType = .no
        smartQuotesType = .no
        smartDashesType = .no
        textContainerInset = UIEdgeInsets(top: 20, left: 16, bottom: 40, right: 16)
        typingAttributes = theme.baseAttributes
        backgroundColor = .platformBackground

        // This recognizer must observe taps without ever claiming them. Two things are
        // needed and neither is sufficient alone: `cancelsTouchesInView = false` keeps
        // the touch flowing to the view, and the delegate below allows simultaneous
        // recognition — without it this recognizer wins arbitration and UITextView's own
        // text-interaction recognizer never fires, so the view never becomes first
        // responder and the editor silently refuses all input.
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        tap.cancelsTouchesInView = false
        tap.delaysTouchesBegan = false
        tap.delaysTouchesEnded = false
        tap.delegate = self
        addGestureRecognizer(tap)

        let linkPress = UILongPressGestureRecognizer(
            target: self,
            action: #selector(handleLinkPress(_:))
        )
        linkPress.minimumPressDuration = 0.45
        linkPress.cancelsTouchesInView = false
        addGestureRecognizer(linkPress)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    override public func layoutSubviews() {
        super.layoutSubviews()
        scheduleViewportPaint()
        scheduleWidgetLayout()
        layoutPluginPresentations()
    }

    override public func scrollRangeToVisible(_ range: NSRange) {
        super.scrollRangeToVisible(range)
        pendingPaintLocation = range.location
        scheduleViewportPaint()
        scheduleWidgetLayout()
    }

    /// The platform undo manager is deliberately inert: it sees keystrokes, not
    /// markdown structure, so undoing a bold-toggle would come back as two unrelated
    /// character deletions. History lives in the core instead (DESIGN §9).
    override public var undoManager: UndoManager? { ownUndoManager }

    override public var keyCommands: [UIKeyCommand]? {
        var shortcuts: Set<String> = []
        let owned = pluginCommandOrder.reversed().compactMap { name -> UIKeyCommand? in
            guard let registration = pluginCommands[name],
                  registration.command.isEnabled(),
                  let key = registration.command.key,
                  !key.isEmpty else { return nil }
            let signature = "\(key.lowercased())|\(registration.command.modifiers.rawValue)"
            guard shortcuts.insert(signature).inserted else { return nil }
            return UIKeyCommand(
                title: registration.command.title,
                action: #selector(handlePluginCommand(_:)),
                input: key,
                modifierFlags: Self.keyModifierFlags(registration.command.modifiers),
                propertyList: name
            )
        }
        let escape = pluginPresentationOrder.contains(where: {
            pluginPresentations[$0]?.presentation.options.dismissOnEscape == true
        }) ? [UIKeyCommand(
            input: UIKeyCommand.inputEscape,
            modifierFlags: [],
            action: #selector(handlePluginPresentationEscape)
        )] : []
        return (super.keyCommands ?? []) + owned + escape
    }

    @objc private func handlePluginCommand(_ command: UIKeyCommand) {
        guard let name = command.propertyList as? String,
              let winner = pluginCommands[name] else { return }
        let conflicts = pluginCommandOrder.compactMap { id -> String? in
            guard let candidate = pluginCommands[id],
                  candidate.command.isEnabled(),
                  candidate.command.key?.lowercased() == winner.command.key?.lowercased(),
                  candidate.command.modifiers == winner.command.modifiers
            else { return nil }
            return id
        }
        if conflicts.count > 1 {
            NotificationCenter.default.post(
                name: .markdownPluginCommandConflict,
                object: self,
                userInfo: ["commandIds": conflicts, "winner": name]
            )
        }
        _ = executePluginCommand(id: name)
    }

    @objc private func handlePluginPresentationEscape() {
        guard let name = pluginPresentationOrder.last else { return }
        guard pluginPresentations[name]?.presentation.options.dismissOnEscape == true else { return }
        removePluginPresentation(name, reason: .escape)
    }

    private static func keyModifierFlags(
        _ modifiers: MarkdownPluginCommandModifiers
    ) -> UIKeyModifierFlags {
        var flags: UIKeyModifierFlags = []
        if modifiers.contains(.primary) { flags.insert(.command) }
        if modifiers.contains(.shift) { flags.insert(.shift) }
        if modifiers.contains(.option) { flags.insert(.alternate) }
        return flags
    }

    func setPluginCommand(_ name: String, _ command: MarkdownPluginCommandRegistration) {
        pluginCommandOrder.removeAll { $0 == name }
        pluginCommands[name] = command
        pluginCommandOrder.append(name)
        postPluginCommandsDidChange()
    }

    func updatePluginCommand(
        _ name: String,
        generation: UUID,
        command: MarkdownPluginCommand
    ) {
        guard pluginCommands[name]?.generation == generation else { return }
        pluginCommands[name]?.command = command
        postPluginCommandsDidChange()
    }

    @discardableResult
    func removePluginCommand(_ name: String, generation: UUID? = nil) -> Bool {
        guard let current = pluginCommands[name],
              generation == nil || current.generation == generation else { return false }
        pluginCommands.removeValue(forKey: name)
        pluginCommandOrder.removeAll { $0 == name }
        postPluginCommandsDidChange()
        return true
    }

    public var registeredPluginCommands: [MarkdownPluginCommandDescriptor] {
        pluginCommandOrder.compactMap { id in
            guard let registration = pluginCommands[id],
                  registration.command.isDiscoverable else { return nil }
            let command = registration.command
            return MarkdownPluginCommandDescriptor(
                id: id,
                plugin: registration.plugin,
                name: registration.name,
                title: command.title,
                key: command.key,
                modifiers: command.modifiers,
                category: command.category,
                keywords: command.keywords,
                isEnabled: command.isEnabled(),
                isChecked: command.isChecked()
            )
        }
    }

    @discardableResult
    public func executePluginCommand(id: String) -> Bool {
        guard let registration = pluginCommands[id], registration.command.isEnabled() else {
            return false
        }
        registration.command.handler()
        return true
    }

    private func postPluginCommandsDidChange() {
        NotificationCenter.default.post(
            name: .markdownPluginCommandsDidChange,
            object: self,
            userInfo: ["commands": registeredPluginCommands]
        )
    }

    func setPluginPresentation(_ name: String, _ presentation: MarkdownPluginPresentation) {
        let focusWasEditor = pluginPresentations[name]?.focusWasEditor ?? isFirstResponder
        let replaced = pluginPresentations[name]
        replaced?.presentation.options.view.removeFromSuperview()
        pluginPresentations[name] = UIKitPluginPresentationRecord(
            presentation: presentation,
            focusWasEditor: focusWasEditor
        )
        pluginPresentationOrder.removeAll { $0 == name }
        pluginPresentationOrder.append(name)
        presentation.options.view.accessibilityViewIsModal = presentation.options.modal
        addSubview(presentation.options.view)
        layoutPluginPresentations()
        presentation.options.initialFocus?.becomeFirstResponder()
        replaced?.presentation.options.onDismiss?(.replaced)
    }

    func updatePluginPresentation(
        _ name: String,
        generation: UUID,
        options: MarkdownPluginPresentationOptions
    ) {
        guard let record = pluginPresentations[name],
              record.presentation.generation == generation else { return }
        let old = record.presentation.options.view
        if old !== options.view {
            old.removeFromSuperview()
            addSubview(options.view)
        }
        record.presentation.options = options
        options.view.accessibilityViewIsModal = options.modal
        layoutPluginPresentations()
    }

    @discardableResult
    func removePluginPresentation(
        _ name: String,
        generation: UUID? = nil,
        reason: MarkdownPluginPresentationDismissReason = .programmatic
    ) -> Bool {
        guard let record = pluginPresentations[name],
              generation == nil || record.presentation.generation == generation else {
            return false
        }
        pluginPresentations.removeValue(forKey: name)
        pluginPresentationOrder.removeAll { $0 == name }
        let options = record.presentation.options
        options.view.removeFromSuperview()
        if options.restoreFocus && record.focusWasEditor && !isFirstResponder {
            _ = becomeFirstResponder()
        }
        options.onDismiss?(reason)
        return true
    }

    func repositionPluginPresentation(_ name: String, generation: UUID? = nil) {
        guard let record = pluginPresentations[name],
              generation == nil || record.presentation.generation == generation else { return }
        layoutPluginPresentations()
    }

    private func dismissPluginPresentations(at point: CGPoint) {
        for name in pluginPresentationOrder.reversed() {
            guard let record = pluginPresentations[name] else { continue }
            let options = record.presentation.options
            let dismisses = options.dismissOnOutsideInteraction ?? !options.modal
            if dismisses && !options.view.frame.contains(point) {
                removePluginPresentation(name, reason: .outsideInteraction)
            }
        }
    }

    private func layoutPluginPresentations() {
        guard !pluginPresentations.isEmpty else { return }
        let safe = UIEdgeInsets(
            top: max(8, safeAreaInsets.top),
            left: max(8, safeAreaInsets.left),
            bottom: max(8, safeAreaInsets.bottom),
            right: max(8, safeAreaInsets.right)
        )
        let viewport = CGRect(origin: contentOffset, size: bounds.size).inset(by: safe)
        let selectionRect: CGRect = {
            guard selectedRange.location != NSNotFound,
                  selectedRange.location <= textStorage.length else { return viewport }
            let glyphs = layoutManager.glyphRange(
                forCharacterRange: NSRange(location: selectedRange.location, length: 0),
                actualCharacterRange: nil
            )
            var rect = layoutManager.boundingRect(forGlyphRange: glyphs, in: textContainer)
            rect.origin.x += textContainerInset.left
            rect.origin.y += textContainerInset.top
            return rect
        }()
        for record in pluginPresentations.values {
            let options = record.presentation.options
            let view = options.view
            var size = view.intrinsicContentSize
            if size.width <= 0 || size.height <= 0 {
                size = view.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
            }
            if size.width <= 0 { size.width = min(320, viewport.width) }
            if size.height <= 0 { size.height = 44 }
            size.width = min(size.width, viewport.width)
            size.height = min(size.height, viewport.height)
            var origin: CGPoint
            switch options.anchor {
            case .selection:
                let below = selectionRect.maxY + options.offset
                let above = selectionRect.minY - size.height - options.offset
                let placement = options.placement == .automatic
                    ? (below + size.height <= viewport.maxY ? .below : .above)
                    : options.placement
                origin = CGPoint(
                    x: selectionRect.minX,
                    y: placement == .above ? above : below
                )
            case .editor:
                origin = CGPoint(x: viewport.minX + 4, y: viewport.minY + 4)
            case .viewport:
                origin = CGPoint(x: viewport.midX - size.width / 2, y: viewport.midY - size.height / 2)
            }
            origin.x = min(max(origin.x, viewport.minX), viewport.maxX - size.width)
            origin.y = min(max(origin.y, viewport.minY), viewport.maxY - size.height)
            view.frame = CGRect(origin: origin, size: size)
        }
    }

    // MARK: - Document

    public var markdown: String { textStorage.string }

    /// Stops speculative paint/layout and cancels pending resources while the host app
    /// is backgrounded. Source and the engine remain live and resume without reopening.
    public func suspendPresentation() {
        guard !presentationSuspended else { return }
        presentationSuspended = true
        applier.resources.suspend()
        widgetOverlays.values.forEach { $0.removeFromSuperview() }
        widgetOverlays.removeAll()
    }

    public func resumePresentation() {
        guard presentationSuspended else { return }
        presentationSuspended = false
        applier.resources.resume()
        // Suspension removes native overlays, but it deliberately leaves the
        // length-preserving attributed source intact. Repainting the whole document
        // here made foregrounding a media-heavy journal proportional to document
        // size. Recreate only the visible overlays; their attachments restart any
        // preview loads that were cancelled while backgrounded.
        scheduleViewportPaint()
        layoutWidgetOverlays()
    }

    /// Every decoration currently in effect, reveal already applied. Useful for hosts
    /// that want to act on the document's structure — collect all task checkboxes,
    /// find every mention — without re-parsing it.
    public var decorations: [Decoration] { applier.decorations }

    public func setMarkdown(_ text: String) {
        updateLongParagraphLayout(in: text as NSString)
        // TextKit may ask for presentation paragraphs synchronously while replacing
        // storage. Drop old-document widget ranges first so they can never be sliced
        // from the new, possibly shorter buffer.
        applier.reset()
        widgetOverlays.values.forEach { $0.removeFromSuperview() }
        widgetOverlays.removeAll()
        isRewinding = true
        textStorage.setAttributedString(
            NSAttributedString(string: text, attributes: theme.baseAttributes)
        )
        isRewinding = false

        applier.ingest(engine.reset(text))
        usesViewportPainting = textStorage.length > Self.eagerPaintLimit
            || longParagraphAnchor != nil
        paintedRanges.removeAll()
        refreshPainting()
        pluginsDidChangeMarkdown()
    }

    func captureProjection() -> NSAttributedString? {
        let copy = NSMutableAttributedString(attributedString: textStorage)
        copy.removeAttribute(
            DecorationApplier.widgetAttachmentAttribute,
            range: NSRange(location: 0, length: copy.length)
        )
        return copy
    }

    @discardableResult
    func restoreProjection(markdown text: String, projection: NSAttributedString) -> Bool {
        guard projection.string == text else { return false }
        updateLongParagraphLayout(in: text as NSString)
        applier.reset()
        widgetOverlays.values.forEach { $0.removeFromSuperview() }
        widgetOverlays.removeAll()
        isRewinding = true
        textStorage.setAttributedString(projection)
        isRewinding = false
        applier.ingest(engine.reset(text))
        usesViewportPainting = textStorage.length > Self.eagerPaintLimit || longParagraphAnchor != nil
        paintedRanges = usesViewportPainting ? [] : [NSRange(location: 0, length: textStorage.length)]
        scheduleViewportPaint()
        scheduleWidgetLayout()
        pluginsDidChangeMarkdown()
        return true
    }

    private static func longParagraph(in source: NSString) -> NSRange? {
        var location = 0
        while location < source.length {
            let paragraph = source.paragraphRange(for: NSRange(location: location, length: 0))
            if paragraph.length >= longParagraphThreshold { return paragraph }
            let next = paragraph.upperBound
            guard next > location else { break }
            location = next
        }
        return nil
    }

    private func updateLongParagraphLayout() {
        updateLongParagraphLayout(in: textStorage.string as NSString)
    }

    private func updateLongParagraphLayout(in source: NSString) {
        let paragraph = optimizesLongParagraphLayout ? Self.longParagraph(in: source) : nil
        setLongParagraphLayout(anchor: paragraph?.location)
    }

    private func updateLongParagraphLayout(afterEditAt location: Int, delta: Int) {
        let source = textStorage.string as NSString
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
            setLongParagraphLayout(anchor: nil)
            return
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

    /// Force the next edit to start a new undo step.
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
        guard let rewind else { return false }
        isRewinding = true
        textStorage.beginEditing()
        // Back-to-front so earlier offsets stay valid, matching the core.
        for edit in rewind.edits.sorted(by: { $0.range.location > $1.range.location }) {
            textStorage.replaceCharacters(
                in: edit.range,
                with: NSAttributedString(string: edit.text, attributes: theme.baseAttributes)
            )
        }
        textStorage.endEditing()
        isRewinding = false

        updateLongParagraphLayout()
        applier.ingest(rewind.patch)
        refreshPainting()
        if let sel = rewind.selection, sel.upperBound <= textStorage.length {
            selectedRange = sel
        }
        pluginsDidChangeMarkdown()
        markdownDelegate?.markdownTextViewDidChange(self)
        return true
    }

    // MARK: - Selection

    // Deliberately no `selectedTextRange` override: UIKit reads it throughout touch
    // handling, and repainting from inside that setter re-enters text storage mid-
    // gesture and breaks focus entirely. `textViewDidChangeSelection` is the supported
    // hook and fires for taps, drags, and arrow keys alike.

    private func reportSelection() {
        guard isFirstResponder else { return }
        applyPatch(engine.setSelection(selectedRange))
        pluginsDidChangeSelection()
        markdownDelegate?.markdownTextViewDidChangeSelection(self)
    }

    override public func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { reportSelection() }
        return ok
    }

    override public func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        // Blur collapses the document back to its rendered form.
        if ok { applyPatch(engine.setSelection(nil)) }
        return ok
    }

    // MARK: - Hit testing

    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: self)
        dismissPluginPresentations(at: point)
        guard let position = closestPosition(to: point) else { return }
        let index = offset(from: beginningOfDocument, to: position)
        guard let hit = applier.hit(at: index) else { return }
        let source = (textStorage.string as NSString).substring(with: hit.range)
        markdownDelegate?.markdownTextView(self, didTap: hit, source: source)
    }

    @objc private func handleLinkPress(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began,
              let position = closestPosition(to: gesture.location(in: self))
        else { return }
        let index = offset(from: beginningOfDocument, to: position)
        requestOpenLink(at: index)
    }

    /// Ask the host to open the link label at a UTF-16 offset. Long press calls this;
    /// hosts may also expose it from a context menu or keyboard command.
    @discardableResult
    public func requestOpenLink(at offset: Int) -> Bool {
        guard let link = applier.link(at: offset),
              let destination = engine.payload(for: link.key)
        else { return false }
        markdownDelegate?.markdownTextView(self, didRequestOpenLink: destination)
        return true
    }

    /// Toggle a `- [ ]` / `- [x]` checkbox. Goes through the normal edit path, so it
    /// lands in the undo history as its own step.
    public func toggleTask(at decoration: Decoration) {
        let ns = textStorage.string as NSString
        guard decoration.range.upperBound <= ns.length else { return }
        let replacement = ns.substring(with: decoration.range).lowercased().contains("x")
            ? "[ ]" : "[x]"
        engine.boundary()
        textStorage.replaceCharacters(in: decoration.range, with: replacement)
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
        guard !patch.isEmpty || alsoDirty != nil else { return }
        // Disjoint ranges, not a bounding box: see `dirtyRanges`.
        let dirty = applier.dirtyRanges(for: patch, alsoDirty: alsoDirty)
        applier.ingest(patch)
        // A reveal patch can turn a projected widget back into styled source. Remove
        // that overlay immediately so selection never sits behind a stale native view.
        for key in widgetOverlays.keys {
            guard let decoration = applier.live[key],
                  decoration.kind == .inlineWidget || decoration.kind == .blockWidget
            else {
                widgetOverlays.removeValue(forKey: key)?.removeFromSuperview()
                continue
            }
        }
        if usesViewportPainting {
            invalidatePainted(dirty)
            if let alsoDirty, isRangeNearViewport(alsoDirty) {
                applier.repaint(alsoDirty, in: textStorage)
                rememberPainted(alsoDirty)
            } else {
                for range in dirty where isRangeNearViewport(range) {
                    applier.repaint(range, in: textStorage)
                    rememberPainted(range)
                }
            }
        } else {
            for range in dirty { applier.repaint(range, in: textStorage) }
        }
        scheduleViewportPaint()
        if patch.added.contains(where: {
            $0.kind == .inlineWidget || $0.kind == .blockWidget
        }) {
            layoutWidgetOverlays()
        } else {
            scheduleWidgetLayout()
        }
    }

    private func isRangeNearViewport(_ range: NSRange) -> Bool {
        let origin = CGPoint(x: textContainerInset.left, y: textContainerInset.top)
        let viewport = bounds
            .insetBy(dx: -bounds.width, dy: -bounds.height)
            .offsetBy(dx: -origin.x, dy: -origin.y)
        let glyphs = layoutManager.glyphRange(forBoundingRect: viewport, in: textContainer)
        let characters = layoutManager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        return NSIntersectionRange(range, characters).length > 0
    }

    private func invalidatePainted(_ dirty: [NSRange]) {
        for cut in dirty {
            paintedRanges = paintedRanges.flatMap { existing -> [NSRange] in
                let overlap = NSIntersectionRange(existing, cut)
                guard overlap.length > 0 else { return [existing] }
                var remaining = [NSRange]()
                if overlap.location > existing.location {
                    remaining.append(NSRange(
                        location: existing.location,
                        length: overlap.location - existing.location
                    ))
                }
                if overlap.upperBound < existing.upperBound {
                    remaining.append(NSRange(
                        location: overlap.upperBound,
                        length: existing.upperBound - overlap.upperBound
                    ))
                }
                return remaining
            }
        }
    }

    private func repaintAll() {
        applier.repaint(NSRange(location: 0, length: textStorage.length), in: textStorage)
        paintedRanges = [NSRange(location: 0, length: textStorage.length)]
        scheduleWidgetLayout()
    }

    private func refreshPainting() {
        paintedRanges.removeAll()
        if usesViewportPainting { scheduleViewportPaint() } else { repaintAll() }
    }

    private func scheduleViewportPaint() {
        guard !presentationSuspended, usesViewportPainting, !viewportPaintScheduled else { return }
        viewportPaintScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.viewportPaintScheduled = false
            self.repaintViewport()
        }
    }

    private func repaintViewport() {
        guard usesViewportPainting, textStorage.length > 0 else {
            return
        }
        let origin = CGPoint(x: textContainerInset.left, y: textContainerInset.top)
        let viewportRect = bounds.offsetBy(dx: -origin.x, dy: -origin.y)
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
            textStorage.length,
            max(max(top, bottom) + paintRadius, from + minimumPaint)
        )
        let range = NSRange(location: from, length: max(0, to - from))
        applier.resources.prioritize(applier.references(intersecting: range))
        guard !paintedRanges.contains(where: {
            $0.location <= range.location && $0.upperBound >= range.upperBound
        }) else { return }
        applier.repaint(range, in: textStorage)
        rememberPainted(range)
    }

    private func rememberPainted(_ range: NSRange) {
        guard usesViewportPainting else { return }
        paintedRanges = DecorationApplier.merged(paintedRanges + [range])
    }

    /// A resource finished loading. Repaint only the nodes that point at it, so one
    /// slow image does not re-lay-out the document.
    private func repaintNodes(referencing reference: String) {
        for key in applier.widgetKeys(referencing: reference) {
            widgetOverlays.removeValue(forKey: key)?.removeFromSuperview()
        }
        for range in applier.ranges(referencing: reference) {
            applier.repaint(range, in: textStorage)
        }
        scheduleWidgetLayout()
    }

    private func scheduleWidgetLayout() {
        guard !presentationSuspended, !widgetLayoutScheduled else { return }
        widgetLayoutScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.widgetLayoutScheduled = false
            self.layoutWidgetOverlays()
        }
    }

    /// TextKit 1 reserves widget glyph geometry; this keeps only views near the
    /// viewport alive, matching the lazy resource behavior of the web renderer.
    private func layoutWidgetOverlays() {
        guard textStorage.length > 0 else {
            widgetOverlays.values.forEach { $0.removeFromSuperview() }
            widgetOverlays.removeAll()
            return
        }
        let origin = CGPoint(x: textContainerInset.left, y: textContainerInset.top)
        let viewport = bounds
            .insetBy(dx: -bounds.width, dy: -bounds.height)
            .offsetBy(dx: -origin.x, dy: -origin.y)
        let glyphs = layoutManager.glyphRange(forBoundingRect: viewport, in: textContainer)
        guard glyphs.length > 0 else { return }
        let characters = layoutManager.characterRange(
            forGlyphRange: glyphs,
            actualGlyphRange: nil
        )
        var visibleKeys = Set<UInt64>()
        textStorage.enumerateAttribute(
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

// MARK: - Gesture arbitration

extension MarkdownTextView: UIGestureRecognizerDelegate {
    public func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        true
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
            containerWidth: textContainer.size.width
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
        font aFont: UIFont,
        forGlyphRange glyphRange: NSRange
    ) -> Int {
        guard let storage = layoutManager.textStorage else { return 0 }
        var generatedGlyphs = Array(UnsafeBufferPointer(start: glyphs, count: glyphRange.length))
        var generatedProps = Array(UnsafeBufferPointer(start: props, count: glyphRange.length))
        let generatedIndexes = Array(UnsafeBufferPointer(start: charIndexes, count: glyphRange.length))
        guard let first = generatedIndexes.min(), let last = generatedIndexes.max(), first < storage.length else {
            return 0
        }
        var widgetCharacters = Set<Int>()
        var listProjections: [Int: String] = [:]
        storage.enumerateAttribute(
            DecorationApplier.widgetAttachmentAttribute,
            in: NSRange(location: first, length: min(storage.length - first, last - first + 1)),
            options: []
        ) { value, range, _ in
            if value is WidgetAttachment { widgetCharacters.insert(range.location) }
        }
        storage.enumerateAttribute(
            DecorationApplier.listProjectionAttribute,
            in: NSRange(location: first, length: min(storage.length - first, last - first + 1)),
            options: []
        ) { value, range, _ in
            if let projection = value as? String { listProjections[range.location] = projection }
        }
        guard !widgetCharacters.isEmpty || !listProjections.isEmpty else { return 0 }
        var changed = false
        for index in generatedProps.indices {
            if let projection = listProjections[generatedIndexes[index]],
               let character = projection.utf16.first {
                var source = character
                var glyph: CGGlyph = 0
                let font = CTFontCreateUIFontForLanguage(.system, aFont.pointSize, nil)
                if let font,
                   CTFontGetGlyphsForCharacters(font, &source, &glyph, 1), glyph != 0 {
                    generatedGlyphs[index] = glyph
                    changed = true
                    continue
                }
            }
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
        proposedLineFragment proposedRect: CGRect,
        glyphPosition: CGPoint,
        characterIndex charIndex: Int
    ) -> CGRect {
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
        return CGRect(
            x: glyphPosition.x,
            y: proposedRect.minY + bounds.origin.y,
            width: bounds.width,
            height: bounds.height
        )
    }

    public func layoutManager(
        _ layoutManager: NSLayoutManager,
        shouldSetLineFragmentRect lineFragmentRect: UnsafeMutablePointer<CGRect>,
        lineFragmentUsedRect: UnsafeMutablePointer<CGRect>,
        baselineOffset: UnsafeMutablePointer<CGFloat>,
        in textContainer: NSTextContainer,
        forGlyphRange glyphRange: NSRange
    ) -> Bool {
        guard let storage = layoutManager.textStorage else { return false }
        let characters = layoutManager.characterRange(forGlyphRange: glyphRange, actualGlyphRange: nil)
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
        lineFragmentRect.pointee.size.height = max(lineFragmentRect.pointee.height, desiredHeight)
        lineFragmentUsedRect.pointee.size.height = desiredHeight
        baselineOffset.pointee += growth / 2
        return true
    }
}

// MARK: - Text storage

extension MarkdownTextView: NSTextStorageDelegate {
    public func textStorage(
        _ textStorage: NSTextStorage,
        didProcessEditing editedMask: NSTextStorage.EditActions,
        range editedRange: NSRange,
        changeInLength delta: Int
    ) {
        guard editedMask.contains(.editedCharacters), !applier.isRepainting, !isRewinding else {
            return
        }

        // `editedRange` is in the new text; the core wants the pre-edit range plus what
        // replaced it.
        let oldRange = NSRange(
            location: editedRange.location,
            length: max(0, editedRange.length - delta)
        )
        let inserted = (textStorage.string as NSString).substring(with: editedRange)

        do {
            let patch = try engine.apply(
                [TextEdit(range: oldRange, text: inserted)],
                documentLength: textStorage.length
            )
            // Attributes cannot be mutated while the storage is still processing this
            // edit, so the repaint is deferred by one turn of the runloop.
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
            // The mirror drifted. Resync from the authoritative buffer rather than
            // painting decorations computed from a document that no longer exists.
            let text = textStorage.string
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

// MARK: - UITextViewDelegate

extension MarkdownTextView: UITextViewDelegate {
    public func textView(
        _ textView: UITextView,
        shouldChangeTextIn range: NSRange,
        replacementText text: String
    ) -> Bool {
        selectedRange = range
        return !applyPluginInputRules(inputType: text.contains("\n") ? "insertLineBreak" : "insertText",
                                      text: text)
    }

    public func textViewDidChangeSelection(_ textView: UITextView) {
        reportSelection()
    }
}

/// Neutralises `UITextView`'s own undo support without getting in the way of text
/// input.
///
/// Note what is *not* overridden: `prepare(withInvocationTarget:)`. Returning `self`
/// from it makes UIKit invoke text-mutation selectors on the undo manager rather than
/// on the text view, which silently swallows every keystroke. Refusing to *perform*
/// undo is enough — the registrations can pile up harmlessly.
final class DisabledUndoManager: UndoManager {
    override func registerUndo(withTarget target: Any, selector: Selector, object: Any?) {}
    override var canUndo: Bool { false }
    override var canRedo: Bool { false }
    override func undo() {}
    override func redo() {}
}
#endif
