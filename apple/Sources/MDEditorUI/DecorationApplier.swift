import Foundation
import MDECore

#if os(macOS)
import AppKit
#else
import UIKit
#endif

extension Array {
    /// Index of the first element for which `predicate` is false, assuming the array is
    /// partitioned by it. Swift has no standard equivalent.
    func partitionPoint(_ predicate: (Element) -> Bool) -> Int {
        var lo = 0
        var hi = count
        while lo < hi {
            let mid = lo + (hi - lo) / 2
            if predicate(self[mid]) { lo = mid + 1 } else { hi = mid }
        }
        return lo
    }
}

/// Everything about turning decorations into text attributes, with no UIKit/AppKit
/// host in it. Both `MarkdownTextView`s drive this identically; keeping it here is what
/// stops the two platforms drifting apart on the semantics in DESIGN §4.
final class DecorationApplier {
    /// Above this size, resetting an entire paragraph for a tiny local edit becomes a
    /// TextKit denial of service. Dirty ranges already contain every removed and added
    /// decoration; repainting their local union is sufficient and preserves untouched
    /// attributes that NSTextStorage shifted with the edit.
    private static let localizedParagraphThreshold = 16 * 1024

    let engine: MarkdownEngine
    var theme: Theme
    /// Strong on purpose. A provider is a service the editor owns, not a delegate:
    /// hosts assign a freshly constructed one inline (`editor.widgetProvider =
    /// HostWidgets()`), and a weak reference would drop it before the first paint.
    /// Providers must not retain the editor.
    var widgetProvider: (any WidgetProvider)?
    /// Routes links inside presentation widgets back through the editor's delegate.
    var openLink: ((String) -> Void)?
    let resources = ResourceCache()

    /// Host-drawn widget views, kept by decoration key.
    ///
    /// This is safe precisely because keys are stable across edits (DESIGN §3.3): a key
    /// changes exactly when its node's own source changes, so the cache invalidates
    /// itself for free — no staleness rule to get wrong. Without it every re-layout of a
    /// paragraph asked the host to build its callout again.
    private var widgetViews: [UInt64: PlatformView] = [:]
    /// Insertion order, for eviction. A document can hold more widgets than it is worth
    /// keeping views for.
    private var widgetOrder: [UInt64] = []
    private let widgetCacheLimit = 256

    /// Every decoration in effect, by key. Kept so a `removed` entry can be resolved
    /// back to the range it used to occupy.
    private(set) var live: [UInt64: Decoration] = [:] {
        didSet { indexStale = true }
    }

    /// `live` sorted by location, so a repaint can binary-search the decorations that
    /// touch a paragraph instead of filtering all of them. Rebuilt lazily: a keystroke
    /// changes `live` several times before anything is drawn.
    private var index: [Decoration] = []
    private var indexStale = true
    /// Longest decoration in the index, so the backward search has a bound. A block
    /// widget can start far above the paragraph being repainted.
    private var maxLength = 0
    /// Payload-bearing decorations indexed by reference, so one resource completion
    /// does not scan the entire document (and then scan it again for a table parent).
    private var references: [String: Set<UInt64>] = [:]
    private var referenceByKey: [UInt64: String] = [:]

    /// Position-sorted view of `live`, for hosts and tests.
    var decorations: [Decoration] {
        rebuildIndexIfNeeded()
        return index
    }

    private func rebuildIndexIfNeeded() {
        guard indexStale else { return }
        index = live.values.sorted {
            ($0.range.location, $0.range.length) < ($1.range.location, $1.range.length)
        }
        maxLength = index.map(\.range.length).max() ?? 0
        indexStale = false
    }

    /// Decorations overlapping `scope`, found by binary search rather than by scanning
    /// every live decoration — which made a one-paragraph repaint cost O(document).
    func decorations(intersecting scope: NSRange) -> ArraySlice<Decoration> {
        rebuildIndexIfNeeded()
        guard !index.isEmpty else { return [] }
        let from = max(0, scope.location - maxLength)
        var lo = index.partitionPoint { $0.range.location < from }
        let hi = index.partitionPoint { $0.range.location < scope.upperBound }
        // `partitionPoint` gives a starting point; the slice is trimmed by the caller's
        // intersection test, which is cheap once the range is bounded.
        lo = min(lo, hi)
        return index[lo..<hi]
    }

