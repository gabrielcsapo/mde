import MDEditorUI
import UIKit

/// Composes the showcase shots that `scripts/capture.sh` records.
///
/// `simctl` can screenshot and record a simulator but cannot inject a touch into one,
/// so there is no way to drive the app from the outside. Rather than script the
/// Simulator window through System Events — which needs Accessibility, moves the real
/// cursor, and depends on where the window happens to sit — the app composes each shot
/// itself when launched with `--mde-capture <shot>`.
///
/// Nothing about *rendering* changes here. This only sets the scroll offset and the
/// selection, which is exactly what a hand holding the phone would have touched.
enum CaptureMode {
    /// The shot named on the command line, if the app was launched for a capture.
    static var shot: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let flag = args.firstIndex(of: "--mde-capture"), flag + 1 < args.count else {
            return nil
        }
        return args[flag + 1]
    }

    static func apply(to editor: MarkdownTextView) {
        guard let shot else { return }

        // The screencast is started after the app, so the tour holds still long enough
        // for the recorder to be running before anything moves. The still shots need
        // only enough of a wait for the references to resolve — the chart landing at
        // its real size moves everything below it, and a cold run and a warm run have
        // to compose the same frame.
        guard shot != "demo" else {
            after(3.0) { runDemo(editor) }
            return
        }

        after(1.2) {
            switch shot {
            case "inline": break // the top of the document, exactly as launched
            case "reveal": revealBold(editor)
            case "widgets": scroll(editor, to: top(of: editor) + 285)
            case "references": scroll(editor, to: bottom(of: editor))
            case "history": showHistory(editor)
            default: break
            }
        }
    }

    // MARK: - Shots

    /// Two spaced revisions, then the history sheet — the state a hand would reach by
    /// typing, pausing, typing again and tapping the clock.
    private static func showHistory(_ editor: MarkdownTextView) {
        guard let storage = editor.textStorage as NSTextStorage? else { return }
        editor.closeUndoGroup()
        storage.replaceCharacters(in: NSRange(location: 0, length: 0), with: "Draft: ")
        editor.closeUndoGroup()
        after(0.4) {
            storage.replaceCharacters(in: NSRange(location: 7, length: 0), with: "v2 ")
            editor.closeUndoGroup()
        }
        after(1.2) {
            guard let root = editor.window?.rootViewController else { return }
            let history = HistoryViewController(editor: editor) {}
            let nav = UINavigationController(rootViewController: history)
            if let sheet = nav.sheetPresentationController {
                sheet.detents = [.medium()]
            }
            (root.presentedViewController ?? root).present(nav, animated: false)
        }
    }

    /// Caret inside `**markdown**` so its delimiters come back — the signature
    /// behaviour, and the one shot where the editor must hold focus.
    private static func revealBold(_ editor: MarkdownTextView) {
        let source = editor.textStorage.string as NSString
        let bold = source.range(of: "**markdown**")
        guard bold.location != NSNotFound else { return }
        // Mid-word, so both delimiters are inside the revealed node.
        editor.selectedRange = NSRange(location: bold.location + 6, length: 0)
        _ = editor.becomeFirstResponder()
    }

    /// The tour: reveal, collapse, then scroll through the widgets to the resolved
    /// references. Roughly eight seconds from the first move to the last.
    private static func runDemo(_ editor: MarkdownTextView) {
        after(0.5) { revealBold(editor) }
        after(2.9) { _ = editor.resignFirstResponder() }
        after(4.1) { scroll(editor, to: top(of: editor) + 285, over: 1.6) }
        after(5.7) { scroll(editor, to: bottom(of: editor), over: 2.0) }
    }

    // MARK: - Scrolling

    private static func top(of editor: MarkdownTextView) -> CGFloat {
        -editor.adjustedContentInset.top
    }

    private static func bottom(of editor: MarkdownTextView) -> CGFloat {
        let limit = editor.contentSize.height - editor.bounds.height
            + editor.adjustedContentInset.bottom
        return max(top(of: editor), limit)
    }

    private static func scroll(
        _ editor: MarkdownTextView,
        to y: CGFloat,
        over duration: TimeInterval = 0
    ) {
        let target = CGPoint(x: 0, y: min(y, bottom(of: editor)))
        guard duration > 0 else {
            editor.setContentOffset(target, animated: false)
            return
        }
        // A hand-rolled animation rather than `animated: true`: UIScrollView's own
        // 0.3s curve reads as a jump on video.
        UIView.animate(withDuration: duration, delay: 0, options: [.curveEaseInOut]) {
            editor.contentOffset = target
        }
    }

    private static func after(_ delay: TimeInterval, _ body: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: body)
    }
}
