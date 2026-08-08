import CoreGraphics
import Foundation
import MDECore

/// Everything a host needs to turn a reference into something displayable.
public struct ResourceRequest {
    /// The reference the parser extracted — an image or link destination, a fence
    /// argument. This is a *path or URL*, never content.
    public let reference: String
    /// The manifest role, e.g. `"image"` or a host's own `"attachment"`.
    public let roleName: String
    /// The full markdown source of the node, for hosts that need more than the
    /// reference (alt text, title).
    public let source: String
    /// Width available in the text container.
    public let fittingWidth: CGFloat
}

public enum ResourceState {
    case loading
    case ready(PlatformView)
    case failed(String)
}

/// Turns a reference in the document into a view.
///
/// This exists because the document must stay a portable markdown string. A note
/// holds `![chart](assets/q3.png)` or `[spec](docs/spec.pdf)` — never the bytes.
/// Inlining an image, video, or document as base64 would balloon the file, break
/// diffing, and stop other markdown tools from reading it. So the editor asks the
/// host, which already knows where its assets live and how to fetch them.
///
/// Resolution is expected to be asynchronous. Return `.loading` immediately, reserve
/// space with `reservedSize`, and call `deliver` when the resource arrives — the
/// editor re-lays out just that node, so nothing else on screen moves.
public protocol ResourceResolver: AnyObject {
    /// Called on the main thread. Return the state you have now; if it is `.loading`,
    /// invoke `deliver` later (also on the main thread) exactly once.
    func resolve(
        _ request: ResourceRequest,
        deliver: @escaping (ResourceState) -> Void
    ) -> ResourceState

    /// Space to reserve while loading, so the document does not jump when the
    /// resource lands. Best effort — a host that knows the real dimensions from a
    /// sidecar or filename should say so here.
    func reservedSize(_ request: ResourceRequest) -> CGSize
}

/// Caches resolution by reference, so the same asset used twice loads once and a
/// re-layout never refetches.
///
/// The cache is keyed by reference rather than by decoration key deliberately: the
/// decoration key changes whenever the node's source is edited, but
/// `![a](x.png)` and `![b](x.png)` are the same asset.
final class ResourceCache {
    /// Strong, for the same reason as `DecorationApplier.widgetProvider`: hosts write
    /// `editor.resourceResolver = DiskResourceResolver(root: ...)` and a weak reference
    /// would deallocate it before the first reference resolves. Resolvers must not
    /// retain the editor.
    var resolver: (any ResourceResolver)?
    /// Called with the reference when a pending resource resolves, so the host can
    /// repaint exactly the nodes that point at it.
    var onResolved: ((String) -> Void)?

    /// Seed sizes remembered from a previous session.
    func remember(_ sizes: [String: CGSize]) {
        for (reference, size) in sizes where size.width > 0 && size.height > 0 {
            known[reference] = size
        }
    }

    private var states: [String: ResourceState] = [:]
    private var reserved: [String: CGSize] = [:]
    private var inFlight: Set<String> = []

    /// Sizes learned from resources that have already resolved, keyed by reference.
    ///
    /// This is what stops `reservedSize` being a guess *twice*. The first time a
    /// reference is seen nobody knows how big it is, so the document shifts once when
    /// it lands. Handing these back to the host to persist, and seeding them on open,
    /// means that shift happens at most once per asset ever rather than once per launch.
    private(set) var known: [String: CGSize] = [:]

    func reset() {
        states.removeAll()
        reserved.removeAll()
        inFlight.removeAll()
        // `known` deliberately survives: it describes assets, not this document.
    }

    func state(for request: ResourceRequest) -> ResourceState {
        if let cached = states[request.reference] { return cached }
        guard let resolver else { return .failed("no resolver") }

        // Widget substitution can run before the text container has been laid out, when
        // its width is still zero. Resolving then bakes that width into the result — an
        // image sized to one point, cached forever, rendered as an invisible gap. Wait
        // for a real width; layout will ask again.
        guard request.fittingWidth > 1 else { return .loading }

        // A size we have seen before beats anything the resolver can guess.
        reserved[request.reference] = known[request.reference] ?? resolver.reservedSize(request)

        // Guard against a resolver that delivers synchronously: `deliver` may run
        // before `resolve` returns, in which case the return value is stale and must
        // not overwrite the delivered state.
        var settled = false
        inFlight.insert(request.reference)
        let reference = request.reference
        let fitting = request.fittingWidth
        let immediate = resolver.resolve(request) { [weak self] state in
            guard let self, self.inFlight.contains(reference) else { return }
            settled = true
            self.inFlight.remove(reference)
            self.states[reference] = state
            self.record(state, for: reference, fitting: fitting)
            self.onResolved?(reference)
        }
        if !settled {
            states[request.reference] = immediate
            record(immediate, for: request.reference, fitting: fitting)
            if case .loading = immediate {} else { inFlight.remove(request.reference) }
        }
        return states[request.reference] ?? .loading
    }

    /// Learn the size of anything that actually resolved.
    ///
    /// Both delivery paths go through here. A resolver is free to answer synchronously
    /// — a bundled asset, a warm cache — and those resolutions are exactly the ones
    /// most worth remembering, so measuring only in the `deliver` closure would miss
    /// them.
    private func record(_ state: ResourceState, for reference: String, fitting: CGFloat) {
        guard case .ready(let view) = state else { return }
        // Cap to the column, never to the previous reservation: that reservation was a
        // guess, and capping the truth to a guess would record anything wider than the
        // guess at the wrong size and keep it wrong forever.
        let size = view.measured(cappedTo: fitting)
        guard size.width > 0, size.height > 0 else { return }
        reserved[reference] = size
        known[reference] = size
    }

    func size(for request: ResourceRequest) -> CGSize {
        // Asking for a size is also what starts resolution. Layout is often the first
        // caller that knows a real width — the widget substitution that runs before it
        // sees a zero-width text container — so if only `state(for:)` could start the
        // load, a resource requested too early would sit at "loading" forever with
        // nothing ever asking again.
        if case .ready(let view) = state(for: request) {
            return view.measured(cappedTo: request.fittingWidth)
        }
        return known[request.reference]
            ?? reserved[request.reference]
            ?? resolver?.reservedSize(request)
            ?? CGSize(width: min(request.fittingWidth, 240), height: 32)
    }
}

extension PlatformView {
    /// Size the view wants, capped to the available width.
    ///
    /// Three sources, in order, because widget views legitimately size themselves three
    /// different ways: an explicit `intrinsicContentSize`, Auto Layout, or just a frame.
    /// Asking Auto Layout alone returns zero for a frame-based view — which measured a
    /// resolved image at 1x1 point and rendered it as an invisible gap, with no error
    /// anywhere to say so.
    func measured(cappedTo width: CGFloat) -> CGSize {
        let cap = width > 0 ? width : 320

        var size = intrinsicContentSize
        if size.width <= 0 || size.height <= 0 {
            #if os(macOS)
            size = fittingSize
            #else
            size = systemLayoutSizeFitting(
                CGSize(width: cap, height: 0),
                withHorizontalFittingPriority: .fittingSizeLevel,
                verticalFittingPriority: .fittingSizeLevel
            )
            #endif
        }
        if size.width <= 0 || size.height <= 0 {
            size = frame.size
        }
        return CGSize(width: min(max(size.width, 1), cap), height: max(size.height, 1))
    }
}