    /// Guards re-entry: applying attributes re-enters the storage delegate.
    private(set) var isRepainting = false

    init(engine: MarkdownEngine, theme: Theme) {
        self.engine = engine
        self.theme = theme
    }

    func reset() {
        live.removeAll()
        references.removeAll()
        referenceByKey.removeAll()
        resources.reset()
        widgetViews.removeAll()
        widgetOrder.removeAll()
    }

    /// A previously built view for this widget, if one is still cached.
    func cachedWidgetView(for key: UInt64) -> PlatformView? {
        guard let view = widgetViews[key] else { return nil }
        // The caller re-parents it. A view lives in one place at a time, and the
        // container it came from is being discarded, so moving it is the point.
        view.removeFromSuperview()
        return view
    }

    func cacheWidgetView(_ view: PlatformView, for key: UInt64) {
        widgetViews[key] = view
        widgetOrder.append(key)
        guard widgetOrder.count > widgetCacheLimit else { return }
        // Drop the oldest entry that is no longer a live decoration before evicting
        // anything the document still points at.
        let victim = widgetOrder.firstIndex { live[$0] == nil } ?? 0
        widgetViews.removeValue(forKey: widgetOrder.remove(at: victim))
    }

    func ingest(_ patch: Patch) {
        // Cursor-style plugins replace one or two spans while the parsed document is
        // unchanged. Re-sorting tens of thousands of decorations for that tiny patch
        // made the renderer, not the now-constant-time core, the dominant cost. Keep
        // the materialised index in place only for small patches with no position
        // mutations; edits and bulk analysis layers retain the lazy rebuild path.
        let changed = patch.removed.count + patch.added.count
        let incrementalIndex = !indexStale
            && changed <= 16
            && patch.shifted.isEmpty
            && patch.moved.isEmpty
        let removedKeys = incrementalIndex ? Set(patch.removed) : []
        var removedLongest = false
        for key in patch.removed {
            if incrementalIndex, let removed = live[key], removed.range.length >= maxLength {
                removedLongest = true
            }
            unindexReference(key)
            live.removeValue(forKey: key)
            // A removed key can never come back: it encodes the node's own source, so
            // its view is unreachable and would just occupy the cache.
            if widgetViews.removeValue(forKey: key) != nil {
                widgetOrder.removeAll { $0 == key }
            }
        }
        if incrementalIndex, !removedKeys.isEmpty {
            index.removeAll { removedKeys.contains($0.key) }
        }
        for shift in patch.shifted {
            for key in Array(live.keys) {
                guard var d = live[key], d.range.location >= shift.start else { continue }
                d.range.location += shift.delta
                live[key] = d
            }
        }
        for move in patch.moved {
            if var d = live[move.key] {
                d.range = move.range
                live[move.key] = d
            }
        }
        for d in patch.added {
            unindexReference(d.key)
            live[d.key] = d
            guard d.role != Role.table, let reference = engine.payload(for: d.key) else { continue }
            referenceByKey[d.key] = reference
            references[reference, default: []].insert(d.key)
        }
        if incrementalIndex {
            for decoration in patch.added {
                let insertion = index.partitionPoint { existing in
                    if existing.range.location != decoration.range.location {
                        return existing.range.location < decoration.range.location
                    }
                    return existing.range.length <= decoration.range.length
                }
                index.insert(decoration, at: insertion)
                maxLength = max(maxLength, decoration.range.length)
            }
            if removedLongest { maxLength = index.map(\.range.length).max() ?? 0 }
            // `live`'s didSet conservatively dirtied the index for each dictionary
            // mutation above; the small-patch update has now brought it back in sync.
            indexStale = false
        }
    }

    private func unindexReference(_ key: UInt64) {
        guard let reference = referenceByKey.removeValue(forKey: key) else { return }
        references[reference]?.remove(key)
        if references[reference]?.isEmpty == true { references.removeValue(forKey: reference) }
    }

