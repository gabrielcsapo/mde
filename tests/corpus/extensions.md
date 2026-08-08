+++
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
+++
Ping @gabe about [[the roadmap]].

```callout warning
Ship it carefully.
```

```rust
fn unregistered() {}
```

:::chart
**not decorated in here**
:::
