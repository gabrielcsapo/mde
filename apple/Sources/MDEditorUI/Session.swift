import Foundation

public struct MarkdownSessionDocument: Sendable, Equatable {
    public let id: String
    public var markdown: String
    public var selection: NSRange?
    public var touchedAt: TimeInterval
}

/// Bounded open-document state that saves source and selection before every switch.
public final class MarkdownSession {
    public let editor: MarkdownTextView
    public let maxDocuments: Int
    private var documents: [String: MarkdownSessionDocument] = [:]
    private var order: [String] = []
    public private(set) var activeDocumentID: String?

    public init(editor: MarkdownTextView, maxDocuments: Int = 16) {
        self.editor = editor
        self.maxDocuments = max(1, maxDocuments)
    }

    public var openDocumentIDs: [String] { order }

    public func open(id: String, markdown: String) throws {
        guard !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw MarkdownSessionError.emptyID
        }
        saveActive()
        var document = documents[id] ?? MarkdownSessionDocument(
            id: id, markdown: markdown, selection: nil, touchedAt: 0
        )
        document.touchedAt = Date.timeIntervalSinceReferenceDate
        documents[id] = document
        order.removeAll { $0 == id }
        order.append(id)
        activeDocumentID = id
        editor.setMarkdown(document.markdown)
        if let selection = document.selection, selection.upperBound <= editor.markdown.utf16.count {
            editor.selectedRange = selection
        }
        evictInactive()
    }

    @discardableResult
    public func switchTo(id: String) throws -> Bool {
        guard let document = documents[id] else { return false }
        if activeDocumentID != id { try open(id: id, markdown: document.markdown) }
        return true
    }

    @discardableResult
    public func close(id: String) -> Bool {
        let existed = documents.removeValue(forKey: id) != nil
        order.removeAll { $0 == id }
        if activeDocumentID == id { activeDocumentID = nil }
        return existed
    }

    public func snapshot(id: String) -> MarkdownSessionDocument? {
        if activeDocumentID == id { saveActive() }
        return documents[id]
    }

    public func saveActive() {
        guard let id = activeDocumentID, var document = documents[id] else { return }
        document.markdown = editor.markdown
        document.selection = editor.selectedRange
        document.touchedAt = Date.timeIntervalSinceReferenceDate
        documents[id] = document
    }

    private func evictInactive() {
        while order.count > maxDocuments,
              let candidate = order.first(where: { $0 != activeDocumentID }) {
            documents.removeValue(forKey: candidate)
            order.removeAll { $0 == candidate }
        }
    }
}

public enum MarkdownSessionError: Error { case emptyID }
