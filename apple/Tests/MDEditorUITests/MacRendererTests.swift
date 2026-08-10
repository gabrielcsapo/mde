#if os(macOS)
import AppKit
@testable import MDECore
@testable import MDEHost
import XCTest
@testable import MDEditorUI

/// Drives the real AppKit `MarkdownTextView` and asserts on what it actually renders.
///
/// This is the macOS half of "verify the renderer": the decoration logic is shared with
/// iOS via `DecorationApplier`, so these tests pin the semantics in DESIGN §3–4 for
/// both hosts, and they run headlessly rather than needing a screenshot.
final class MacRendererTests: XCTestCase {
    private var window: NSWindow!
    private var scroll: NSScrollView!
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
        scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 600, height: 800))
        scroll.hasVerticalScroller = true
        scroll.documentView = editor
        window.contentView?.addSubview(scroll)
    }

    override func tearDown() {
        window = nil
        scroll = nil
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

    func testAPathologicalParagraphUsesTheResponsiveUnwrappedLayout() throws {
        let source = String(repeating: "word **strong** @same résumé 日本語 🎉 ", count: 850)

        editor.setMarkdown(source)

        XCTAssertEqual(editor.markdown, source, "the layout fast path must not rewrite source")
        XCTAssertEqual(storage.string, source, "the backing store must remain the source")
        XCTAssertFalse(try XCTUnwrap(editor.textContainer).widthTracksTextView)
        XCTAssertTrue(editor.isHorizontallyResizable)
        XCTAssertTrue(scroll.hasHorizontalScroller)
    }

    func testOrdinaryTextRestoresWrappingAfterAPathologicalParagraph() throws {
        editor.setMarkdown(String(repeating: "word ", count: 2_000))
        XCTAssertFalse(try XCTUnwrap(editor.textContainer).widthTracksTextView)

        editor.setMarkdown("ordinary wrapped text")

        XCTAssertTrue(try XCTUnwrap(editor.textContainer).widthTracksTextView)
        XCTAssertFalse(editor.isHorizontallyResizable)
        XCTAssertFalse(scroll.hasHorizontalScroller)
    }

    func testLongParagraphOptimizationCanBeDisabled() throws {
        editor.optimizesLongParagraphLayout = false
        let source = String(repeating: "word ", count: 2_000)

        editor.setMarkdown(source)

        XCTAssertEqual(storage.string, source)
        XCTAssertTrue(try XCTUnwrap(editor.textContainer).widthTracksTextView)
        XCTAssertFalse(editor.isHorizontallyResizable)
        XCTAssertFalse(scroll.hasHorizontalScroller)
    }

    func testEditingCanEnterAndLeaveTheLongParagraphFastPath() throws {
        let source = String(repeating: "word ", count: 2_000)
        editor.setMarkdown("short")
        storage.replaceCharacters(in: NSRange(location: 5, length: 0), with: source)
        drainMainQueue()
        XCTAssertFalse(try XCTUnwrap(editor.textContainer).widthTracksTextView)

        let middle = storage.length / 2
        storage.replaceCharacters(in: NSRange(location: middle, length: 1), with: "\n")
        drainMainQueue()

        XCTAssertTrue(try XCTUnwrap(editor.textContainer).widthTracksTextView)
        XCTAssertEqual(editor.markdown, storage.string)
    }

    func testReplacingAWidgetDocumentWithShortTextDropsStalePresentationRanges() {
        editor.setMarkdown("| A | B |\n| --- | --- |\n| one | [two](https://example.dev) |\n")
        forceLayout()

        editor.setMarkdown("short")
        forceLayout()

        XCTAssertEqual(editor.markdown, "short")
        XCTAssertTrue(editor.decorations.allSatisfy { $0.range.upperBound <= 5 })
    }

    func testAHeadingRendersLargerThanBody() {
        editor.setMarkdown("# Title\n\nbody text")
        let headingSize = fontSize(at: 2) // inside "Title"
        let bodySize = fontSize(at: 10) // inside "body"
        XCTAssertGreaterThan(headingSize, bodySize)
    }

    func testLargeDocumentsPaintTheViewportBeforeTheDistantTail() {
        let source = "# visible heading\n\n"
            + String(repeating: "ordinary body text\n", count: 16_000)
            + "\n# distant heading\n"
        let tail = (source as NSString).range(of: "# distant", options: .backwards).location
        editor.setMarkdown(source)
        editor.layoutSubtreeIfNeeded()
        editor.contentStorage.textLayoutManagers.first?
            .textViewportLayoutController.layoutViewport()
        drainMainQueue()

        XCTAssertGreaterThan(fontSize(at: 2), fontSize(at: 18))
        XCTAssertEqual(
            fontSize(at: tail + 2),
            fontSize(at: 18),
            accuracy: 0.01,
            "offscreen attributes were eagerly painted across the full document"
        )

        editor.scrollRangeToVisible(NSRange(location: tail, length: 1))
        editor.layoutSubtreeIfNeeded()
        editor.contentStorage.textLayoutManagers.first?
            .textViewportLayoutController.layoutViewport()
        drainMainQueue()
        XCTAssertGreaterThan(
            fontSize(at: tail + 2), fontSize(at: 18),
            "scrolling did not paint the newly visible heading"
        )
    }

    func testALocalEditInALongParagraphPreservesDistantStyling() throws {
        let repeated = String(repeating: "lead **bold** ", count: 700)
        let source = repeated + "target **edited** " + repeated
        XCTAssertGreaterThan(source.utf16.count, 16 * 1024)

        let engine = try XCTUnwrap(MarkdownEngine(manifest: HostExtensions.manifest))
        let applier = DecorationApplier(engine: engine, theme: Theme())
        let backing = NSTextStorage(attributedString: NSAttributedString(
            string: source,
            attributes: applier.theme.baseAttributes
        ))
        applier.ingest(engine.reset(source))
        applier.repaint(NSRange(location: 0, length: backing.length), in: backing)

        let edited = (source as NSString).range(of: "edited")
        let insertion = NSRange(location: edited.location + 2, length: 0)
        backing.replaceCharacters(in: insertion, with: "x")
        let patch = try engine.apply(
            [TextEdit(range: insertion, text: "x")],
            documentLength: backing.length
        )
        let dirty = applier.dirtyRanges(for: patch, alsoDirty: insertion)
        applier.ingest(patch)
        for range in dirty { applier.repaint(range, in: backing) }

        XCTAssertEqual(backing.string, repeated + "target **edxited** " + repeated)
        let localMarker = (backing.string as NSString).range(of: "**edxited**")
        let distantMarker = (backing.string as NSString).range(
            of: "**bold**",
            options: .backwards
        )
        XCTAssertLessThan(
            (backing.attribute(.font, at: localMarker.location, effectiveRange: nil)
                as? NSFont)?.pointSize ?? 0,
            1
        )
        XCTAssertTrue(
            ((backing.attribute(.font, at: localMarker.location + 3, effectiveRange: nil)
                as? NSFont)?.fontDescriptor.symbolicTraits.contains(.bold)) ?? false
        )
        XCTAssertLessThan(
            (backing.attribute(.font, at: distantMarker.location, effectiveRange: nil)
                as? NSFont)?.pointSize ?? 0,
            1,
            "localized repainting stripped a distant marker"
        )
        XCTAssertTrue(
            ((backing.attribute(.font, at: distantMarker.location + 3, effectiveRange: nil)
                as? NSFont)?.fontDescriptor.symbolicTraits.contains(.bold)) ?? false,
            "localized repainting stripped distant strong text"
        )
    }

    func testRequestingALinkUsesTheCoreDestinationWithoutChangingSource() {
        let source = "Read [the docs](https://example.dev/docs)."
        let recorder = LinkRecorder()
        editor.markdownDelegate = recorder
        editor.setMarkdown(source)

        XCTAssertTrue(editor.requestOpenLink(at: 8))
        XCTAssertEqual(recorder.destination, "https://example.dev/docs")
        XCTAssertEqual(editor.markdown, source)
        XCTAssertFalse(editor.requestOpenLink(at: 1))
    }

    func testASetextHeadingUsesLevelTwoAndConcealsItsUnderline() {
        editor.setMarkdown("Heading\n-------\n\nbody")
        let headingSize = fontSize(at: 1)
        let bodySize = fontSize(at: 19)
        XCTAssertGreaterThan(headingSize, bodySize)
        XCTAssertLessThan(fontSize(at: 8), 1, "the setext underline should be concealed")
    }

    func testAComplexTableUsesANativeGridAndKeepsItsMarkdownSource() throws {
        let source = """
        | Name | Detail | Asset |
        | :--- | :----: | ----: |
        | **Ada** | [profile](https://example.dev) + `10` | ![chart](chart.png) |
        """
        editor.setMarkdown(source)

        let table = try XCTUnwrap(editor.decorations.first { $0.role == Role.table })
        XCTAssertEqual(table.kind, .blockWidget)
        let paragraph = try XCTUnwrap(editor.textContentStorage(
            editor.contentStorage,
            textParagraphWith: NSRange(location: 0, length: storage.length)
        ))
        let attachment = try XCTUnwrap(
            paragraph.attributedString.attribute(.attachment, at: 0, effectiveRange: nil)
                as? WidgetAttachment
        )
        let view = try XCTUnwrap(attachment.makeView() as? TableWidgetView)

        XCTAssertEqual(view.model.rows.count, 2)
        XCTAssertEqual(view.model.rows[1].map(\.source), [
            "**Ada**", "[profile](https://example.dev) + `10`", "![chart](chart.png)",
        ])
        XCTAssertEqual(view.model.alignments, [.left, .center, .right])
        XCTAssertGreaterThan(view.frame.height, 70)
        XCTAssertEqual(editor.markdown, source, "the native projection changed the source")
    }

    func testNativeTableCellsRenderBoldLinksAndCode() {
        let bold = TableCellRenderer.render(TableCellModel(source: "Ada", inlines: [
            TableInlineDecoration(
                range: NSRange(location: 0, length: 3), role: Role.strong, kind: .style, payload: nil
            ),
        ]), header: false)
        let boldFont = bold.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        XCTAssertTrue(boldFont?.fontDescriptor.symbolicTraits.contains(.bold) ?? false)

        let link = TableCellRenderer.render(TableCellModel(source: "profile", inlines: [
            TableInlineDecoration(
                range: NSRange(location: 0, length: 7),
                role: Role.linkText,
                kind: .style,
                payload: "https://example.dev"
            ),
        ]), header: false)
        XCTAssertNotNil(link.attribute(.link, at: 0, effectiveRange: nil))
        var opened: String?
        let interactiveLink = TableTextCellView(
            content: link,
            alignment: .left,
            onOpenLink: { opened = $0 }
        )
        XCTAssertTrue(interactiveLink.activateLink(at: 2))
        XCTAssertEqual(opened, "https://example.dev")
        XCTAssertTrue(interactiveLink.isSelectable)

        let code = TableCellRenderer.render(TableCellModel(source: "10", inlines: [
            TableInlineDecoration(
                range: NSRange(location: 0, length: 2), role: Role.codeInline, kind: .style, payload: nil
            ),
        ]), header: false)
        let codeFont = code.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        XCTAssertTrue(codeFont?.fontDescriptor.symbolicTraits.contains(.monoSpace) ?? false)

    }

    func testMixedTableImageKeepsAdjacentInlineCodeVisible() {
        let rendered = TableCellRenderer.render(TableCellModel(source: "`DOM` + ![chart](chart.png)", inlines: [
            TableInlineDecoration(
                range: NSRange(location: 0, length: 5), role: Role.codeInline, kind: .style, payload: nil
            ),
            TableInlineDecoration(
                range: NSRange(location: 0, length: 1), role: Role.codeInline, kind: .conceal, payload: nil
            ),
            TableInlineDecoration(
                range: NSRange(location: 4, length: 1), role: Role.codeInline, kind: .conceal, payload: nil
            ),
            TableInlineDecoration(
                range: NSRange(location: 8, length: 19),
                role: Role.image,
                kind: .inlineWidget,
                payload: "chart.png"
            ),
        ]), header: false)

        XCTAssertTrue(rendered.string.hasPrefix("DOM + "))
        XCTAssertEqual(rendered.string.last, "\u{fffc}")
        let attachment = rendered.attribute(
            .attachment,
            at: rendered.length - 1,
            effectiveRange: nil
        ) as? NSTextAttachment
        XCTAssertLessThanOrEqual(attachment?.bounds.width ?? .greatestFiniteMagnitude, 40)
    }

    func testNativeTableImagesComeFromTheResourceResolverWithoutADuplicateAttachment() throws {
        let source = "| Asset |\n| :---: |\n| ![chart](chart.png) |\n"
        let resolver = ImageResolver()
        editor.resourceResolver = resolver
        editor.setMarkdown(source)
        let paragraph = try XCTUnwrap(editor.textContentStorage(
            editor.contentStorage,
            textParagraphWith: NSRange(location: 0, length: storage.length)
        ))
        let attachment = try XCTUnwrap(
            paragraph.attributedString.attribute(.attachment, at: 0, effectiveRange: nil)
                as? WidgetAttachment
        )
        let view = try XCTUnwrap(attachment.makeView() as? TableWidgetView)

        func descendants(_ root: NSView) -> [NSView] {
            root.subviews.flatMap { [$0] + descendants($0) }
        }
        let renderedImages = descendants(view).compactMap { ($0 as? NSImageView)?.image }
        XCTAssertEqual(resolver.requested, ["chart.png"])
        XCTAssertEqual(renderedImages.count, 1, "the table did not draw the resolved image")
        XCTAssertEqual(
            view.frame.height,
            view.intrinsicContentSize.height,
            accuracy: 0.5,
            "the attachment reserved less height than its image row draws"
        )

        let imageRange = (source as NSString).range(of: "![chart](chart.png)")
        let paragraphRange = (source as NSString).paragraphRange(for: imageRange)
        XCTAssertNil(
            editor.textContentStorage(editor.contentStorage, textParagraphWith: paragraphRange),
            "the nested image also became a full-size attachment behind the table"
        )
        XCTAssertEqual(editor.markdown, source)
    }

    func testNativeTablesResolveReferenceImagesInsideMixedContent() throws {
        let source = """
        | Mixed | Reference |
        | :--- | ---: |
        | before ![chart][chart-ref] after | ![photo][photo-ref] |

        [chart-ref]: chart.png
        [photo-ref]: photo.png
        """
        let resolver = ImageResolver()
        editor.resourceResolver = resolver
        editor.setMarkdown(source)
        let paragraph = try XCTUnwrap(editor.textContentStorage(
            editor.contentStorage,
            textParagraphWith: NSRange(location: 0, length: storage.length)
        ))
        let attachment = try XCTUnwrap(
            paragraph.attributedString.attribute(.attachment, at: 0, effectiveRange: nil)
                as? WidgetAttachment
        )
        let table = try XCTUnwrap(attachment.makeView() as? TableWidgetView)

        func descendants(_ root: NSView) -> [NSView] {
            root.subviews.flatMap { [$0] + descendants($0) }
        }
        let labels = descendants(table).compactMap { view -> NSAttributedString? in
            if let textView = view as? NSTextView { return textView.attributedString() }
            if let label = view as? NSTextField { return label.attributedStringValue }
            return nil
        }
        let inlineAttachments = labels.reduce(0) { count, value in
            var found = 0
            value.enumerateAttribute(
                .attachment,
                in: NSRange(location: 0, length: value.length)
            ) { attachment, _, _ in
                if attachment != nil { found += 1 }
            }
            return count + found
        }
        XCTAssertGreaterThanOrEqual(inlineAttachments, 1, "mixed image fell back to source text")
        XCTAssertEqual(Set(resolver.requested), Set(["chart.png", "photo.png"]))
        XCTAssertEqual(table.model.rows[1].map(\.source), [
            "before ![chart][chart-ref] after", "![photo][photo-ref]",
        ])
        XCTAssertEqual(editor.markdown, source)
    }

    func testMovingTheCaretIntoATableRevealsPipesThenRestoresTheNativeGrid() throws {
        let source = "| Name | Score |\n| :--- | ----: |\n| Ada | 10 |\n\nafter"
        editor.setMarkdown(source)
        focus()

        editor.setSelectedRange(NSRange(location: source.range(of: "Ada")!.lowerBound.utf16Offset(
            in: source
        ), length: 0))
        XCTAssertEqual(
            try XCTUnwrap(editor.decorations.first { $0.role == Role.table }).kind,
            .style
        )

        editor.setSelectedRange(NSRange(location: (source as NSString).range(of: "after").location, length: 0))
        XCTAssertEqual(
            try XCTUnwrap(editor.decorations.first { $0.role == Role.table }).kind,
            .blockWidget
        )
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
        let attachment = try XCTUnwrap(
            paragraph.attributedString.attribute(.attachment, at: 5, effectiveRange: nil)
                as? WidgetAttachment
        )
        let bounds = attachment.attachmentBounds(
            for: nil,
            proposedLineFragment: .zero,
            glyphPosition: .zero,
            characterIndex: 5
        )
        let font = Theme().bodyFont
        XCTAssertEqual(
            bounds.midY,
            (font.ascender + font.descender) / 2,
            accuracy: 0.5,
            "the mention chip is not vertically centered on the surrounding text"
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

    func testAStaleResourceDeliveryCannotOverwriteTheSamePathAfterReset() throws {
        let cache = ResourceCache()
        let resolver = DeferredResolver()
        cache.resolver = resolver
        var resolved = [String]()
        cache.onResolved = { resolved.append($0) }
        let request = ResourceRequest(
            reference: "same.png",
            roleName: "image",
            source: "![x](same.png)",
            fittingWidth: 200
        )

        guard case .loading = cache.state(for: request) else {
            return XCTFail("the first request did not start loading")
        }
        cache.reset()
        guard case .loading = cache.state(for: request) else {
            return XCTFail("the replacement request did not start loading")
        }

        let stale = FixedSizeView(size: CGSize(width: 10, height: 10))
        resolver.deliveries[0](.ready(stale))
        guard case .loading = cache.state(for: request) else {
            return XCTFail("the stale request overwrote the new loading state")
        }
        XCTAssertTrue(resolved.isEmpty)

        let current = FixedSizeView(size: CGSize(width: 20, height: 20))
        resolver.deliveries[1](.ready(current))
        let view: PlatformView
        if case .ready(let ready) = cache.state(for: request) {
            view = ready
        } else {
            return XCTFail("the current request did not resolve")
        }
        XCTAssertTrue(view === current)
        XCTAssertEqual(resolved, ["same.png"])
    }

    func testResourceReferenceIndexFollowsAnEditedDestination() throws {
        let engine = try XCTUnwrap(MarkdownEngine(manifest: nil))
        let applier = DecorationApplier(engine: engine, theme: Theme())
        let source = (0..<600).map { "![\($0)](asset-\($0).png)" }.joined(separator: "\n") + "\n"
        applier.ingest(engine.reset(source))

        XCTAssertEqual(applier.ranges(referencing: "asset-599.png").count, 1)
        let old = "asset-599.png"
        let at = (source as NSString).range(of: old, options: .backwards).location
        let replacement = "renamed.png"
        let patch = try engine.apply(
            [TextEdit(range: NSRange(location: at, length: old.utf16.count), text: replacement)],
            documentLength: source.utf16.count - old.utf16.count + replacement.utf16.count
        )
        applier.ingest(patch)

        XCTAssertTrue(applier.ranges(referencing: old).isEmpty)
        XCTAssertEqual(applier.ranges(referencing: replacement).count, 1)
    }

    func testDiskImagesDecodeToTheDisplayedPixelBudget() throws {
        let resolver = DiskResourceResolver(root: SampleAssets.install())
        let request = ResourceRequest(
            reference: "chart.png",
            roleName: "image",
            source: "![chart](chart.png)",
            fittingWidth: 100
        )
        let delivered = expectation(description: "downsampled image delivered")
        var view: ImageResourceView?
        let immediate = resolver.resolve(request) { state in
            if case .ready(let resolved) = state {
                view = resolved as? ImageResourceView
            }
            delivered.fulfill()
        }
        if case .ready(let resolved) = immediate {
            view = resolved as? ImageResourceView
            delivered.fulfill()
        }
        wait(for: [delivered], timeout: 2)

        let image = try XCTUnwrap(view)
        let displayScale = NSScreen.main?.backingScaleFactor ?? 2
        XCTAssertLessThanOrEqual(image.decodedPixelSize.width, ceil(100 * displayScale))
        XCTAssertLessThanOrEqual(image.intrinsicContentSize.width, 100)
    }

    func testCompactSuffixShiftUpdatesLiveDecorationRanges() throws {
        let engine = try XCTUnwrap(MarkdownEngine(manifest: nil))
        let applier = DecorationApplier(engine: engine, theme: Theme())
        let source = (0..<100).map { "**item \($0)**\n\n" }.joined()
        let initial = engine.reset(source)
        applier.ingest(initial)
        let last = try XCTUnwrap(initial.added.filter { $0.role == Role.strong }.max {
            $0.range.location < $1.range.location
        })

        let patch = try engine.apply(
            [TextEdit(range: NSRange(location: 0, length: 0), text: "x")],
            documentLength: source.utf16.count + 1
        )
        XCTAssertEqual(patch.shifted.count, 1)
        applier.ingest(patch)

        XCTAssertEqual(applier.live[last.key]?.range.location, last.range.location + 1)
    }

    func testExplicitMoveOverridesACompactSuffixShift() throws {
        let engine = try XCTUnwrap(MarkdownEngine(manifest: nil))
        let applier = DecorationApplier(engine: engine, theme: Theme())
        let initial = engine.reset("**first**\n\n**second**\n")
        applier.ingest(initial)
        let strong = initial.added.filter { $0.role == Role.strong }
        let first = try XCTUnwrap(strong.first)
        let second = try XCTUnwrap(strong.last)

        applier.ingest(Patch(
            removed: [],
            added: [],
            shifted: [(first.range.location, 3)],
            moved: [(second.key, second.range)]
        ))

        XCTAssertEqual(applier.live[first.key]?.range.location, first.range.location + 3)
        XCTAssertEqual(applier.live[second.key]?.range, second.range)
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

        editor.setMarkdown("- [X] already checked\n")
        let uppercase = try XCTUnwrap(
            editor.decorations.first { $0.role == Role.taskCheckbox }
        )
        editor.toggleTask(at: uppercase)
        XCTAssertEqual(editor.markdown, "- [ ] already checked\n")
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

extension MacRendererTests {
    func testPluginConvenienceInitializerComposesSyntaxBeforeInstallation() throws {
        let plugin = ManifestPlugin()
        let view = try MarkdownTextView(plugins: [plugin])
        view.setMarkdown("Ping @plugin now")
        XCTAssertTrue(view.installedPluginNames.contains(plugin.name))
        XCTAssertTrue(view.decorations.contains { decoration in
            view.engine.roleName(decoration.role) == "plugin-mention"
        })
    }

    func testPluginLifecycleOwnsCallbacksAndCleansUpLayers() throws {
        let plugin = CountingPlugin()
        try editor.installPlugin(plugin)
        XCTAssertEqual(editor.installedPluginNames, [plugin.name])
        XCTAssertEqual(plugin.markdownChanges, 1, "install should publish the current document")
        XCTAssertEqual(plugin.selectionChanges, 1, "install should publish the current selection")

        editor.setMarkdown("hello plugin")
        XCTAssertEqual(plugin.markdownChanges, 2)
        XCTAssertTrue(editor.decorations.contains { $0.role == plugin.role })

        XCTAssertThrowsError(try editor.installPlugin(plugin)) { error in
            XCTAssertEqual(error as? MarkdownPluginError, .duplicateName(plugin.name))
        }
        XCTAssertTrue(editor.removePlugin(named: plugin.name))
        XCTAssertEqual(plugin.uninstalls, 1)
        XCTAssertFalse(editor.decorations.contains { $0.role == plugin.role })
        XCTAssertFalse(editor.removePlugin(named: plugin.name))

        editor.setMarkdown("after removal")
        XCTAssertEqual(plugin.markdownChanges, 2, "a removed plugin still received callbacks")
    }

    func testFailedPluginInstallationRollsBackItsLayerAndName() throws {
        editor.setMarkdown("hello")
        let plugin = FailingPlugin()
        XCTAssertThrowsError(try editor.installPlugin(plugin))
        XCTAssertEqual(editor.installedPluginNames, [])
        XCTAssertFalse(editor.decorations.contains { $0.role == plugin.role })

        // The failed install did not leave the name reserved.
        let replacement = CountingPlugin(name: plugin.name)
        XCTAssertNoThrow(try editor.installPlugin(replacement))
    }

    func testPluginAnalysisIsLatestWinsAndCancelledOnRemoval() throws {
        let applied = expectation(description: "latest analysis applied")
        let plugin = AnalysisPlugin { markdown in
            if markdown == "latest snapshot" { applied.fulfill() }
        }
        try editor.installPlugin(plugin)
        editor.setMarkdown("first snapshot")
        editor.setMarkdown("latest snapshot")
        wait(for: [applied], timeout: 2)
        XCTAssertEqual(plugin.results, ["latest snapshot"])

        editor.setMarkdown("must never apply")
        XCTAssertTrue(editor.removePlugin(named: plugin.name))
        let settled = expectation(description: "cancelled analysis stayed cancelled")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { settled.fulfill() }
        wait(for: [settled], timeout: 1)
        XCTAssertEqual(plugin.results, ["latest snapshot"])
    }

    func testPublishedPluginCompatibilityCheckVerifiesLayerCleanup() throws {
        let report = try MarkdownPluginCompatibility.check(CountingPlugin(), in: editor)
        XCTAssertEqual(report.name, "test.counting")
        XCTAssertTrue(report.installed)
        XCTAssertTrue(report.removed)
        XCTAssertTrue(report.sourcePreserved)
        XCTAssertEqual(report.contributedLayerDecorations, 1)
        XCTAssertTrue(report.cleanupRemovedLayers)
    }
}

private final class CountingPlugin: MarkdownPlugin {
    let name: String
    private var context: MarkdownPluginContext?
    private(set) var role: UInt32 = .max
    private(set) var markdownChanges = 0
    private(set) var selectionChanges = 0
    private(set) var uninstalls = 0

    init(name: String = "test.counting") { self.name = name }

    func install(in context: MarkdownPluginContext) throws {
        self.context = context
        role = context.internRole("test-plugin-mark")
    }

    func markdownDidChange() {
        markdownChanges += 1
        guard let length = context?.editor?.markdown.utf16.count, length > 0 else { return }
        context?.setLayer("marks", [
            LayerSpan(range: NSRange(location: 0, length: min(5, length)), role: role),
        ])
    }

    func selectionDidChange() { selectionChanges += 1 }

    func uninstall() {
        uninstalls += 1
        context = nil
    }
}

private enum TestPluginFailure: Error { case expected }

private final class ManifestPlugin: MarkdownPlugin {
    let name = "test.manifest"
    let manifest: String? = """
    [[inline]]
    name = "plugin-mention"
    syntax = { kind = "pattern", regex = "@[a-z]+" }
    render = "style"
    reveal = "never"
    """

    func install(in _: MarkdownPluginContext) throws {}
}

private final class FailingPlugin: MarkdownPlugin {
    let name = "test.failing"
    private(set) var role: UInt32 = .max

    func install(in context: MarkdownPluginContext) throws {
        role = context.internRole("test-failed-mark")
        context.setLayer("partial", [
            LayerSpan(range: NSRange(location: 0, length: 5), role: role),
        ])
        throw TestPluginFailure.expected
    }
}

private final class AnalysisPlugin: MarkdownPlugin {
    let name = "test.analysis"
    private var context: MarkdownPluginContext?
    private let onApply: (String) -> Void
    private(set) var results: [String] = []

    init(onApply: @escaping (String) -> Void) {
        self.onApply = onApply
    }

    func install(in context: MarkdownPluginContext) throws {
        self.context = context
    }

    func markdownDidChange() {
        context?.scheduleAnalysis(
            "document",
            delay: 0.02,
            analyze: { markdown, _ in markdown },
            apply: { [weak self] markdown, _ in
                self?.results.append(markdown)
                self?.onApply(markdown)
            }
        )
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

private final class LinkRecorder: MarkdownTextViewDelegate {
    var destination: String?

    func markdownTextView(
        _ view: MarkdownTextView,
        didRequestOpenLink destination: String
    ) {
        self.destination = destination
    }
}

private final class ImageResolver: ResourceResolver {
    private(set) var requested = [String]()

    func resolve(
        _ request: ResourceRequest,
        deliver: @escaping (ResourceState) -> Void
    ) -> ResourceState {
        requested.append(request.reference)
        let image = NSImage(size: CGSize(width: 160, height: 90), flipped: false) { rect in
            NSColor.systemBlue.setFill()
            rect.fill()
            return true
        }
        return .ready(NSImageView(image: image))
    }

    func reservedSize(_ request: ResourceRequest) -> CGSize {
        CGSize(width: 96, height: 54)
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

private final class DeferredResolver: ResourceResolver {
    private(set) var deliveries: [(ResourceState) -> Void] = []

    func resolve(
        _ request: ResourceRequest,
        deliver: @escaping (ResourceState) -> Void
    ) -> ResourceState {
        deliveries.append(deliver)
        return .loading
    }

    func reservedSize(_ request: ResourceRequest) -> CGSize {
        CGSize(width: 40, height: 20)
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
