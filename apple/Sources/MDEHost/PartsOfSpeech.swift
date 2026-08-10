import Foundation
import MDECore
import MDEditorUI
import NaturalLanguage

/// Parts-of-speech highlighting — an extension, not a feature of the editor.
///
/// Like `TypewriterMode`, nothing in `MDEditorUI` knows this exists. It reads the
/// document, asks the operating system what each word is, and pushes a decoration layer
/// (DESIGN §5.3).
///
/// It is the more demanding of the two showcase extensions, because its decorations
/// depend on *language* — something the markdown parser has no concept of and never
/// will. The core supplies ranges and identity; what a range *means* is entirely the
/// host's business, which is what makes a feature like this possible without touching
/// the editor.
public final class PartsOfSpeech: MarkdownPlugin {
    public let name = "mde.parts-of-speech"
    private static let layer = "words"
    private static let analysis = "tag-document"

    private var context: MarkdownPluginContext?
    private var roles: [NLTag: UInt32] = [:]
    public private(set) var isEnabled = false

    /// The attributes this extension's roles need. See `TypewriterMode.themeRoles`.
    public static func themeRoles() -> [String: [NSAttributedString.Key: Any]] {
        [
            "pos-noun": [.foregroundColor: PlatformColor.systemBlue],
            "pos-verb": [.foregroundColor: PlatformColor.systemOrange],
            "pos-adjective": [.foregroundColor: PlatformColor.systemPurple],
            "pos-adverb": [.foregroundColor: PlatformColor.systemTeal],
        ]
    }

    public init() {}

    public func install(in context: MarkdownPluginContext) throws {
        self.context = context
        roles = [
            .noun: context.internRole("pos-noun"),
            .verb: context.internRole("pos-verb"),
            .adjective: context.internRole("pos-adjective"),
            .adverb: context.internRole("pos-adverb"),
        ]
    }

    public func uninstall() {
        isEnabled = false
        context = nil
        roles.removeAll()
    }

    public func markdownDidChange() { scheduleRecompute() }

    @discardableResult
    public func toggle() -> Bool {
        isEnabled ? disable() : enable()
        return isEnabled
    }

    public func enable() {
        guard !isEnabled else { return }
        isEnabled = true
        recompute()
    }

    public func disable() {
        guard isEnabled else { return }
        isEnabled = false
        context?.cancelAnalysis(Self.analysis)
        context?.clearLayer(Self.layer)
    }

    /// Tagging the whole document on every keystroke would be wasteful, and the core
    /// already slides existing spans over an edit so they stay on their words in the
    /// meantime (DESIGN §5.3) — so coalescing to a short idle is invisible.
    public func scheduleRecompute() {
        scheduleRecompute(after: 0.15)
    }

    public func recompute() {
        scheduleRecompute(after: 0)
    }

    private func scheduleRecompute(after delay: TimeInterval) {
        guard isEnabled, let context else { return }
        let roles = roles
        context.scheduleAnalysis(
            Self.analysis,
            delay: delay,
            analyze: { text, cancellation in
                Self.tag(text, roles: roles, cancellation: cancellation)
            },
            apply: { spans, context in context.setLayer(Self.layer, spans) }
        )
    }

    private static func tag(
        _ text: String,
        roles: [NLTag: UInt32],
        cancellation: MarkdownPluginAnalysisCancellation
    ) -> [LayerSpan] {
        guard !text.isEmpty else { return [] }

        let tagger = NLTagger(tagSchemes: [.lexicalClass])
        tagger.string = text

        var spans: [LayerSpan] = []
        tagger.enumerateTags(
            in: text.startIndex ..< text.endIndex,
            unit: .word,
            scheme: .lexicalClass,
            options: [.omitWhitespace, .omitPunctuation, .omitOther]
        ) { tag, range in
            guard !cancellation.isCancelled else { return false }
            guard let tag, let role = roles[tag] else { return true }
            // NSRange from String.Index, so the offsets are UTF-16 — which is what every
            // boundary in this API speaks (DESIGN §3.2).
            spans.append(LayerSpan(range: NSRange(range, in: text), role: role))
            return true
        }
        return spans
    }
}
