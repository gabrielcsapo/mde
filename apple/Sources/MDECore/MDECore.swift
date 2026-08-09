import CMDE
import Foundation

/// The closed set of things a renderer must know how to draw (DESIGN §3).
public enum DecorationKind: UInt8, Sendable {
    case style = 0
    case conceal = 1
    case inlineWidget = 2
    case blockWidget = 3
    case gutter = 4
    case hit = 5
}

public enum Reveal: UInt8, Sendable {
    case never = 0
    case caretInNode = 1
    case caretInLine = 2
    case caretInBlock = 3
}

/// Built-in role ids. Extension roles are interned after these, so any id >=
/// `firstExtensionRole` needs a `roleName(_:)` lookup.
public enum Role {
    public static let heading: UInt32 = 0
    public static let marker: UInt32 = 1
    public static let emphasis: UInt32 = 2
    public static let strong: UInt32 = 3
    public static let codeInline: UInt32 = 4
    public static let codeBlock: UInt32 = 5
    public static let link: UInt32 = 6
    public static let linkText: UInt32 = 7
    public static let image: UInt32 = 8
    public static let quote: UInt32 = 9
    public static let listBullet: UInt32 = 10
    public static let taskCheckbox: UInt32 = 11
    public static let rule: UInt32 = 12
    public static let strikethrough: UInt32 = 13
    public static let table: UInt32 = 14
    public static let tableHeader: UInt32 = 15
    public static let tableDelimiter: UInt32 = 16
    public static let tableCell: UInt32 = 17
    public static let html: UInt32 = 18
    public static let firstExtensionRole: UInt32 = 19
}

/// Ranges are in UTF-16 code units, so they drop straight into `NSRange`.
public struct Decoration: Equatable, Sendable {
    /// Mutable so a renderer can absorb a `moved` entry in place rather than
    /// rebuilding the decoration.
    public var range: NSRange
    public let key: UInt64
    public let role: UInt32
    public let kind: DecorationKind
    public let reveal: Reveal
    public let depth: UInt8
    /// Paint order among ties. `0` is the parse; higher values are host layers, drawn
    /// after it and in ascending order, so a layer can deliberately override.
    public let layer: UInt8

    init(_ c: MdeDecoration) {
        self.range = NSRange(location: Int(c.start), length: Int(c.end - c.start))
        self.key = c.key
        self.role = c.role
        self.kind = DecorationKind(rawValue: c.kind) ?? .style
        self.reveal = Reveal(rawValue: c.reveal) ?? .never
        self.depth = c.depth
        self.layer = c.layer
    }
}

public struct Patch: Sendable {
    public let removed: [UInt64]
    public let added: [Decoration]
    /// Position changed but identity did not — move the view, do not rebuild it.
    public let moved: [(key: UInt64, range: NSRange)]

    public var isEmpty: Bool { removed.isEmpty && added.isEmpty && moved.isEmpty }

    init(_ p: UnsafePointer<MdePatch>) {
        let v = p.pointee
        removed = v.removed_len == 0
            ? []
            : Array(UnsafeBufferPointer(start: v.removed, count: v.removed_len))
        added = v.added_len == 0
            ? []
            : UnsafeBufferPointer(start: v.added, count: v.added_len).map(Decoration.init)
        moved = v.moved_len == 0
            ? []
            : UnsafeBufferPointer(start: v.moved, count: v.moved_len).map {
                ($0.key, NSRange(location: Int($0.start), length: Int($0.end - $0.start)))
            }
    }

    init() {
        removed = []
        added = []
        moved = []
    }
}

/// What a revision did. Coarse on purpose — the core knows which characters moved, not
/// what the person meant, and a label that guesses at intent is worse than one that
/// states what happened.
public enum RevisionKind: UInt8, Sendable {
    case insert = 0
    case delete = 1
    /// Both sides non-empty: a replacement, a paste over a selection, a command.
    case replace = 2
}

/// One entry in a browsable history.
public struct Revision: Equatable, Sendable, Identifiable {
    public var id: UInt32 { index }
    /// Position in the timeline. Jumping here means "the document immediately after
    /// this revision was applied".
    public let index: UInt32
    public let at: UInt32
    public let atMs: UInt64
    /// UTF-16 code units added and removed.
    public let inserted: UInt32
    public let removed: UInt32
    public let kind: RevisionKind

    init(_ c: MdeRevision) {
        self.index = c.index
        self.at = c.at
        self.atMs = c.at_ms
        self.inserted = c.inserted
        self.removed = c.removed
        self.kind = RevisionKind(rawValue: c.kind) ?? .replace
    }
}

/// One host-supplied decoration, offsets in UTF-16 code units.
public struct LayerSpan: Equatable, Sendable {
    public var range: NSRange
    public var role: UInt32
    public var kind: DecorationKind
    public var depth: UInt8