    /// The range a patch requires repainting.
    ///
    /// `shifted` and `moved` entries are deliberately excluded. Both preserve identity
    /// and attributes while changing only offsets — and `NSTextStorage` already carried
    /// those attributes along with the characters. Including them would drag the dirty
    /// range to the end of the document on every keystroke, making each character
    /// O(document) instead of O(paragraph).
    ///
    /// `alsoDirty` is the range the edit itself touched, which must be repainted even
    /// when no decoration changed: freshly inserted characters inherit the attributes
    /// of the character before them.
    /// Returns *disjoint ranges*, not a bounding box.
    ///
    /// A bounding box is a trap here. Editing a node changes how many byte-identical
    /// siblings precede its twin elsewhere, which changes that twin's key (DESIGN §3.3),
    /// which puts a removal half a document away from the caret. Unioning the two
    /// covered everything in between: one keystroke measured at 1844 ms instead of
    /// 0.33 ms. Two small ranges repaint two paragraphs.
    func dirtyRanges(for patch: Patch, alsoDirty: NSRange?) -> [NSRange] {
        var ranges: [NSRange] = []
        ranges.reserveCapacity(patch.added.count + patch.removed.count + 1)
        for key in patch.removed { if let d = live[key] { ranges.append(d.range) } }
        for d in patch.added { ranges.append(d.range) }
        if let alsoDirty { ranges.append(alsoDirty) }
        return Self.merged(ranges)
    }

    /// Sort and coalesce overlapping or adjacent ranges, so a cluster of changes in one
    /// paragraph becomes one repaint rather than a dozen.
    static func merged(_ ranges: [NSRange]) -> [NSRange] {
        guard !ranges.isEmpty else { return [] }
        let sorted = ranges.sorted { $0.location < $1.location }
        var out: [NSRange] = [sorted[0]]
        for r in sorted.dropFirst() {
            let last = out[out.count - 1]
            if r.location <= last.upperBound {
                out[out.count - 1] = NSUnionRange(last, r)
            } else {
                out.append(r)
            }
        }
        return out
    }

    /// Ranges of every node whose reference is `reference`, so a resolved resource
    /// repaints exactly the nodes that point at it.
    func ranges(referencing reference: String) -> [NSRange] {
        var ranges = [NSRange]()
        for key in references[reference] ?? [] {
            guard let decoration = live[key] else { continue }
            if let table = decorations(intersecting: decoration.range).first(where: {
                $0.kind == .blockWidget
                    && $0.role == Role.table
                    && $0.range.location <= decoration.range.location
                    && $0.range.upperBound >= decoration.range.upperBound
            }) {
                // The cached table contains the loading projection. Rebuild it now
                // that the nested resource is ready, without refetching the bytes.
                widgetViews.removeValue(forKey: table.key)?.removeFromSuperview()
                widgetOrder.removeAll { $0 == table.key }
                ranges.append(table.range)
            } else {
                ranges.append(decoration.range)
            }
        }
        return Self.merged(ranges)
    }

    /// Reset the affected scope to base attributes, then lay every live decoration back
    /// over it. Ordinary paragraphs repaint as a unit. Pathologically long paragraphs
    /// use the already-complete dirty range, avoiding seconds of redundant TextKit work.
    func repaint(_ range: NSRange, in storage: NSTextStorage) {
        guard !isRepainting, storage.length > 0 else { return }
        let ns = storage.string as NSString
        let clamped = NSIntersectionRange(range, NSRange(location: 0, length: ns.length))
        guard clamped.length > 0 || range.location < ns.length else { return }
        let paragraph = ns.paragraphRange(for: clamped)
        let scope: NSRange
        if paragraph.length >= Self.localizedParagraphThreshold,
           clamped.length < Self.localizedParagraphThreshold / 4 {
            // Include one neighbouring code unit so inserted text cannot retain an
            // attribute inherited from the character immediately across the boundary.
            let start = clamped.location > paragraph.location
                ? clamped.location - 1
                : paragraph.location
            let end = min(
                paragraph.upperBound,
                max(clamped.upperBound, clamped.location + 1) + 1
            )
            scope = NSRange(location: start, length: max(0, end - start))
        } else {
            scope = paragraph
        }

        isRepainting = true
        storage.beginEditing()
        storage.setAttributes(theme.baseAttributes, range: scope)

        let ordered = decorations(intersecting: scope)
            .filter { NSIntersectionRange($0.range, scope).length > 0 }
            // Ties break on `layer`, so a host layer paints over what the parse
            // decided — a focus-mode dim has to beat a heading's own colour, and
            // sorting by kind alone leaves their order undefined.
            .sorted {
                if paintOrder($0) != paintOrder($1) {
                    return paintOrder($0) < paintOrder($1)
                }
                if $0.layer != $1.layer {
                    return $0.layer < $1.layer
                }
                // Within one style layer, broad structural roles paint first and
                // narrower semantic roles win: table -> header -> cell, heading ->
                // emphasis. Dictionary iteration order must never choose the font.
                return $0.range.length > $1.range.length
            }

        for d in ordered {
            let r = NSIntersectionRange(d.range, scope)
            guard r.length > 0 else { continue }
            paint(d, in: r, source: ns, storage: storage)
        }
        storage.endEditing()
        isRepainting = false
    }

