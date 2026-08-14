import Foundation
import MDEditorUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

public struct MarkdownSuggestionTrigger: Sendable, Equatable {
    public let text: String
    public let requiresBoundary: Bool
    public let allowsSpaces: Bool
    public let lineLeading: Bool

    public init(
        _ text: String,
        requiresBoundary: Bool = true,
        allowsSpaces: Bool = false,
        lineLeading: Bool = false
    ) {
        self.text = text
        self.requiresBoundary = requiresBoundary
        self.allowsSpaces = allowsSpaces
        self.lineLeading = lineLeading
    }
}

public struct MarkdownSuggestionMatch: Sendable, Equatable {
    public let trigger: String
    public let query: String
    public let range: NSRange
}

public final class MarkdownSuggestionCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    public var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return cancelled
    }
    fileprivate func cancel() { lock.lock(); cancelled = true; lock.unlock() }
}

public struct MarkdownSuggestionRequest {
    public let match: MarkdownSuggestionMatch
    public let markdown: String
    public let cancellation: MarkdownSuggestionCancellation
    public weak var editor: MarkdownTextView?
}

public struct MarkdownSuggestionItem {
    public let id: String
    public let label: String
    public let detail: String?
    public let group: String?
    public let keywords: [String]
    public let replacement: String?
    public let suffix: String
    public let isEnabled: Bool
    public let select: ((MarkdownSuggestionRequest) -> Void)?

    public init(
        id: String,
        label: String,
        detail: String? = nil,
        group: String? = nil,
        keywords: [String] = [],
        replacement: String? = nil,
        suffix: String = " ",
        isEnabled: Bool = true,
        select: ((MarkdownSuggestionRequest) -> Void)? = nil
    ) {
        self.id = id
        self.label = label
        self.detail = detail
        self.group = group
        self.keywords = keywords
        self.replacement = replacement
        self.suffix = suffix
        self.isEnabled = isEnabled
        self.select = select
    }
}

public typealias MarkdownSuggestionProvider = (
    MarkdownSuggestionRequest,
    @escaping ([MarkdownSuggestionItem]) -> Void
) -> Void

/// Cross-platform autocomplete with debouncing, latest-wins cancellation, and a small cache.
public final class MarkdownSuggestionPlugin: MarkdownPlugin {
    public let name: String
    private let triggers: [MarkdownSuggestionTrigger]
    private let maximumResults: Int
    private let debounce: TimeInterval
    private let provider: MarkdownSuggestionProvider
    private let accessibilityLabel: String
    private var context: MarkdownPluginContext?
    private var workItem: DispatchWorkItem?
    private var cancellation: MarkdownSuggestionCancellation?
    private var activeKey: String?
    private var cache: [String: [MarkdownSuggestionItem]] = [:]
    private var cacheOrder: [String] = []
    private var activeItems: [MarkdownSuggestionItem] = []
    private var activeRequest: MarkdownSuggestionRequest?
    private var activeIndex = 0

    public init(
        name: String,
        triggers: [MarkdownSuggestionTrigger],
        maximumResults: Int = 8,
        debounce: TimeInterval = 0,
        accessibilityLabel: String = "Suggestions",
        provider: @escaping MarkdownSuggestionProvider
    ) {
        self.name = name
        self.triggers = triggers
        self.maximumResults = max(1, maximumResults)
        self.debounce = max(0, debounce)
        self.accessibilityLabel = accessibilityLabel
        self.provider = provider
    }

    public func install(in context: MarkdownPluginContext) throws {
        self.context = context
        context.registerCommand("suggestions-next", command: MarkdownPluginCommand(
            title: "Next suggestion", key: suggestionDownKey, isDiscoverable: false,
            isEnabled: { [weak self] in self?.activeItems.isEmpty == false }
        ) { [weak self] in self?.moveSelection(1) })
        context.registerCommand("suggestions-previous", command: MarkdownPluginCommand(
            title: "Previous suggestion", key: suggestionUpKey, isDiscoverable: false,
            isEnabled: { [weak self] in self?.activeItems.isEmpty == false }
        ) { [weak self] in self?.moveSelection(-1) })
        context.registerCommand("suggestions-accept", command: MarkdownPluginCommand(
            title: "Choose suggestion", key: "\r", isDiscoverable: false,
            isEnabled: { [weak self] in self?.activeItems.isEmpty == false }
        ) { [weak self] in self?.acceptSelection() })
    }
    public func uninstall() { close(); context = nil }
    public func markdownDidChange() { update() }
    public func selectionDidChange() { update() }

