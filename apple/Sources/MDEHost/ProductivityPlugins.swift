import Foundation
import MDEditorUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

public struct MarkdownTemplate: Sendable, Equatable {
    public let id: String
    public let title: String
    public let markdown: String
    public let detail: String?
    public init(id: String, title: String, markdown: String, detail: String? = nil) {
        self.id = id; self.title = title; self.markdown = markdown; self.detail = detail
    }
}

public final class FloatingSelectionToolbar: MarkdownPlugin {
    public let name = "mde.examples.selection-toolbar"
    private var context: MarkdownPluginContext?
    public init() {}
    public func install(in context: MarkdownPluginContext) throws { self.context = context }
    public func uninstall() { context = nil }
    public func markdownDidChange() { update() }
    public func selectionDidChange() { update() }
    private func update() {
        guard let context, let editor = context.editor else { return }
        let selection = editor.selectedRange
        guard selection.length > 0 else { context.dismissPresentation("toolbar"); return }
        let toolbar = MarkdownFormattingToolbar { [weak editor] before, after in
            guard let editor else { return }
            let selected = (editor.markdown as NSString).substring(with: selection)
            let replacement = before + selected + after
            _ = editor.replaceMarkdown(
                in: selection, with: replacement,
                selection: NSRange(location: selection.location + before.utf16.count,
                                   length: selected.utf16.count)
            )
        }
        context.showPresentation(
            "toolbar",
            options: MarkdownPluginPresentationOptions(
                view: toolbar, anchor: .selection, placement: .above,
                offset: 6, dismissOnOutsideInteraction: false, restoreFocus: false
            )
        )
    }
}

private struct MarkdownInlineLink {
    let range: NSRange
    let label: String
    let destination: String
}

