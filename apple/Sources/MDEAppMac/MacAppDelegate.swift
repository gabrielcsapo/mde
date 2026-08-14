import AppKit
import MDECore
import MDEditorUI
import MDEHost

/// macOS reference app. The window and toolbar are AppKit; everything below the view —
/// the manifest, widgets, resolver, sample document — is the same `MDEHost` code the
/// iOS app uses, and the decoration behaviour is the same `DecorationApplier`.
final class MacAppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var editor: MarkdownTextView!
    private var undoItem: NSButton!
    private var typewriterItem: NSButton!
    private var posItem: NSButton!
    private var historyItem: NSButton!
    private var typewriter: TypewriterMode!
    private var partsOfSpeech: PartsOfSpeech!
    private var mentions: MentionAutocomplete!
    private var attachments: AttachmentComposer!
    private var redoItem: NSButton!

    func applicationDidFinishLaunching(_ notification: Notification) {
        var theme = Theme()
        theme.extensionRoles = [
            "wikilink": [
                .foregroundColor: NSColor.systemPurple,
                .underlineStyle: NSUnderlineStyle.single.rawValue,
            ],
        ]

        // Each extension brings its own role attributes; the editor's theme only knows
        // what the parser produces.
        theme.extensionRoles.merge(TypewriterMode.themeRoles(bodyFont: theme.bodyFont)) { a, _ in a }
        theme.extensionRoles.merge(PartsOfSpeech.themeRoles()) { a, _ in a }

        typewriter = TypewriterMode()
        partsOfSpeech = PartsOfSpeech()
        mentions = MentionAutocomplete(candidates: [
            MentionCandidate(handle: "gabe", label: "Gabriel", detail: "Editor team"),
            MentionCandidate(handle: "grace", label: "Grace", detail: "Design"),
            MentionCandidate(handle: "mira", label: "Mira", detail: "Journal"),
        ])
        attachments = AttachmentComposer()
        editor = try! MarkdownTextView(
            plugins: [typewriter, partsOfSpeech, mentions, attachments],
            manifest: HostExtensions.manifest,
            theme: theme
        )
        editor.widgetProvider = HostWidgets()
        editor.resourceResolver = DiskResourceResolver(root: SampleAssets.install())
        editor.resourceSizes = ResourceSizeStore.load()
        editor.markdownDelegate = self

        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.documentView = editor
        scroll.translatesAutoresizingMaskIntoConstraints = false
        editor.minSize = NSSize(width: 0, height: 0)
        editor.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )

        let bar = NSStackView()
        bar.orientation = .horizontal
        bar.spacing = 8
        bar.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        bar.translatesAutoresizingMaskIntoConstraints = false

        undoItem = NSButton(title: "Undo", target: self, action: #selector(undoTapped))
        redoItem = NSButton(title: "Redo", target: self, action: #selector(redoTapped))
        let bold = NSButton(title: "Bold", target: self, action: #selector(boldTapped))
        // Both features are toggled the same way, because both are just a layer being
        // pushed and cleared. Neither needed a change to the editor.
        typewriterItem = NSButton(title: "Typewriter", target: self, action: #selector(typewriterTapped))
        posItem = NSButton(title: "Parts of speech", target: self, action: #selector(posTapped))
        historyItem = NSButton(title: "History", target: self, action: #selector(historyTapped))
        for b in [bold, undoItem!, redoItem!, typewriterItem!, posItem!, historyItem!] {
            bar.addArrangedSubview(b)
        }
        bar.addArrangedSubview(NSView())

        let root = NSView()
        root.addSubview(bar)
        root.addSubview(scroll)
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: root.topAnchor),
            bar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: bar.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: CaptureMode.width ?? 760, height: 900),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Note"
        window.contentView = root
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)

        editor.setMarkdown(HostExtensions.sample)
        refreshButtons()

        // `scripts/capture.sh` launches with `--mde-capture <shot>` and photographs the
        // window; without the flag this does nothing. See `CaptureMode`.
        CaptureMode.apply(to: editor)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// Save on the way out, not at launch: nothing has resolved when the document is
    /// first set, so there is nothing to remember until the resources have landed.
    func applicationWillTerminate(_ notification: Notification) {
        ResourceSizeStore.save(editor.resourceSizes)
    }

    /// The timeline as a menu: every revision, including undone ones, click to land
    /// anywhere. Undo and redo are the two-button view of the same thing (DESIGN §9).
    @objc private func historyTapped() {
        let menu = NSMenu()
        let position = editor.historyPosition

        let opened = NSMenuItem(
            title: "Opened document",
            action: #selector(jumpToRevision(_:)),
            keyEquivalent: ""
        )
        opened.target = self
        opened.tag = 0
        opened.state = position == 0 ? .on : .off
        menu.addItem(opened)

        for rev in editor.revisions {
            let what = switch rev.kind {
            case .insert: "Added \(rev.inserted) characters"
            case .delete: "Removed \(rev.removed) characters"
            case .replace: "Replaced \(rev.removed) with \(rev.inserted) characters"
            }
            let item = NSMenuItem(title: what, action: #selector(jumpToRevision(_:)), keyEquivalent: "")
            item.target = self
            // Position p means "the document immediately after revision p-1".
            item.tag = Int(rev.index) + 1
            item.state = position == item.tag ? .on : .off
            menu.addItem(item)
        }
        menu.popUp(
            positioning: nil,
            at: NSPoint(x: 0, y: historyItem.bounds.height + 4),
            in: historyItem
        )
    }

    @objc private func jumpToRevision(_ sender: NSMenuItem) {
        editor.jump(to: sender.tag)
        refreshButtons()
    }

    @objc private func typewriterTapped() {
        typewriter.toggle()
        refreshButtons()
    }

    @objc private func posTapped() {
        partsOfSpeech.toggle()
        refreshButtons()
    }

    private func refreshButtons() {
        undoItem.isEnabled = editor.canUndo
        redoItem.isEnabled = editor.canRedo
        typewriterItem.state = typewriter.isEnabled ? .on : .off
        posItem.state = partsOfSpeech.isEnabled ? .on : .off
    }

    @objc private func undoTapped() {
        editor.performUndo()
        refreshButtons()
    }

    @objc private func redoTapped() {
        editor.performRedo()
        refreshButtons()
    }

    /// A formatting command: fence it with undo boundaries so it comes off in one step
    /// rather than as two stray marker insertions.
    @objc private func boldTapped() {
        let range = editor.selectedRange()
        guard range.length > 0, let storage = editor.textStorage else { return }
        let selected = (storage.string as NSString).substring(with: range)
        editor.closeUndoGroup()
        storage.replaceCharacters(in: range, with: "**\(selected)**")
        editor.setSelectedRange(NSRange(location: range.location + 2, length: range.length))
        editor.closeUndoGroup()
        refreshButtons()
    }
}

extension MacAppDelegate: MarkdownTextViewDelegate {
    func markdownTextView(
        _ view: MarkdownTextView,
        didRequestOpenLink destination: String
    ) {
        guard let url = URL(string: destination) else { return }
        NSWorkspace.shared.open(url)
    }

    func markdownTextView(
        _ view: MarkdownTextView,
        didTap decoration: Decoration,
        source: String
    ) {
        guard decoration.role == Role.taskCheckbox else { return }
        view.toggleTask(at: decoration)
        refreshButtons()
    }

    func markdownTextViewDidChange(_ view: MarkdownTextView) {
        refreshButtons()
    }
}
