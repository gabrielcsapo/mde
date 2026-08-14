#if canImport(SwiftUI)
import SwiftUI

#if os(macOS)
import AppKit
#else
import UIKit

private final class UIKitSwiftUIPluginHost<Content: View>: UIView {
    private let controller: UIHostingController<Content>

    init(rootView: Content) {
        controller = UIHostingController(rootView: rootView)
        super.init(frame: .zero)
        controller.view.backgroundColor = .clear
        controller.view.translatesAutoresizingMaskIntoConstraints = false
        addSubview(controller.view)
        NSLayoutConstraint.activate([
            controller.view.leadingAnchor.constraint(equalTo: leadingAnchor),
            controller.view.trailingAnchor.constraint(equalTo: trailingAnchor),
            controller.view.topAnchor.constraint(equalTo: topAnchor),
            controller.view.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    override var intrinsicContentSize: CGSize {
        controller.sizeThatFits(in: CGSize(width: 420, height: 900))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }
}
#endif

public extension MarkdownPluginContext {
    /// Present SwiftUI content without making the editor or plugin lifecycle SwiftUI-specific.
    @discardableResult
    func showSwiftUIPresentation<Content: View>(
        _ name: String,
        anchor: MarkdownPluginPresentationAnchor = .selection,
        placement: MarkdownPluginPresentationPlacement = .automatic,
        offset: CGFloat = 8,
        modal: Bool = false,
        dismissOnOutsideInteraction: Bool? = nil,
        restoreFocus: Bool = true,
        onDismiss: ((MarkdownPluginPresentationDismissReason) -> Void)? = nil,
        @ViewBuilder content: () -> Content
    ) -> MarkdownPluginPresentationHandle? {
        #if os(macOS)
        let host = NSHostingView(rootView: content())
        #else
        let host = UIKitSwiftUIPluginHost(rootView: content())
        #endif
        return showPresentation(name, options: MarkdownPluginPresentationOptions(
            view: host,
            anchor: anchor,
            placement: placement,
            offset: offset,
            modal: modal,
            dismissOnOutsideInteraction: dismissOnOutsideInteraction,
            restoreFocus: restoreFocus,
            onDismiss: onDismiss
        ))
    }
}
#endif
