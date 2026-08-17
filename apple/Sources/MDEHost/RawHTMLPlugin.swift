import Foundation
import MDECore
import MDEPluginKit
import MDEditorUI
import WebKit

/// Projects parser-recognized HTML blocks through a host-owned native renderer.
///
/// The plugin never interprets or sanitizes content. Apps can return a native view, a
/// managed WKWebView, or a domain-specific canvas and own that renderer's trust policy.
/// The exact source remains in text storage and reappears whenever the caret enters it.
public final class RawHTMLPlugin: MarkdownPlugin {
    public let name: String
    public let requirement = MarkdownPluginRequirement(
        capabilities: [.semantics, .selection, .decorations, .renderers]
    )

    private let renderer: MarkdownPluginRendererContribution
    private weak var context: MarkdownPluginContext?
    private var role: UInt32 = UInt32.max

    public init(
        name: String = "mde.raw-html",
        renderer: MarkdownPluginRendererContribution
    ) {
        self.name = name
        self.renderer = renderer
    }

    public func install(in context: MarkdownPluginContext) throws {
        self.context = context
        role = context.internRole("\(name):view")
        let roleName = "\(name):view"
        let hostRenderer = renderer
        context.registerRenderer("html", contribution: MarkdownPluginRendererContribution(
            matches: { candidate, source, payload in
                candidate == roleName && hostRenderer.matches(candidate, source, payload)
            },
            makeWidget: hostRenderer.makeWidget,
            updateWidget: hostRenderer.updateWidget,
            removeWidget: hostRenderer.removeWidget,
            size: hostRenderer.size,
            wantsTouches: hostRenderer.wantsTouches
        ))
    }

    public func markdownDidChange() { project() }
    public func selectionDidChange() { project() }

    private func project() {
        guard let context, role != UInt32.max else { return }
        let selection = context.selection.isActive ? context.selection.range : nil
        let spans = context.semantics.query(MarkdownSemanticQuery(roles: ["html"]))
            .filter { $0.layer == 0 && $0.payload == "block" }
            .filter { renderer.matches("\(name):view", $0.source, $0.payload) }
            .filter { !Self.touches($0.range, selection) }
            .map { LayerSpan(range: $0.range, role: role, kind: .blockWidget) }
        context.setLayer("views", spans)
    }

    private static func touches(_ node: NSRange, _ selection: NSRange?) -> Bool {
        guard let selection else { return false }
        if selection.length == 0 {
            return selection.location >= node.location && selection.location <= NSMaxRange(node)
        }
        return NSIntersectionRange(node, selection).length > 0
    }
}

/// Ready-made renderers kept outside the editor core so applications choose the trust boundary.
public enum RawHTMLRenderers {
    /// Loads trusted HTML and JavaScript in a managed WKWebView with fixed editor geometry.
    public static func trustedWebView(
        height: CGFloat = 180,
        accepts: @escaping (String) -> Bool = { _ in true }
    ) -> MarkdownPluginRendererContribution {
        MarkdownPluginRendererContribution(
            matches: { _, source, _ in accepts(source) },
            makeWidget: { _, source, _ in
                let configuration = WKWebViewConfiguration()
                let view = TrustedHTMLWebView(configuration: configuration)
                #if os(macOS)
                view.underPageBackgroundColor = .clear
                #else
                view.isOpaque = false
                view.backgroundColor = .clear
                #endif
                view.loadHTMLString(Self.document(source), baseURL: nil)
                return view
            },
            removeWidget: { view in
                (view as? TrustedHTMLWebView)?.prepareForRemoval()
                (view as? WKWebView)?.stopLoading()
            },
            size: { _, _, width in CGSize(width: width, height: height) },
            wantsTouches: { _, _, _ in true }
        )
    }

    private static func document(_ source: String) -> String {
        """
        <!doctype html><html><head>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>
        </head><body>\(source)</body></html>
        """
    }
}

private final class TrustedHTMLMessageProxy: NSObject, WKScriptMessageHandler {
    weak var owner: TrustedHTMLWebView?

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        owner?.requestSourceReveal()
    }
}

/// Keeps controls inside trusted HTML interactive while turning the rest of the web
/// surface into the same source-reveal affordance as an ordinary editor widget.
private final class TrustedHTMLWebView: WKWebView, WidgetSourceRevealRequesting {
    private static let handlerName = "mdeRevealSource"
    private let messageProxy: TrustedHTMLMessageProxy
    private var revealSource: (() -> Void)?
    private var removed = false

    init(configuration: WKWebViewConfiguration) {
        let proxy = TrustedHTMLMessageProxy()
        messageProxy = proxy
        let controller = configuration.userContentController
        controller.addUserScript(WKUserScript(
            source: Self.sourceRevealScript,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        controller.add(proxy, name: Self.handlerName)
        super.init(frame: .zero, configuration: configuration)
        proxy.owner = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    func setSourceRevealHandler(_ handler: @escaping () -> Void) {
        revealSource = handler
    }

    fileprivate func requestSourceReveal() {
        revealSource?()
    }

    fileprivate func prepareForRemoval() {
        guard !removed else { return }
        removed = true
        configuration.userContentController.removeScriptMessageHandler(
            forName: Self.handlerName
        )
        revealSource = nil
    }

    deinit { prepareForRemoval() }

    private static let sourceRevealScript = #"""
    document.addEventListener('click', function (event) {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const control = target.closest(
        'a[href],button,input,select,textarea,summary,video,audio,' +
        '[contenteditable="true"],[role="button"],[data-mde-control]'
      );
      if (control) return;
      window.webkit.messageHandlers.mdeRevealSource.postMessage(null);
    }, true);
    """#
}