    private func update() {
        guard let context, let editor = context.editor, !editorHasMarkedText(editor) else {
            close(); return
        }
        let selection = editor.selectedRange
        guard selection.length == 0, selection.location != NSNotFound else { close(); return }
        let source = editor.markdown as NSString
        guard selection.location <= source.length,
              let match = matchSuggestion(
                triggers: triggers,
                markdownBeforeCaret: source.substring(to: selection.location),
                caret: selection.location
              )
        else { close(); return }
        let key = "\(match.trigger)\u{0}\(match.query.lowercased())"
        if key == activeKey, cancellation?.isCancelled == false { return }
        workItem?.cancel()
        cancellation?.cancel()
        context.dismissPresentation("suggestions", reason: .replaced)
        activeItems = []
        activeRequest = nil
        activeIndex = 0
        activeKey = key
        let token = MarkdownSuggestionCancellation()
        cancellation = token
        let request = MarkdownSuggestionRequest(
            match: match, markdown: editor.markdown, cancellation: token, editor: editor
        )
        if let cached = cache[key] { publish(cached, request: request); return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, !token.isCancelled else { return }
            self.provider(request) { [weak self] items in
                let publish = {
                    guard let self, !token.isCancelled, self.activeKey == key else { return }
                    self.remember(items, key: key)
                    self.publish(items, request: request)
                }
                if Thread.isMainThread { publish() }
                else { DispatchQueue.main.async(execute: publish) }
            }
        }
        workItem = work
        if debounce == 0 { work.perform() }
        else { DispatchQueue.main.asyncAfter(deadline: .now() + debounce, execute: work) }
    }

    private func publish(_ items: [MarkdownSuggestionItem], request: MarkdownSuggestionRequest) {
        guard context != nil, !request.cancellation.isCancelled else { return }
        let results = Array(filterSuggestions(items, query: request.match.query).prefix(maximumResults))
        guard !results.isEmpty else { close(); return }
        activeItems = results
        activeRequest = request
        activeIndex = min(activeIndex, results.count - 1)
        presentActive()
    }

    private func presentActive() {
        guard let context, let request = activeRequest, !activeItems.isEmpty else { return }
        let view = MarkdownSuggestionListView(
            items: activeItems, selectedIndex: activeIndex, accessibilityLabel: accessibilityLabel
        ) { [weak self] item in self?.choose(item, request: request) }
        context.showPresentation(
            "suggestions",
            options: MarkdownPluginPresentationOptions(
                view: view, anchor: .selection, placement: .automatic,
                dismissOnOutsideInteraction: true,
                onDismiss: { [weak self] reason in
                    if reason != .replaced { self?.cancelRequest() }
                }
            )
        )
    }

    private func moveSelection(_ delta: Int) {
        guard !activeItems.isEmpty else { return }
        activeIndex = (activeIndex + delta + activeItems.count) % activeItems.count
        presentActive()
    }

    private func acceptSelection() {
        guard let request = activeRequest, activeItems.indices.contains(activeIndex) else { return }
        choose(activeItems[activeIndex], request: request)
    }

    private func choose(_ item: MarkdownSuggestionItem, request: MarkdownSuggestionRequest) {
        guard item.isEnabled, let context, let editor = context.editor else { return }
        if let select = item.select { select(request) }
        else {
            let replacement = (item.replacement ?? item.label) + item.suffix
            _ = editor.replaceMarkdown(
                in: request.match.range,
                with: replacement,
                selection: NSRange(
                    location: request.match.range.location + replacement.utf16.count,
                    length: 0
                )
            )
        }
        context.dismissPresentation("suggestions")
    }

    private func remember(_ items: [MarkdownSuggestionItem], key: String) {
        cache[key] = items
        cacheOrder.removeAll { $0 == key }
        cacheOrder.append(key)
        if cacheOrder.count > 64 { cache.removeValue(forKey: cacheOrder.removeFirst()) }
    }

    private func cancelRequest() {
        workItem?.cancel(); workItem = nil
        cancellation?.cancel(); cancellation = nil
        activeKey = nil
        activeItems = []
        activeRequest = nil
        activeIndex = 0
    }

    private func close() {
        cancelRequest()
        context?.dismissPresentation("suggestions")
    }
}

