import Foundation

public enum MarkdownCommand: String, Sendable {
    case bold, italic, code, link, heading, bulletList, orderedList, taskList, quote
}

public struct MarkdownCommandResult: Sendable, Equatable {
    public let range: NSRange
    public let text: String
    public let selection: NSRange
}

public func markdownCommand(
    _ command: MarkdownCommand,
    markdown: String,
    selection: NSRange
) -> MarkdownCommandResult {
    let source = markdown as NSString
    let safe = NSIntersectionRange(selection, NSRange(location: 0, length: source.length))
    let selected = source.substring(with: safe)
    func wrap(_ open: String, _ close: String? = nil, placeholder: String = "text")
        -> MarkdownCommandResult {
        let close = close ?? open
        let body = selected.isEmpty ? placeholder : selected
        let openLength = open.utf16.count
        let bodyLength = body.utf16.count
        return MarkdownCommandResult(
            range: safe,
            text: open + body + close,
            selection: NSRange(location: safe.location + openLength, length: bodyLength)
        )
    }
    switch command {
    case .bold: return wrap("**")
    case .italic: return wrap("*")
    case .code: return wrap("`", placeholder: "code")
    case .link: return wrap("[", "](https://)", placeholder: "label")
    default: break
    }
    let lines = source.lineRange(for: safe)
    let body = source.substring(with: lines)
    let parts = body.split(separator: "\n", omittingEmptySubsequences: false)
    let prefixed = parts.enumerated().map { index, line -> String in
        let prefix: String
        switch command {
        case .heading: prefix = "# "
        case .bulletList: prefix = "- "
        case .orderedList: prefix = "\(index + 1). "
        case .taskList: prefix = "- [ ] "
        case .quote: prefix = "> "
        default: prefix = ""
        }
        return prefix + line
    }.joined(separator: "\n")
    let firstPrefix = command == .orderedList ? 3 : [
        MarkdownCommand.heading: 2, .bulletList: 2, .taskList: 6, .quote: 2,
    ][command] ?? 0
    return MarkdownCommandResult(
        range: lines,
        text: prefixed,
        selection: NSRange(
            location: safe.location + firstPrefix,
            length: safe.length + prefixed.utf16.count - lines.length - firstPrefix
        )
    )
}

public extension MarkdownTextView {
    @discardableResult
    func execute(_ command: MarkdownCommand, selection: NSRange? = nil) -> Bool {
        let result = markdownCommand(command, markdown: markdown, selection: selection ?? selectedRange)
        closeUndoGroup()
        guard let textStorage else { return false }
        textStorage.replaceCharacters(in: result.range, with: result.text)
        closeUndoGroup()
        selectedRange = result.selection
        return true
    }
}
