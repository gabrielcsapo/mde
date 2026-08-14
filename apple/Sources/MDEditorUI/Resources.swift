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

    public init(
        reference: String,
        roleName: String,
        source: String,
        fittingWidth: CGFloat
    ) {
        self.reference = reference
        self.roleName = roleName
        self.source = source
        self.fittingWidth = fittingWidth
    }
}

public enum ResourceState {
    case loading
    /// A usable low-cost representation while final resolution continues.
    case preview(PlatformView)
    case ready(PlatformView)
    case failed(String)
}

extension ResourceState {
    var resourceView: PlatformView? {
        switch self {
        case .preview(let view), .ready(let view): return view
        case .loading, .failed: return nil
        }
    }
}

/// Optional memory accounting supplied by decoded-image and generated-preview views.
/// The cache uses this to enforce an aggregate decoded-pixel ceiling, not merely a
/// count of native view objects.
public protocol ResourceMemoryCostProviding {
    var resourceMemoryCostBytes: Int { get }
}

/// Optional estimate of peak decode memory before work starts. Retained-view limits
/// apply after decoding; this admission estimate prevents several huge source images
/// from expanding simultaneously before any view reaches that cache.
public protocol ResourceDecodeCostEstimating: ResourceResolver {
    func estimatedDecodeMemoryBytes(_ request: ResourceRequest) -> Int
}

/// Optional teardown for resource views that own players, object stores, or other
/// state not released merely by removing the view from the hierarchy.
public protocol ResourceDisposing {
    func disposeResource()
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
    /// `deliver` may publish previews and must eventually publish one `.ready` or
    /// `.failed` terminal state. Deliveries are made on the main thread.
    func resolve(
        _ request: ResourceRequest,
        deliver: @escaping (ResourceState) -> Void
    ) -> ResourceState

    /// Space to reserve while loading, so the document does not jump when the
    /// resource lands. Best effort — a host that knows the real dimensions from a
    /// sidecar or filename should say so here.
    func reservedSize(_ request: ResourceRequest) -> CGSize
}

/// Optional cancellation hook for resolvers that own network, decode, or media work.
/// `ResourceCache` calls it when the editor replaces its document, while still using
/// generation checks to make a late completion harmless for resolvers that cannot stop.
public protocol CancellableResourceResolver: ResourceResolver {
    func cancel(_ references: Set<String>)
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
    /// Decode/network work is intentionally bounded. A journal with hundreds of media
    /// references must not turn one layout pass into hundreds of simultaneous tasks.
    var maxConcurrent = 6
    private(set) var peakConcurrent = 0
    var maxInFlightMemoryBytes = 48 * 1024 * 1024
    private(set) var inFlightMemoryBytes = 0
    private(set) var peakInFlightMemoryBytes = 0
    /// Resolved native views are substantially heavier than their remembered geometry.
    /// Keep only a viewport-sized LRU; an evicted reference can be recreated by the
    /// resolver while `known` continues to reserve the correct box.
    var maxReadyViews = 32
    private(set) var readyViewCount = 0
    var maxReadyViewMemoryBytes = 64 * 1024 * 1024
    private(set) var readyViewMemoryBytes = 0

    /// Seed sizes remembered from a previous session.
    func remember(_ sizes: [String: CGSize]) {
        for (reference, size) in sizes where size.width > 0 && size.height > 0 {
            known[reference] = size
        }
    }

    private var states: [String: ResourceState] = [:]
    private var reserved: [String: CGSize] = [:]
    private var representationWidths: [String: CGFloat] = [:]
    private var inFlight: Set<String> = []
    private var inFlightMemoryCosts: [String: Int] = [:]
    private struct Pending {
        let request: ResourceRequest
        let presentationWidth: CGFloat
        let generation: UInt64
        let order: UInt64
        var priority: Int
    }
    private var pending: [Pending] = []
    private var nextOrder: UInt64 = 0
    private var readyOrder: [String] = []
    private var readyMemoryCosts: [String: Int] = [:]
    private var viewportReferences: Set<String> = []
    /// Invalidates deliveries belonging to a document that has since been reset.
    private var generation: UInt64 = 0
    private var suspended = false

    /// Sizes learned from resources that have already resolved, keyed by reference.
    ///
    /// This is what stops `reservedSize` being a guess *twice*. The first time a
    /// reference is seen nobody knows how big it is, so the document shifts once when
    /// it lands. Handing these back to the host to persist, and seeding them on open,
    /// means that shift happens at most once per asset ever rather than once per launch.
    private(set) var known: [String: CGSize] = [:]

    func reset() {
        if !inFlight.isEmpty {
            (resolver as? any CancellableResourceResolver)?.cancel(inFlight)
        }
        generation &+= 1
        dispose(states.values)
        states.removeAll()
        reserved.removeAll()
        representationWidths.removeAll()
        inFlight.removeAll()
        inFlightMemoryCosts.removeAll()
        inFlightMemoryBytes = 0
        pending.removeAll()
        readyOrder.removeAll()
        readyMemoryCosts.removeAll()
        viewportReferences.removeAll()
        readyViewCount = 0
        readyViewMemoryBytes = 0
        // `known` deliberately survives: it describes assets, not this document.
    }

