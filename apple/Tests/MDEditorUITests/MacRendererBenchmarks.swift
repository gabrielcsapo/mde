#if os(macOS)
import AppKit
import MDECore
import MDEHost
import XCTest
@testable import MDEditorUI

/// The renderer half of the per-keystroke budget, measured on the real AppKit host.
///
/// DESIGN §2.2 asserts that parsing is cheap and "renderer mutation" is the real cost.
/// The core benchmark (`cargo run --release --example bench -p mde-core`) prices the
/// first half; this prices the second, on the same documents, so the two can be added
/// into one end-to-end number. That only works if both layers measure the same bytes,
/// which is why the corpus is generated once by the Rust benchmark and read here rather
/// than regenerated in Swift.
///
/// ```text
/// cargo run --release --example bench -p mde-core -- --dump target/bench-corpus
/// cd apple && MDE_BENCH=1 swift test --filter MacRendererBenchmarks
/// ```
///
/// Off by default: these take minutes and allocate gigabytes, which is not something an
/// ordinary `swift test` should do. `MDE_BENCH_MAX_BYTES` raises the 1 MB ceiling — the
/// 5 MB corpus is opt-in because a full TextKit layout over it is measured in minutes,
/// not milliseconds.
///
/// Note `swift test` builds the Swift side unoptimised unless `-c release` is passed.
/// Attribute application is mostly time in Foundation and AppKit, which are optimised
/// either way, but the numbers are an upper bound; the report says which mode produced
/// them.
final class MacRendererBenchmarks: XCTestCase {
    // MARK: - Corpus

    private struct Corpus {
        let label: String
        let text: String
    }

    /// Written by `cargo run --release --example bench -p mde-core -- --dump <dir>`.
    private static let corpusDir: String = {
        if let override = ProcessInfo.processInfo.environment["MDE_BENCH_CORPUS"] {
            return override
        }
        // Tests/MDEditorUITests/<this file> -> repo root
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("target/bench-corpus")
            .path
    }()

    private func corpora() throws -> [Corpus] {
        guard ProcessInfo.processInfo.environment["MDE_BENCH"] != nil else {
            throw XCTSkip("set MDE_BENCH=1 to run the renderer benchmarks")
        }
        let ceiling = ProcessInfo.processInfo.environment["MDE_BENCH_MAX_BYTES"]
            .flatMap(Int.init) ?? 1_100_000

        var out: [Corpus] = []
        for label in ["10KB", "100KB", "500KB", "1MB", "5MB"] {
            let path = "\(Self.corpusDir)/\(label).md"
            guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
            guard text.utf8.count <= ceiling else { continue }
            out.append(Corpus(label: label, text: text))
        }
        guard !out.isEmpty else {
            throw XCTSkip(
                "no corpus in \(Self.corpusDir) — run the Rust benchmark with --dump first"
            )
        }
        return out
    }

    // MARK: - Timing

    /// Milliseconds, matching the core benchmark's units so the two tables add up.
    private func timed(_ body: () -> Void) -> Double {
        let start = DispatchTime.now().uptimeNanoseconds
        body()
        return Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
    }

    /// Minimum over `iterations`, discarding one warm-up. The minimum rather than the
    /// mean because AppKit's first touch of a font or a paragraph style is a one-time
    /// cost that would otherwise be charged to every size equally.
    private func best(_ iterations: Int, _ body: () -> Void) -> Double {
        _ = timed(body)
        var best = Double.greatestFiniteMagnitude
        for _ in 0 ..< iterations { best = min(best, timed(body)) }
        return best
    }

    private func iterations(for bytes: Int) -> Int {
        switch bytes {
        case ..<200_000: 20
        case ..<600_000: 8
        default: 3
        }
    }

    /// Runs the main queue until everything already enqueued has executed.
    ///
    /// `MarkdownTextView` hands the patch back to itself with `DispatchQueue.main.async`
    /// — repainting inside the storage delegate would re-enter it — so the repaint half
    /// of a keystroke has not happened yet when `replaceCharacters` returns. A benchmark
    /// that stopped the clock there would report the cheap half and call it the total.
    private func drainMainQueue() {
        var done = false
        DispatchQueue.main.async { done = true }
        while !done {
            _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
        }
    }

    // MARK: - Fixtures

