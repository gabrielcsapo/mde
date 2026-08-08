import CMDE
import XCTest
@testable import MDECore

/// Stands in for `NSTextStorage`: the platform-owned buffer the core only mirrors.
/// Every test that drives edits also drives this, so a divergence between the two is
/// caught here rather than as a corrupted document on device.
private final class MirrorBuffer {
    private var storage = NSMutableString()

    var string: String { storage as String }
    var length: Int { storage.length }

    init(_ initial: String = "") { storage = NSMutableString(string: initial) }

    func apply(_ edits: [TextEdit]) {
        for e in edits.sorted(by: { $0.range.location > $1.range.location }) {
            storage.replaceCharacters(in: e.range, with: e.text)
        }
    }
}

final class MDECoreTests: XCTestCase {
    private let manifest = """
        [[block]]
        name   = "callout"
        syntax = { kind = "fence", info = "callout" }
        render = "block_widget"
        reveal = "caret_in_block"

        [[inline]]
        name   = "mention"
        syntax = { kind = "pattern", regex = "@[a-zA-Z0-9_-]+" }
        render = "inline_widget"
        reveal = "caret_in_node"
        """

    // MARK: - ABI

    func testLayoutMatchesTheRustSide() {
        // If these drift, every decoration read from the patch is garbage.
        XCTAssertEqual(MemoryLayout<MdeDecoration>.size, 24)
        XCTAssertEqual(MemoryLayout<MdeDecoration>.alignment, 8)
        XCTAssertEqual(MemoryLayout<MdeMove>.size, 16)
        XCTAssertEqual(MemoryLayout<MdeAppliedEdit>.size, 16)
    }

