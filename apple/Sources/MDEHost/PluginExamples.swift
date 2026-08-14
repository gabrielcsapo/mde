import Foundation
import MDECore
import MDEPluginKit
import MDEditorUI

/// Package-quality example that discovers wiki links without retaining a text view.
public final class MarkdownBacklinks: MarkdownPlugin {
    public let name = "examples.backlinks"
    public let requirement = MarkdownPluginRequirement(
        capabilities: [.document, .decorations, .analysis, .commands]
    )
    private let resolve: @Sendable (String) -> Bool
    private let open: (String) -> Void
    private weak var context: MarkdownPluginContext?
    public init(resolve: @escaping @Sendable (String) -> Bool,
                open: @escaping (String) -> Void = { _ in }) {
        self.resolve = resolve; self.open = open
    }
    public func install(in context: MarkdownPluginContext) throws {
        self.context = context
        context.registerCommand("open", command: MarkdownPluginCommand(
            title: "Open backlink", category: "Navigate", keywords: ["wiki", "note"],
            isEnabled: { [weak self] in self?.linkAtSelection() != nil }
        ) { [weak self] in if let title = self?.linkAtSelection() { self?.open(title) } })
    }
    public func markdownDidChange() {
        guard let context else { return }
        let role = context.internRole("backlink")
        let resolver = resolve
        context.scheduleAnalysis("links", delay: 0.04, analyze: { markdown, cancellation in
            let source = markdown as NSString
            let expression = try! NSRegularExpression(pattern: #"\[\[([^\]\n]+)\]\]"#)
            return expression.matches(
                in: markdown, range: NSRange(location: 0, length: source.length)
            ).compactMap { match -> LayerSpan? in
                guard !cancellation.isCancelled,
                      resolver(source.substring(with: match.range(at: 1))) else { return nil }
                return LayerSpan(range: match.range, role: role)
            }
        }, apply: { spans, context in context.setLayer("backlinks", spans) })
    }
    private func linkAtSelection() -> String? {
        guard let context, let range = context.selection.range else { return nil }
        let source = context.document.markdown as NSString
        let expression = try! NSRegularExpression(pattern: #"\[\[([^\]\n]+)\]\]"#)
        return expression.matches(
            in: source as String, range: NSRange(location: 0, length: source.length)
        ).first(where: { $0.range.location <= range.location && NSMaxRange($0.range) >= range.location })
            .map { source.substring(with: $0.range(at: 1)) }
    }
}

/// Semantic media discovery with host-owned presentation, suitable for SwiftUI or UIKit/AppKit.
public final class MarkdownMediaGallery: MarkdownPlugin {
    public let name = "examples.media-gallery"
    public let requirement = MarkdownPluginRequirement(
        capabilities: [.semantics, .selection, .commands, .presentations]
    )
    private let present: ([MarkdownSemanticNode], MarkdownPluginContext) -> Void
    public init(present: @escaping ([MarkdownSemanticNode], MarkdownPluginContext) -> Void) {
        self.present = present
    }
    public func install(in context: MarkdownPluginContext) throws {
        context.registerCommand("show", command: MarkdownPluginCommand(
            title: "Show media gallery", category: "View", keywords: ["image", "media", "gallery"]
        ) { [present] in
            present(context.semantics.query(MarkdownSemanticQuery(roles: ["image"])), context)
        })
    }
}