    public init(range: NSRange, role: UInt32, kind: DecorationKind = .style, depth: UInt8 = 0) {
        self.range = range
        self.role = role
        self.kind = kind
        self.depth = depth
    }
}

/// A text replacement, offsets in UTF-16 code units.
public struct TextEdit: Equatable, Sendable {
    public var range: NSRange
    public var text: String

    public init(range: NSRange, text: String) {
        self.range = range
        self.text = text
    }
}

/// What the platform must do to its own buffer after undo/redo.
public struct Rewind: Sendable {
    public let edits: [TextEdit]
    public let selection: NSRange?
    public let patch: Patch
}

public enum EngineError: Error, Equatable {
    /// The mirror and the platform buffer disagree. Recover with `reset(_:)`.
    case desync
    case outOfBounds
    case badArgument
    case unknown(UInt32)

    init?(status: UInt32) {
        switch status {
        case 0: return nil
        case 1: self = .desync
        case 2: self = .outOfBounds
        case 3: self = .badArgument
        default: self = .unknown(status)
        }
    }
}

/// Safe wrapper over the Rust core. Not thread-safe — drive it from the main actor,
/// which is where text input lives anyway.
public final class MarkdownEngine {
    private let handle: OpaquePointer
    private var roleNames: [UInt32: String] = [:]

    /// `manifest` is the extension manifest in TOML. Returns nil if it fails to parse.
    public init?(manifest: String? = nil) {
        let h: OpaquePointer? = if let manifest {
            manifest.withCString { mde_engine_new($0) }
        } else {
            mde_engine_new(nil)
        }
        guard let h else { return nil }
        self.handle = h
    }

    deinit { mde_engine_free(handle) }

    /// Full resync. Clears undo history — see DESIGN §9.
    @discardableResult
    public func reset(_ text: String) -> Patch {
        var bytes = Array(text.utf8)
        return bytes.withUnsafeMutableBufferPointer { buf in
            guard let p = mde_reset(handle, buf.baseAddress, buf.count) else { return Patch() }
            return Patch(p)
        }
    }

    /// Report edits the platform already applied. `documentLength` is the post-edit
    /// length in UTF-16 units and is checked against the mirror.
    ///
    /// Never call this for edits that came out of `undo()`/`redo()`.
    @discardableResult
    public func apply(
        _ edits: [TextEdit],
        documentLength: Int?,
        now: UInt64 = MarkdownEngine.now()
    ) throws -> Patch {
        // Keep every UTF-8 buffer alive for the duration of the call.
        let blobs = edits.map { Array($0.text.utf8) }
        var storage: [MdeEdit] = []
        storage.reserveCapacity(edits.count)

        func build(_ i: Int, _ finish: ([MdeEdit]) throws -> Patch) throws -> Patch {
            if i == edits.count { return try finish(storage) }
            return try blobs[i].withUnsafeBufferPointer { buf in
                storage.append(MdeEdit(
                    start: UInt32(edits[i].range.location),
                    end: UInt32(edits[i].range.location + edits[i].range.length),
                    text: buf.baseAddress,
                    text_len: buf.count
                ))
                return try build(i + 1, finish)
            }
        }

        return try build(0) { list in
            try list.withUnsafeBufferPointer { buf in
                let expected = documentLength.map(UInt32.init) ?? UInt32.max
                guard let p = mde_edit(handle, buf.baseAddress, buf.count, expected, now) else {
                    throw EngineError.badArgument
                }
                if let err = EngineError(status: p.pointee.status) { throw err }
                return Patch(p)
            }
        }
    }

    /// Pass nil on blur so the document collapses back to its rendered form.
    @discardableResult
    public func setSelection(_ range: NSRange?) -> Patch {
        let p: UnsafePointer<MdePatch>? = if let range {
            mde_set_selection(handle, UInt32(range.location), UInt32(range.location + range.length))
        } else {
            mde_clear_selection(handle)
        }
        guard let p else { return Patch() }
        return Patch(p)
    }

    // MARK: - Browsable history (DESIGN §9)

    /// The whole timeline, oldest first, *including revisions that have been undone*.
    ///
    /// Undo and redo are the two-button view of this. A history panel needs the list —
    /// and needs the undone branch to stay in it, or there is nothing to step forward to.
    public func revisions() -> [Revision] {
        var count = 0
        guard let ptr = mde_revisions(handle, &count), count > 0 else { return [] }
        return UnsafeBufferPointer(start: ptr, count: count).map(Revision.init)
    }

    /// How many revisions are applied — the caret's position in the timeline.
    public var historyPosition: Int { Int(mde_history_position(handle)) }

    /// Move to any point in the timeline rather than one step at a time.
    public func jump(to target: Int) -> Rewind? {
        rewind(mde_jump_to(handle, UInt32(target)))
    }

