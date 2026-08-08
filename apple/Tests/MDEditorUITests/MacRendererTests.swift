#if os(macOS)
import AppKit
import MDECore
import MDEHost
import XCTest
@testable import MDEditorUI

/// Drives the real AppKit `MarkdownTextView` and asserts on what it actually renders.
///
/// This is the macOS half of "verify the renderer": the decoration logic is shared with
/// iOS via `DecorationApplier`, so these tests pin the semantics in DESIGN §3–4 for
/// both hosts, and they run headlessly rather than needing a screenshot.
final class MacRendererTests: XCTestCase {
    private var window: NSWindow!
    private var editor: MarkdownTextView!

    override func setUp() {
        super.setUp()
        editor = MarkdownTextView(manifest: HostExtensions.manifest)
        editor.widgetProvider = HostWidgets()
        editor.frame = NSRect(x: 0, y: 0, width: 600, height: 800)

        // Offscreen but real: selection reporting is gated on being the window's first
        // responder, which is exactly the behaviour worth exercising.
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 800),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView?.addSubview(editor)
    }

    override func tearDown() {
        window = nil
        editor = nil
        super.tearDown()
    }

    private var storage: NSTextStorage { editor.textStorage! }

    private func attribute<T>(_ key: NSAttributedString.Key, at index: Int) -> T? {
        storage.attribute(key, at: index, effectiveRange: nil) as? T
    }

    private func fontSize(at index: Int) -> CGFloat {
        (attribute(.font, at: index) as NSFont?)?.pointSize ?? 0
    }

    private func focus() {
        XCTAssertTrue(window.makeFirstResponder(editor), "editor could not take focus")
    }

    /// Attachments consult the resolver during layout, not during substitution, so a
    /// test that only calls the content-storage delegate never reaches it.
    private func forceLayout() {
        let cs = editor.contentStorage
        cs.textLayoutManagers.first?.ensureLayout(for: cs.documentRange)
    }

    /// Drains the main queue. `textStorage(_:didProcessEditing:…)` cannot re-enter the
    /// storage it is being notified about, so it applies the patch on the next turn of
    /// the run loop; a test that edits and asserts immediately sees the old decorations.
    ///
    /// This has to go through an expectation. `RunLoop.current.run(until:)` looks like it
    /// would do the job and does not — it services run-loop sources, but a block posted
    /// with `DispatchQueue.main.async` is never delivered, so the drain silently does
    /// nothing and every assertion after it reads pre-edit state. An earlier version of
    /// this helper did exactly that, which made two of the widget-cache tests pass
    /// without testing anything.
    private func drainMainQueue() {
        let drained = XCTestExpectation(description: "main queue drained")
        DispatchQueue.main.async { drained.fulfill() }
        wait(for: [drained], timeout: 2)
    }

    // MARK: - Painting

    func testTheDocumentStorageIsExactlyTheMarkdownSource() {
        let source = "# Title\n\nSome **bold** text with ![a](x.png)."
        editor.setMarkdown(source)
        XCTAssertEqual(editor.markdown, source, "the storage must never diverge from the source")
    }

    func testAHeadingRendersLargerThanBody() {
        editor.setMarkdown("# Title\n\nbody text")
        let headingSize = fontSize(at: 2) // inside "Title"
        let bodySize = fontSize(at: 10) // inside "body"
        XCTAssertGreaterThan(headingSize, bodySize)
    }

    func testMarkersAreConcealedWhileUnfocused() {
        editor.setMarkdown("hello **world** end")
        // "**" occupies 6..8
        XCTAssertLessThan(fontSize(at: 6), 1, "the '**' should be collapsed to a hairline")
        XCTAssertEqual(attribute(.foregroundColor, at: 6), NSColor.clear)
        XCTAssertGreaterThan(fontSize(at: 8), 1, "the word itself must stay full size")
    }

    func testBoldTextIsActuallyBold() {
        editor.setMarkdown("hello **world** end")
        let font: NSFont? = attribute(.font, at: 9)
        XCTAssertTrue(font?.fontDescriptor.symbolicTraits.contains(.bold) ?? false)
    }

    func testMovingTheCaretIntoANodeRevealsItsMarkers() {
        editor.setMarkdown("hello **world** end")
        focus()

        editor.setSelectedRange(NSRange(location: 10, length: 0))
        XCTAssertGreaterThan(fontSize(at: 6), 1, "entering the node must bring '**' back")

        editor.setSelectedRange(NSRange(location: 0, length: 0))
        XCTAssertLessThan(fontSize(at: 6), 1, "leaving it must collapse them again")
    }

    func testOnlyTheNodeUnderTheCaretReveals() {
        editor.setMarkdown("**one** and **two**")
        focus()
        editor.setSelectedRange(NSRange(location: 3, length: 0)) // inside "one"

        XCTAssertGreaterThan(fontSize(at: 0), 1, "the caret's own markers reveal")
        XCTAssertLessThan(fontSize(at: 12), 1, "the other node stays collapsed")
    }

    // MARK: - Widgets

    func testWidgetSubstitutionIsLengthPreserving() throws {
        editor.setMarkdown("ping @gabe now")
        let backing = storage
        let paragraph = try XCTUnwrap(
            editor.textContentStorage(
                editor.contentStorage,
                textParagraphWith: NSRange(location: 0, length: backing.length)
            ),
            "a mention should produce a substituted paragraph"
        )
        // The single invariant that keeps every selection and edit offset valid.
        XCTAssertEqual(
            paragraph.attributedString.length,
            backing.length,
            "substitution changed the length, which desynchronises every offset"
        )
        XCTAssertNotNil(
            paragraph.attributedString.attribute(.attachment, at: 5, effectiveRange: nil)
        )
    }

    func testAWidgetsSourceIsConcealedBehindIt() {
        editor.setMarkdown("ping @gabe now")
        // The first character carries the attachment; the rest of "@gabe" is hidden.
        XCTAssertLessThan(fontSize(at: 6), 1)
        XCTAssertLessThan(fontSize(at: 9), 1)
        XCTAssertGreaterThan(fontSize(at: 11), 1, "text after the widget is untouched")
    }

    func testAnUnregisteredFenceStaysStyledSourceRatherThanBecomingAWidget() {
        editor.setMarkdown("```swift\nlet x = 1\n```\n")
        let font: NSFont? = attribute(.font, at: 10)
        XCTAssertTrue(font?.isFixedPitch ?? false, "it should render as code, not a widget")
    }

    /// TextKit instantiates attachment view providers during display, which an
    /// offscreen view never gets, so the container is exercised directly. The mechanism
    /// is what matters: whether the widget's view swallows the click.
    func testAWidgetDoesNotCaptureClicksSoTheCaretCanReachItsSource() {
        let content = NSButton(title: "chip", target: nil, action: nil)
        let container = WidgetContainer(hosting: content, wantsTouches: false)
        container.frame = NSRect(x: 0, y: 0, width: 80, height: 24)
        container.layoutSubtreeIfNeeded()

        // Regression guard: a view that takes the click swallows it before the text
        // view's own interaction sees it, so the caret can never land in the widget's
        // source and the content cannot be edited at all.
        XCTAssertNil(container.hitTest(NSPoint(x: 10, y: 10)), "the widget captured the click")
    }

    func testAWidgetCanOptBackIntoHandlingItsOwnClicks() {
        let content = NSButton(title: "chip", target: nil, action: nil)
        let container = WidgetContainer(hosting: content, wantsTouches: true)
        container.frame = NSRect(x: 0, y: 0, width: 80, height: 24)
        container.layoutSubtreeIfNeeded()

        XCTAssertNotNil(container.hitTest(NSPoint(x: 10, y: 10)))
    }

    func testProvidersAreNonInteractiveUnlessTheyOptIn() {
        // The default is what protects hosts that never think about it — including the
        // reference app, whose callouts and chips are pure presentation.
        XCTAssertFalse(HostWidgets().widgetWantsTouches(roleName: "callout"))
        XCTAssertFalse(HostWidgets().widgetWantsTouches(roleName: "mention"))
        XCTAssertTrue(InteractiveWidgets().widgetWantsTouches(roleName: "mention"))
    }

    func testPuttingTheCaretInAWidgetRevealsItsSource() throws {
        editor.setMarkdown("ping @gabe now")
        let collapsed = try XCTUnwrap(editor.decorations.first { $0.range.location == 5 })
        XCTAssertEqual(collapsed.kind, .inlineWidget, "should start collapsed")

        focus()
        editor.setSelectedRange(NSRange(location: 7, length: 0)) // inside "@gabe"
        let revealed = try XCTUnwrap(editor.decorations.first { $0.range.location == 5 })
        XCTAssertEqual(
            revealed.kind, .style,
            "the caret in the widget's source must reveal it for editing"
        )
    }

    // MARK: - References

    func testAReferenceReachesTheResolverAndTheDocumentKeepsOnlyThePath() {
        let resolver = RecordingResolver()
        editor.resourceResolver = resolver
        editor.setMarkdown("![a chart](assets/q3.png)")

        forceLayout()

        XCTAssertEqual(resolver.requested, ["assets/q3.png"])
        XCTAssertEqual(editor.markdown, "![a chart](assets/q3.png)")
    }

    func testTheSameReferenceIsResolvedOnceEvenWhenUsedTwice() {
        let resolver = RecordingResolver()
        editor.resourceResolver = resolver
        editor.setMarkdown("![a](same.png) and ![b](same.png)")

        forceLayout()
        XCTAssertEqual(resolver.requested, ["same.png"], "the cache should collapse the second use")
    }

    // MARK: - Resource sizing

    /// A widget view is allowed to size itself by frame rather than by Auto Layout.
    ///
    /// Regression guard: measuring only via `systemLayoutSizeFitting` reports zero for
    /// such a view, which clamped a resolved image to one point and rendered it as an
    /// invisible gap — with no error anywhere to say what had happened.
    func testAFrameBasedWidgetViewIsMeasuredByItsIntrinsicSize() {
        let view = FixedSizeView(size: CGSize(width: 400, height: 250))
        let measured = view.measured(cappedTo: 600)
        XCTAssertEqual(measured, CGSize(width: 400, height: 250))
    }

    func testAWidgetWiderThanTheColumnIsCappedNotStretched() {
        let view = FixedSizeView(size: CGSize(width: 900, height: 300))
        XCTAssertEqual(view.measured(cappedTo: 400).width, 400)
    }

    /// Widget substitution can run before layout, when the text container is still
    /// zero-width. Resolving then would bake that width into the cached result forever.
    func testAResourceRequestedBeforeLayoutIsNotResolvedAtAZeroWidth() {
        let resolver = RecordingResolver()
        let cache = ResourceCache()
        cache.resolver = resolver

        let tooEarly = ResourceRequest(
            reference: "chart.png",
            roleName: "image",
            source: "![c](chart.png)",
            fittingWidth: 0
        )
        if case .ready = cache.state(for: tooEarly) {
            XCTFail("should not resolve before a width is known")
        }
        XCTAssertEqual(resolver.requested, [], "no width yet, so nothing to load against")

        // Layout arrives with a real width, and the load starts then.
        let real = ResourceRequest(
            reference: "chart.png",
            roleName: "image",
            source: "![c](chart.png)",
            fittingWidth: 370
        )
        _ = cache.size(for: real)
        XCTAssertEqual(resolver.requested, ["chart.png"])
        XCTAssertEqual(resolver.widths, [370], "resolved against the real column width")
    }

    /// Asking for a size is what layout does first, so it has to start the load too —
    /// otherwise a resource skipped for want of a width is never requested again.
    func testAskingForASizeStartsResolution() {
        let resolver = RecordingResolver()
        let cache = ResourceCache()
        cache.resolver = resolver
        _ = cache.size(for: ResourceRequest(
            reference: "photo.png",
            roleName: "image",
            source: "![p](photo.png)",
            fittingWidth: 320
        ))
        XCTAssertEqual(resolver.requested, ["photo.png"])
    }


    // MARK: - Remembered sizes

    /// The first sighting of a reference has to guess. Every later one must not: the
    /// resolved size is fed back so the reservation is right and the document does not
    /// shift a second time.
    func testAResolvedSizeIsRememberedInsteadOfGuessedAgain() {
        let resolver = ResolvingResolver(size: CGSize(width: 300, height: 120))
        let cache = ResourceCache()
        cache.resolver = resolver
        let request = ResourceRequest(
            reference: "photo.png",
            roleName: "image",
            source: "![p](photo.png)",
            fittingWidth: 400
        )

        XCTAssertEqual(cache.size(for: request), CGSize(width: 300, height: 120))
        XCTAssertEqual(cache.known["photo.png"], CGSize(width: 300, height: 120))

        // A new document holding the same asset must not fall back to the guess.
        cache.reset()
        XCTAssertEqual(resolver.guesses, 1, "the guess should have happened exactly once")
        XCTAssertEqual(
            cache.size(for: request),
            CGSize(width: 300, height: 120),
            "a known size was thrown away by reset"
        )
        XCTAssertEqual(resolver.guesses, 1, "the resolver was asked to guess a size it knew")
    }

    func testRememberedSizesCanBeSeededAndReadBack() {
        let resolver = RecordingResolver()
        let cache = ResourceCache()
        cache.resolver = resolver
        cache.remember(["photo.png": CGSize(width: 300, height: 120)])

        let request = ResourceRequest(
            reference: "photo.png",
            roleName: "image",
            source: "![p](photo.png)",
            fittingWidth: 400
        )
        XCTAssertEqual(
            cache.size(for: request),
            CGSize(width: 300, height: 120),
            "a seeded size was ignored in favour of the resolver's guess"
        )

        // Junk must not be trusted into the cache.
        cache.remember(["bad": .zero])
        XCTAssertNil(cache.known["bad"])
    }

    func testTheEditorExposesRememberedSizesToTheHost() {
        editor.resourceSizes = ["photo.png": CGSize(width: 300, height: 120)]
        XCTAssertEqual(editor.resourceSizes["photo.png"], CGSize(width: 300, height: 120))
    }

    // MARK: - Widget view cache

    /// A keystroke elsewhere in the paragraph must not make the host redraw a widget
    /// whose own source never changed.
    func testAWidgetViewIsBuiltOnceAndReusedAcrossRepaints() {
        let counting = CountingWidgets()
        editor.widgetProvider = counting
        editor.setMarkdown("hello @gabe there\n")
        forceLayout()
        let first = counting.calls
        XCTAssertGreaterThan(first, 0, "the mention was never drawn")

        for _ in 0 ..< 4 {
            storage.replaceCharacters(in: NSRange(location: 5, length: 0), with: "x")
            drainMainQueue()
            forceLayout()
        }
        XCTAssertEqual(
            counting.calls, first,
            "the widget view was rebuilt by an edit that did not touch its source"
        )
    }

    /// The flip side: the cache must not go stale. A key encodes the node's own source,
    /// so changing that source must produce a new view.
    func testEditingAWidgetsOwnSourceRebuildsItsView() {
        let counting = CountingWidgets()
        editor.widgetProvider = counting
        editor.setMarkdown("hi @gabe\n")
        forceLayout()
        let first = counting.calls

        storage.replaceCharacters(in: NSRange(location: 8, length: 0), with: "x")
        XCTAssertEqual(editor.markdown, "hi @gabex\n")
        drainMainQueue()
        forceLayout()
        XCTAssertGreaterThan(
            counting.calls, first,
            "the cached view survived a change to the source it renders"
        )
        XCTAssertTrue(
            counting.sources.contains("@gabex"),
            "the host was never asked for the new source"
        )
    }


    // MARK: - Widget sizing

    /// TextKit builds a widget's view before it knows how wide the column is, then sizes
    /// the container from `attachmentBounds`. The content has to follow that resize.
    func testAWidgetsContentFollowsTheContainerWhenTheColumnSizesIt() {
        let card = CardView(text: "body", tone: .warning)
        XCTAssertEqual(card.frame.size, .zero, "the host builds its view before layout")

        let container = WidgetContainer(hosting: card, wantsTouches: false)
        container.frame = NSRect(x: 0, y: 0, width: 320, height: 60)
        container.layoutSubtreeIfNeeded()

        XCTAssertEqual(card.frame.width, 320, accuracy: 0.5, "the card ignored the column width")
        XCTAssertEqual(card.frame.height, 60, accuracy: 0.5, "the card ignored the reserved height")
    }

    /// A callout must reserve at least the room its label will actually draw into.
    ///
    /// This is the invariant behind a bug that was invisible in every measurement:
    /// `CardView.height` sized the box with `boundingRect`, the label drew through
    /// `NSTextFieldCell`, and the two disagreed by ~2pt. Given a frame even slightly
    /// shorter than its `cellSize`, AppKit's label does not clip the last line — it
    /// drops to a single line. So the callout rendered as one cut-off line inside a box
    /// sized for two, while `intrinsicContentSize`, `wraps`, `isScrollable` and the
    /// frame all looked correct. Asserting on any of those passes against the bug; only
    /// comparing the reserved height to the drawing height catches it.
    func testACalloutReservesTheHeightItsLabelWillDrawInto() {
        let text = "A custom block type. The host draws it natively; the core only "
            + "says where it starts and stops."

        for width in [900.0, 520.0, 420.0, 380.0, 320.0] as [CGFloat] {
            let reserved = CardView.height(for: text, width: width)
            let card = CardView(text: text, tone: .warning)

            // Through the container, exactly as TextKit hosts it. This is the part that
            // makes the test faithful: the container pins the card's frame, so Auto
            // Layout cannot quietly grow the card to fit its label the way it does when
            // the card is exercised on its own. In the app the reserved height is final.
            let container = WidgetContainer(hosting: card, wantsTouches: false)
            container.frame = NSRect(x: 0, y: 0, width: width, height: reserved)
            container.layoutSubtreeIfNeeded()

            let label = try! XCTUnwrap(card.subviews.first as? NSTextField)
            let cell = try! XCTUnwrap(label.cell)
            let needed = cell.cellSize(
                forBounds: NSRect(
                    x: 0, y: 0, width: label.frame.width, height: .greatestFiniteMagnitude
                )
            ).height

            XCTAssertGreaterThanOrEqual(
                label.frame.height, needed - 0.01,
                "at \(Int(width))pt the label has \(label.frame.height)pt but needs "
                    + "\(needed)pt to draw — it will collapse to a single line"
            )
        }
    }

    /// And the label has to be a wrapping one in the first place.
    func testACalloutsLabelWraps() {
        let card = CardView(text: "some long body text that has to wrap somewhere", tone: .info)
        let cell = try! XCTUnwrap((card.subviews.first as? NSTextField)?.cell as? NSTextFieldCell)
        XCTAssertTrue(cell.wraps, "the label would scroll sideways as one line")
        XCTAssertFalse(cell.isScrollable, "a scrollable cell never wraps")
    }





    // MARK: - Undo

    /// The web cascade's gesture, on the platform where it structurally cannot happen —
    /// pinned anyway, so all three renderers carry the same regression test.
    ///
    /// On the web the browser owns the buffer and, on Enter, mutates the DOM into a
    /// shape the editor never built; the cascade came from diffing against that. Here
    /// TextKit mutates `NSTextStorage` and reports the exact change to the storage
    /// delegate, so there is no second source of truth to diverge from. This test is the
    /// evidence for that claim, not just the assertion of it.
    func testTypingANewlineThenCharactersDoesNotCascade() {
        editor.setMarkdown("what is up?\n")

        let end = (editor.markdown as NSString).length
        storage.replaceCharacters(in: NSRange(location: end, length: 0), with: "\n")
        drainMainQueue()
        var caret = end + 1
        for ch in ["w", "h", "a", "t"] {
            storage.replaceCharacters(in: NSRange(location: caret, length: 0), with: ch)
            drainMainQueue()
            caret += 1
        }

        XCTAssertEqual(editor.markdown, "what is up?\n\nwhat")
        XCTAssertEqual(
            storage.string, editor.markdown,
            "the storage and the mirror must never diverge"
        )
        // And the document reparsed sanely along the way: one paragraph per line,
        // nothing fossilised.
        XCTAssertFalse(editor.markdown.contains("whatwhat"))
    }


    /// Clicking a history entry must time-travel the *view*: the storage text, the
    /// decorations and the position all land on the chosen revision, and travelling
    /// forward again restores what was undone. This drives `MarkdownTextView.jump(to:)`
    /// — the exact call the iOS sheet and the macOS menu make — rather than the engine,
    /// so the storage-rewind plumbing is what is being tested.
    func testJumpingThroughTheViewTimeTravelsTheStorage() throws {
        // Two lines, so a heading size can always be compared against body size —
        // sampling two offsets on the same line proves nothing.
        editor.setMarkdown("plain text\n\nbody")
        let original = editor.markdown

        storage.replaceCharacters(in: NSRange(location: 0, length: 0), with: "# ")
        drainMainQueue()
        editor.closeUndoGroup()
        storage.replaceCharacters(in: NSRange(location: editor.markdown.count, length: 0), with: " end")
        drainMainQueue()
        let newest = editor.markdown
        XCTAssertEqual(newest, "# plain text\n\nbody end")
        XCTAssertEqual(editor.revisions.count, 2)

        // Back to the opened document in one move.
        XCTAssertTrue(editor.jump(to: 0))
        XCTAssertEqual(editor.markdown, original)
        XCTAssertEqual(editor.historyPosition, 0)
        XCTAssertEqual(
            fontSize(at: 0), fontSize(at: 12),
            "the heading styling must be gone after travelling back"
        )
        XCTAssertEqual(editor.revisions.count, 2, "the undone branch stays listed")

        // And forward again to the newest state.
        XCTAssertTrue(editor.jump(to: 2))
        XCTAssertEqual(editor.markdown, newest)
        XCTAssertGreaterThan(
            fontSize(at: 2), fontSize(at: 15),
            "the heading styling must be back after travelling forward"
        )
    }


    func testUndoThroughTheViewRestoresBothStorageAndDecorations() {
        editor.setMarkdown("plain text")
        focus()
        storage.replaceCharacters(in: NSRange(location: 0, length: 0), with: "# ")
        XCTAssertEqual(editor.markdown, "# plain text")

        XCTAssertTrue(editor.performUndo())
        XCTAssertEqual(editor.markdown, "plain text")
        XCTAssertEqual(
            fontSize(at: 0), fontSize(at: 6),
            "the heading styling should be gone after undo"
        )

        XCTAssertTrue(editor.performRedo())
        XCTAssertEqual(editor.markdown, "# plain text")
    }

    func testTogglingATaskRewritesTheSourceAndUndoesInOneStep() throws {
        editor.setMarkdown("- [ ] a task\n")
        let checkbox = try XCTUnwrap(
            editor.decorations.first { $0.role == Role.taskCheckbox }
        )
        editor.toggleTask(at: checkbox)
        XCTAssertEqual(editor.markdown, "- [x] a task\n")

        XCTAssertTrue(editor.performUndo())
        XCTAssertEqual(editor.markdown, "- [ ] a task\n")
    }

    func testTheViewRefusesToUndoWhenThereIsNothingToUndo() {
        editor.setMarkdown("text")
        XCTAssertFalse(editor.canUndo)
        XCTAssertFalse(editor.performUndo())
    }

    func testTheNativeUndoManagerIsInert() {
        editor.setMarkdown("text")
        focus()
        storage.replaceCharacters(in: NSRange(location: 4, length: 0), with: "!")
        // AppKit's own undo must not be able to bypass the core's history.
        XCTAssertFalse(editor.undoManager?.canUndo ?? true)
        editor.undoManager?.undo()
        XCTAssertEqual(editor.markdown, "text!")
    }
}