    func suspend() {
        guard !suspended else { return }
        suspended = true
        if !inFlight.isEmpty {
            (resolver as? any CancellableResourceResolver)?.cancel(inFlight)
        }
        generation &+= 1
        states = states.filter { _, state in
            switch state {
            case .loading: return false
            case .preview(let view):
                (view as? any ResourceDisposing)?.disposeResource()
                return false
            case .ready, .failed: return true
            }
        }
        inFlight.removeAll()
        inFlightMemoryCosts.removeAll()
        inFlightMemoryBytes = 0
        pending.removeAll()
    }

    func resume() { suspended = false }

    func state(for request: ResourceRequest) -> ResourceState {
        if let cached = states[request.reference] {
            let requestedWidth = Self.representationWidth(request.fittingWidth)
            let cachedWidth = representationWidths[request.reference] ?? 0
            if requestedWidth <= cachedWidth {
                if case .ready = cached { touchReady(request.reference) }
                return cached
            }
            // The same reference may first appear as a tiny table thumbnail and later
            // as a full-width journal image. Upgrade at stable width buckets instead
            // of pinning the first undersized decode forever or decoding every point
            // crossed during a live resize.
            (resolver as? any CancellableResourceResolver)?.cancel([request.reference])
            inFlight.remove(request.reference)
            inFlightMemoryCosts.removeValue(forKey: request.reference)
            pending.removeAll { $0.request.reference == request.reference }
            if case .preview(let view) = cached {
                (view as? any ResourceDisposing)?.disposeResource()
            } else if case .ready(let view) = cached {
                (view as? any ResourceDisposing)?.disposeResource()
                readyOrder.removeAll { $0 == request.reference }
                readyMemoryCosts.removeValue(forKey: request.reference)
                readyViewCount = readyOrder.count
                readyViewMemoryBytes = readyMemoryCosts.values.reduce(0, +)
            }
            states.removeValue(forKey: request.reference)
            updateInFlightMemory()
        }
        guard let resolver else { return .failed("no resolver") }
        guard !suspended else {
            reserved[request.reference] = known[request.reference]
                ?? resolver.reservedSize(request)
            return .loading
        }

        // Widget substitution can run before the text container has been laid out, when
        // its width is still zero. Resolving then bakes that width into the result — an
        // image sized to one point, cached forever, rendered as an invisible gap. Wait
        // for a real width; layout will ask again.
        guard request.fittingWidth > 1 else { return .loading }

        // A size we have seen before beats anything the resolver can guess.
        reserved[request.reference] = known[request.reference] ?? resolver.reservedSize(request)

        let resolutionWidth = Self.representationWidth(request.fittingWidth)
        representationWidths[request.reference] = resolutionWidth
        states[request.reference] = .loading
        pending.append(Pending(
            request: ResourceRequest(
                reference: request.reference,
                roleName: request.roleName,
                source: request.source,
                fittingWidth: resolutionWidth
            ),
            presentationWidth: request.fittingWidth,
            generation: generation,
            order: nextOrder,
            priority: 100
        ))
        nextOrder &+= 1
        pump()
        return states[request.reference] ?? .loading
    }

    /// Move queued references ahead of speculative offscreen work.
    func prioritize(_ references: Set<String>, priority: Int = 0) {
        viewportReferences = references
        for index in pending.indices where references.contains(pending[index].request.reference) {
            pending[index].priority = priority
        }
        // A rapid scroll should spend the bounded decoder slots on the destination,
        // not on media that has already left the overscanned viewport. Removing the
        // loading state makes a cancelled reference demand-loadable if the user
        // scrolls back; late resolver callbacks are ignored by the in-flight guard.
        if !references.isEmpty {
            let stale = inFlight.subtracting(references)
            if !stale.isEmpty {
                (resolver as? any CancellableResourceResolver)?.cancel(stale)
                inFlight.subtract(stale)
                for reference in stale {
                    inFlightMemoryCosts.removeValue(forKey: reference)
                    if let state = states.removeValue(forKey: reference),
                       case .preview(let view) = state {
                        (view as? any ResourceDisposing)?.disposeResource()
                    }
                }
                updateInFlightMemory()
            }
        }
        evictReadyViews()
        pump()
    }

    private func pump() {
        guard resolver != nil, !suspended else { return }
        pending.sort { lhs, rhs in
            lhs.priority == rhs.priority ? lhs.order < rhs.order : lhs.priority < rhs.priority
        }
        while inFlight.count < max(1, maxConcurrent), !pending.isEmpty {
            let next = pending.first!
            let cost = estimatedDecodeCost(next.request)
            if !inFlight.isEmpty, inFlightMemoryBytes + cost > max(1, maxInFlightMemoryBytes) {
                break
            }
            let item = pending.removeFirst()
            guard item.generation == generation else { continue }
            start(item, estimatedCost: cost)
        }
    }