    // MARK: - Host decoration layers (DESIGN §5.3)

    /// Get (or create) the role id for a name, so a host can decorate with roles that
    /// no manifest declared.
    ///
    /// Roles are open strings by design: the core never interprets one, it only hands
    /// it back for the theme to look up. That is what lets a whole feature live outside
    /// the core and still use the same decoration pipeline.
    public func internRole(_ name: String) -> UInt32 {
        var bytes = Array(name.utf8)
        return bytes.withUnsafeMutableBufferPointer { buf in
            mde_intern_role(handle, buf.baseAddress, buf.count)
        }
    }

    /// Replace a named layer's decorations — ranges no parse produced, computed by the
    /// host from something the core knows nothing about: where the caret is, what a
    /// language tagger calls a word.
    ///
    /// They flow through the same identity and diffing machinery as parsed decorations,
    /// so a renderer needs no new code to draw them. Layers paint after the parse, in
    /// registration order.
    @discardableResult
    public func setLayer(_ name: String, _ spans: [LayerSpan]) -> Patch {
        var raw = spans.map {
            MdeLayerSpan(
                start: UInt32($0.range.location),
                end: UInt32($0.range.location + $0.range.length),
                role: $0.role,
                kind: $0.kind.rawValue,
                depth: $0.depth
            )
        }
        var bytes = Array(name.utf8)
        return bytes.withUnsafeMutableBufferPointer { n in
            raw.withUnsafeMutableBufferPointer { s in
                guard let p = mde_set_layer(handle, n.baseAddress, n.count, s.baseAddress, s.count)
                else { return Patch() }
                return Patch(p)
            }
        }
    }

    /// Remove a layer entirely. Not the same as pushing zero spans — an empty layer
    /// keeps its slot in the paint order.
    @discardableResult
    public func clearLayer(_ name: String) -> Patch {
        var bytes = Array(name.utf8)
        return bytes.withUnsafeMutableBufferPointer { buf in
            guard let p = mde_clear_layer(handle, buf.baseAddress, buf.count) else { return Patch() }
            return Patch(p)
        }
    }

    /// Force the next edit to begin a new undo step. Call before a formatting command.
    public func boundary() { mde_boundary(handle) }

    public var canUndo: Bool { mde_can_undo(handle) }
    public var canRedo: Bool { mde_can_redo(handle) }

    public func undo() -> Rewind? { rewind(mde_undo(handle)) }
    public func redo() -> Rewind? { rewind(mde_redo(handle)) }

    private func rewind(_ p: UnsafePointer<MdeRewind>?) -> Rewind? {
        guard let p else { return nil }
        let v = p.pointee
        let blob = v.text_len == 0
            ? Data()
            : Data(UnsafeBufferPointer(start: v.text, count: v.text_len))
        let edits: [TextEdit] = v.edits_len == 0
            ? []
            : UnsafeBufferPointer(start: v.edits, count: v.edits_len).map { e in
                let lo = Int(e.text_off)
                let text = String(decoding: blob[lo..<(lo + Int(e.text_len))], as: UTF8.self)
                return TextEdit(
                    range: NSRange(location: Int(e.start), length: Int(e.end - e.start)),
                    text: text
                )
            }
        let selection: NSRange? = v.has_selection
            ? NSRange(
                location: Int(min(v.sel_anchor, v.sel_head)),
                length: Int(max(v.sel_anchor, v.sel_head) - min(v.sel_anchor, v.sel_head))
            )
            : nil
        return Rewind(
            edits: edits,
            selection: selection,
            patch: withUnsafePointer(to: v.patch) { Patch($0) }
        )
    }

    /// Extra text the parser already resolved for this decoration: an image or link
    /// destination, table alignments, a fence argument, or a delimited token's content.
    ///
    /// A resource payload is a **reference, never content**. A document holds
    /// `![alt](photo.jpg)`, not the bytes of the photo; `ResourceResolver` displays it.
    public func payload(for key: UInt64) -> String? {
        var len = 0
        guard let ptr = mde_payload(handle, key, &len), len > 0 else { return nil }
        return String(decoding: UnsafeBufferPointer(start: ptr, count: len), as: UTF8.self)
    }

    /// Role name for theme lookup. Cached — the mapping never changes for an engine.
    public func roleName(_ role: UInt32) -> String? {
        if let cached = roleNames[role] { return cached }
        var len = 0
        guard let ptr = mde_role_name(handle, role, &len) else { return nil }
        let name = String(decoding: UnsafeBufferPointer(start: ptr, count: len), as: UTF8.self)
        roleNames[role] = name
        return name
    }

    /// Monotonic millisecond clock for undo coalescing.
    public static func now() -> UInt64 {
        UInt64(ProcessInfo.processInfo.systemUptime * 1000)
    }
}