    /// Broad decorations paint first so narrow ones win: a concealed `**` must beat the
    /// emphasis span it sits inside.
    private func paintOrder(_ d: Decoration) -> Int {
        switch d.kind {
        case .style: 0
        case .gutter: 1
        case .hit: 2
        case .conceal: 3
        case .inlineWidget, .blockWidget: 4
        }
    }

    private func paint(
        _ d: Decoration,
        in range: NSRange,
        source ns: NSString,
        storage: NSTextStorage
    ) {
        switch d.kind {
        case .style, .gutter, .hit:
            let level = d.role == Role.heading
                ? (d.depth > 0 ? Int(d.depth) : headingLevel(at: d.range, in: ns))
                : 0
            let attrs = theme.attributes(
                role: d.role,
                roleName: engine.roleName(d.role),
                headingLevel: level
            )
            if !attrs.isEmpty { storage.addAttributes(attrs, range: range) }
            #if os(macOS)
            // TextKit 1 paints a background attached to a newline across the remaining
            // line fragment. Keep code-block backgrounds behind glyphs, matching UIKit
            // and TextKit 2, instead of producing a full-width grey stripe.
            if d.role == Role.codeBlock, attrs[.backgroundColor] != nil {
                for location in range.location ..< range.upperBound {
                    let character = ns.character(at: location)
                    if character == 0x0A || character == 0x0D {
                        storage.removeAttribute(
                            .backgroundColor,
                            range: NSRange(location: location, length: 1)
                        )
                    }
                }
            }
            #endif

        case .conceal:
            storage.addAttributes(Self.concealAttributes, range: range)

        case .inlineWidget, .blockWidget:
            guard isTopLevelWidget(d) else { return }
            #if os(macOS)
            if NSLocationInRange(d.range.location, range),
               let attachment = makeWidgetAttachment(
                   for: d,
                   backing: storage,
                   containerWidth: 320
               ) {
                storage.addAttribute(
                    Self.widgetAttachmentAttribute,
                    value: attachment,
                    range: NSRange(location: d.range.location, length: 1)
                )
            }
            #endif
            // Everything after the first character is concealed, including newlines
            // inside a block widget — a hairline newline contributes ~0 height, so only
            // the attachment/control glyph shows.
            let tail = NSRange(
                location: d.range.location + 1,
                length: max(0, d.range.length - 1)
            )
            let visible = NSIntersectionRange(tail, range)
            if visible.length > 0 {
                storage.addAttributes(Self.concealAttributes, range: visible)
            }
        }
    }

    /// Collapsing a range without changing the character count: a hairline font plus a
    /// clear colour. Line height is the max over the line, so shrinking the `#` on a
    /// heading does not shrink the heading. The characters remain selectable, which is
    /// why the core snaps selection endpoints out of concealed ranges.
    static let concealAttributes: [NSAttributedString.Key: Any] = [
        .font: PlatformFont.platformSystem(ofSize: 0.01),
        .foregroundColor: PlatformColor.clear,
    ]

    private func headingLevel(at range: NSRange, in ns: NSString) -> Int {
        let line = ns.lineRange(for: NSRange(location: range.location, length: 0))
        return ns.substring(with: line).prefix(while: { $0 == "#" }).count
    }

    // MARK: - Widget substitution

