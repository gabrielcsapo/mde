import AppKit
import MDEditorUI

/// Composes the showcase shots that `scripts/capture.sh` records, the AppKit half of
/// the iOS app's `CaptureMode`.
///
/// `screencapture` can photograph a window but cannot click in one, so the app puts
/// itself into the state each shot needs when launched with `--mde-capture <shot>`.
/// Only the scroll offset and the selection are touched; rendering is untouched.
enum CaptureMode {
    static var shot: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let flag = args.firstIndex(of: "--mde-capture"), flag + 1 < args.count else {
            return nil
        }
        return args[flag + 1]
    }

    /// `--mde-width <points>` sizes the window before the shot. Layout bugs in widgets
    /// are width-dependent, so being able to photograph the editor at an arbitrary
    /// column width is how you see them without driving the UI by hand.
    static var width: CGFloat? {
        let args = ProcessInfo.processInfo.arguments
        guard let flag = args.firstIndex(of: "--mde-width"), flag + 1 < args.count,
              let value = Double(args[flag + 1]), value > 0
        else { return nil }
        return CGFloat(value)
    }

    static func apply(to editor: MarkdownTextView) {
        guard let shot else { return }
        after(0.3) {
            guard let window = editor.window else { return }
            // Nothing may cover the window: `screencapture -v` records a screen
            // *rect*, so an overlapping window would land in the recording.
            window.level = .floating
            if shot == "demo" { park(window) }
            report(window)
        }
        // The screencast is started after the app, so the tour holds still long enough
        // for `screencapture` to be running before anything moves.
        guard shot != "demo" else {
            after(3.0) { runDemo(editor) }
            return
        }

        // References resolve asynchronously; wait for the document to settle so a cold
        // run and a warm run compose the same frame.
        after(1.2) {
            dump(editor)
            switch shot {
            case "editor": break // the top of the document, exactly as launched
            // The window is tall enough that the bottom of the document holds every
            // widget and both references at once — and anchoring to the bottom stays
            // correct whatever the resolved chart turns out to measure.
            case "widgets": scroll(editor, to: bottom(of: editor))
            default: break
            }
        }
    }

    /// Moves the window into the top-left corner for the screencast.
    ///
    /// The still shots photograph the window itself (`screencapture -l`) and do not
    /// care where it sits or what is in front of it. The screencast cannot: it records
    /// a screen *rect*, so whatever the system puts on top — an "allow this accessory
    /// to connect?" prompt, a software-update nag — is recorded along with the editor.
    /// Those appear near the middle of the screen, so the window is parked in the
    /// corner and kept narrow enough to stay out of their way.
    private static func park(_ window: NSWindow) {
        guard let visible = window.screen?.visibleFrame else { return }
        let margin: CGFloat = 16
        let size = NSSize(
            width: min(700, visible.width - margin * 2),
            height: min(880, visible.height - margin * 2)
        )
        window.setFrame(
            NSRect(
                x: visible.minX + margin,
                y: visible.maxY - margin - size.height,
                width: size.width,
                height: size.height
            ),
            display: true
        )
    }

    /// Tells `scripts/capture.sh` where to point `screencapture`.
    ///
    /// `-l` wants a CGWindowID and `-v` wants a screen rect, and neither can be looked
    /// up from the shell: the system python has no Quartz bindings and System Events
    /// needs Accessibility. The window knows both, so it says so.
    /// `NSWindow.windowNumber` *is* the CGWindowID; the frame is flipped into the
    /// top-left origin `screencapture -R` expects.
    /// Dumps the widget view tree with real frames, for diagnosing layout at a given
    /// column width. Views inside a text attachment are only instantiated during
    /// display, so this is the only place their geometry is real.
    static func dump(_ editor: MarkdownTextView) {
        guard ProcessInfo.processInfo.arguments.contains("--mde-dump") else { return }
        func walk(_ v: NSView, _ depth: Int) {
            let pad = String(repeating: "  ", count: depth)
            let f = v.frame
            var extra = ""
            if let tf = v as? NSTextField {
                let cell = tf.cell as? NSTextFieldCell
                let probe = NSRect(x: 0, y: 0, width: tf.frame.width, height: 100_000)
                let drawn = cell?.cellSize(forBounds: probe) ?? .zero
                extra = " text=\"\(tf.stringValue.prefix(20))\" lines=\(tf.maximumNumberOfLines)"
                    + " pmlw=\(tf.preferredMaxLayoutWidth) intrinsic=\(tf.intrinsicContentSize)"
                    + " cellSize=\(drawn) wraps=\(cell?.wraps ?? false)"
                    + " scrollable=\(cell?.isScrollable ?? false)"
                    + " single=\(tf.usesSingleLineMode) lbm=\(tf.lineBreakMode.rawValue)"
                    + " clips=\(v.superview?.frame.height ?? -1)"
            }
            print("MDE_DUMP \(pad)\(type(of: v)) "
                + "frame=(\(Int(f.minX)),\(Int(f.minY)),\(Int(f.width)),\(Int(f.height)))\(extra)")
            for sub in v.subviews { walk(sub, depth + 1) }
        }
        print("MDE_DUMP editor width=\(editor.bounds.width) "
            + "container=\(editor.textContainer?.size.width ?? -1) "
            + "inset=\(editor.textContainerInset) "
            + "pad=\(editor.textContainer?.lineFragmentPadding ?? -1)")
        for v in editor.subviews { walk(v, 1) }
        fflush(stdout)
    }

    private static func report(_ window: NSWindow) {
        print("MDE_WINDOW_ID \(window.windowNumber)")
        if let screen = NSScreen.screens.first {
            let frame = window.frame
            let top = screen.frame.maxY - frame.maxY
            print("MDE_WINDOW_RECT \(Int(frame.minX)),\(Int(top)),"
                + "\(Int(frame.width)),\(Int(frame.height))")
        }
        fflush(stdout)
    }

    /// Reveal, collapse, then scroll down to the widgets and the resolved references.
    private static func runDemo(_ editor: MarkdownTextView) {
        after(0.5) { revealBold(editor) }
        after(2.9) { editor.window?.makeFirstResponder(nil) }
        after(4.1) { scroll(editor, to: bottom(of: editor), over: 2.4) }
    }

    /// Caret inside `**markdown**` so its delimiters come back.
    private static func revealBold(_ editor: MarkdownTextView) {
        guard let storage = editor.textStorage else { return }
        let bold = (storage.string as NSString).range(of: "**markdown**")
        guard bold.location != NSNotFound else { return }
        editor.window?.makeFirstResponder(editor)
        // Mid-word, so both delimiters are inside the revealed node.
        editor.setSelectedRange(NSRange(location: bold.location + 6, length: 0))
    }

    // MARK: - Scrolling

    private static func bottom(of editor: MarkdownTextView) -> CGFloat {
        guard let clip = editor.enclosingScrollView?.contentView else { return 0 }
        return max(0, editor.bounds.height - clip.bounds.height)
    }

    private static func scroll(
        _ editor: MarkdownTextView,
        to y: CGFloat,
        over duration: TimeInterval = 0
    ) {
        guard let scroll = editor.enclosingScrollView else { return }
        let target = NSPoint(x: 0, y: min(y, bottom(of: editor)))
        guard duration > 0 else {
            scroll.contentView.setBoundsOrigin(target)
            scroll.reflectScrolledClipView(scroll.contentView)
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            scroll.contentView.animator().setBoundsOrigin(target)
        } completionHandler: {
            scroll.reflectScrolledClipView(scroll.contentView)
        }
    }

    private static func after(_ delay: TimeInterval, _ body: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: body)
    }
}
