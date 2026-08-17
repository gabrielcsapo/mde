import Foundation
import MDECore

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Draws a replaced range. This is the one seam a host implements per platform
/// (DESIGN §5) — the core resolves syntax, ranges, reveal state, identity, and the
/// reference; the host only draws.
///
/// For widgets whose content lives outside the document (images, video, documents),
/// prefer `ResourceResolver`: it handles asynchrony, caching, and reserved layout
/// space. Use `WidgetProvider` for content that is fully described by the markdown
/// itself, like a callout's text.
public protocol WidgetProvider: AnyObject {
    /// Return nil to fall through to the resource resolver, and failing that, to leave
    /// the range as ordinary styled text.
    func makeWidget(roleName: String, source: String, payload: String?) -> PlatformView?

    /// Point size the widget wants. Width is capped to the text container.
    func widgetSize(roleName: String, source: String, fittingWidth: CGFloat) -> CGSize?

    /// Whether this widget's view handles its own taps.
    ///
    /// Defaults to **false**, and that default matters: a view that takes touches
    /// swallows them before the text view's own text interaction sees them, so the
    /// caret can never land in the widget's source, so the reveal policy never fires,
    /// so the user cannot edit what the widget stands for. Tapping a widget must put
    /// the caret in its source — that is what makes "the caret can reach every
    /// character" true for widgets too (DESIGN §4).
    ///
    /// Return true only for widgets with real controls of their own — a video
    /// scrubber, a button — and give those an escape hatch back to the source.
    func widgetWantsTouches(roleName: String) -> Bool

    /// Richer form used by plugin renderers that share a role but match on source.
    func widgetWantsTouches(roleName: String, source: String, payload: String?) -> Bool

    /// Stable widget keys call update instead of rebuilding the platform view.
    func updateWidget(_ view: PlatformView, roleName: String, source: String, payload: String?)

    /// Called exactly once when a cached host view becomes unreachable.
    func removeWidget(_ view: PlatformView)
}

public extension WidgetProvider {
    func makeWidget(roleName _: String, source _: String, payload _: String?) -> PlatformView? {
        nil
    }
    func widgetSize(roleName _: String, source _: String, fittingWidth _: CGFloat) -> CGSize? {
        nil
    }
    func widgetWantsTouches(roleName _: String) -> Bool { false }
    func widgetWantsTouches(roleName: String, source _: String, payload _: String?) -> Bool {
        widgetWantsTouches(roleName: roleName)
    }
    func updateWidget(
        _: PlatformView,
        roleName _: String,
        source _: String,
        payload _: String?
    ) {}
    func removeWidget(_: PlatformView) {}
}

/// Optional bridge for interactive widget views whose non-control background should
/// still reveal the exact source they replace. The editor installs the handler; the
/// view only reports the user's intent, so it never needs document or selection APIs.
public protocol WidgetSourceRevealRequesting: AnyObject {
    func setSourceRevealHandler(_ handler: @escaping () -> Void)
}

/// Carries context and geometry from the source decoration to the viewport overlay.
final class WidgetAttachment: NSTextAttachment {
    let roleName: String
    let source: String
    let payload: String?
    weak var provider: (any WidgetProvider)?
    weak var resources: ResourceCache?
    /// Owns the view cache. Weak because the applier outlives any one attachment.
    weak var cache: DecorationApplier?
    let key: UInt64
    let tableModel: MarkdownTableModel?
    let openLink: ((String) -> Void)?
    /// Inline host widgets are centered on this font's typographic line box. Block
    /// widgets and externally resolved resources keep their existing baseline rules.
    let baselineFont: PlatformFont
    let isInline: Bool
    var fittingWidth: CGFloat = 320

