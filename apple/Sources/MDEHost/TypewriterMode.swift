import Foundation
import MDECore
import MDEditorUI
import MDEPluginKit

/// Typewriter (focus) mode — an extension, not a feature of the editor.
///
/// Nothing in `MDEditorUI` knows this type exists. It never touches TextKit, never asks
/// how a line is laid out, and never reaches into the applier. It watches the caret and
/// pushes a decoration layer (DESIGN §5.3): the paragraph being worked on gets one role,
/// everything else gets another, and the theme decides what those look like.
///
/// That is the point of the exercise. The declarative manifest — patterns and fences —
/// could never express this, because what to decorate depends on where the caret is,
/// which no parse can know. The layer API is what makes it possible from outside.
public final class TypewriterMode: MarkdownPlugin {
    public let name = "mde.typewriter"
    private static let layer = "focus"

    private var context: MarkdownPluginContext?
    private var focusRole: UInt32 = 0
    private var dimRole: UInt32 = 0
    public private(set) var isEnabled = false

    /// The attributes this extension's roles need.
    ///
    /// An extension owning its own theming is the other half of owning its own roles:
    /// the editor's `Theme` knows what the *parser* produces and nothing else, so a
    /// feature invented at runtime brings its own appearance with it.
    public static func themeRoles(bodyFont: PlatformFont) -> [String: [NSAttributedString.Key: Any]] {
        [
            "typewriter-dim": [.foregroundColor: PlatformColor.platformTertiaryLabel],
            "typewriter-focus": [
                .foregroundColor: PlatformColor.platformLabel,
                .font: bodyFont.withSize(bodyFont.pointSize + 1),
            ],
        ]
    }

    public init() {}

    public func install(in context: MarkdownPluginContext) throws {
        self.context = context
        focusRole = context.internRole("typewriter-focus")
        dimRole = context.internRole("typewriter-dim")
    }

    public func uninstall() {
        isEnabled = false
        context = nil
    }

    public func markdownDidChange() { recompute() }
    public func selectionDidChange() { recompute() }

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
        // `clearLayer`, not an empty push: the layer should give up its paint slot.
        context?.clearLayer(Self.layer)
    }

    public func recompute() {
        guard isEnabled, let context else { return }
        let text = context.document.markdown as NSString
        let caret = context.selection.range?.location ?? NSNotFound

        // No caret is not the same as a caret at 0. Dimming an entire document because
        // the editor lost focus would be a strange thing to look at.
        guard caret != NSNotFound, text.length > 0 else {
            context.setLayer(Self.layer, [])
            return
        }

        let focus = paragraphRange(in: text, containing: min(caret, text.length))
        var spans: [LayerSpan] = []
        if focus.location > 0 {
            spans.append(LayerSpan(range: NSRange(location: 0, length: focus.location), role: dimRole))
        }
        let tail = focus.upperBound
        if tail < text.length {
            spans.append(LayerSpan(range: NSRange(location: tail, length: text.length - tail), role: dimRole))
        }
        spans.append(contentsOf: focusSpans(over: focus))
        context.setLayer(Self.layer, spans)
    }

    /// The focused paragraph, split around any heading it contains.
    ///
    /// The focus role carries a slightly larger font, and attributes are applied in
    /// paint order — so a focus span laid over a heading would *shrink* the heading to
    /// body size, which reads as a bug rather than as focus. Skipping the heading's own
    /// range leaves it alone. The extension can do this because the editor already
    /// publishes what it decorated, and roles are just names.
    private func focusSpans(over range: NSRange) -> [LayerSpan] {
        guard let context else { return [] }
        let headings = context.semantics.query(MarkdownSemanticQuery(
            roles: ["heading"], range: range
        ))
            .map { NSIntersectionRange($0.range, range) }
            .sorted { $0.location < $1.location }

        var spans: [LayerSpan] = []
        var cursor = range.location
        for h in headings {
            if h.location > cursor {
                spans.append(
                    LayerSpan(range: NSRange(location: cursor, length: h.location - cursor), role: focusRole)
                )
            }
            cursor = max(cursor, h.upperBound)
        }
        if cursor < range.upperBound {
            spans.append(
                LayerSpan(range: NSRange(location: cursor, length: range.upperBound - cursor), role: focusRole)
            )
        }
        return spans
    }

    /// The paragraph containing `offset` — bounded by blank lines, matching how the core
    /// segments blocks.
    ///
    /// Deliberately a paragraph rather than a single line: focusing one visual line makes
    /// the mode flicker as the caret crosses a soft wrap, which reads as noise.
    private func paragraphRange(in text: NSString, containing offset: Int) -> NSRange {
        var start = text.lineRange(for: NSRange(location: offset, length: 0)).location
        while start > 0 {
            let previous = text.lineRange(for: NSRange(location: start - 1, length: 0))
            let line = text.substring(with: previous).trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { break }
            start = previous.location
        }

        var end = text.lineRange(for: NSRange(location: offset, length: 0)).upperBound
        while end < text.length {
            let next = text.lineRange(for: NSRange(location: end, length: 0))
            let line = text.substring(with: next).trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { break }
            end = next.upperBound
        }

        return NSRange(location: start, length: max(0, end - start))
    }
}
