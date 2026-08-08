import Foundation

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// What a host app registers: two custom block types and two custom inline tokens,
/// all declarative. No host code runs inside the parser.
public enum HostExtensions {
    public static let manifest = """
        [[block]]
        name   = "callout"
        syntax = { kind = "fence", info = "callout" }
        render = "block_widget"
        reveal = "caret_in_block"

        [[block]]
        name   = "chart"
        syntax = { kind = "directive", marker = ":::", name = "chart" }
        render = "block_widget"
        reveal = "caret_in_block"

        [[inline]]
        name   = "mention"
        syntax = { kind = "pattern", regex = "@[a-zA-Z0-9_-]+" }
        render = "inline_widget"
        reveal = "caret_in_node"

        [[inline]]
        name   = "wikilink"
        syntax = { kind = "delimited", open = "[[", close = "]]" }
        render = "style"
        reveal = "caret_in_node"
        """

    public static let sample = """
    # Inline rendering

    Markdown stays **markdown**. Put the caret inside *any* node and its syntax comes back — nothing is hidden from you, and nothing is converted into a separate model.

    Ordinary things work: `inline code`, [a link](https://example.dev), and ~~struck text~~.

    > A quote renders with a rule in the margin.
    > > And nesting carries depth.

    - a plain bullet
    - [ ] tap this checkbox
    - [x] this one is done

    ## Extensions

    Ping @gabe about [[the roadmap]] — both of those come from the host app's manifest, not from this editor.

    ```callout warning
    A custom block type. The host draws it natively; the core only says where it starts and stops.
    ```

    ```swift
    // An unregistered fence stays styled source.
    let editor = MarkdownTextView()
    ```

    ## References

    The document holds a *reference*, never the bytes. This image is a 26-character path that the host resolves off disk:

    ![a generated chart](chart.png)

    Same for anything else the host can fetch — a document, a video, a remote asset:

    ![the spec](spec.pdf)

    ---
    """
}