    init(
        roleName: String,
        source: String,
        payload: String?,
        provider: (any WidgetProvider)?,
        resources: ResourceCache?,
        cache: DecorationApplier?,
        key: UInt64,
        baselineFont: PlatformFont,
        isInline: Bool,
        tableModel: MarkdownTableModel? = nil,
        openLink: ((String) -> Void)? = nil
    ) {
        self.roleName = roleName
        self.source = source
        self.payload = payload
        self.provider = provider
        self.resources = resources
        self.cache = cache
        self.key = key
        self.baselineFont = baselineFont
        self.isInline = isInline
        self.tableModel = tableModel
        self.openLink = openLink
        super.init(data: nil, ofType: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    private var request: ResourceRequest? {
        guard let payload, !payload.isEmpty else { return nil }
        return ResourceRequest(
            reference: payload,
            roleName: roleName,
            source: source,
            fittingWidth: fittingWidth
        )
    }

    /// Host widget first, then the resource resolver. A callout is drawn from the
    /// document; an image is fetched by reference.
    ///
    /// Host-drawn views go through the cache; resource views are already cached by the
    /// resolver, and caching them again here would keep a second reference to a view
    /// that may be shared between two references to the same asset.
    func makeView() -> PlatformView {
        if let cached = cache?.cachedWidgetView(for: key) {
            provider?.updateWidget(cached, roleName: roleName, source: source, payload: payload)
            return cached
        }
        if let view = provider?.makeWidget(roleName: roleName, source: source, payload: payload) {
            cache?.cacheWidgetView(view, for: key)
            return view
        }
        if roleName == "table", let tableModel {
            let view = TableWidgetView(
                model: tableModel,
                fittingWidth: fittingWidth,
                resources: resources,
                onOpenLink: openLink
            )
            cache?.cacheWidgetView(view, for: key)
            return view
        }
        guard let request, let resources else { return PlatformView() }
        switch resources.state(for: request) {
        case .preview(let view): return view
        case .ready(let view): return view
        case .loading: return ResourcePlaceholderView(text: shortName(payload ?? ""), failed: false)
        case .failed(let message): return ResourcePlaceholderView(text: message, failed: true)
        }
    }

    override func viewProvider(
        for parentView: PlatformView?,
        location: any NSTextLocation,
        textContainer: NSTextContainer?
    ) -> NSTextAttachmentViewProvider? {
        let vp = WidgetViewProvider(
            textAttachment: self,
            parentView: parentView,
            textLayoutManager: textContainer?.textLayoutManager,
            location: location
        )
        vp.tracksTextAttachmentViewBounds = true
        return vp
    }

    override func attachmentBounds(
        for textContainer: NSTextContainer?,
        proposedLineFragment lineFrag: CGRect,
        glyphPosition position: CGPoint,
        characterIndex charIndex: Int
    ) -> CGRect {
        let width = textContainer?.size.width ?? fittingWidth
        // Layout is the first point at which the real width is known, so record it here
        // for everything that measures against it.
        if width > 1 {
            fittingWidth = width
        }
        if let size = provider?.widgetSize(
            roleName: roleName,
            source: source,
            fittingWidth: width
        ) {
            let y = isInline
                ? (baselineFont.ascender + baselineFont.descender - size.height) / 2
                : 0
            return CGRect(origin: CGPoint(x: 0, y: y), size: size)
        }
        if roleName == "table", let tableModel {
            return CGRect(origin: .zero, size: TableWidgetView.size(for: tableModel, fittingWidth: width))
        }
        if let request, let resources {
            return CGRect(origin: .zero, size: resources.size(for: request))
        }
        return CGRect(origin: .zero, size: CGSize(width: width, height: 24))
    }

    private func shortName(_ reference: String) -> String {
        (reference as NSString).lastPathComponent
    }
}

final class WidgetViewProvider: NSTextAttachmentViewProvider {
    override func loadView() {
        guard let attachment = textAttachment as? WidgetAttachment else {
            view = PlatformView()
            return
        }
        view = WidgetContainer(
            hosting: attachment.makeView(),
            wantsTouches: attachment.roleName == "table"
                || (attachment.provider?.widgetWantsTouches(
                    roleName: attachment.roleName,
                    source: attachment.source,
                    payload: attachment.payload
                ) ?? false)
        )
    }
}

/// Hosts a widget's view and, unless the provider opts in, refuses to take taps so they
/// reach the text view underneath.
///
/// Without this the editor looks right and is unusable: a callout, an image or a chip
/// silently absorbs every tap, and there is no way to get a caret into the source it
/// replaced.
final class WidgetContainer: PlatformView {
    private let wantsTouches: Bool
    private let content: PlatformView

    init(
        hosting content: PlatformView,
        wantsTouches: Bool,
        revealSource: (() -> Void)? = nil
    ) {
        self.wantsTouches = wantsTouches
        self.content = content
        super.init(frame: content.bounds)

        if let revealSource,
           let requesting = content as? any WidgetSourceRevealRequesting {
            requesting.setSourceRevealHandler(revealSource)
        }

        // Explicit frames, not constraints. Pinning the content to all four edges at
        // required priority fights any intrinsic size the content sets for itself — an
        // image view with its own width/height constraints ends up unsatisfiable, and
        // the widget silently renders as a blank gap where the image should be.
        content.translatesAutoresizingMaskIntoConstraints = true
        content.frame = bounds
        addSubview(content)

        #if !os(macOS)
        // Disabling it on the container covers every subview too.
        isUserInteractionEnabled = wantsTouches
        #endif
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    /// Resize the content with the container, and make it lay itself out again.
    ///
    /// A host builds its view before anything knows how wide the column is, so the view
    /// arrives at zero size and TextKit resizes the container afterwards from
    /// `attachmentBounds`. Autoresizing cannot carry that: it scales a subview against
    /// the superview's *old* size, and from zero there is nothing to scale. The content
    /// kept its zero-width layout, so a callout's label measured itself unwrapped and
    /// drew one clipped line inside a box correctly sized for two.
    private func layoutContent() {
        guard content.frame != bounds else { return }
        content.frame = bounds
        #if os(macOS)
        content.layoutSubtreeIfNeeded()
        #else
        content.setNeedsLayout()
        content.layoutIfNeeded()
        #endif
    }

    #if os(macOS)
    override func layout() {
        super.layout()
        layoutContent()
    }

    /// AppKit has no `isUserInteractionEnabled`; refusing the hit is the equivalent.
    override func hitTest(_ point: NSPoint) -> NSView? {
        wantsTouches ? super.hitTest(point) : nil
    }
    #else
    override func layoutSubviews() {
        super.layoutSubviews()
        layoutContent()
    }
    #endif
}

/// Shown while a reference is resolving, or when it could not be.
final class ResourcePlaceholderView: PlatformView {
    init(text: String, failed: Bool) {
        super.init(frame: CGRect(x: 0, y: 0, width: 220, height: 30))
        let label = PlatformLabel()
        let title = (failed ? "⚠ " : "◌ ") + text

        #if os(macOS)
        label.stringValue = title
        label.isEditable = false
        label.isBordered = false
        label.drawsBackground = false
        label.font = .platformSystem(ofSize: 12)
        label.textColor = failed ? .systemRed : .platformSecondaryLabel
        wantsLayer = true
        layer?.cornerRadius = 6
        updateAppearanceColor()
        #else
        label.text = title
        label.font = .platformSystem(ofSize: 12)
        label.textColor = failed ? .systemRed : .platformSecondaryLabel
        layer.cornerRadius = 6
        backgroundColor = .platformSecondaryBackground
        #endif

        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    #if os(macOS)
    private func updateAppearanceColor() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = PlatformColor.platformSecondaryBackground.cgColor
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateAppearanceColor()
    }
    #endif
}
