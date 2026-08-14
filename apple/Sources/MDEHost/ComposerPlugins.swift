import Foundation
import MDEditorUI
import MDEPluginKit

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
    private let suggestions: MarkdownSuggestionPlugin

    public init(candidates: [MentionCandidate], maximumResults: Int = 6) {
        suggestions = MarkdownSuggestionPlugin(
            name: name,
            triggers: [MarkdownSuggestionTrigger("@")],
            maximumResults: maximumResults,
            accessibilityLabel: "Mention suggestions"
        ) { _, complete in
            complete(candidates.map { candidate in
                MarkdownSuggestionItem(
                    id: candidate.handle,
                    label: candidate.label,
                    detail: candidate.detail ?? "@\(candidate.handle)",
                    keywords: [candidate.handle],
                    replacement: "@\(candidate.handle)"
                )
            })
        }
    }

    public func install(in context: MarkdownPluginContext) throws { try suggestions.install(in: context) }
    public func uninstall() { suggestions.uninstall() }
    public func markdownDidChange() { suggestions.markdownDidChange() }
    public func selectionDidChange() { suggestions.selectionDidChange() }
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
        context.registerCommand("open", command: MarkdownPluginCommand(
            title: "Add attachment", key: "o", modifiers: .primary,
            category: "Insert", keywords: ["image", "video", "audio", "file", "media"]
        ) { [weak self] in self?.open() })
    }

    public func uninstall() { context = nil }

    public func open() {
        guard let context else { return }
        insertion = context.selection.range ?? NSRange(location: context.document.length, length: 0)
        let panel = AttachmentComposerView(
            onInsert: { [weak self] kind, reference, label in
                self?.insert(kind: kind, reference: reference, label: label)
            },
            onCancel: { [weak self, weak context] in
                guard let context else { return }
                context.dismissPresentation("composer")
                guard let self else { return }
                context.selection.range = self.insertion
                _ = context.focusEditor()
            }
        )
        context.showPresentation("composer", view: panel, anchor: .viewport, modal: true)
        panel.focusReferenceField()
    }

    private func insert(kind: AttachmentKind, reference: String, label: String) {
        guard let context else { return }
        let cleanReference = reference.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanReference.isEmpty else { return }
        let cleanLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let display = cleanLabel.isEmpty ? kind.rawValue : cleanLabel
        let markdown = kind == .link
            ? "[\(display)](\(cleanReference))"
            : "![\(display)](\(cleanReference))"
        _ = try? context.document.transact(MarkdownPluginTransaction(
            edits: [MarkdownPluginTextEdit(range: insertion, text: markdown)],
            selection: NSRange(location: insertion.location + markdown.utf16.count, length: 0),
            label: "Insert attachment", origin: name
        ))
        onInsert?(kind, cleanReference)
        context.dismissPresentation("composer")
        _ = context.focusEditor()
    }
}

#if os(macOS)
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
