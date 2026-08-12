#if os(macOS)
import AppKit
import Darwin.Mach
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

    private struct EditMatrix: Decodable {
        let repetitions: Int
        let corpora: [String]
        let positions: [MatrixPosition]
        let edits: [MatrixEdit]
        let endurance: MatrixEndurance
    }

    private struct MatrixPosition: Decodable {
        let name: String
        let fraction: Double
    }

    private struct MatrixEdit: Decodable {
        let name: String
        let deleteUtf16: Int
        let text: String?
        let textPattern: String?
        let textUtf8Bytes: Int?

        var replacement: String {
            guard let bytes = textUtf8Bytes, let pattern = textPattern else { return text ?? "" }
            let repeated = String(repeating: pattern, count: bytes / pattern.utf8.count + 1)
            return String(decoding: repeated.utf8.prefix(bytes), as: UTF8.self)
        }
    }

    private struct MatrixEndurance: Decodable {
        let corpus: String
        let position: Double
        let operations: Int
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

    private func editMatrix() throws -> EditMatrix {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("benchmarks/edit-matrix.json")
        return try JSONDecoder().decode(EditMatrix.self, from: Data(contentsOf: url))
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

    private func percentile(_ samples: [Double], _ quantile: Double) -> Double {
        let sorted = samples.sorted()
        let index = Int(ceil(Double(sorted.count - 1) * quantile))
        return sorted[index]
    }

    private func residentMemoryBytes() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size
        )
        let status = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return status == KERN_SUCCESS ? info.phys_footprint : 0
    }

    private func enforceBudget(_ value: Double, environment key: String, metric: String) {
        guard ProcessInfo.processInfo.environment["MDE_BENCH_ENFORCE"] == "1",
              let raw = ProcessInfo.processInfo.environment[key],
              let budget = Double(raw)
        else { return }
        XCTAssertLessThanOrEqual(
            value,
            budget,
            "\(metric) \(String(format: "%.3f", value)) ms exceeded "
                + "\(String(format: "%.3f", budget)) ms budget"
        )
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

    private func makeDetachedEditor() -> MarkdownTextView {
        let editor = MarkdownTextView(manifest: HostExtensions.manifest)
        editor.widgetProvider = HostWidgets()
        editor.frame = NSRect(x: 0, y: 0, width: 600, height: 800)
        return editor
    }

    private func makeEditor() -> (NSWindow, MarkdownTextView) {
        let editor = makeDetachedEditor()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 800),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 600, height: 800))
        scroll.hasVerticalScroller = true
        scroll.documentView = editor
        window.contentView?.addSubview(scroll)
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
            let repetitionCount = iterations(for: c.text.utf8.count) + 1
            for _ in 0 ..< repetitionCount {
                // Load trials do not need a window. NSApplication retains native
                // windows longer than their Swift locals, so creating one per trial
                // polluted every later benchmark with dozens of live layout trees.
                autoreleasepool {
                    let fresh = makeDetachedEditor()
                    load = min(load, timed { fresh.setMarkdown(c.text) })
                    drainMainQueue()
                }
            }
            let (viewportWindow, editor) = makeEditor()
            load = min(load, timed { editor.setMarkdown(c.text) })
            let decorations = editor.decorations.count

            // TextKit 1's non-contiguous layout manager is the shipping path: opening a
            // document must lay out what is visible without visiting every paragraph.
            let viewport = timed {
                editor.layoutSubtreeIfNeeded()
                if let layoutManager = editor.layoutManager,
                   let textContainer = editor.textContainer {
                    let origin = editor.textContainerOrigin
                    let rect = editor.visibleRect.offsetBy(dx: -origin.x, dy: -origin.y)
                    layoutManager.ensureLayout(forBoundingRect: rect, in: textContainer)
                }
                // Large documents paint attributes on the next main-queue turn after
                // viewport layout. Include that work rather than timing an unpainted
                // viewport and calling it a renderer improvement.
                drainMainQueue()
            }

            // TextKit lays out lazily, so `setMarkdown` returning is not the same as the
            // document being on screen. A real editor only ever lays out the viewport,
            // but the full-document number is what a "jump to the end" costs, and it is
            // the term that decides whether a document is usable at all.
            let layout = timed {
                editor.layoutManager?.ensureLayout(
                    forCharacterRange: NSRange(location: 0, length: editor.string.utf16.count)
                )
            }

            print(String(
                format: "%-6@ setMarkdown %8.2f   viewport %8.2f   full layout %9.2f   decorations %d",
                c.label as NSString, load, viewport, layout, decorations
            ))
            if c.label == "1MB" {
                enforceBudget(
                    load,
                    environment: "MDE_APPLE_1MB_LOAD_BUDGET_MS",
                    metric: "1 MB native cold load"
                )
                enforceBudget(
                    viewport,
                    environment: "MDE_APPLE_1MB_VIEWPORT_BUDGET_MS",
                    metric: "1 MB initial viewport layout"
                )
                enforceBudget(
                    load + viewport,
                    environment: "MDE_APPLE_1MB_FIRST_PAINT_BUDGET_MS",
                    metric: "1 MB load through painted first viewport"
                )
            }
            withExtendedLifetime(viewportWindow) {}
            // Do not leave a full TextKit tree retained by NSApplication until the
            // benchmark process exits; later tests must not inherit its memory pressure.
            viewportWindow.contentView = nil
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
            enforceBudget(
                bestSync + bestRepaint,
                environment: "MDE_APPLE_\(c.label)_KEYSTROKE_BUDGET_MS",
                metric: "\(c.label) native keystroke"
            )
            _ = window
        }
    }

    func testBenchmarkPositionAndTailLatency() throws {
        let all = try corpora()
        guard let large = all.first(where: { $0.label == "1MB" }),
              let endurance = all.first(where: { $0.label == "100KB" })
        else { throw XCTSkip("position workloads require the 100KB and 1MB corpora") }

        print("\n=== positional and sustained native edits (ms) ===")
        for (label, fraction) in [("near start", 0.01), ("middle", 0.50), ("near end", 0.99)] {
            let (window, editor) = makeEditor()
            editor.setMarkdown(large.text)
            XCTAssertTrue(window.makeFirstResponder(editor))
            drainMainQueue()
            let storage = try XCTUnwrap(editor.textStorage)
            var at = Int(Double(storage.length) * fraction)
            var samples: [Double] = []
            for _ in 0..<7 {
                samples.append(timed {
                    storage.replaceCharacters(in: NSRange(location: at, length: 0), with: "x")
                    drainMainQueue()
                })
                at += 1
            }
            print(String(
                format: "1MB %-10@ p50 %8.2f   p95 %8.2f   max %8.2f",
                label as NSString,
                percentile(samples, 0.50),
                percentile(samples, 0.95),
                samples.max() ?? 0
            ))
            enforceBudget(
                percentile(samples, 0.95),
                environment: "MDE_APPLE_1MB_POSITION_EDIT_P95_BUDGET_MS",
                metric: "1 MB native \(label) edit p95"
            )
            _ = window
        }

        let (window, editor) = makeEditor()
        editor.setMarkdown(endurance.text)
        XCTAssertTrue(window.makeFirstResponder(editor))
        drainMainQueue()
        let storage = try XCTUnwrap(editor.textStorage)
        var at = storage.length / 2
        var sustained: [Double] = []
        for _ in 0..<200 {
            sustained.append(timed {
                storage.replaceCharacters(in: NSRange(location: at, length: 0), with: "x")
                drainMainQueue()
            })
            at += 1
        }
        print(String(
            format: "100KB sustained 200 edits p50 %8.2f   p95 %8.2f   max %8.2f",
            percentile(sustained, 0.50),
            percentile(sustained, 0.95),
            sustained.max() ?? 0
        ))
        enforceBudget(
            percentile(sustained, 0.95),
            environment: "MDE_APPLE_100KB_SUSTAINED_EDIT_P95_BUDGET_MS",
            metric: "100 KB native sustained edit p95"
        )
        _ = window
    }

    func testBenchmarkSharedEditMatrix() throws {
        let spec = try editMatrix()
        let memoryBefore = residentMemoryBytes()
        let available = Dictionary(uniqueKeysWithValues: try corpora().map { ($0.label, $0.text) })
        var allSamples = [Double]()
        print("\n=== shared edit matrix: AppKit (ms) ===")

        for label in spec.corpora {
            let source = try XCTUnwrap(available[label])
            var corpusSamples = [Double]()
            let (window, editor) = makeEditor()
            for position in spec.positions {
                for edit in spec.edits {
                    var samples = [Double]()
                    for _ in 0 ..< spec.repetitions {
                        autoreleasepool {
                            editor.setMarkdown(source)
                            drainMainQueue()
                            let storage = editor.textStorage!
                            let start = min(
                                Int(Double(storage.length) * position.fraction),
                                max(0, storage.length - edit.deleteUtf16)
                            )
                            let range = NSRange(
                                location: start,
                                length: min(edit.deleteUtf16, storage.length - start)
                            )
                            let expected = NSMutableString(string: source)
                            expected.replaceCharacters(in: range, with: edit.replacement)
                            let value = timed {
                                storage.replaceCharacters(in: range, with: edit.replacement)
                                drainMainQueue()
                            }
                            XCTAssertEqual(editor.markdown, expected as String)
                            samples.append(value)
                            corpusSamples.append(value)
                            allSamples.append(value)
                        }
                    }
                    print(String(
                        format: "  %-5@ %-7@ %-16@ p95 %8.2f",
                        label as NSString,
                        position.name as NSString,
                        edit.name as NSString,
                        percentile(samples, 0.95)
                    ))
                }
            }
            print(String(
                format: "  %-5@ all edits p95 %8.2f",
                label as NSString,
                percentile(corpusSamples, 0.95)
            ))
            window.contentView = nil
        }

        let enduranceSource = try XCTUnwrap(available[spec.endurance.corpus])
        let (window, editor) = makeEditor()
        editor.setMarkdown(enduranceSource)
        drainMainQueue()
        let expected = NSMutableString(string: enduranceSource)
        var endurance = [Double]()
        for index in 0 ..< spec.endurance.operations {
            let at = Int(Double(expected.length) * spec.endurance.position)
            let range = NSRange(location: at, length: index.isMultiple(of: 2) ? 0 : 1)
            let replacement = index.isMultiple(of: 2) ? "x" : ""
            expected.replaceCharacters(in: range, with: replacement)
            endurance.append(timed {
                editor.textStorage?.replaceCharacters(in: range, with: replacement)
                drainMainQueue()
            })
        }
        XCTAssertEqual(editor.markdown, expected as String)
        let matrixP95 = percentile(allSamples, 0.95)
        let enduranceP95 = percentile(endurance, 0.95)
        let memoryAfter = residentMemoryBytes()
        let memoryGrowth = memoryAfter > memoryBefore ? memoryAfter - memoryBefore : 0
        print(String(format: "  all matrix edits p95   %8.2f", matrixP95))
        print(String(format: "  100-edit endurance p95 %8.2f", enduranceP95))
        print("  matrix footprint growth   \(memoryGrowth) bytes")
        enforceBudget(
            matrixP95,
            environment: "MDE_APPLE_EDIT_MATRIX_P95_BUDGET_MS",
            metric: "AppKit shared edit matrix p95"
        )
        enforceBudget(
            enduranceP95,
            environment: "MDE_APPLE_EDIT_MATRIX_ENDURANCE_P95_BUDGET_MS",
            metric: "AppKit shared edit matrix endurance p95"
        )
        enforceBudget(
            Double(memoryGrowth),
            environment: "MDE_APPLE_EDIT_MATRIX_MEMORY_GROWTH_BUDGET_BYTES",
            metric: "AppKit shared edit matrix footprint growth"
        )
        _ = window
    }

    func testBenchmarkPluginLayerUpdate() throws {
        let all = try corpora()
        guard let large = all.first(where: { $0.label == "1MB" }) else {
            throw XCTSkip("plugin-layer workload requires the 1MB corpus")
        }

        let (window, editor) = makeEditor()
        var theme = editor.theme
        theme.extensionRoles["benchmark-plugin"] = [.backgroundColor: NSColor.systemYellow]
        editor.theme = theme
        editor.setMarkdown(large.text)
        drainMainQueue()
        let role = editor.internRole("benchmark-plugin")
        let first = large.text.utf16.count / 4
        let second = first * 3
        var flip = false
        let update = best(20) {
            flip.toggle()
            let start = flip ? first : second
            editor.setLayer(
                "benchmark-plugin",
                [LayerSpan(range: NSRange(location: start, length: 5), role: role)]
            )
            drainMainQueue()
        }
        print(String(format: "1MB one-span plugin layer %8.3f ms", update))
        enforceBudget(
            update,
            environment: "MDE_APPLE_1MB_LAYER_BUDGET_MS",
            metric: "1 MB native one-span plugin layer"
        )
        _ = window
    }

    func testBenchmarkGiantUnicodeParagraph() throws {
        guard ProcessInfo.processInfo.environment["MDE_BENCH"] != nil else {
            throw XCTSkip("set MDE_BENCH=1 to run the renderer benchmarks")
        }
        let source = String(repeating: "word **strong** @same résumé 日本語 🎉 ", count: 1_700)
        let (window, editor) = makeEditor()
        editor.setMarkdown(source)
        XCTAssertTrue(window.makeFirstResponder(editor))
        drainMainQueue()
        let at = editor.string.utf16.count / 2
        editor.setSelectedRange(NSRange(location: at, length: 0))
        editor.scrollRangeToVisible(NSRange(location: at, length: 0))
        drainMainQueue()
        var samples: [(total: Double, input: Double, display: Double)] = []
        for offset in 0 ..< 5 {
            var input = 0.0
            var display = 0.0
            let total = timed {
                input = timed {
                    editor.insertText(
                        "x",
                        replacementRange: NSRange(location: at + offset, length: 0)
                    )
                }
                display = timed { drainMainQueue() }
            }
            samples.append((total, input, display))
        }
        let totals = samples.map(\.total)
        let p95 = percentile(totals, 0.95)
        let slowest = samples.max(by: { $0.total < $1.total })!
        print(String(
            format: "64KB no-newline Unicode paragraph p50 %8.3f p95 %8.3f ms",
            percentile(totals, 0.50),
            p95
        ))
        print(String(
            format: "  slowest input %8.3f ms  display %8.3f ms",
            slowest.input,
            slowest.display
        ))
        XCTAssertLessThanOrEqual(
            p95,
            250,
            "64 KB AppKit pathological edit must stay perceptibly interactive"
        )
        enforceBudget(
            p95,
            environment: "MDE_APPLE_GIANT_PARAGRAPH_BUDGET_MS",
            metric: "64 KB native no-newline Unicode paragraph edit p95"
        )
        _ = window
    }

    func testBenchmarkCoreOnlyGiantUnicodeParagraph() throws {
        guard ProcessInfo.processInfo.environment["MDE_BENCH"] != nil else {
            throw XCTSkip("set MDE_BENCH=1 to run the renderer benchmarks")
        }
        let source = String(repeating: "word **strong** @same résumé 日本語 🎉 ", count: 1_700)
        let engine = try XCTUnwrap(MarkdownEngine(manifest: HostExtensions.manifest))
        _ = engine.reset(source)
        let at = source.utf16.count / 2
        let expectedLength = source.utf16.count + 1
        _ = engine.setSelection(NSRange(location: at, length: 0))
        let update = timed {
            _ = try! engine.apply(
                [TextEdit(range: NSRange(location: at, length: 0), text: "x")],
                documentLength: expectedLength
            )
        }
        print(String(format: "64KB no-newline Unicode paragraph core only %8.3f ms", update))
        XCTAssertLessThanOrEqual(update, 50, "the shared core should leave AppKit headroom")
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
                    + "  patch: %d added, %d removed, %d shifted, %d moved;"
                    + " furthest add/remove %d chars from the caret",
                dirtyChars, ns.length, dirty.count,
                patch.added.count, patch.removed.count, patch.shifted.count, patch.moved.count,
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
            editor.layoutManager?.ensureLayout(
                forCharacterRange: NSRange(location: 0, length: editor.string.utf16.count)
            )
        }
        print(String(format: "100x10 table projection %8.2f ms", projection))
        enforceBudget(
            projection,
            environment: "MDE_APPLE_TABLE_BUDGET_MS",
            metric: "100x10 native table projection"
        )
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
        enforceBudget(
            lookup,
            environment: "MDE_APPLE_RESOURCE_LOOKUP_BUDGET_MS",
            metric: "10k-resource lookup"
        )
    }

    func testBenchmarkRepeatedLifecycle() throws {
        guard ProcessInfo.processInfo.environment["MDE_BENCH_LIFECYCLE"] == "1" else {
            throw XCTSkip("set MDE_BENCH_LIFECYCLE=1 to run lifecycle benchmarks")
        }
        let source = String(
            repeating: "# Journal\n\n**Rendered** entry with [link](https://example.dev) and 日本語 🎉.\n\n",
            count: 1_400
        )
        let memoryBefore = residentMemoryBytes()
        var maximum = 0.0
        for cycle in 0 ..< 30 {
            autoreleasepool {
                let (window, editor) = makeEditor()
                maximum = max(maximum, timed {
                    editor.setMarkdown(source)
                    let storage = editor.textStorage!
                    let at = storage.length / 2
                    storage.replaceCharacters(in: NSRange(location: at, length: 0), with: "x")
                    editor.scrollRangeToVisible(NSRange(location: storage.length - 1, length: 0))
                    drainMainQueue()
                })
                window.contentView = nil
                if cycle.isMultiple(of: 10) { drainMainQueue() }
            }
        }
        let memoryGrowth = max(0, residentMemoryBytes() - memoryBefore)
        print(String(
            format: "30-cycle native lifecycle max %8.2f ms memory growth %lld bytes",
            maximum, memoryGrowth
        ))
        enforceBudget(
            maximum,
            environment: "MDE_APPLE_LIFECYCLE_OPERATION_BUDGET_MS",
            metric: "native lifecycle operation"
        )
        if let raw = ProcessInfo.processInfo.environment["MDE_APPLE_LIFECYCLE_MEMORY_GROWTH_BUDGET_BYTES"],
           let budget = UInt64(raw) {
            XCTAssertLessThanOrEqual(memoryGrowth, budget)
        }
    }

}