    private func start(_ item: Pending, estimatedCost: Int) {
        guard let resolver else { return }
        let request = item.request
        let reference = request.reference
        let fitting = item.presentationWidth
        inFlight.insert(reference)
        inFlightMemoryCosts[reference] = estimatedCost
        updateInFlightMemory()
        peakConcurrent = max(peakConcurrent, inFlight.count)

        // Guard against a resolver that delivers synchronously: `deliver` may run
        // before `resolve` returns, in which case the return value is stale and must
        // not overwrite the delivered state.
        var settled = false
        let immediate = resolver.resolve(request) { [weak self] state in
            guard let self,
                  self.generation == item.generation,
                  self.inFlight.contains(reference)
            else { return }
            settled = true
            self.finish(state, reference: reference, fitting: fitting)
        }
        if !settled {
            states[reference] = immediate
            record(immediate, for: reference, fitting: fitting)
            switch immediate {
            case .loading, .preview: break
            case .ready, .failed:
                inFlight.remove(reference)
                inFlightMemoryCosts.removeValue(forKey: reference)
                updateInFlightMemory()
                onResolved?(reference)
                pump()
            }
        }
    }

    private func finish(_ state: ResourceState, reference: String, fitting: CGFloat) {
        if case .preview = state {
            states[reference] = state
            record(state, for: reference, fitting: fitting)
            onResolved?(reference)
            return
        }
        inFlight.remove(reference)
        inFlightMemoryCosts.removeValue(forKey: reference)
        updateInFlightMemory()
        if case .preview(let preview) = states[reference] {
            (preview as? any ResourceDisposing)?.disposeResource()
        }
        states[reference] = state
        record(state, for: reference, fitting: fitting)
        onResolved?(reference)
        pump()
    }

    /// Learn the size of anything that actually resolved.
    ///
    /// Both delivery paths go through here. A resolver is free to answer synchronously
    /// — a bundled asset, a warm cache — and those resolutions are exactly the ones
    /// most worth remembering, so measuring only in the `deliver` closure would miss
    /// them.
    private func record(_ state: ResourceState, for reference: String, fitting: CGFloat) {
        let view: PlatformView
        switch state {
        case .preview(let preview): view = preview
        case .ready(let ready): view = ready
        case .loading, .failed: return
        }
        // Cap to the column, never to the previous reservation: that reservation was a
        // guess, and capping the truth to a guess would record anything wider than the
        // guess at the wrong size and keep it wrong forever.
        let size = view.measured(cappedTo: fitting)
        guard size.width > 0, size.height > 0 else { return }
        reserved[reference] = size
        known[reference] = size
        if case .ready = state {
            readyMemoryCosts[reference] = max(
                0, (view as? any ResourceMemoryCostProviding)?.resourceMemoryCostBytes ?? 0
            )
            touchReady(reference)
            evictReadyViews()
        }
    }

    private func touchReady(_ reference: String) {
        readyOrder.removeAll { $0 == reference }
        readyOrder.append(reference)
        readyViewCount = readyOrder.count
        readyViewMemoryBytes = readyMemoryCosts.values.reduce(0, +)
    }

    private func evictReadyViews() {
        let limit = max(1, maxReadyViews)
        let memoryLimit = max(1, maxReadyViewMemoryBytes)
        while (readyViewCount > limit || readyViewMemoryBytes > memoryLimit), !readyOrder.isEmpty {
            let victim = readyOrder.firstIndex { !viewportReferences.contains($0) } ?? 0
            let reference = readyOrder.remove(at: victim)
            guard case .ready(let view) = states[reference] else { continue }
            (view as? any ResourceDisposing)?.disposeResource()
            states.removeValue(forKey: reference)
            readyMemoryCosts.removeValue(forKey: reference)
            readyViewCount = readyOrder.count
            readyViewMemoryBytes = readyMemoryCosts.values.reduce(0, +)
        }
    }

    private func estimatedDecodeCost(_ request: ResourceRequest) -> Int {
        max(0, (resolver as? any ResourceDecodeCostEstimating)?
            .estimatedDecodeMemoryBytes(request) ?? 0)
    }

    private func updateInFlightMemory() {
        inFlightMemoryBytes = inFlightMemoryCosts.values.reduce(0, +)
        peakInFlightMemoryBytes = max(peakInFlightMemoryBytes, inFlightMemoryBytes)
    }

    private static func representationWidth(_ width: CGFloat) -> CGFloat {
        let step: CGFloat = 64
        return max(step, ceil(max(width, 1) / step) * step)
    }

    private func dispose(_ states: Dictionary<String, ResourceState>.Values) {
        for state in states {
            switch state {
            case .preview(let view), .ready(let view):
                (view as? any ResourceDisposing)?.disposeResource()
            case .loading, .failed: break
            }
        }
    }

    func size(for request: ResourceRequest) -> CGSize {
        // Asking for a size is also what starts resolution. Layout is often the first
        // caller that knows a real width — the widget substitution that runs before it
        // sees a zero-width text container — so if only `state(for:)` could start the
        // load, a resource requested too early would sit at "loading" forever with
        // nothing ever asking again.
        switch state(for: request) {
        case .preview(let view), .ready(let view):
            return view.measured(cappedTo: request.fittingWidth)
        case .loading, .failed: break
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