public func filterSuggestions(
    _ items: [MarkdownSuggestionItem], query: String
) -> [MarkdownSuggestionItem] {
    items.enumerated().compactMap { order, item -> (MarkdownSuggestionItem, Double, Int)? in
        let text = ([item.label, item.detail] + item.keywords).compactMap { $0 }.joined(separator: " ")
        guard let score = markdownSuggestionScore(query: query, candidate: text) else { return nil }
        return (item, score, order)
    }.sorted { $0.1 == $1.1 ? $0.2 < $1.2 : $0.1 < $1.1 }.map(\.0)
}

public func markdownSuggestionScore(query: String, candidate: String) -> Double? {
    let needle = Array(query.lowercased())
    let haystack = Array(candidate.lowercased())
    if needle.isEmpty { return 0 }
    if let range = candidate.lowercased().range(of: query.lowercased()) {
        return Double(candidate.distance(from: candidate.startIndex, to: range.lowerBound)) * 0.01
            + Double(max(0, haystack.count - needle.count)) * 0.001
    }
    var cursor = 0
    var score = 0.0
    var previous = -2
    for character in needle {
        guard let found = haystack[cursor...].firstIndex(of: character) else { return nil }
        score += found == previous + 1 ? 0.1 : 1 + Double(found) * 0.05
        previous = found
        cursor = found + 1
    }
    return score + Double(max(0, haystack.count - needle.count)) * 0.01
}

public func matchSuggestion(
    triggers: [MarkdownSuggestionTrigger], markdownBeforeCaret: String, caret: Int
) -> MarkdownSuggestionMatch? {
    let source = markdownBeforeCaret as NSString
    var best: MarkdownSuggestionMatch?
    for trigger in triggers {
        let range = source.range(of: trigger.text, options: .backwards)
        guard range.location != NSNotFound else { continue }
        if trigger.lineLeading {
            let line = source.lineRange(for: NSRange(location: range.location, length: 0))
            guard range.location == line.location else { continue }
        }
        if trigger.requiresBoundary, range.location > 0 {
            let preceding = source.substring(with: NSRange(location: range.location - 1, length: 1))
            guard preceding.rangeOfCharacter(from: .whitespacesAndNewlines) != nil else { continue }
        }
        let queryRange = NSRange(
            location: NSMaxRange(range), length: source.length - NSMaxRange(range)
        )
        let query = source.substring(with: queryRange)
        let allowed = trigger.allowsSpaces
            ? CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_- "))
            : CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        guard query.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { continue }
        let match = MarkdownSuggestionMatch(
            trigger: trigger.text, query: query,
            range: NSRange(location: range.location, length: caret - range.location)
        )
        if best == nil || match.range.location > best!.range.location { best = match }
    }
    return best
}

private func editorHasMarkedText(_ editor: MarkdownTextView) -> Bool {
#if os(macOS)
    editor.hasMarkedText()
#else
    editor.markedTextRange != nil
#endif
}

private var suggestionUpKey: String {
#if os(macOS)
    "\u{F700}"
#else
    UIKeyCommand.inputUpArrow
#endif
}

private var suggestionDownKey: String {
#if os(macOS)
    "\u{F701}"
#else
    UIKeyCommand.inputDownArrow
#endif
}