/// A provider whose widgets handle their own clicks.
/// Counts how many times the host was asked to draw a widget, and with what source.
private final class CountingWidgets: WidgetProvider {
    private(set) var calls = 0
    private(set) var sources: [String] = []

    func makeWidget(roleName: String, source: String, payload: String?) -> PlatformView? {
        guard roleName == "mention" else { return nil }
        calls += 1
        sources.append(source)
        return NSView(frame: CGRect(x: 0, y: 0, width: 40, height: 16))
    }
}

/// Resolves immediately to a view of a known size, and counts guesses.
private final class ResolvingResolver: ResourceResolver {
    private(set) var guesses = 0
    private let size: CGSize

    init(size: CGSize) { self.size = size }

    func resolve(
        _ request: ResourceRequest,
        deliver: @escaping (ResourceState) -> Void
    ) -> ResourceState {
        .ready(FixedSizeView(size: size))
    }

    func reservedSize(_ request: ResourceRequest) -> CGSize {
        guesses += 1
        return CGSize(width: 100, height: 60)
    }
}

private final class InteractiveWidgets: WidgetProvider {
    func makeWidget(roleName: String, source: String, payload: String?) -> PlatformView? {
        roleName == "mention" ? NSButton(title: source, target: nil, action: nil) : nil
    }

    func widgetWantsTouches(roleName: String) -> Bool { true }
}

/// Records which references were asked for, and never resolves them — enough to prove
/// the plumbing without depending on the filesystem.
private final class RecordingResolver: ResourceResolver {
    private(set) var requested: [String] = []
    private(set) var widths: [CGFloat] = []

    func resolve(
        _ request: ResourceRequest,
        deliver: @escaping (ResourceState) -> Void
    ) -> ResourceState {
        requested.append(request.reference)
        widths.append(request.fittingWidth)
        return .loading
    }

    func reservedSize(_ request: ResourceRequest) -> CGSize {
        CGSize(width: 100, height: 60)
    }
}

/// Sizes itself by frame and `intrinsicContentSize`, with no constraints at all — the
/// shape a host naturally reaches for when wrapping an image.
private final class FixedSizeView: NSView {
    private let target: CGSize

    init(size: CGSize) {
        target = size
        super.init(frame: CGRect(origin: .zero, size: size))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    override var intrinsicContentSize: CGSize { target }
}
#endif
