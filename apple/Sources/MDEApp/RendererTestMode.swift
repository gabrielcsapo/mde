import MDECore
import MDEditorUI
import MDEHost
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
            let labels = views.compactMap { view -> NSAttributedString? in
                if let textView = view as? UITextView,
                   textView.accessibilityIdentifier == "mde.table-cell" {
                    return textView.attributedText
                }
                if let label = view as? UILabel,
                   label.accessibilityIdentifier == "mde.table-cell" {
                    return label.attributedText
                }
                return nil
            }

            let bold = labels.contains { text in
                guard text.string == "JS" || text.string == "UIKit" else { return false }
                let font = text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont
                return font?.fontDescriptor.symbolicTraits.contains(.traitBold) == true
            }
            let link = labels.contains { text in
                text.string.contains("Web") && text.attribute(.link, at: 0, effectiveRange: nil) != nil
            }
            let interactiveLink = views.compactMap { $0 as? UILabel }.contains { label in
                label.accessibilityIdentifier == "mde.table-cell"
                    && label.isUserInteractionEnabled
                    && !(label.gestureRecognizers ?? []).isEmpty
                    && (label.attributedText?.length ?? 0) > 0
                    && label.attributedText?.attribute(
                        .link,
                        at: 0,
                        effectiveRange: nil
                    ) != nil
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
            let mentionAligned = mentionIsAligned(in: editor, source: source, views: views)

            let sourceStorage = source as NSString
            let selectionStart = sourceStorage.range(of: "| **JS**").location
            let selectionEnd = sourceStorage.range(of: "| **iOS**").location
            let selectedRows = NSRange(
                location: selectionStart,
                length: selectionEnd - selectionStart
            )
            _ = editor.becomeFirstResponder()
            editor.selectedRange = selectedRows
            editor.layoutIfNeeded()
            let revealed = editor.decorations.first { $0.role == Role.table }?.kind == .style
            let rowSelection = editor.selectedRange == selectedRows
                && sourceStorage.substring(with: selectedRows).hasPrefix("| **JS**")
                && sourceStorage.substring(with: selectedRows).contains("| **React**")
            let tableHiddenWhileEditing = !descendants(of: editor).contains {
                $0.accessibilityIdentifier == "mde.rendered-table"
            }
            editor.selectedRange = NSRange(location: 0, length: 0)
            editor.layoutIfNeeded()
            let restored = editor.decorations.first { $0.role == Role.table }?.kind == .blockWidget
            let tableViewRestored = descendants(of: editor).contains {
                $0.accessibilityIdentifier == "mde.rendered-table"
            }

            editor.interactionMode = .view
            let viewReadOnly = !editor.isEditable && editor.isSelectable
            _ = editor.becomeFirstResponder()
            editor.selectedRange = selectedRows
            editor.layoutIfNeeded()
            let viewKeepsRendering = editor.decorations.first { $0.role == Role.table }?.kind
                    == .blockWidget
                && descendants(of: editor).contains {
                    $0.accessibilityIdentifier == "mde.rendered-table"
                }
            if let task = editor.decorations.first(where: { $0.role == Role.taskCheckbox }) {
                editor.toggleTask(at: task)
            }
            let viewRefusesTaskEdits = editor.markdown == source
            editor.interactionMode = .edit

            let plugin = RendererPluginProbe()
            let pluginInstalled = (try? editor.installPlugin(plugin)) != nil
                && editor.installedPluginNames.contains(plugin.name)
            let pluginLayer = editor.decorations.contains { $0.role == plugin.role }
            let pluginRemoved = editor.removePlugin(named: plugin.name)
            let pluginCleanup = pluginRemoved
                && plugin.uninstalls == 1
                && !editor.decorations.contains { $0.role == plugin.role }
            let commonMarkHelp = commonMarkHelpReachesRenderer(editor)

            finish([
                "fixture": true,
                "sourcePreserved": editor.markdown == source,
                "nativeTable": tableView != nil,
                "collapsed": tableBefore?.kind == .blockWidget,
                "bold": bold,
                "link": link,
                "interactiveLink": interactiveLink,
                "code": code,
                "image": image,
                "mixedImage": mixedImage,
                "imageRowsFit": imageRowsFit,
                "noDuplicateImage": noDuplicateImage,
                "mentionAligned": mentionAligned,
                "revealed": revealed,
                "rowSelection": rowSelection,
                "tableHiddenWhileEditing": tableHiddenWhileEditing,
                "restored": restored,
                "tableViewRestored": tableViewRestored,
                "viewReadOnly": viewReadOnly,
                "viewKeepsRendering": viewKeepsRendering,
                "viewRefusesTaskEdits": viewRefusesTaskEdits,
                "pluginInstalled": pluginInstalled,
                "pluginLayer": pluginLayer,
                "pluginCleanup": pluginCleanup,
                "commonMarkHelp": commonMarkHelp,
            ])
        }
    }

    private static func commonMarkHelpReachesRenderer(_ editor: MarkdownTextView) -> Bool {
        let original = editor.markdown
        defer { editor.setMarkdown(original) }
        let cases: [(String, UInt32)] = [
            ("*italic*", Role.emphasis),
            ("_italic_", Role.emphasis),
            ("**bold**", Role.strong),
            ("__bold__", Role.strong),
            ("## heading\n", Role.heading),
            ("heading\n-------\n", Role.heading),
            ("[label](https://example.dev)", Role.linkText),
            ("[label][id]\n\n[id]: /path\n", Role.linkText),
            ("![alt](chart.png)", Role.image),
            ("![alt][image]\n\n[image]: chart.png\n", Role.image),
            ("> quoted\n", Role.quote),
            ("* item\n", Role.listBullet),
            ("- item\n", Role.listBullet),
            ("+ item\n", Role.listBullet),
            ("1. item\n", Role.listBullet),
            ("1) item\n", Role.listBullet),
            ("---\n", Role.rule),
            ("***\n", Role.rule),
            ("* * *\n", Role.rule),
            ("`code`", Role.codeInline),
            ("```\ncode\n```\n", Role.codeBlock),
            ("    code\n", Role.codeBlock),
        ]
        for (source, role) in cases {
            editor.setMarkdown(source)
            editor.layoutIfNeeded()
            guard editor.markdown == source,
                  editor.decorations.contains(where: { $0.role == role })
            else { return false }
        }
        return true
    }

    private static func descendants(of root: UIView) -> [UIView] {
        root.subviews.flatMap { [$0] + descendants(of: $0) }
    }

    private static func mentionIsAligned(
        in editor: MarkdownTextView,
        source: String,
        views: [UIView]
    ) -> Bool {
        let mention = (source as NSString).range(of: "@gabe")
        guard mention.location != NSNotFound,
              let chip = views.first(where: { $0 is ChipView }),
              let textStart = editor.position(
                  from: editor.beginningOfDocument,
                  offset: max(0, mention.location - 5)
              ),
              let textEnd = editor.position(
                  from: editor.beginningOfDocument,
                  offset: mention.location
              ),
              let textRange = editor.textRange(from: textStart, to: textEnd)
        else { return false }

        let textRect = editor.firstRect(for: textRange)
        let chipRect = chip.convert(chip.bounds, to: editor)
        return !textRect.isNull && abs(textRect.midY - chipRect.midY) <= 1.5
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

private final class RendererPluginProbe: MarkdownPlugin {
    let name = "test.uikit-renderer"
    private var context: MarkdownPluginContext?
    private(set) var role: UInt32 = .max
    private(set) var uninstalls = 0

    func install(in context: MarkdownPluginContext) throws {
        self.context = context
        role = context.internRole("uikit-plugin-probe")
    }

    func markdownDidChange() {
        guard let context else { return }
        let length = context.document.length
        guard length > 0 else { return }
        context.setLayer("probe", [
            LayerSpan(range: NSRange(location: 0, length: min(5, length)), role: role),
        ])
    }

    func uninstall() {
        uninstalls += 1
        context = nil
    }
}
