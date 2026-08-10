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

/// An `NSTextView` on TextKit 2 that renders markdown inline.
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

    private let applier: DecorationApplier
    /// Internal rather than private so the renderer tests can drive paragraph
    /// substitution directly.
    let contentStorage: NSTextContentStorage
    private lazy var ownUndoManager = DisabledUndoManager()
    private var isRewinding = false
    private static let eagerPaintLimit = 256 * 1024
    private var usesViewportPainting = false
    private var paintedRanges: [NSRange] = []
    private var viewportPaintScheduled = false
    private var pendingPaintLocation: Int?

    // MARK: - Init

    public convenience init(manifest: String? = nil, theme: Theme = Theme()) {
        self.init(engine: MarkdownEngine(manifest: manifest) ?? MarkdownEngine()!, theme: theme)
    }

    public init(engine: MarkdownEngine, theme: Theme = Theme()) {
        applier = DecorationApplier(engine: engine, theme: theme)

        let contentStorage = NSTextContentStorage()
        let layoutManager = NSTextLayoutManager()
        let container = NSTextContainer(
            size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        )
        container.widthTracksTextView = true
        layoutManager.textContainer = container
        contentStorage.addTextLayoutManager(layoutManager)
        self.contentStorage = contentStorage

        super.init(frame: .zero, textContainer: container)

        applier.openLink = { [weak self] destination in
            guard let self else { return }
            self.markdownDelegate?.markdownTextView(self, didRequestOpenLink: destination)
        }
        applier.resources.onResolved = { [weak self] reference in
            self?.repaintNodes(referencing: reference)
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
    }

    override public func scrollRangeToVisible(_ range: NSRange) {
        super.scrollRangeToVisible(range)
        pendingPaintLocation = range.location
        scheduleViewportPaint()
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
        // TextKit may ask for presentation paragraphs synchronously while replacing
        // storage. Drop old-document widget ranges first so they can never be sliced
        // from the new, possibly shorter buffer.
        applier.reset()
        isRewinding = true
        storage.setAttributedString(
            NSAttributedString(string: text, attributes: theme.baseAttributes)
        )
        isRewinding = false

        applier.ingest(engine.reset(text))
        usesViewportPainting = storage.length > Self.eagerPaintLimit
        paintedRanges.removeAll()
        refreshPainting()
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

        applier.ingest(rewind.patch)
        refreshPainting()
        if let sel = rewind.selection, sel.upperBound <= storage.length {
            setSelectedRange(sel)
        }
        markdownDelegate?.markdownTextViewDidChange(self)
        return true
    }

    // MARK: - Selection

    private func reportSelection() {
        guard window?.firstResponder === self else { return }
        applyPatch(engine.setSelection(selectedRange()))
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
        if ok { applyPatch(engine.setSelection(nil)) }
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
    }

    private func repaintAll() {
        guard let storage = textStorage else { return }
        applier.repaint(NSRange(location: 0, length: storage.length), in: storage)
        paintedRanges = [NSRange(location: 0, length: storage.length)]
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
        guard usesViewportPainting, let storage = textStorage, storage.length > 0 else { return }
        let viewport = contentStorage.textLayoutManagers.first?
            .textViewportLayoutController.viewportRange
        let viewportTop = viewport.map {
            contentStorage.offset(from: contentStorage.documentRange.location, to: $0.location)
        } ?? 0
        let viewportBottom = viewport.map {
            contentStorage.offset(from: contentStorage.documentRange.location, to: $0.endLocation)
        } ?? viewportTop
        let target = pendingPaintLocation
        pendingPaintLocation = nil
        let top = target ?? viewportTop
        let bottom = target ?? viewportBottom
        let from = max(0, min(top, bottom) - 4096)
        let to = min(storage.length, max(max(top, bottom) + 4096, from + 8192))
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
                self.applyPatch(patch, alsoDirty: editedRange)
                self.reportSelection()
                self.markdownDelegate?.markdownTextViewDidChange(self)
            }
        } catch EngineError.desync {
            let text = storage.string
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.applier.reset()
                self.applier.ingest(self.engine.reset(text))
                self.refreshPainting()
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
