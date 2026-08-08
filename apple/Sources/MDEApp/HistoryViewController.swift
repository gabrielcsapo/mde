import MDECore
import MDEditorUI
import UIKit

/// The revision timeline as a list (DESIGN §9).
///
/// Every entry is shown, *including revisions that have been undone* — the branch you
/// stepped back from stays visible, which is what makes the history browsable rather
/// than merely reversible. Tapping any row lands there in one move via `jump(to:)`.
final class HistoryViewController: UITableViewController {
    private let editor: MarkdownTextView
    private let onJump: () -> Void

    init(editor: MarkdownTextView, onJump: @escaping () -> Void) {
        self.editor = editor
        self.onJump = onJump
        super.init(style: .insetGrouped)
        title = "History"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            systemItem: .done,
            primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) }
        )
    }

    // Row 0 is the document as opened; row n is "after revision n-1", matching
    // `historyPosition`'s meaning exactly.
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        editor.revisions.count + 1
    }

    override func tableView(
        _ tableView: UITableView,
        cellForRowAt indexPath: IndexPath
    ) -> UITableViewCell {
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        var content = cell.defaultContentConfiguration()

        if indexPath.row == 0 {
            content.text = "Opened document"
        } else {
            let rev = editor.revisions[indexPath.row - 1]
            content.text = describe(rev)
            content.secondaryText = age(of: rev)
            content.secondaryTextProperties.color = .secondaryLabel
        }
        cell.contentConfiguration = content
        cell.accessoryType = indexPath.row == editor.historyPosition ? .checkmark : .none
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        editor.jump(to: indexPath.row)
        onJump()
        tableView.reloadData()
    }

    private func describe(_ rev: Revision) -> String {
        switch rev.kind {
        case .insert: "Added \(rev.inserted) characters"
        case .delete: "Removed \(rev.removed) characters"
        case .replace: "Replaced \(rev.removed) with \(rev.inserted) characters"
        }
    }

    /// The engine's clock is monotonic — it exists for undo coalescing — so age against
    /// the same clock is the honest rendering; a wall-clock date would show 1970.
    private func age(of rev: Revision) -> String {
        let elapsed = (MarkdownEngine.now() - min(rev.atMs, MarkdownEngine.now())) / 1000
        return switch elapsed {
        case ..<5: "just now"
        case ..<60: "\(elapsed)s ago"
        case ..<3600: "\(elapsed / 60)m ago"
        default: "\(elapsed / 3600)h ago"
        }
    }
}
