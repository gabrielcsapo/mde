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
    public let maxWarmDocuments: Int
    public let maxWarmBytes: Int
    private var documents: [String: MarkdownSessionDocument] = [:]
    private var warm: [String: NSAttributedString] = [:]
    private var warmCosts: [String: Int] = [:]
    private var warmOrder: [String] = []
    private var order: [String] = []
    public private(set) var activeDocumentID: String?
    internal private(set) var projectionCaptureCount = 0

    public init(
        editor: MarkdownTextView,
        maxDocuments: Int = 16,
        maxWarmDocuments: Int = 4,
        maxWarmBytes: Int = 16 * 1024 * 1024
    ) {
        self.editor = editor
        self.maxDocuments = max(1, maxDocuments)
        self.maxWarmDocuments = max(0, min(self.maxDocuments, maxWarmDocuments))
        self.maxWarmBytes = max(0, maxWarmBytes)
    }

    public var openDocumentIDs: [String] { order }
    public var warmDocumentIDs: [String] { warmOrder }
    public var warmProjectionBytes: Int { warmCosts.values.reduce(0, +) }

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
        if let projection = warm[id],
           editor.restoreProjection(markdown: document.markdown, projection: projection) {
            warmOrder.removeAll { $0 == id }
            warmOrder.append(id)
        } else {
            editor.setMarkdown(document.markdown)
        }
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
        warm.removeValue(forKey: id)
        warmCosts.removeValue(forKey: id)
        warmOrder.removeAll { $0 == id }
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
        // A restored warm projection is already an immutable snapshot of this exact
        // source. Re-copying its entire attributed string on every switch creates
        // document-sized transient allocations even when the user changed nothing.
        // Preserve it and only capture again after the source actually diverges.
        if maxWarmDocuments > 0, warm[id]?.string == document.markdown {
            warmOrder.removeAll { $0 == id }
            warmOrder.append(id)
        } else if maxWarmDocuments > 0, let projection = editor.captureProjection() {
            projectionCaptureCount += 1
            warm[id] = projection
            // UTF-16 storage is the stable lower bound. Attribute dictionaries may
            // share values, so avoid pretending an imprecise heap estimate is exact.
            warmCosts[id] = projection.length * MemoryLayout<unichar>.stride
            warmOrder.removeAll { $0 == id }
            warmOrder.append(id)
            while warmOrder.count > maxWarmDocuments || warmProjectionBytes > maxWarmBytes {
                let victim = warmOrder.removeFirst()
                warm.removeValue(forKey: victim)
                warmCosts.removeValue(forKey: victim)
            }
        }
    }

    private func evictInactive() {
        while order.count > maxDocuments,
              let candidate = order.first(where: { $0 != activeDocumentID }) {
            documents.removeValue(forKey: candidate)
            warm.removeValue(forKey: candidate)
            warmCosts.removeValue(forKey: candidate)
            warmOrder.removeAll { $0 == candidate }
            order.removeAll { $0 == candidate }
        }
    }
}

public enum MarkdownSessionError: Error { case emptyID }
