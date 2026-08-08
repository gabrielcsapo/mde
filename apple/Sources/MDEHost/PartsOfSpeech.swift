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
public final class PartsOfSpeech {
    public static let layer = "parts-of-speech"

    private unowned let editor: MarkdownTextView
    private let roles: [NLTag: UInt32]
    private var pending: DispatchWorkItem?
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

    public init(editor: MarkdownTextView) {
        self.editor = editor
        self.roles = [
            .noun: editor.internRole("pos-noun"),
            .verb: editor.internRole("pos-verb"),
            .adjective: editor.internRole("pos-adjective"),
            .adverb: editor.internRole("pos-adverb"),
        ]
    }

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
        pending?.cancel()
        editor.clearLayer(Self.layer)
    }

    /// Call from `markdownTextViewDidChange`.
    ///
    /// Tagging the whole document on every keystroke would be wasteful, and the core
    /// already slides existing spans over an edit so they stay on their words in the
    /// meantime (DESIGN §5.3) — so coalescing to a short idle is invisible.
    public func scheduleRecompute() {
        guard isEnabled else { return }
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.recompute() }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
    }

    public func recompute() {
        guard isEnabled else { return }
        let text = editor.markdown
        guard !text.isEmpty else {
            editor.setLayer(Self.layer, [])
            return
        }

        let tagger = NLTagger(tagSchemes: [.lexicalClass])
        tagger.string = text

        var spans: [LayerSpan] = []
        tagger.enumerateTags(
            in: text.startIndex ..< text.endIndex,
            unit: .word,
            scheme: .lexicalClass,
            options: [.omitWhitespace, .omitPunctuation, .omitOther]
        ) { tag, range in
            guard let tag, let role = roles[tag] else { return true }
            // NSRange from String.Index, so the offsets are UTF-16 — which is what every
            // boundary in this API speaks (DESIGN §3.2).
            spans.append(LayerSpan(range: NSRange(range, in: text), role: role))
            return true
        }
        editor.setLayer(Self.layer, spans)
    }
}