#if os(macOS)
private final class MarkdownSuggestionListView: NSStackView {
    private let items: [MarkdownSuggestionItem]
    private let choose: (MarkdownSuggestionItem) -> Void
    private var buttons: [NSButton] = []
    private var headings: [NSTextField] = []
    init(
        items: [MarkdownSuggestionItem], selectedIndex: Int, accessibilityLabel: String,
        choose: @escaping (MarkdownSuggestionItem) -> Void
    ) {
        self.items = items; self.choose = choose
        super.init(frame: .zero)
        orientation = .vertical; alignment = .leading; spacing = 4
        edgeInsets = NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        wantsLayer = true; layer?.cornerRadius = 10; layer?.borderWidth = 1
        setAccessibilityRole(.list); setAccessibilityLabel(accessibilityLabel)
        var group: String?
        for (index, item) in items.enumerated() {
            if let next = item.group, next != group {
                let heading = NSTextField(labelWithString: next.uppercased())
                heading.font = .boldSystemFont(ofSize: 10); heading.textColor = .secondaryLabelColor
                addArrangedSubview(heading); headings.append(heading); group = next
            }
            let button = NSButton(
                title: [item.label, item.detail].compactMap { $0 }.joined(separator: "  "),
                target: self, action: #selector(chosen(_:))
            )
            button.isBordered = false; button.alignment = .left
            button.tag = index; button.isEnabled = item.isEnabled
            button.state = index == selectedIndex ? .on : .off
            button.setAccessibilitySelected(index == selectedIndex)
            addArrangedSubview(button); buttons.append(button)
        }
        updateColors()
    }
    @objc private func chosen(_ sender: NSButton) { choose(items[sender.tag]) }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); updateColors() }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance(); updateColors()
    }
    private func updateColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let background = NSColor.windowBackgroundColor
            let foreground = NSColor.labelColor
            layer?.backgroundColor = background.cgColor
            layer?.borderColor = NSColor.separatorColor.cgColor
            buttons.forEach { button in
                button.contentTintColor = foreground
                button.attributedTitle = NSAttributedString(
                    string: button.title,
                    attributes: [.foregroundColor: foreground, .font: button.font ?? .systemFont(ofSize: 13)]
                )
            }
            headings.forEach { $0.textColor = NSColor.secondaryLabelColor }
        }
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not supported") }
}
#else
private final class MarkdownSuggestionListView: UIStackView {
    init(
        items: [MarkdownSuggestionItem], selectedIndex: Int, accessibilityLabel: String,
        choose: @escaping (MarkdownSuggestionItem) -> Void
    ) {
        super.init(frame: .zero)
        axis = .vertical; alignment = .fill; spacing = 4
        isLayoutMarginsRelativeArrangement = true
        directionalLayoutMargins = NSDirectionalEdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8)
        backgroundColor = .secondarySystemBackground; layer.cornerRadius = 10
        self.accessibilityLabel = accessibilityLabel
        var group: String?
        for (index, item) in items.enumerated() {
            if let next = item.group, next != group {
                let heading = UILabel(); heading.text = next.uppercased()
                heading.font = .preferredFont(forTextStyle: .caption2)
                heading.textColor = .secondaryLabel; addArrangedSubview(heading); group = next
            }
            let button = UIButton(type: .system, primaryAction: UIAction(
                title: [item.label, item.detail].compactMap { $0 }.joined(separator: "  ")
            ) { _ in choose(item) })
            button.contentHorizontalAlignment = .leading; button.isEnabled = item.isEnabled
            button.isSelected = index == selectedIndex
            if button.isSelected { button.backgroundColor = .tertiarySystemFill }
            addArrangedSubview(button)
        }
    }
    @available(*, unavailable) required init(coder: NSCoder) { fatalError("not supported") }
}
#endif

/// Tags, wiki links, and slash commands are ordinary configurations of the generic engine.
public enum MarkdownSuggestionPlugins {
    public static func tags(_ tags: [String]) -> MarkdownSuggestionPlugin {
        MarkdownSuggestionPlugin(
            name: "mde.examples.tags", triggers: [MarkdownSuggestionTrigger("#")],
            accessibilityLabel: "Tag suggestions"
        ) { request, complete in
            complete(tags.map {
                MarkdownSuggestionItem(id: $0, label: $0, replacement: "#\($0)")
            })
        }
    }

    public static func wikiLinks(_ titles: [String]) -> MarkdownSuggestionPlugin {
        MarkdownSuggestionPlugin(
            name: "mde.examples.wikilinks",
            triggers: [MarkdownSuggestionTrigger("[[", requiresBoundary: false, allowsSpaces: true)],
            accessibilityLabel: "Note suggestions"
        ) { _, complete in
            complete(titles.map {
                MarkdownSuggestionItem(id: $0, label: $0, replacement: "[[\($0)]]")
            })
        }
    }

    public static func slashCommands() -> MarkdownSuggestionPlugin {
        MarkdownSuggestionPlugin(
            name: "mde.examples.slash-menu",
            triggers: [MarkdownSuggestionTrigger("/", lineLeading: true)],
            maximumResults: 12, accessibilityLabel: "Editor commands"
        ) { request, complete in
            guard let editor = request.editor else { complete([]); return }
            complete(editor.registeredPluginCommands.filter(\.isEnabled).map { command in
                MarkdownSuggestionItem(
                    id: command.id, label: command.title,
                    detail: command.category ?? command.plugin,
                    group: command.category ?? "Commands", keywords: command.keywords,
                    select: { request in
                        guard let editor = request.editor else { return }
                        _ = editor.replaceMarkdown(in: request.match.range, with: "")
                        _ = editor.executePluginCommand(id: command.id)
                    }
                )
            })
        }
    }
}
