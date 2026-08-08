#if os(macOS)
import AppKit
import MDECore
import MDEHost
import XCTest
@testable import MDEditorUI

/// Where the renderer breaks, and how.
///
/// The renderer is the layer where a bad offset stops being a wrong colour and starts
/// being a crash: every decoration range is used to address `NSTextStorage`, and every
/// one of these documents is built to produce ranges that a naive implementation would
/// get wrong. The bar is: never trap, never let the storage diverge from the source.
final class MacBoundsTests: XCTestCase {
    private var window: NSWindow!
    private var editor: MarkdownTextView!

    override func setUp() {
        super.setUp()
        editor = MarkdownTextView(manifest: HostExtensions.manifest)
        editor.widgetProvider = HostWidgets()
        editor.frame = NSRect(x: 0, y: 0, width: 600, height: 800)
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

    /// Runs the main queue until everything already enqueued has executed.
    ///
    /// `MarkdownTextView` hands the patch back to itself with `DispatchQueue.main.async`
    /// — repainting inside the storage delegate would re-enter it — so `decorations` is
    /// one runloop turn stale immediately after an edit. The storage itself is always
    /// current; only the decoration set lags.
    private func drainMainQueue() {
        var done = false
        DispatchQueue.main.async { done = true }
        while !done {
            _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
        }
    }

    /// The storage is the document; nothing the renderer does may change it.
    private func assertStorageMatches(_ source: String, _ label: String) {
        XCTAssertEqual(editor.markdown, source, "\(label): the storage diverged from the source")
        for d in editor.decorations {
            XCTAssertLessThanOrEqual(
                d.range.upperBound, (editor.markdown as NSString).length,
                "\(label): decoration past the end of the document"
            )
        }
    }

    // MARK: - Pathological documents

    func testADocumentThatIsOneEnormousLine() {
        let source = String(repeating: "word ", count: 20_000)
        editor.setMarkdown(source)
        assertStorageMatches(source, "one line")
    }

    func testThousandsOfUnclosedMarkers() {
        for source in [
            String(repeating: "*", count: 5_000),
            String(repeating: "[", count: 5_000),
            String(repeating: "`", count: 5_000),
        ] {
            editor.setMarkdown(source)
            assertStorageMatches(source, "unclosed markers")
        }
    }

    func testAdversarialUnicodeSurvivesTheRenderer() {
        for source in [
            String(repeating: "😀", count: 2_000),
            String(repeating: "a\u{0301}", count: 2_000),
            "\u{202E}reversed\u{202C} **bold**",
            String(repeating: "\u{200B}", count: 2_000),
            // The attachment character itself, which the widget substitution also uses.
            "\u{FFFC}object replacement **x** @who",
        ] {
            editor.setMarkdown(source)
            assertStorageMatches(source, "adversarial unicode")
        }
    }

    func testAnEmptyDocumentIsEditable() {
        for source in ["", "\n", "\n\n\n", " "] {
            editor.setMarkdown(source)
            assertStorageMatches(source, "trivial document")
            let ns = editor.markdown as NSString
            editor.textStorage?.replaceCharacters(in: NSRange(location: ns.length, length: 0), with: "x")
            XCTAssertEqual(editor.markdown, source + "x")
        }
    }

    func testDeeplyNestedQuotesRender() {
        let source = String(repeating: "> ", count: 300) + "deep\n"
        editor.setMarkdown(source)
        assertStorageMatches(source, "deep quotes")
    }

    // MARK: - Edit patterns

    func testAnEditStormKeepsTheStorageIntact() {
        editor.setMarkdown("")
        var expected = ""
        let fragments = ["# h\n\n", "**b** ", "`c` ", "@x ", "[[w]] ", "\n\n", "- i\n"]
        var seed: UInt64 = 0x1234_5678

        for step in 0 ..< 400 {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1
            let ns = expected as NSString
            let at = Int(seed >> 33) % (ns.length + 1)
            let frag = fragments[Int(seed >> 20) % fragments.count]

            // A composed character sequence must not be split, exactly as a real host
            // would refuse to offer such an offset. The ends are always safe, and an
            // empty string has no index to ask about at all.
            if at > 0, at < ns.length {
                let safe = ns.rangeOfComposedCharacterSequence(at: at)
                guard safe.location == at else { continue }
            }

            editor.textStorage?.replaceCharacters(in: NSRange(location: at, length: 0), with: frag)
            expected = ns.replacingCharacters(in: NSRange(location: at, length: 0), with: frag)
            XCTAssertEqual(editor.markdown, expected, "storage drifted at step \(step)")
        }
    }

    func testDeletingTheWholeDocumentAndUndoing() {
        let source = "# Title\n\n**bold** and @mention\n\n```callout x\nbody\n```\n"
        editor.setMarkdown(source)
        let ns = editor.markdown as NSString

        editor.textStorage?.replaceCharacters(in: NSRange(location: 0, length: ns.length), with: "")
        XCTAssertEqual(editor.markdown, "")
        drainMainQueue()
        XCTAssertTrue(editor.decorations.isEmpty, "an empty document has no decorations")

        XCTAssertTrue(editor.performUndo())
        assertStorageMatches(source, "after undoing a full delete")
    }

    func testPastingALargeBlockIntoTheMiddle() {
        editor.setMarkdown("start\n\nend\n")
        let paste = String(repeating: "# Pasted\n\n**bold** @who\n\n", count: 1_000)
        editor.textStorage?.replaceCharacters(in: NSRange(location: 7, length: 0), with: paste)
        XCTAssertTrue(editor.markdown.contains(paste))

        XCTAssertTrue(editor.performUndo())
        assertStorageMatches("start\n\nend\n", "after undoing a paste")
    }

    // MARK: - Selection

    func testSelectionAtEveryOffsetOfAHostileDocument() {
        let source = "😀**bold**日本\n\n```callout x\nbody\n```\n\n@who [[link]]\n"
        editor.setMarkdown(source)
        XCTAssertTrue(window.makeFirstResponder(editor))

        let ns = source as NSString
        var at = 0
        while at <= ns.length {
            editor.setSelectedRange(NSRange(location: at, length: 0))
            // Step by composed character sequences: a caret cannot sit inside one.
            let next = at < ns.length
                ? ns.rangeOfComposedCharacterSequence(at: at).upperBound
                : at + 1
            at = max(next, at + 1)
        }
        assertStorageMatches(source, "after sweeping the caret")
    }

}
#endif