/// Runs in its own test process from the performance script. The large-document suite
/// intentionally forces several gigabytes of transient TextKit allocations; measuring
/// media creation after that prices allocator pressure from unrelated workloads rather
/// than the journal a user opened.
final class MacMediaRendererBenchmarks: XCTestCase {
    private func timed(_ body: () -> Void) -> Double {
        let start = DispatchTime.now().uptimeNanoseconds
        body()
        return Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
    }

    private func drainMainQueue() {
        var done = false
        DispatchQueue.main.async { done = true }
        while !done {
            _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
        }
    }

    private func enforceBudget(_ value: Double, environment key: String, metric: String) {
        guard ProcessInfo.processInfo.environment["MDE_BENCH_ENFORCE"] == "1",
              let raw = ProcessInfo.processInfo.environment[key],
              let budget = Double(raw)
        else { return }
        XCTAssertLessThanOrEqual(
            value,
            budget,
            "\(metric) \(String(format: "%.3f", value)) ms exceeded "
                + "\(String(format: "%.3f", budget)) ms budget"
        )
    }

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
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 600, height: 800))
        scroll.hasVerticalScroller = true
        scroll.documentView = editor
        window.contentView?.addSubview(scroll)
        return (window, editor)
    }

    func testBenchmarkMediaJournalProjection() throws {
        guard ProcessInfo.processInfo.environment["MDE_BENCH"] != nil else {
            throw XCTSkip("set MDE_BENCH=1 to run the renderer benchmarks")
        }
        let source = mediaJournalSource()
        let resolver = MediaJournalResolver()
        let (window, editor) = makeEditor()
        editor.resourceResolver = resolver

        let ready = timed {
            editor.setMarkdown(source)
            editor.layoutManager?.ensureLayout(
                forCharacterRange: NSRange(location: 0, length: editor.string.utf16.count)
            )
            editor.layoutWidgetOverlays()
            drainMainQueue()
        }
        let storage = try XCTUnwrap(editor.textStorage)
        let editAt = (storage.string as NSString).range(of: "Closing reflection").location
        let edit = timed {
            storage.replaceCharacters(in: NSRange(location: editAt, length: 0), with: "x")
            drainMainQueue()
        }
        let scroll = timed {
            editor.scrollRangeToVisible(NSRange(location: max(0, storage.length - 1), length: 0))
            editor.layoutSubtreeIfNeeded()
            drainMainQueue()
        }

        print(String(
            format: "320-resource media journal ready %8.2f edit %8.2f scroll %8.2f ms views %d",
            ready, edit, scroll, resolver.requested.count
        ))
        enforceBudget(
            ready,
            environment: "MDE_APPLE_MEDIA_JOURNAL_READY_BUDGET_MS",
            metric: "320-resource native media journal render"
        )
        enforceBudget(
            edit,
            environment: "MDE_APPLE_MEDIA_JOURNAL_EDIT_BUDGET_MS",
            metric: "native edit after 320 media resources"
        )
        enforceBudget(
            scroll,
            environment: "MDE_APPLE_MEDIA_JOURNAL_SCROLL_BUDGET_MS",
            metric: "native media journal scroll"
        )
        XCTAssertEqual(resolver.requested.count, 320)
        XCTAssertEqual(resolver.images, 240)
        XCTAssertEqual(resolver.videos, 32)
        XCTAssertEqual(resolver.audio, 48)
        XCTAssertEqual(editor.markdown, source.replacingOccurrences(
            of: "Closing reflection", with: "xClosing reflection"
        ))
        _ = window
    }

    private func mediaJournalSource() -> String {
        var entries = [String]()
        func append(_ kind: String, count: Int, extension ext: String) {
            for index in 1...count {
                entries.append("""
                ### \(kind) \(index)

                A journal paragraph around \(kind.lowercased()) \(index), with **context**, a [reference](https://example.dev/\(kind.lowercased())/\(index)), and a timestamp.

                ![\(kind) \(index)](journal/\(kind.lowercased())-\(index).\(ext))
                """)
            }
        }
        append("Photo", count: 240, extension: "jpg")
        append("Video", count: 32, extension: "mp4")
        append("Audio", count: 48, extension: "m4a")
        return "# Media journal\n\n" + entries.joined(separator: "\n\n")
            + "\n\nClosing reflection.\n"
    }
}