    #if os(macOS)
    static let widgetAttachmentAttribute = NSAttributedString.Key("MDEWidgetAttachment")
    #endif

    private func isTopLevelWidget(_ candidate: Decoration) -> Bool {
        !decorations(intersecting: candidate.range).contains(where: { outer in
            outer.key != candidate.key
                && outer.kind == .blockWidget
                && outer.range.location <= candidate.range.location
                && outer.range.upperBound >= candidate.range.upperBound
        })
    }

    private func topLevelWidgets(intersecting range: NSRange) -> [Decoration] {
        let overlapping = decorations(intersecting: range)
        return overlapping.filter { candidate in
            (candidate.kind == .inlineWidget || candidate.kind == .blockWidget)
                && candidate.range.length > 0
                && NSLocationInRange(candidate.range.location, range)
                && isTopLevelWidget(candidate)
        }
    }

    func makeWidgetAttachment(
        for widget: Decoration,
        backing: NSTextStorage,
        containerWidth: CGFloat
    ) -> WidgetAttachment? {
        guard let roleName = engine.roleName(widget.role),
              widget.range.length > 0,
              widget.range.upperBound <= backing.length
        else { return nil }
        let source = (backing.string as NSString).substring(with: widget.range)
        let baselineFont = backing.attribute(
            .font,
            at: widget.range.location,
            effectiveRange: nil
        ) as? PlatformFont ?? theme.bodyFont
        let tableModel = roleName == "table"
            ? MarkdownTableModel(
                source: source,
                tableRange: widget.range,
                decorations: Array(decorations(intersecting: widget.range)),
                alignmentPayload: engine.payload(for: widget.key),
                payload: { [engine] key in engine.payload(for: key) }
            )
            : nil
        let attachment = WidgetAttachment(
            roleName: roleName,
            source: source,
            payload: engine.payload(for: widget.key),
            provider: widgetProvider,
            resources: resources,
            cache: self,
            key: widget.key,
            baselineFont: baselineFont,
            isInline: widget.kind == .inlineWidget,
            tableModel: tableModel,
            openLink: openLink
        )
        attachment.fittingWidth = max(containerWidth, 1)
        return attachment
    }

    /// TextKit 2 lets the *display* string for a paragraph differ from the backing
    /// store. UIKit uses that to get an attachment glyph without writing a `U+FFFC`
    /// into the document. AppKit installs the same `WidgetAttachment` as a custom
    /// control-glyph attribute and overlays its native view instead.
    ///
    /// The substitution is strictly length-preserving: one source character becomes one
    /// attachment character. A length change here would desynchronise every selection
    /// and edit offset in the view.
    func substituteWidgets(
        in range: NSRange,
        backing: NSTextStorage,
        containerWidth: CGFloat
    ) -> NSTextParagraph? {
        let widgets = topLevelWidgets(intersecting: range)
        guard !widgets.isEmpty else { return nil }

        let display = NSMutableAttributedString(
            attributedString: backing.attributedSubstring(from: range)
        )
        for w in widgets.sorted(by: { $0.range.location > $1.range.location }) {
            let local = NSRange(location: w.range.location - range.location, length: 1)
            guard local.upperBound <= display.length,
                  let attachment = makeWidgetAttachment(
                      for: w,
                      backing: backing,
                      containerWidth: containerWidth
                  )
            else { continue }
            display.replaceCharacters(in: local, with: NSAttributedString(attachment: attachment))
        }
        assert(display.length == range.length, "widget substitution changed the length")
        return NSTextParagraph(attributedString: display)
    }

    /// The smallest `Hit` decoration containing `offset`, if any.
    func hit(at offset: Int) -> Decoration? {
        decorations(intersecting: NSRange(location: offset, length: 1))
            .filter { $0.kind == .hit && NSLocationInRange(offset, $0.range) }
            .min { $0.range.length < $1.range.length }
    }

    /// The smallest visible link label containing `offset`, if any.
    func link(at offset: Int) -> Decoration? {
        decorations(intersecting: NSRange(location: offset, length: 1))
            .filter {
                $0.role == Role.linkText && NSLocationInRange(offset, $0.range)
            }
            .min { $0.range.length < $1.range.length }
    }
}
