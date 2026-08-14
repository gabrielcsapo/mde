import Foundation
import MDEditorUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

public struct MentionCandidate: Sendable, Equatable {
    public let handle: String
    public let label: String
    public let detail: String?

    public init(handle: String, label: String, detail: String? = nil) {
        self.handle = handle
        self.label = label
        self.detail = detail
    }
}

/// Complete `@` autocomplete example using only the public plugin presentation API.
public final class MentionAutocomplete: MarkdownPlugin {
    public let name = "mde.examples.mentions"
    private let candidates: [MentionCandidate]
    private let maximumResults: Int
    private var context: MarkdownPluginContext?

    public init(candidates: [MentionCandidate], maximumResults: Int = 6) {
        self.candidates = candidates
        self.maximumResults = max(1, maximumResults)
    }

    public func install(in context: MarkdownPluginContext) throws { self.context = context }
    public func uninstall() { context = nil }
    public func markdownDidChange() { update() }
    public func selectionDidChange() { update() }

    private func update() {
        guard let context, let editor = context.editor else { return }
        let selection = editor.selectedRange
        guard selection.length == 0, selection.location != NSNotFound else {
            context.dismissPresentation("suggestions")
            return
        }
        let source = editor.markdown as NSString
        guard selection.location <= source.length else { return }
        let before = source.substring(to: selection.location) as NSString
        let expression = try! NSRegularExpression(pattern: "(?:^|\\s)@([\\p{L}\\p{N}_-]*)$")
        guard let match = expression.firstMatch(
            in: before as String, range: NSRange(location: 0, length: before.length)
        ), match.range(at: 1).location != NSNotFound else {
            context.dismissPresentation("suggestions")
            return
        }
        let query = before.substring(with: match.range(at: 1)).lowercased()
        let results = candidates.filter {
            $0.handle.lowercased().hasPrefix(query) || $0.label.lowercased().contains(query)
        }.prefix(maximumResults)
        guard !results.isEmpty else {
            context.dismissPresentation("suggestions")
            return
        }
        let replacement = NSRange(
            location: selection.location - query.utf16.count - 1,
            length: query.utf16.count + 1
        )
        let list = MentionSuggestionView(candidates: Array(results)) { [weak self] candidate in
            self?.choose(candidate, range: replacement)
        }
        context.showPresentation("suggestions", view: list, anchor: .selection)
    }

    private func choose(_ candidate: MentionCandidate, range: NSRange) {
        guard let context, let editor = context.editor else { return }
        // Finish the trigger with a delimiter so restoring the caret does not reopen
        // the same suggestion list on the following selection callback.
        let text = "@\(candidate.handle) "
        _ = editor.replaceMarkdown(
            in: range, with: text,
            selection: NSRange(location: range.location + text.utf16.count, length: 0)
        )
        context.dismissPresentation("suggestions")
        _ = editor.becomeFirstResponder()
    }
}

public enum AttachmentKind: String, CaseIterable, Sendable { case image, video, link }

/// Command-O image/video/link composer demonstrating viewport-modal plugin UI.
public final class AttachmentComposer: MarkdownPlugin {
    public let name = "mde.examples.attachments"
    private var context: MarkdownPluginContext?
    private var insertion = NSRange(location: 0, length: 0)
    public var onInsert: ((AttachmentKind, String) -> Void)?

    public init() {}

    public func install(in context: MarkdownPluginContext) throws {
        self.context = context
        context.registerCommand("open", title: "Add attachment", key: "o") { [weak self] in
            self?.open()
        }
    }

    public func uninstall() { context = nil }

    public func open() {
        guard let context, let editor = context.editor else { return }
        insertion = editor.selectedRange
        let panel = AttachmentComposerView(
            onInsert: { [weak self] kind, reference, label in
                self?.insert(kind: kind, reference: reference, label: label)
            },
            onCancel: { [weak self, weak editor] in
                context.dismissPresentation("composer")
                guard let self, let editor else { return }
                editor.selectedRange = self.insertion
                _ = editor.becomeFirstResponder()
            }
        )
        context.showPresentation("composer", view: panel, anchor: .viewport, modal: true)
        panel.focusReferenceField()
    }

    private func insert(kind: AttachmentKind, reference: String, label: String) {
        guard let context, let editor = context.editor else { return }
        let cleanReference = reference.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanReference.isEmpty else { return }
        let cleanLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let display = cleanLabel.isEmpty ? kind.rawValue : cleanLabel
        let markdown = kind == .link
            ? "[\(display)](\(cleanReference))"
            : "![\(display)](\(cleanReference))"
        _ = editor.replaceMarkdown(in: insertion, with: markdown)
        onInsert?(kind, cleanReference)
        context.dismissPresentation("composer")
        _ = editor.becomeFirstResponder()
    }
}

#if os(macOS)
private final class MentionSuggestionView: NSStackView {
    private let choose: (MentionCandidate) -> Void
    private let candidates: [MentionCandidate]

    init(candidates: [MentionCandidate], choose: @escaping (MentionCandidate) -> Void) {
        self.choose = choose
        self.candidates = candidates
        super.init(frame: .zero)
        orientation = .vertical
        alignment = .leading
        spacing = 4
        edgeInsets = NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.borderWidth = 1
        updateColors()
        setAccessibilityRole(.list)
        setAccessibilityLabel("Mention suggestions")
        for (index, candidate) in candidates.enumerated() {
            let button = NSButton(
                title: "\(candidate.label)  @\(candidate.handle)", target: self,
                action: #selector(chosen(_:))
            )
            button.bezelStyle = .inline
            button.tag = index
            addArrangedSubview(button)
        }
    }

