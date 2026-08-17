import MDECore
import MDEditorUI
import MDEHost
import UIKit

final class EditorViewController: UIViewController {
    private var editor: MarkdownTextView!
    private var undoItem: UIBarButtonItem!
    private var typewriterItem: UIBarButtonItem!
    private var historyItem: UIBarButtonItem!
    private var posItem: UIBarButtonItem!
    private var typewriter: TypewriterMode!
    private var partsOfSpeech: PartsOfSpeech!
    private var mentions: MentionAutocomplete!
    private var attachments: AttachmentComposer!
    private var slashCommands: MarkdownSuggestionPlugin!
    private var linkEditor: LinkEditor!
    private var redoItem: UIBarButtonItem!

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Note"
        view.backgroundColor = .systemBackground

        var theme = Theme()
        theme.extensionRoles = [
            // `wikilink` renders as styled text rather than a widget, so it is themed
            // here rather than drawn by the widget provider.
            "wikilink": [
                .foregroundColor: UIColor.systemPurple,
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
        linkEditor = LinkEditor()
        slashCommands = MarkdownSuggestionPlugins.slashCommands()
        let rawHTML = RawHTMLPlugin(renderer: RawHTMLRenderers.trustedWebView {
            $0.contains("data-mde-render")
        })
        editor = try! MarkdownTextView(
            plugins: [
                typewriter, partsOfSpeech, mentions, attachments, linkEditor, slashCommands, rawHTML,
            ],
            manifest: HostExtensions.manifest,
            theme: theme
        )
        editor.widgetProvider = HostWidgets()
        // References in the document resolve against a directory on disk — the note
        // holds `![a chart](chart.png)`, never the image itself.
        editor.resourceResolver = DiskResourceResolver(root: SampleAssets.install())
        editor.resourceSizes = ResourceSizeStore.load()
        editor.markdownDelegate = self
        editor.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(editor)

        NSLayoutConstraint.activate([
            editor.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            editor.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            editor.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            editor.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
        ])

        undoItem = UIBarButtonItem(
            image: UIImage(systemName: "arrow.uturn.backward"),
            style: .plain, target: self, action: #selector(undoTapped)
        )
        redoItem = UIBarButtonItem(
            image: UIImage(systemName: "arrow.uturn.forward"),
            style: .plain, target: self, action: #selector(redoTapped)
        )
        // Both features are toggled the same way, because both are just a layer being
        // pushed and cleared. Neither needed a change to the editor.
        typewriterItem = UIBarButtonItem(
            image: UIImage(systemName: "text.alignleft"),
            style: .plain, target: self, action: #selector(typewriterTapped)
        )
        posItem = UIBarButtonItem(
            image: UIImage(systemName: "textformat.abc"),
            style: .plain, target: self, action: #selector(posTapped)
        )
        historyItem = UIBarButtonItem(
            image: UIImage(systemName: "clock.arrow.circlepath"),
            style: .plain, target: self, action: #selector(historyTapped)
        )
        navigationItem.rightBarButtonItems = [redoItem, undoItem, posItem, typewriterItem, historyItem]
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            image: UIImage(systemName: "bold"),
            style: .plain, target: self, action: #selector(boldTapped)
        )

        editor.setMarkdown(HostExtensions.sample)
        refreshButtons()

        // Save on the way out, not here: nothing has resolved yet at this point, so
        // there is nothing to remember until the resources have actually landed.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(persistResourceSizes),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
    }

    /// `scripts/capture.sh` launches the app with `--mde-capture <shot>` and takes a
    /// screenshot; without the flag this does nothing. See `CaptureMode`.
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if PerformanceTestMode.isEnabled {
            PerformanceTestMode.run(editor)
            return
        }
        if RendererTestMode.isEnabled {
            RendererTestMode.run(editor)
            return
        }
        CaptureMode.apply(to: editor)
    }

    @objc private func persistResourceSizes() {
        ResourceSizeStore.save(editor.resourceSizes)
    }

    /// The timeline as a sheet: every revision, including undone ones, tap to land
    /// anywhere. Undo and redo are the two-button view of the same thing (DESIGN §9).
    @objc private func historyTapped() {
        let controller = HistoryViewController(editor: editor) { [weak self] in
            self?.refreshButtons()
        }
        let nav = UINavigationController(rootViewController: controller)
        if let sheet = nav.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
        }
        present(nav, animated: true)
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
        typewriterItem.tintColor = typewriter.isEnabled ? .systemBlue : .secondaryLabel
        posItem.tintColor = partsOfSpeech.isEnabled ? .systemBlue : .secondaryLabel
    }

    @objc private func undoTapped() {
        editor.performUndo()
        refreshButtons()
    }

    @objc private func redoTapped() {
        editor.performRedo()
        refreshButtons()
    }

    /// A formatting command: fence it with undo boundaries so it comes off in one
    /// step rather than as two stray marker insertions.
    @objc private func boldTapped() {
        let range = editor.selectedRange
        guard range.length > 0 else { return }
        let ns = editor.textStorage.string as NSString
        let selected = ns.substring(with: range)

        editor.closeUndoGroup()
        editor.textStorage.replaceCharacters(in: range, with: "**\(selected)**")
        editor.selectedRange = NSRange(location: range.location + 2, length: range.length)
        editor.closeUndoGroup()
        refreshButtons()
    }
}

extension EditorViewController: MarkdownTextViewDelegate {
    func markdownTextView(
        _ view: MarkdownTextView,
        didRequestOpenLink destination: String
    ) {
        guard let url = URL(string: destination) else { return }
        UIApplication.shared.open(url)
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
