import MDECore
import MDEditorUI
import UIKit

/// A simulator-side renderer test. SwiftPM can exercise AppKit directly, but this
/// repository deliberately has no Xcode project, so UIKit runs these assertions in
/// the reference app and writes a machine-readable result for the shell test runner.
enum RendererTestMode {
    static var isEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--mde-renderer-tests")
    }

    static func run(_ editor: MarkdownTextView) {
        guard isEnabled else { return }
        guard let url = Bundle.main.url(forResource: "cross-platform", withExtension: "md"),
              let source = try? String(contentsOf: url, encoding: .utf8)
        else {
            finish(["fixture": false])
            return
        }

        editor.setMarkdown(source)
        editor.setContentOffset(CGPoint(x: 0, y: -editor.adjustedContentInset.top), animated: false)
        editor.layoutIfNeeded()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            editor.layoutIfNeeded()
            let tableBefore = editor.decorations.first { $0.role == Role.table }
            let views = descendants(of: editor)
            let tableView = views.first { $0.accessibilityIdentifier == "mde.rendered-table" }
            let labels = views.compactMap { $0 as? UILabel }.compactMap(\.attributedText)

            let bold = labels.contains { text in
                guard text.string == "JS" || text.string == "UIKit" else { return false }
                let font = text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont
                return font?.fontDescriptor.symbolicTraits.contains(.traitBold) == true
            }
            let link = labels.contains { text in
                text.string.contains("Web") && text.attribute(.link, at: 0, effectiveRange: nil) != nil
            }
            let code = labels.contains { text in
                guard text.string.contains("wasm") else { return false }
                var found = false
                text.enumerateAttribute(.font, in: NSRange(location: 0, length: text.length)) {
                    value, _, _ in
                    if (value as? UIFont)?.fontDescriptor.symbolicTraits.contains(.traitMonoSpace) == true {
                        found = true
                    }
                }
                return found
            }
            let mixedImage = labels.contains { text in
                var found = false
                text.enumerateAttribute(
                    .attachment,
                    in: NSRange(location: 0, length: text.length)
                ) { value, _, _ in
                    if value != nil { found = true }
                }
                return found
            }
            let tableImages = views.compactMap { $0 as? UIImageView }.filter { imageView in
                imageView.image != nil && ancestors(of: imageView).contains {
                    $0.accessibilityIdentifier == "mde.table-image"
                }
            }
            let image = tableImages.count == 2
            let imageRowsFit = tableView.map { table in
                tableImages.allSatisfy { imageView in
                    table.convert(imageView.bounds, from: imageView).maxY <= table.bounds.maxY + 0.5
                }
            } ?? false
            let noDuplicateImage = views.compactMap { $0 as? UIImageView }.filter { imageView in
                imageView.image != nil && !ancestors(of: imageView).contains { ancestor in
                    ancestor.accessibilityIdentifier == "mde.table-image"
                }
            }.isEmpty

            let tableRange = (source as NSString).range(of: "| Surface")
            _ = editor.becomeFirstResponder()
            editor.selectedRange = NSRange(location: tableRange.location + 4, length: 0)
            let revealed = editor.decorations.first { $0.role == Role.table }?.kind == .style
            editor.selectedRange = NSRange(location: 0, length: 0)
            let restored = editor.decorations.first { $0.role == Role.table }?.kind == .blockWidget

            finish([
                "fixture": true,
                "sourcePreserved": editor.markdown == source,
                "nativeTable": tableView != nil,
                "collapsed": tableBefore?.kind == .blockWidget,
                "bold": bold,
                "link": link,
                "code": code,
                "image": image,
                "mixedImage": mixedImage,
                "imageRowsFit": imageRowsFit,
                "noDuplicateImage": noDuplicateImage,
                "revealed": revealed,
                "restored": restored,
            ])
        }
    }

    private static func descendants(of root: UIView) -> [UIView] {
        root.subviews.flatMap { [$0] + descendants(of: $0) }
    }

    private static func ancestors(of view: UIView) -> [UIView] {
        var result = [UIView]()
        var current = view.superview
        while let view = current {
            result.append(view)
            current = view.superview
        }
        return result
    }

    private static func finish(_ checks: [String: Bool]) {
        let result: [String: Any] = [
            "ok": checks.values.allSatisfy { $0 },
            "checks": checks,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted]),
              let directory = FileManager.default.urls(
                for: .documentDirectory, in: .userDomainMask
              ).first
        else { return }
        let file = directory.appendingPathComponent("mde-renderer-tests.json")
        try? data.write(to: file, options: .atomic)
        print("MDE_RENDERER_TESTS \(String(data: data, encoding: .utf8) ?? "invalid")")
    }
}