    private func makeEditor() -> (NSWindow, MarkdownTextView) {
        let editor = MarkdownTextView(manifest: HostExtensions.manifest)
        editor.widgetProvider = HostWidgets()
        editor.frame = NSRect(x: 0, y: 0, width: 600, height: 800)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 800),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView?.addSubview(editor)
        return (window, editor)
    }

    // MARK: - Cold load

    func testBenchmarkColdLoad() throws {
        let all = try corpora()
        print("\n=== setMarkdown, cold load (ms, min) ===")
        for c in all {
            // A fresh editor per repetition, not one editor loaded repeatedly. Reloading
            // the same text into the same editor does not repeat the work: `setMarkdown`
            // clears the applier and then ingests `Engine::reset`'s patch, and that patch
            // is empty when the text is unchanged, so every repetition after the first
            // would paint nothing and be timed as if loading were free.
            var load = Double.greatestFiniteMagnitude
            var decorations = 0
            var editor: MarkdownTextView!
            var windows: [NSWindow] = []
            for _ in 0 ... iterations(for: c.text.utf8.count) {
                let (window, fresh) = makeEditor()
                windows.append(window)
                load = min(load, timed { fresh.setMarkdown(c.text) })
                decorations = fresh.decorations.count
                editor = fresh
            }

            // TextKit lays out lazily, so `setMarkdown` returning is not the same as the
            // document being on screen. A real editor only ever lays out the viewport,
            // but the full-document number is what a "jump to the end" costs, and it is
            // the term that decides whether a document is usable at all.
            let layout = timed {
                let cs = editor.contentStorage
                cs.textLayoutManagers.first?.ensureLayout(for: cs.documentRange)
            }

            print(String(
                format: "%-6@ setMarkdown %8.2f   full TextKit layout %9.2f   decorations %d",
                c.label as NSString, load, layout, decorations
            ))
            windows.removeAll()
        }
    }

    // MARK: - Keystroke

    func testBenchmarkKeystroke() throws {
        let all = try corpora()
        print("\n=== one character inserted mid-document (ms, min) ===")
        print("storage = NSTextStorage.replaceCharacters through the delegate to engine.apply")
        print("repaint = the deferred half: dirtyRange + ingest + DecorationApplier.repaint\n")

        for c in all {
            let (window, editor) = makeEditor()
            editor.setMarkdown(c.text)
            XCTAssertTrue(window.makeFirstResponder(editor))
            drainMainQueue()

            let storage = editor.textStorage!
            var at = storage.length / 2
            let n = iterations(for: c.text.utf8.count)

            var bestSync = Double.greatestFiniteMagnitude
            var bestRepaint = Double.greatestFiniteMagnitude
            for _ in 0 ... n {
                at += 1
                let sync = timed {
                    storage.replaceCharacters(in: NSRange(location: at, length: 0), with: "x")
                }
                let repaint = timed { drainMainQueue() }
                bestSync = min(bestSync, sync)
                bestRepaint = min(bestRepaint, repaint)
            }

            print(String(
                format: "%-6@  storage %8.2f   repaint %8.2f   total %8.2f",
                c.label as NSString, bestSync, bestRepaint, bestSync + bestRepaint
            ))
            _ = window
        }
    }

    // MARK: - Repaint scope

    /// DESIGN §7 claims a keystroke repaints a paragraph, not the document, because
    /// `moved` entries are left out of the dirty range. That is a claim about how the
    /// cost grows, so it has to be checked at a size where the two answers differ by
    /// orders of magnitude rather than by noise.
    func testBenchmarkRepaintScopeAndDirtyRange() throws {
        let all = try corpora()
        print("\n=== DecorationApplier.repaint: one paragraph vs whole document (ms, min) ===")
        for c in all {
            let engine = try XCTUnwrap(MarkdownEngine(manifest: HostExtensions.manifest))
            let theme = Theme()
            let applier = DecorationApplier(engine: engine, theme: theme)
            let storage = NSTextStorage(string: c.text, attributes: theme.baseAttributes)
            applier.ingest(engine.reset(c.text))

            let ns = storage.string as NSString
            let whole = NSRange(location: 0, length: ns.length)
            let mid = ns.paragraphRange(for: NSRange(location: ns.length / 2, length: 0))
            let n = iterations(for: c.text.utf8.count)

            let paragraph = best(n) { applier.repaint(mid, in: storage) }
            let document = best(max(1, n / 4)) { applier.repaint(whole, in: storage) }

            // The measurement that decides whether the rule in DESIGN §7 actually holds:
            // how wide is the dirty range a real keystroke produces, and how much of the
            // patch was absorbed as `moved` rather than becoming repaint work?
            //
            // Excluding `moved` is only half of what the rule needs. `dirtyRange` unions
            // `added` and `removed` as *disjoint* ranges. It used to union them into one
            // bounding box, so two entries at opposite ends of the document produced a
            // dirty range covering everything between them — the measurement that
            // prompted the fix. The distance between the outermost add/remove is still
            // printed, so a regression back to a bounding box would show up immediately
            // as dirty chars tracking that distance rather than staying small.
            let caret = ns.length / 2
            let edit = TextEdit(range: NSRange(location: caret, length: 0), text: "x")
            let patch = try engine.apply([edit], documentLength: ns.length + 1)
            let dirty = applier.dirtyRanges(for: patch, alsoDirty: NSRange(location: caret, length: 1))
            let dirtyChars = dirty.reduce(0) { $0 + $1.length }

            // `live` still holds the pre-edit set — the patch has not been ingested — so
            // a removed key resolves to the range it used to occupy, exactly as
            // `dirtyRanges` resolves it.
            let touched = patch.added.map(\.range) + patch.removed.compactMap { applier.live[$0]?.range }
            let furthest = touched.map { abs($0.location - caret) }.max() ?? 0

            print(String(
                format: "%-6@  paragraph %8.3f (%d chars)   document %9.2f (%d chars)",
                c.label as NSString, paragraph, mid.length, document, whole.length
            ))
            print(String(
                format: "        keystroke repaints %d chars of %d across %d range(s);"
                    + "  patch: %d added, %d removed, %d moved;"
                    + " furthest add/remove %d chars from the caret",
                dirtyChars, ns.length, dirty.count,
                patch.added.count, patch.removed.count, patch.moved.count,
                furthest
            ))
            // When the dirty range is far wider than the paragraph the caret is in, the
            // entries that stretched it are worth naming: this is the difference between
            // an O(paragraph) keystroke and an O(document) one, and knowing *which* node
            // moved out of the caret's neighbourhood is the whole diagnosis.
            if dirtyChars > mid.length * 10 {
                for d in patch.added {
                    print("          added   \(engine.roleName(d.role) ?? "#\(d.role)") "
                        + "at \(d.range.location) (+\(d.range.location - caret)): "
                        + "\(ns.substring(with: NSIntersectionRange(d.range, whole)).debugDescription)")
                }
                for key in patch.removed {
                    guard let d = applier.live[key] else { continue }
                    print("          removed \(engine.roleName(d.role) ?? "#\(d.role)") "
                        + "at \(d.range.location) (+\(d.range.location - caret))")
                }
            }
        }
    }

    func testBenchmarkLargeTableProjection() throws {
        guard ProcessInfo.processInfo.environment["MDE_BENCH"] != nil else {
            throw XCTSkip("set MDE_BENCH=1 to run the renderer benchmarks")
        }
        let columns = (0..<10).map { "C\($0)" }
        let rows = (0..<100).map { row in
            "| " + columns.indices.map { "r\(row)c\($0)" }.joined(separator: " | ") + " |"
        }
        let source = "| " + columns.joined(separator: " | ") + " |\n"
            + "| " + columns.map { _ in "---" }.joined(separator: " | ") + " |\n"
            + rows.joined(separator: "\n") + "\n"
        let (window, editor) = makeEditor()
        let projection = timed {
            editor.setMarkdown(source)
            editor.contentStorage.textLayoutManagers.first?.ensureLayout(
                for: editor.contentStorage.documentRange
            )
        }
        print(String(format: "100x10 table projection %8.2f ms", projection))
        XCTAssertEqual(editor.markdown, source)
        _ = window
    }

    func testBenchmarkResourceReferenceLookup() throws {
        guard ProcessInfo.processInfo.environment["MDE_BENCH"] != nil else {
            throw XCTSkip("set MDE_BENCH=1 to run the renderer benchmarks")
        }
        let count = 10_000
        let source = (0..<count).map { "![\($0)](asset-\($0).png)" }.joined(separator: "\n") + "\n"
        let engine = try XCTUnwrap(MarkdownEngine(manifest: nil))
        let applier = DecorationApplier(engine: engine, theme: Theme())
        applier.ingest(engine.reset(source))

        let target = "asset-\(count - 1).png"
        XCTAssertEqual(applier.ranges(referencing: target).count, 1) // warm the position index
        let lookup = best(500) {
            XCTAssertEqual(applier.ranges(referencing: target).count, 1)
        }
        print(String(format: "10k-resource indexed lookup %8.4f ms", lookup))
    }
}
#endif