    func testBuiltInRoleIdsAgreeWithTheCore() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        XCTAssertEqual(e.roleName(Role.heading), "heading")
        XCTAssertEqual(e.roleName(Role.marker), "marker")
        XCTAssertEqual(e.roleName(Role.taskCheckbox), "task.checkbox")
        XCTAssertEqual(e.roleName(Role.strikethrough), "strikethrough")
        XCTAssertEqual(e.roleName(Role.table), "table")
        XCTAssertEqual(e.roleName(Role.tableHeader), "table.header")
        XCTAssertEqual(e.roleName(Role.tableDelimiter), "table.delimiter")
        XCTAssertEqual(e.roleName(Role.tableCell), "table.cell")
        XCTAssertEqual(e.roleName(Role.html), "html")
        XCTAssertNil(e.roleName(9999))
    }

    func testAMalformedManifestFailsInitialisationRatherThanTrapping() {
        XCTAssertNil(MarkdownEngine(manifest: "[[inline]]\nname = \"x\"\n"))
    }

    // MARK: - Decorations

    func testResetProducesStyledAndConcealedRanges() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        let patch = e.reset("# Title\n\nSome **bold** text.")
        XCTAssertTrue(patch.removed.isEmpty)

        let heading = patch.added.filter { $0.role == Role.heading }
        XCTAssertEqual(heading.count, 1)
        XCTAssertEqual(heading[0].range, NSRange(location: 0, length: 7))

        let markers = patch.added.filter { $0.kind == .conceal && $0.role == Role.marker }
        XCTAssertEqual(markers.count, 3, "the '# ' plus both '**' runs")
    }

    func testUnfocusedDocumentKeepsMarkersConcealed() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        let patch = e.reset("# Title")
        XCTAssertTrue(patch.added.contains { $0.kind == .conceal })
        XCTAssertFalse(patch.added.contains { $0.kind == .style && $0.role == Role.marker })
    }

    func testMovingTheCaretIntoANodeRevealsItsMarkers() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        e.reset("hello **world** end")

        let inside = e.setSelection(NSRange(location: 10, length: 0))
        XCTAssertFalse(inside.isEmpty, "entering the node must repaint its markers")

        let away = e.setSelection(NSRange(location: 0, length: 0))
        XCTAssertFalse(away.isEmpty, "leaving it must collapse them again")

        let blurred = e.setSelection(nil)
        XCTAssertTrue(blurred.isEmpty, "already collapsed, so blur changes nothing")
    }

    func testExtensionRolesAreInternedAfterTheBuiltIns() throws {
        let e = try XCTUnwrap(MarkdownEngine(manifest: manifest))
        let patch = e.reset("ping @gabe")
        let widget = try XCTUnwrap(patch.added.first { $0.kind == .inlineWidget })
        XCTAssertGreaterThanOrEqual(widget.role, Role.firstExtensionRole)
        XCTAssertEqual(e.roleName(widget.role), "mention")
        XCTAssertEqual(widget.range, NSRange(location: 5, length: 5))
    }

    func testUTF16OffsetsSurviveEmojiAndCJK() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        let text = "😀 **b** 日本"
        let patch = e.reset(text)
        let ns = text as NSString

        for d in patch.added {
            XCTAssertLessThanOrEqual(
                d.range.location + d.range.length, ns.length,
                "decoration ran past the end of the NSString"
            )
        }
        let strong = try XCTUnwrap(patch.added.first { $0.role == Role.strong })
        XCTAssertEqual(ns.substring(with: strong.range), "b")
    }

    func testTablesAutolinksAndHTMLReachSwiftAsBuiltInRoles() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        let source = """
        | Name | Score |
        | :--- | ----: |
        | Ada | 10 |

        <https://example.dev> and <kbd>HTML</kbd>
        """
        let patch = e.reset(source)

        for role in [Role.table, Role.tableHeader, Role.tableDelimiter, Role.tableCell, Role.html] {
            XCTAssertTrue(patch.added.contains { $0.role == role }, "missing role \(role)")
        }
        let link = try XCTUnwrap(patch.added.first { $0.role == Role.linkText })
        XCTAssertEqual(e.payload(for: link.key), "https://example.dev")
    }

    // MARK: - References

    func testAnImageCarriesADestinationNotItsContent() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        let source = "![a chart](assets/q3-revenue.png)"
        let patch = e.reset(source)
        let widget = try XCTUnwrap(patch.added.first { $0.role == Role.image })

        XCTAssertEqual(e.payload(for: widget.key), "assets/q3-revenue.png")
        // The whole point: the widget spans exactly the reference in the document, so
        // the document carries a path and nothing else. Content never lands in here.
        XCTAssertEqual((source as NSString).substring(with: widget.range), source)
    }

    func testALinkCarriesItsDestination() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        let patch = e.reset("see [the spec](docs/spec.pdf) here")
        let link = try XCTUnwrap(patch.added.first { $0.role == Role.linkText })
        XCTAssertEqual(e.payload(for: link.key), "docs/spec.pdf")
    }

    func testARegisteredFenceCarriesItsArgument() throws {
        let e = try XCTUnwrap(MarkdownEngine(manifest: manifest))
        let patch = e.reset("```callout warning\nbody\n```\n")
        let block = try XCTUnwrap(patch.added.first { $0.kind == .blockWidget })
        XCTAssertEqual(e.payload(for: block.key), "warning")
    }

    func testDecorationsWithoutAReferenceHaveNoPayload() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        let patch = e.reset("**bold**")
        let strong = try XCTUnwrap(patch.added.first { $0.role == Role.strong })
        XCTAssertNil(e.payload(for: strong.key))
    }

    func testAPayloadSurvivesAnEditElsewhereInTheDocument() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        let buf = MirrorBuffer("intro\n\n![a](photo.jpg)")
        let initial = e.reset(buf.string)
        let key = try XCTUnwrap(initial.added.first { $0.role == Role.image }).key

        let edit = TextEdit(range: NSRange(location: 0, length: 0), text: "# ")
        buf.apply([edit])
        try e.apply([edit], documentLength: buf.length)

        XCTAssertEqual(e.payload(for: key), "photo.jpg", "reference lost after a distant edit")
    }

    // MARK: - Editing and the mirror

    func testTypingKeepsTheMirrorAndTheCoreInStep() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        let buf = MirrorBuffer("Start")
        e.reset(buf.string)

        for (i, ch) in " here".enumerated() {
            let edit = TextEdit(range: NSRange(location: 5 + i, length: 0), text: String(ch))
            buf.apply([edit])
            XCTAssertNoThrow(
                try e.apply([edit], documentLength: buf.length, now: UInt64(1000 + i * 40))
            )
        }
        XCTAssertEqual(buf.string, "Start here")
    }

    func testAWrongDocumentLengthIsReportedAsDesync() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        e.reset("abc")
        let edit = TextEdit(range: NSRange(location: 0, length: 0), text: "z")
        XCTAssertThrowsError(try e.apply([edit], documentLength: 99)) { error in
            XCTAssertEqual(error as? EngineError, .desync)
        }
    }

    func testAWidgetSurvivesADistantEdit() throws {
        let e = try XCTUnwrap(MarkdownEngine(manifest: manifest))
        let buf = MirrorBuffer("@gabe wrote this\n\ntail")
        let initial = e.reset(buf.string)
        let widget = try XCTUnwrap(initial.added.first { $0.kind == .inlineWidget })

        let edit = TextEdit(range: NSRange(location: buf.length, length: 0), text: "!")
        buf.apply([edit])
        let patch = try e.apply([edit], documentLength: buf.length)

        XCTAssertFalse(
            patch.removed.contains(widget.key),
            "typing at the end tore down a widget at the start"
        )
    }

    // MARK: - Undo

    func testUndoAndRedoKeepTheMirrorExact() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        let buf = MirrorBuffer("The quick fox")
        e.reset(buf.string)

        // Insert markdown, not plain words: undo only has something to repaint if the
        // edit changed the decoration set.
        let edit = TextEdit(range: NSRange(location: 13, length: 0), text: " **jumps**")
        buf.apply([edit])
        let applied = try e.apply([edit], documentLength: buf.length, now: 1000)
        XCTAssertTrue(applied.added.contains { $0.role == Role.strong })
        XCTAssertTrue(e.canUndo)

        let undo = try XCTUnwrap(e.undo())
        buf.apply(undo.edits)
        XCTAssertEqual(buf.string, "The quick fox")
        XCTAssertFalse(undo.patch.removed.isEmpty, "undo must tear down the bold run")

        let redo = try XCTUnwrap(e.redo())
        buf.apply(redo.edits)
        XCTAssertEqual(buf.string, "The quick fox **jumps**")
        XCTAssertTrue(redo.patch.added.contains { $0.role == Role.strong })
        XCTAssertNil(e.redo())
    }

    /// An edit that changes no decorations must produce no patch — otherwise every
    /// keystroke in a plain paragraph would repaint the whole line.
    func testAnUndoThatChangesNoDecorationsProducesNoPatch() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        e.reset("plain words here")
        try e.apply(
            [TextEdit(range: NSRange(location: 16, length: 0), text: " more")],
            documentLength: 21
        )
        let undo = try XCTUnwrap(e.undo())
        XCTAssertTrue(undo.patch.isEmpty)
    }

    func testATypingRunCollapsesIntoOneUndoStep() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        let buf = MirrorBuffer()
        e.reset("")

        for (i, ch) in "hello".enumerated() {
            let edit = TextEdit(range: NSRange(location: i, length: 0), text: String(ch))
            buf.apply([edit])
            try e.apply([edit], documentLength: buf.length, now: UInt64(1000 + i * 40))
        }

        let undo = try XCTUnwrap(e.undo())
        buf.apply(undo.edits)
        XCTAssertEqual(buf.string, "", "five keystrokes should undo as one step")
        XCTAssertFalse(e.canUndo)
    }

    func testAPauseSplitsTheUndoSteps() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        let buf = MirrorBuffer()
        e.reset("")

        for (i, ch) in "abc".enumerated() {
            let edit = TextEdit(range: NSRange(location: i, length: 0), text: String(ch))
            buf.apply([edit])
            try e.apply([edit], documentLength: buf.length, now: UInt64(1000 + i * 40))
        }
        for (i, ch) in "def".enumerated() {
            let edit = TextEdit(range: NSRange(location: 3 + i, length: 0), text: String(ch))
            buf.apply([edit])
            try e.apply([edit], documentLength: buf.length, now: UInt64(9000 + i * 40))
        }

        buf.apply(try XCTUnwrap(e.undo()).edits)
        XCTAssertEqual(buf.string, "abc")
        buf.apply(try XCTUnwrap(e.undo()).edits)
        XCTAssertEqual(buf.string, "")
    }

    func testACommandUndoesAsOneStepWhenFencedByBoundaries() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        let buf = MirrorBuffer("word")
        e.reset(buf.string)
        e.boundary()

        // Toggle bold: two insertions, one gesture.
        let edits = [
            TextEdit(range: NSRange(location: 0, length: 0), text: "**"),
            TextEdit(range: NSRange(location: 4, length: 0), text: "**"),
        ]
        buf.apply(edits)
        try e.apply(edits, documentLength: buf.length)
        XCTAssertEqual(buf.string, "**word**")

        buf.apply(try XCTUnwrap(e.undo()).edits)
        XCTAssertEqual(buf.string, "word", "both markers must come off together")
    }

    func testUndoRestoresTheCaretToWhereTheEditBegan() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        e.reset("abc")
        e.setSelection(NSRange(location: 3, length: 0))
        try e.apply(
            [TextEdit(range: NSRange(location: 3, length: 0), text: "def")],
            documentLength: 6
        )
        e.setSelection(NSRange(location: 0, length: 0)) // user clicks elsewhere

        let undo = try XCTUnwrap(e.undo())
        XCTAssertEqual(undo.selection, NSRange(location: 3, length: 0))
    }

    func testResetDropsHistoryBecauseItsOffsetsNoLongerDescribeTheDocument() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        e.reset("abc")
        try e.apply(
            [TextEdit(range: NSRange(location: 3, length: 0), text: "d")],
            documentLength: 4
        )
        XCTAssertTrue(e.canUndo)
        e.reset("something else")
        XCTAssertFalse(e.canUndo)
    }

    func testUndoOnAnEmptyHistoryIsNil() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        e.reset("abc")
        XCTAssertNil(e.undo())
        XCTAssertNil(e.redo())
    }

    // MARK: - Browsable history (DESIGN §9)

    func testTheTimelineListsRevisionsAndKeepsUndoneOnesVisible() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        e.reset("start\n")
        _ = try e.apply([TextEdit(range: NSRange(location: 5, length: 0), text: " one")],
                        documentLength: 10, now: 10_000)
        _ = try e.apply([TextEdit(range: NSRange(location: 9, length: 0), text: " two")],
                        documentLength: 14, now: 30_000)

        XCTAssertEqual(e.revisions().count, 2)
        XCTAssertEqual(e.historyPosition, 2)

        XCTAssertNotNil(e.undo())
        XCTAssertEqual(e.revisions().count, 2, "undoing must not erase the branch")
        XCTAssertEqual(e.historyPosition, 1, "only the position moves")
    }

    func testARevisionReportsWhatItDid() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        e.reset("hello world\n")
        _ = try e.apply([TextEdit(range: NSRange(location: 5, length: 6), text: "")],
                        documentLength: 6, now: 10_000)

        let last = try XCTUnwrap(e.revisions().last)
        XCTAssertEqual(last.kind, .delete)
        XCTAssertEqual(last.removed, 6)
        XCTAssertEqual(last.inserted, 0)
    }

    func testJumpingLandsWhereSteppingWould() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        e.reset("start\n")
        var states = ["start\n"]
        var text = "start\n"
        for (i, word) in [" one", " two", " three"].enumerated() {
            let at = (text as NSString).length
            _ = try e.apply([TextEdit(range: NSRange(location: at, length: 0), text: word)],
                            documentLength: at + word.count,
                            now: UInt64(i + 1) * 10_000)
            text += word
            states.append(text)
        }

        for target in [0, 3, 1, 2] {
            let rewind = try XCTUnwrap(e.jump(to: target), "jump to \(target)")
            // The host applies the rewind to its own buffer; one splice, however far.
            XCTAssertEqual(rewind.edits.count, 1)
            let edit = rewind.edits[0]
            let ns = NSMutableString(string: text)
            ns.replaceCharacters(in: edit.range, with: edit.text)
            text = ns as String
            XCTAssertEqual(text, states[target], "landing on \(target)")
            XCTAssertEqual(e.historyPosition, target)
        }
    }

    func testJumpingNowhereIsRefused() throws {
        let e = try XCTUnwrap(MarkdownEngine())
        e.reset("start\n")
        _ = try e.apply([TextEdit(range: NSRange(location: 5, length: 0), text: " one")],
                        documentLength: 10, now: 10_000)
        XCTAssertNil(e.jump(to: 1), "already there")
        XCTAssertNil(e.jump(to: 99), "out of range")
    }
}
