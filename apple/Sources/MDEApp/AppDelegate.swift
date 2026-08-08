import MDECore
import MDEditorUI
import MDEHost
import UIKit

/// Reference app for the SDK. Deliberately thin: it exists to prove the editor is
/// droppable and to give the extension API a real customer. Everything host-specific —
/// the manifest, the widgets, the resource resolver — lives in `MDEHost` and is shared
/// verbatim with the macOS app.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = UINavigationController(
            rootViewController: EditorViewController()
        )
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