private func markdownInlineLink(in markdown: String, containing selection: NSRange) -> MarkdownInlineLink? {
    let source = markdown as NSString
    guard selection.location != NSNotFound,
          selection.location <= source.length,
          selection.length <= source.length - selection.location,
          let expression = try? NSRegularExpression(
              pattern: #"\[(?:\\.|[^\]\\])*\]\((?:\\.|[^)\\\n])*\)"#
          ) else { return nil }
    let matches = expression.matches(in: markdown, range: NSRange(location: 0, length: source.length))
    for match in matches {
        let range = match.range
        if range.location > 0, source.character(at: range.location - 1) == 33 { continue } // `!`
        guard selection.location >= range.location,
              NSMaxRange(selection) <= NSMaxRange(range) else { continue }
        let value = source.substring(with: range) as NSString
        let divider = value.range(of: "](")
        guard divider.location != NSNotFound, divider.location > 1 else { continue }
        let label = value.substring(with: NSRange(location: 1, length: divider.location - 1))
            .replacingOccurrences(of: #"\]"#, with: "]")
            .replacingOccurrences(of: #"\\"#, with: #"\"#)
        let destinationStart = NSMaxRange(divider)
        let destination = value.substring(with: NSRange(
            location: destinationStart,
            length: value.length - destinationStart - 1
        ))
            .replacingOccurrences(of: #"\)"#, with: ")")
            .replacingOccurrences(of: #"\\"#, with: #"\"#)
        return MarkdownInlineLink(range: range, label: label, destination: destination)
    }
    return nil
}

public final class LinkEditor: MarkdownPlugin {
    public let name = "mde.examples.link-editor"
    private var context: MarkdownPluginContext?
    public init() {}
    public func install(in context: MarkdownPluginContext) throws {
        self.context = context
        context.registerCommand("open", command: MarkdownPluginCommand(
            title: "Add or edit link", key: "k", modifiers: .primary,
            category: "Formatting", keywords: ["url", "hyperlink"]
        ) { [weak self] in self?.open() })
    }
    public func uninstall() { context = nil }
    public func open() {
        guard let context, let editor = context.editor else { return }
        let currentRange = editor.selectedRange
        let existing = markdownInlineLink(in: editor.markdown, containing: currentRange)
        let range = existing?.range ?? currentRange
        let selected = existing?.label ?? (range.location != NSNotFound
            ? (editor.markdown as NSString).substring(with: range) : "")
        let view = MarkdownTwoFieldDialog(
            title: existing == nil ? "Add a link" : "Edit link",
            firstLabel: "Link text", firstValue: selected.isEmpty ? "link" : selected,
            secondLabel: "URL", secondValue: existing?.destination ?? "https://",
            actionTitle: existing == nil ? "Insert" : "Update",
            submit: { [weak editor] label, destination in
                guard let editor else { return }
                let markdown = "[\(label.replacingOccurrences(of: "]", with: "\\]"))](\(destination))"
                _ = editor.replaceMarkdown(in: range, with: markdown)
                context.dismissPresentation("link")
            }, cancel: { context.dismissPresentation("link") }
        )
        context.showPresentation("link", view: view, anchor: .selection, modal: true)
        view.focusDestinationField()
    }
}

public final class TemplatePicker: MarkdownPlugin {
    public let name = "mde.examples.templates"
    private let templates: [MarkdownTemplate]
    private var context: MarkdownPluginContext?
    public init(_ templates: [MarkdownTemplate]) { self.templates = templates }
    public func install(in context: MarkdownPluginContext) throws {
        self.context = context
        context.registerCommand("open", command: MarkdownPluginCommand(
            title: "Insert template", category: "Insert",
            keywords: ["journal", "daily", "prompt"]
        ) { [weak self] in self?.open() })
    }
    public func uninstall() { context = nil }
    public func open() {
        guard let context, let editor = context.editor else { return }
        let range = editor.selectedRange
        let items = templates.map { template in
            MarkdownSuggestionItem(
                id: template.id, label: template.title, detail: template.detail,
                select: { [weak editor] _ in
                    guard let editor else { return }
                    _ = editor.replaceMarkdown(in: range, with: template.markdown)
                }
            )
        }
        let view = MarkdownActionList(items: items) { item in
            item.select?(MarkdownSuggestionRequest(
                match: MarkdownSuggestionMatch(trigger: "", query: "", range: range),
                markdown: editor.markdown,
                cancellation: MarkdownSuggestionCancellation(), editor: editor
            ))
            context.dismissPresentation("templates")
        }
        context.showPresentation("templates", view: view, anchor: .selection)
    }
}

public final class FindAndReplace: MarkdownPlugin {
    public let name = "mde.examples.find-replace"
    private var context: MarkdownPluginContext?
    public init() {}
    public func install(in context: MarkdownPluginContext) throws {
        self.context = context
        context.registerCommand("open", command: MarkdownPluginCommand(
            title: "Find and replace", key: "f", modifiers: [.primary, .shift],
            category: "Editing", keywords: ["search"]
        ) { [weak self] in self?.open() })
    }
    public func uninstall() { context = nil }
    public func open() {
        guard let context, let editor = context.editor else { return }
        let view = MarkdownTwoFieldDialog(
            title: "Find and replace", firstLabel: "Find", firstValue: "",
            secondLabel: "Replace with", secondValue: "", actionTitle: "Replace all",
            submit: { [weak editor] needle, replacement in
                guard let editor, !needle.isEmpty else { return }
                let source = editor.markdown
                _ = editor.replaceMarkdown(
                    in: NSRange(location: 0, length: source.utf16.count),
                    with: source.replacingOccurrences(of: needle, with: replacement)
                )
            }, cancel: { context.dismissPresentation("find-replace") }
        )
        context.showPresentation("find-replace", view: view, anchor: .viewport, modal: true)
        view.focusPrimaryField()
    }
}

public final class ImageDescriptionEditor: MarkdownPlugin {
    public let name = "mde.examples.image-alt"
    private var context: MarkdownPluginContext?
    public init() {}
    public func install(in context: MarkdownPluginContext) throws {
        self.context = context
        context.registerCommand("edit", command: MarkdownPluginCommand(
            title: "Edit image description", category: "Media",
            keywords: ["alt", "accessibility", "caption"],
            isEnabled: { [weak self] in self?.imageAtCaret() != nil }
        ) { [weak self] in self?.open() })
    }
    public func uninstall() { context = nil }
    private func imageAtCaret() -> (NSRange, String, String)? {
        guard let editor = context?.editor else { return nil }
        let caret = editor.selectedRange.location
        let source = editor.markdown as NSString
        let expression = try! NSRegularExpression(pattern: "!\\[([^]]*)\\]\\(([^)]+)\\)")
        for match in expression.matches(in: source as String, range: NSRange(location: 0, length: source.length)) {
            if NSLocationInRange(caret, NSRange(location: match.range.location, length: match.range.length + 1)) {
                return (match.range, source.substring(with: match.range(at: 1)),
                        source.substring(with: match.range(at: 2)))
            }
        }
        return nil
    }
    public func open() {
        guard let context, let editor = context.editor, let image = imageAtCaret() else { return }
        let view = MarkdownTwoFieldDialog(
            title: "Image description", firstLabel: "Alt text", firstValue: image.1,
            secondLabel: "Destination", secondValue: image.2, actionTitle: "Save",
            submit: { [weak editor] alt, destination in
                _ = editor?.replaceMarkdown(
                    in: image.0,
                    with: "![\(alt.replacingOccurrences(of: "]", with: "\\]"))](\(destination))"
                )
                context.dismissPresentation("image-alt")
            }, cancel: { context.dismissPresentation("image-alt") }
        )
        context.showPresentation("image-alt", view: view, anchor: .selection, modal: true)
        view.focusPrimaryField()
    }
}

