import MDEditorUI
import UIKit

/// Simulator-side performance workloads for the real UIKit renderer.
///
/// These run in the reference app because SwiftPM cannot host UIKit tests on macOS.
/// The result file is consumed by `scripts/test-ios-performance.sh`, which owns the
/// budgets. Codec and network costs remain the responsibility of the embedding app.
enum PerformanceTestMode {
    private struct EditSample {
        let total: Double
        let synchronous: Double
    }
    static var isEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--mde-performance-tests")
    }

    static func run(_ editor: MarkdownTextView) {
        guard isEnabled else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            runStandardWorkloads(editor) { standardMetrics, standardChecks in
                runMediaJournal(editor) { mediaMetrics, mediaChecks in
                    finish(
                        metrics: standardMetrics.merging(mediaMetrics) { _, latest in latest },
                        checks: standardChecks.merging(mediaChecks) { _, latest in latest }
                    )
                }
            }
        }
    }

    private static func runStandardWorkloads(
        _ editor: MarkdownTextView,
        completion: @escaping ([String: Double], [String: Bool]) -> Void
    ) {
        let source = standardCorpus(bytes: 1_000_000)
        editor.resourceResolver = nil
        let loadStart = DispatchTime.now().uptimeNanoseconds
        editor.setMarkdown(source)
        let load = elapsed(since: loadStart)

        // `setMarkdown` schedules viewport painting for large documents. Cross one
        // main-queue boundary so first paint includes the work users wait to see.
        DispatchQueue.main.async {
            editor.layoutIfNeeded()
            let firstPaint = elapsed(since: loadStart)
            let expected = NSMutableString(string: source)
            runEdits(editor, fractions: [0.01, 0.50, 0.99, 0.01, 0.50, 0.99], expected: expected) {
                editSamples in
                let standardPreserved = editor.markdown == expected as String
                runPathologicalWorkload(editor) { pathologicalSamples, pathologicalPreserved in
                    runTableWorkload(editor) { tableReady, tableSync, tablePreserved, tableScrolls in
                        completion(
                            [
                                "standardLoadMs": load,
                                "standardFirstPaintMs": firstPaint,
                                "standardEditP95Ms": percentile(editSamples.map(\.total), 0.95),
                                "pathologicalEditP95Ms": percentile(
                                    pathologicalSamples.map(\.total), 0.95
                                ),
                                "pathologicalEditSyncP95Ms": percentile(
                                    pathologicalSamples.map(\.synchronous), 0.95
                                ),
                                "pathologicalEditDeferredP95Ms": percentile(
                                    pathologicalSamples.map { $0.total - $0.synchronous }, 0.95
                                ),
                                "tableReadyMs": tableReady,
                                "tableSyncMs": tableSync,
                                "tableDeferredMs": tableReady - tableSync,
                            ],
                            [
                                "standardSourcePreserved": standardPreserved,
                                "pathologicalSourcePreserved": pathologicalPreserved,
                                "tableSourcePreserved": tablePreserved,
                                "wideTableScrollsHorizontally": tableScrolls,
                            ]
                        )
                    }
                }
            }
        }
    }

    private static func runEdits(
        _ editor: MarkdownTextView,
        fractions: [Double],
        expected: NSMutableString,
        samples: [EditSample] = [],
        completion: @escaping ([EditSample]) -> Void
    ) {
        guard let fraction = fractions.first else {
            completion(samples)
            return
        }
        let at = min(editor.textStorage.length, Int(Double(editor.textStorage.length) * fraction))
        let start = DispatchTime.now().uptimeNanoseconds
        editor.textStorage.replaceCharacters(in: NSRange(location: at, length: 0), with: "x")
        let synchronous = elapsed(since: start)
        expected.insert("x", at: at)
        DispatchQueue.main.async {
            editor.layoutIfNeeded()
            runEdits(
                editor,
                fractions: Array(fractions.dropFirst()),
                expected: expected,
                samples: samples + [EditSample(
                    total: elapsed(since: start),
                    synchronous: synchronous
                )],
                completion: completion
            )
        }
    }

    private static func runPathologicalWorkload(
        _ editor: MarkdownTextView,
        completion: @escaping ([EditSample], Bool) -> Void
    ) {
        let source = String(repeating: "word **strong** @same résumé 日本語 🎉 ", count: 850)
        editor.setMarkdown(source)
        DispatchQueue.main.async {
            let expected = NSMutableString(string: source)
            runEdits(
                editor,
                fractions: [0.50, 0.50, 0.50, 0.50, 0.50],
                expected: expected
            ) { samples in
                completion(samples, editor.markdown == expected as String)
            }
        }
    }

    private static func runTableWorkload(
        _ editor: MarkdownTextView,
        completion: @escaping (Double, Double, Bool, Bool) -> Void
    ) {
        let header = "| " + (1...10).map { "Column \($0)" }.joined(separator: " | ") + " |\n"
        let separator = "| " + Array(repeating: "---", count: 10).joined(separator: " | ") + " |\n"
        let rows = (1...100).map { row in
            "| " + (1...10).map { "r\(row)c\($0)" }
                .joined(separator: " | ") + " |"
        }.joined(separator: "\n")
        let source = header + separator + rows
        let start = DispatchTime.now().uptimeNanoseconds
        editor.setMarkdown(source)
        let synchronous = elapsed(since: start)
        DispatchQueue.main.async {
            editor.layoutIfNeeded()
            let table = descendants(of: editor).first {
                $0.accessibilityIdentifier == "mde.rendered-table"
            }
            let scrolls = table.map { table in
                descendants(of: table).compactMap { $0 as? UIScrollView }.contains {
                    $0.contentSize.width > $0.bounds.width + 1
                }
            } ?? false
            completion(
                elapsed(since: start),
                synchronous,
                editor.markdown == source,
                scrolls
            )
        }
    }

    private static func runMediaJournal(
        _ editor: MarkdownTextView,
        completion: @escaping ([String: Double], [String: Bool]) -> Void
    ) {
        let source = mediaJournalSource()
        let resolver = MediaJournalResolver()
        editor.resourceResolver = resolver
        editor.setContentOffset(
            CGPoint(x: 0, y: -editor.adjustedContentInset.top),
            animated: false
        )
        let readyStart = DispatchTime.now().uptimeNanoseconds
        editor.setMarkdown(source)
        let resolvedBeforeFullLayout = resolver.requested.count
        editor.layoutManager.ensureLayout(
            forCharacterRange: NSRange(location: 0, length: editor.textStorage.length)
        )
        editor.layoutIfNeeded()
        let ready = elapsed(since: readyStart)

        let editAt = (editor.textStorage.string as NSString)
            .range(of: "Closing reflection").location
        let editStart = DispatchTime.now().uptimeNanoseconds
        editor.textStorage.replaceCharacters(in: NSRange(location: editAt, length: 0), with: "x")
        DispatchQueue.main.async {
            editor.layoutIfNeeded()
            let edit = elapsed(since: editStart)
            let scrollStart = DispatchTime.now().uptimeNanoseconds
            let bottom = max(
                -editor.adjustedContentInset.top,
                editor.contentSize.height - editor.bounds.height + editor.adjustedContentInset.bottom
            )
            editor.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
            editor.layoutIfNeeded()
            DispatchQueue.main.async {
                editor.layoutIfNeeded()
                completion(
                    [
                        "mediaReadyMs": ready,
                        "mediaEditMs": edit,
                        "mediaScrollMs": elapsed(since: scrollStart),
                        "mediaContentHeight": editor.contentSize.height,
                        "mediaViewCount": Double(descendants(of: editor).count),
                        "mediaInitialResolvedCount": Double(resolvedBeforeFullLayout),
                    ],
                    [
                        "mediaSourcePreserved": editor.markdown == source.replacingOccurrences(
                            of: "Closing reflection", with: "xClosing reflection"
                        ),
                        "mediaResolvedVisible": !resolver.requested.isEmpty,
                        "mediaInitialResolutionIsLazy": resolvedBeforeFullLayout < 72,
                        "mediaResolved72AfterFullLayout": resolver.requested.count == 72,
                        "mediaImages48": resolver.images == 48,
                        "mediaVideos8": resolver.videos == 8,
                        "mediaAudio16": resolver.audio == 16,
                        "mediaKindsConsistent": resolver.images + resolver.videos
                            + resolver.audio == resolver.requested.count,
                    ]
                )
            }
        }
    }

    private static func elapsed(since start: UInt64) -> Double {
        Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
    }

    private static func percentile(_ samples: [Double], _ quantile: Double) -> Double {
        let sorted = samples.sorted()
        let index = Int(ceil(Double(sorted.count - 1) * quantile))
        return sorted[index]
    }

    private static func standardCorpus(bytes: Int) -> String {
        let paragraph = """
        ## Journal entry

        A paragraph with **strong text**, _emphasis_, `code`, @gabe, and a [link](https://example.dev).

        - one item
        - another item
        - [x] completed

        > A quoted reflection with ~~old words~~ and new ones.

        """
        let repeated = String(repeating: paragraph, count: bytes / paragraph.utf8.count + 1)
        return String(repeated.prefix(bytes))
    }

    private static func mediaJournalSource() -> String {
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
        append("Photo", count: 48, extension: "jpg")
        append("Video", count: 8, extension: "mp4")
        append("Audio", count: 16, extension: "m4a")
        return "# Media journal\n\n" + entries.joined(separator: "\n\n")
            + "\n\nClosing reflection.\n"
    }

    private static func descendants(of root: UIView) -> [UIView] {
        root.subviews.flatMap { [$0] + descendants(of: $0) }
    }

    private static func finish(metrics: [String: Double], checks: [String: Bool]) {
        let result: [String: Any] = [
            "ok": checks.values.allSatisfy { $0 },
            "checks": checks,
            "metrics": metrics,
        ]
        guard let data = try? JSONSerialization.data(
            withJSONObject: result,
            options: [.prettyPrinted, .sortedKeys]
        ), let directory = FileManager.default.urls(
            for: .documentDirectory,
            in: .userDomainMask
        ).first else { return }
        let file = directory.appendingPathComponent("mde-performance-tests.json")
        try? data.write(to: file, options: .atomic)
        print("MDE_PERFORMANCE_TESTS \(String(data: data, encoding: .utf8) ?? "invalid")")
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

private final class MediaJournalView: UIView {
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
            let image = UIImageView(image: UIImage(systemName: "photo.fill"))
            image.contentMode = .scaleAspectFit
            image.frame = bounds
            image.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            addSubview(image)
        case .video:
            backgroundColor = .black
            let play = UIImageView(image: UIImage(systemName: "play.circle.fill"))
            play.tintColor = .white
            play.frame = CGRect(
                x: target.width / 2 - 18,
                y: target.height / 2 - 18,
                width: 36,
                height: 36
            )
            addSubview(play)
            addSubview(UISlider(frame: CGRect(x: 16, y: target.height - 36, width: target.width - 32, height: 20)))
        case .audio:
            let play = UIImageView(image: UIImage(systemName: "play.fill"))
            play.frame = CGRect(x: 12, y: 15, width: 24, height: 24)
            addSubview(play)
            addSubview(UISlider(frame: CGRect(x: 48, y: 17, width: target.width - 60, height: 20)))
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    override var intrinsicContentSize: CGSize { target }
}