    @objc private func chosen(_ sender: NSButton) {
        guard candidates.indices.contains(sender.tag) else { return }
        choose(candidates[sender.tag])
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateColors()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateColors()
    }

    private func updateColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
            layer?.borderColor = NSColor.separatorColor.cgColor
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }
}

private final class AttachmentComposerView: NSStackView {
    private let kind = NSPopUpButton()
    private let reference = NSTextField()
    private let label = NSTextField()
    private let onInsert: (AttachmentKind, String, String) -> Void
    private let onCancel: () -> Void

    init(
        onInsert: @escaping (AttachmentKind, String, String) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.onInsert = onInsert
        self.onCancel = onCancel
        super.init(frame: .zero)
        orientation = .vertical
        alignment = .leading
        spacing = 10
        edgeInsets = NSEdgeInsets(top: 18, left: 18, bottom: 18, right: 18)
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.borderWidth = 1
        updateColors()
        setAccessibilityRole(.group)
        setAccessibilityLabel("Add to your note")
        let title = NSTextField(labelWithString: "Add to your note")
        title.font = .boldSystemFont(ofSize: 16)
        kind.addItems(withTitles: AttachmentKind.allCases.map { $0.rawValue.capitalized })
        reference.placeholderString = "URL or asset path"
        reference.setAccessibilityLabel("URL or asset path")
        label.placeholderString = "Label or alt text"
        label.setAccessibilityLabel("Label or alt text")
        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.spacing = 8
        actions.addArrangedSubview(NSButton(title: "Cancel", target: self, action: #selector(cancel)))
        actions.addArrangedSubview(NSButton(title: "Insert", target: self, action: #selector(insert)))
        for view in [title, kind, reference, label, actions] { addArrangedSubview(view) }
        reference.widthAnchor.constraint(equalToConstant: 320).isActive = true
        label.widthAnchor.constraint(equalTo: reference.widthAnchor).isActive = true
    }

    func focusReferenceField() { window?.makeFirstResponder(reference) }
    @objc private func cancel() { onCancel() }
    @objc private func insert() {
        let selected = AttachmentKind.allCases[max(0, kind.indexOfSelectedItem)]
        onInsert(selected, reference.stringValue, label.stringValue)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateColors()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateColors()
    }

    private func updateColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
            layer?.borderColor = NSColor.separatorColor.cgColor
        }
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }
}
#else
private final class MentionSuggestionView: UIStackView {
    init(candidates: [MentionCandidate], choose: @escaping (MentionCandidate) -> Void) {
        super.init(frame: .zero)
        axis = .vertical
        alignment = .fill
        spacing = 4
        isLayoutMarginsRelativeArrangement = true
        directionalLayoutMargins = NSDirectionalEdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8)
        backgroundColor = .secondarySystemBackground
        layer.cornerRadius = 10
        accessibilityLabel = "Mention suggestions"
        for candidate in candidates {
            let button = UIButton(type: .system, primaryAction: UIAction(
                title: "\(candidate.label)  @\(candidate.handle)"
            ) { _ in choose(candidate) })
            button.contentHorizontalAlignment = .leading
            addArrangedSubview(button)
        }
    }
    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError("not supported") }
}

private final class AttachmentComposerView: UIStackView {
    private let kind = UISegmentedControl(items: AttachmentKind.allCases.map { $0.rawValue.capitalized })
    private let reference = UITextField()
    private let label = UITextField()
    private let onInsert: (AttachmentKind, String, String) -> Void
    private let onCancel: () -> Void

    init(
        onInsert: @escaping (AttachmentKind, String, String) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.onInsert = onInsert
        self.onCancel = onCancel
        super.init(frame: .zero)
        axis = .vertical
        spacing = 10
        isLayoutMarginsRelativeArrangement = true
        directionalLayoutMargins = NSDirectionalEdgeInsets(top: 18, leading: 18, bottom: 18, trailing: 18)
        backgroundColor = .secondarySystemBackground
        layer.cornerRadius = 12
        accessibilityLabel = "Add to your note"
        let title = UILabel()
        title.text = "Add to your note"
        title.font = .preferredFont(forTextStyle: .headline)
        kind.selectedSegmentIndex = 0
        reference.placeholder = "URL or asset path"
        reference.accessibilityLabel = "URL or asset path"
        reference.borderStyle = .roundedRect
        label.placeholder = "Label or alt text"
        label.accessibilityLabel = "Label or alt text"
        label.borderStyle = .roundedRect
        let actions = UIStackView()
        actions.axis = .horizontal
        actions.spacing = 8
        actions.alignment = .trailing
        actions.addArrangedSubview(UIButton(type: .system, primaryAction: UIAction(title: "Cancel") {
            [weak self] _ in self?.onCancel()
        }))
        actions.addArrangedSubview(UIButton(type: .system, primaryAction: UIAction(title: "Insert") {
            [weak self] _ in self?.insert()
        }))
        for view in [title, kind, reference, label, actions] { addArrangedSubview(view) }
        widthAnchor.constraint(equalToConstant: 340).isActive = true
    }

    func focusReferenceField() { reference.becomeFirstResponder() }
    private func insert() {
        let selected = AttachmentKind.allCases[max(0, kind.selectedSegmentIndex)]
        onInsert(selected, reference.text ?? "", label.text ?? "")
    }
    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError("not supported") }
}
#endif