private final class MediaJournalResolver: ResourceResolver {
    private(set) var requested = [String]()
    private(set) var images = 0
    private(set) var videos = 0
    private(set) var audio = 0

    func resolve(
        _ request: ResourceRequest,
        deliver _: @escaping (ResourceState) -> Void
    ) -> ResourceState {
        requested.append(request.reference)
        let ext = (request.reference as NSString).pathExtension.lowercased()
        let kind: MediaJournalView.Kind
        switch ext {
        case "mp4":
            videos += 1
            kind = .video
        case "m4a":
            audio += 1
            kind = .audio
        default:
            images += 1
            kind = .image
        }
        return .ready(MediaJournalView(kind: kind, maxWidth: request.fittingWidth))
    }

    func reservedSize(_ request: ResourceRequest) -> CGSize {
        let width = min(max(request.fittingWidth, 1), 640)
        if request.reference.hasSuffix(".m4a") {
            return CGSize(width: width, height: 54)
        }
        return CGSize(width: width, height: width * 9 / 16)
    }
}

private final class MediaJournalView: NSView {
    enum Kind { case image, video, audio }
    private let target: CGSize

    init(kind: Kind, maxWidth: CGFloat) {
        let width = min(max(maxWidth, 1), 640)
        target = kind == .audio
            ? CGSize(width: width, height: 54)
            : CGSize(width: width, height: width * 9 / 16)
        super.init(frame: CGRect(origin: .zero, size: target))

        switch kind {
        case .image:
            let image = NSImageView(frame: bounds)
            image.image = NSImage(size: NSSize(width: 16, height: 9))
            image.imageScaling = .scaleProportionallyUpOrDown
            addSubview(image)
        case .video:
            wantsLayer = true
            layer?.backgroundColor = NSColor.black.cgColor
            let play = NSButton(
                image: NSImage(systemSymbolName: "play.circle.fill", accessibilityDescription: nil)
                    ?? NSImage(),
                target: nil,
                action: nil
            )
            play.frame = CGRect(x: target.width / 2 - 18, y: target.height / 2 - 18, width: 36, height: 36)
            addSubview(play)
            let scrubber = NSSlider(frame: CGRect(x: 16, y: 12, width: target.width - 32, height: 20))
            addSubview(scrubber)
        case .audio:
            let play = NSButton(
                image: NSImage(systemSymbolName: "play.fill", accessibilityDescription: nil)
                    ?? NSImage(),
                target: nil,
                action: nil
            )
            play.frame = CGRect(x: 8, y: 9, width: 36, height: 36)
            addSubview(play)
            addSubview(NSSlider(frame: CGRect(x: 52, y: 17, width: target.width - 64, height: 20)))
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    override var intrinsicContentSize: NSSize { target }
}
#endif
