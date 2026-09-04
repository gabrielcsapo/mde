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

    /// Optional destination for a permission-free capture of the actual AppKit view
    /// hierarchy. System window capture can be denied even when the app itself is
    /// allowed to draw; asking the window to cache its own display is deterministic.
    static var output: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let flag = args.firstIndex(of: "--mde-output"), flag + 1 < args.count else {
            return nil
        }
        return args[flag + 1]
    }

    static func apply(to editor: MarkdownTextView) {
        guard let shot else { return }

        if shot == "hero-video" {
            showHeroVideoFixture(editor)
            after(0.3) {
                guard let window = editor.window else { return }
                window.appearance = NSAppearance(named: .darkAqua)
                window.level = .floating
                parkHero(window)
                report(window)
            }
            after(1.7) { runHeroVideo(editor) }
            return
        }

        after(0.3) {
            guard let window = editor.window else { return }
            if shot == "cross-platform" || shot.hasPrefix("matrix-") {
                // Match the fixed light appearance used by the browser captures and
                // the default iOS simulator, independent of the developer's desktop.
                window.appearance = NSAppearance(named: .aqua)
            }
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
            if shot.hasPrefix("matrix-") {
                showMatrixFixture(String(shot.dropFirst("matrix-".count)), editor: editor)
                after(0.5) {
                    dump(editor)
                    writeWindow(editor)
                }
                return
            }
            if shot == "cross-platform" {
                showCrossPlatformFixture(editor)
            }
            dump(editor)
            switch shot {
            case "cross-platform":
                after(0.5) { writeWindow(editor) }
            case "editor": break // the top of the document, exactly as launched
            // The window is tall enough that the bottom of the document holds every
            // widget and both references at once — and anchoring to the bottom stays
            // correct whatever the resolved chart turns out to measure.
            case "widgets": scroll(editor, to: bottom(of: editor))
            default: break
            }
        }
    }

    private static func writeWindow(_ editor: MarkdownTextView) {
        guard let output else { return }
        // Capture the editor surface rather than the app chrome. NSButton uses private
        // compositing that does not participate in cacheDisplay, while the scroll view
        // contains exactly the renderer pixels this artifact is meant to compare.
        let surface: NSView = editor.enclosingScrollView ?? editor
        surface.layoutSubtreeIfNeeded()
        let bounds = surface.bounds
        guard let bitmap = surface.bitmapImageRepForCachingDisplay(in: bounds) else { return }
        surface.cacheDisplay(in: bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return }
        do {
            try png.write(to: URL(fileURLWithPath: output), options: .atomic)
            print("MDE_CAPTURE_WRITTEN \(output)")
            fflush(stdout)
        } catch {
            fputs("MDE_CAPTURE_ERROR \(error)\n", stderr)
        }
    }

    private static func showCrossPlatformFixture(_ editor: MarkdownTextView) {
        // A directly launched hand-assembled bundle does not always populate
        // Bundle.main's resource index, so keep the conventional Resources path as a
        // deterministic fallback for the capture runner.
        let indexed = Bundle.main.url(forResource: "cross-platform", withExtension: "md")
        let bundled = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Resources/cross-platform.md")
        guard let source = [indexed, bundled].compactMap({ $0 }).lazy.compactMap({
            try? String(contentsOf: $0, encoding: .utf8)
        }).first else { return }
        editor.setMarkdown(source)
        scroll(editor, to: 0)
    }

    private static func showMatrixFixture(_ scenario: String, editor: MarkdownTextView) {
        let name = "capture-\(scenario).md"
        let indexed = Bundle.main.url(
            forResource: "capture-\(scenario)",
            withExtension: "md"
        )
        let bundled = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Resources/\(name)")
        guard let source = [indexed, bundled].compactMap({ $0 }).lazy.compactMap({
            try? String(contentsOf: $0, encoding: .utf8)
        }).first else { return }
        editor.setMarkdown(source)
        scroll(editor, to: 0)
        editor.window?.makeFirstResponder(nil)
        guard let storage = editor.textStorage else { return }
        switch scenario {
        case "composer":
            let range = (storage.string as NSString).range(of: "@ga")
            guard range.location != NSNotFound else { return }
            editor.window?.makeFirstResponder(editor)
            editor.setSelectedRange(NSRange(location: range.upperBound, length: 0))
        case "commands":
            let range = (storage.string as NSString).range(of: "/")
            guard range.location != NSNotFound else { return }
            editor.window?.makeFirstResponder(editor)
            editor.setSelectedRange(NSRange(location: range.upperBound, length: 0))
        case "editing":
            let range = (storage.string as NSString).range(of: "revealed syntax")
            guard range.location != NSNotFound else { return }
            editor.window?.makeFirstResponder(editor)
            editor.setSelectedRange(NSRange(location: range.location + 4, length: 0))
        case "table-editing":
            let source = storage.string as NSString
            let start = source.range(of: "| **Ada**").location
            let end = source.range(of: "| **Linus**").location
            guard start != NSNotFound, end != NSNotFound, end > start else { return }
            editor.window?.makeFirstResponder(editor)
            editor.setSelectedRange(NSRange(location: start, length: end - start))
        default:
            break
        }
    }

    /// The same demanding document as the iPhone film. Matching source makes the
    /// platform comparison about native input and presentation rather than content.
    private static func showHeroVideoFixture(_ editor: MarkdownTextView) {
        let source = """
        # Field notes

        > Native text input. Portable Markdown source.

        ## Live edit

        """
        editor.setMarkdown(source)
        editor.window?.makeFirstResponder(editor)
        editor.setSelectedRange(NSRange(location: (source as NSString).length, length: 0))
        editor.scrollRangeToVisible(editor.selectedRange())
        editor.window?.title = "Native Markdown"
    }

    /// Sends every character through NSTextView's ordinary input method, then fixes a
    /// typo and applies the editor's public bold command just like the iPhone film.
    private static func runHeroVideo(_ editor: MarkdownTextView) {
        let segments = [
            "- [x] **Incremental** edits repaint one paragraph\n",
            "  - [ ] keep [source portable](https://commonmark.org)\n\n",
            "| Surface | Native input |\n|:--|:--|\n| macOS | TextKit |\n| Web | contenteditable |\n\n\n\n",
            "Native perfromance, measured in edits—not demos.",
        ]

        typeSegments(segments, at: 0, into: editor) {
            let source = editor.markdown as NSString
            let typo = source.range(of: "perfromance")
            guard typo.location != NSNotFound else { return }

            editor.setSelectedRange(typo)
            editor.scrollRangeToVisible(typo)
            after(0.65) {
                editor.insertText("performance", replacementRange: typo)
                let updated = editor.markdown as NSString
                let word = updated.range(of: "performance")
                guard word.location != NSNotFound else { return }
                editor.setSelectedRange(word)

                after(0.7) {
                    _ = editor.execute(.bold, selection: word)
                    after(0.9) {
                        let end = (editor.markdown as NSString).length
                        editor.setSelectedRange(NSRange(location: end, length: 0))
                        editor.scrollRangeToVisible(editor.selectedRange())
                    }
                }
            }
        }
    }

    private static func typeSegments(
        _ segments: [String],
        at index: Int,
        into editor: MarkdownTextView,
        completion: @escaping () -> Void
    ) {
        guard index < segments.count else {
            completion()
            return
        }
        typeCharacters(Array(segments[index]), at: 0, into: editor) {
            after(0.25) {
                typeSegments(segments, at: index + 1, into: editor, completion: completion)
            }
        }
    }

    private static func typeCharacters(
        _ characters: [Character],
        at index: Int,
        into editor: MarkdownTextView,
        completion: @escaping () -> Void
    ) {
        guard index < characters.count else {
            completion()
            return
        }
        let character = String(characters[index])
        editor.insertText(character, replacementRange: editor.selectedRange())
        let delay = character == "\n" ? 0.085 : 0.019
        after(delay) {
            typeCharacters(characters, at: index + 1, into: editor, completion: completion)
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

    /// A landscape desktop frame sized for the landing-page player.
    private static func parkHero(_ window: NSWindow) {
        guard let visible = window.screen?.visibleFrame else { return }
        let margin: CGFloat = 16
        let size = NSSize(
            width: min(650, visible.width - margin * 2),
            height: min(390, visible.height - margin * 2)
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
            print("MDE_SCREEN_SCALE \(screen.backingScaleFactor)")
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