#if os(macOS)
private final class MarkdownFormattingToolbar: NSStackView {
    init(action: @escaping (String, String) -> Void) {
        super.init(frame: .zero); orientation = .horizontal; spacing = 3
        edgeInsets = NSEdgeInsets(top: 4, left: 4, bottom: 4, right: 4)
        wantsLayer = true; layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        layer?.cornerRadius = 8; setAccessibilityRole(.toolbar)
        for (title, before, after) in [("Bold", "**", "**"), ("Italic", "*", "*"),
                                      ("Code", "`", "`"), ("Link", "[", "](https://)")] {
            addArrangedSubview(ProductivityButton(title: title) { action(before, after) })
        }
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not supported") }
}
private final class MarkdownTwoFieldDialog: NSStackView {
    private let first = NSTextField(); private let second = NSTextField()
    init(title: String, firstLabel: String, firstValue: String, secondLabel: String,
         secondValue: String, actionTitle: String,
         submit: @escaping (String, String) -> Void, cancel: @escaping () -> Void) {
        super.init(frame: .zero); orientation = .vertical; spacing = 8
        edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        wantsLayer = true; layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        layer?.cornerRadius = 10
        addArrangedSubview(NSTextField(labelWithString: title))
        first.placeholderString = firstLabel; first.stringValue = firstValue
        second.placeholderString = secondLabel; second.stringValue = secondValue
        first.widthAnchor.constraint(equalToConstant: 320).isActive = true
        addArrangedSubview(first); addArrangedSubview(second)
        let actions = NSStackView(); actions.orientation = .horizontal
        actions.addArrangedSubview(ProductivityButton(title: "Cancel", action: cancel))
        actions.addArrangedSubview(ProductivityButton(title: actionTitle) { submit(self.first.stringValue, self.second.stringValue) })
        addArrangedSubview(actions)
    }
    func focusPrimaryField() { window?.makeFirstResponder(first) }
    func focusDestinationField() { window?.makeFirstResponder(second) }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not supported") }
}
private final class MarkdownActionList: NSStackView {
    init(items: [MarkdownSuggestionItem], choose: @escaping (MarkdownSuggestionItem) -> Void) {
        super.init(frame: .zero); orientation = .vertical; spacing = 4
        edgeInsets = NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        for item in items { addArrangedSubview(ProductivityButton(title: item.label) { choose(item) }) }
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not supported") }
}
private final class ProductivityButton: NSButton {
    let closure: () -> Void
    init(title: String, action: @escaping () -> Void) {
        closure = action; super.init(frame: .zero); self.title = title
        target = self; self.action = #selector(run)
    }
    @objc private func run() { closure() }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not supported") }
}
#else
private final class MarkdownFormattingToolbar: UIStackView {
    init(action: @escaping (String, String) -> Void) {
        super.init(frame: .zero); axis = .horizontal; spacing = 3
        isLayoutMarginsRelativeArrangement = true
        directionalLayoutMargins = NSDirectionalEdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4)
        backgroundColor = .secondarySystemBackground; layer.cornerRadius = 8
        accessibilityTraits = .none
        for (title, before, after) in [("Bold", "**", "**"), ("Italic", "*", "*"),
                                      ("Code", "`", "`"), ("Link", "[", "](https://)")] {
            addArrangedSubview(UIButton(type: .system, primaryAction: UIAction(title: title) { _ in action(before, after) }))
        }
    }
    @available(*, unavailable) required init(coder: NSCoder) { fatalError("not supported") }
}
private final class MarkdownTwoFieldDialog: UIStackView {
    private let first = UITextField(); private let second = UITextField()
    init(title: String, firstLabel: String, firstValue: String, secondLabel: String,
         secondValue: String, actionTitle: String,
         submit: @escaping (String, String) -> Void, cancel: @escaping () -> Void) {
        super.init(frame: .zero); axis = .vertical; spacing = 8
        isLayoutMarginsRelativeArrangement = true
        directionalLayoutMargins = NSDirectionalEdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16)
        backgroundColor = .secondarySystemBackground; layer.cornerRadius = 10
        let heading = UILabel(); heading.text = title; heading.font = .preferredFont(forTextStyle: .headline)
        addArrangedSubview(heading)
        first.placeholder = firstLabel; first.text = firstValue; first.borderStyle = .roundedRect
        second.placeholder = secondLabel; second.text = secondValue; second.borderStyle = .roundedRect
        addArrangedSubview(first); addArrangedSubview(second)
        let actions = UIStackView(); actions.axis = .horizontal; actions.spacing = 8
        actions.addArrangedSubview(UIButton(type: .system, primaryAction: UIAction(title: "Cancel") { _ in cancel() }))
        actions.addArrangedSubview(UIButton(type: .system, primaryAction: UIAction(title: actionTitle) { [weak self] _ in
            submit(self?.first.text ?? "", self?.second.text ?? "")
        }))
        addArrangedSubview(actions); widthAnchor.constraint(equalToConstant: 340).isActive = true
    }
    func focusPrimaryField() { first.becomeFirstResponder() }
    func focusDestinationField() { second.becomeFirstResponder() }
    @available(*, unavailable) required init(coder: NSCoder) { fatalError("not supported") }
}
private final class MarkdownActionList: UIStackView {
    init(items: [MarkdownSuggestionItem], choose: @escaping (MarkdownSuggestionItem) -> Void) {
        super.init(frame: .zero); axis = .vertical; spacing = 4
        isLayoutMarginsRelativeArrangement = true
        directionalLayoutMargins = NSDirectionalEdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8)
        for item in items {
            addArrangedSubview(UIButton(type: .system, primaryAction: UIAction(title: item.label) { _ in choose(item) }))
        }
    }
    @available(*, unavailable) required init(coder: NSCoder) { fatalError("not supported") }
}
#endif
