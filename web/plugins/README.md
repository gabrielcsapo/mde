# @mdink/plugins

Optional editor experiences built only on the public capability API. Import only the
entry points you ship; the core editor does not bundle these features.

```sh
pnpm add @mdink/plugins
```

`@mdink/plugins/raw-html` is the reference custom-node renderer. It projects recognized
HTML blocks through a host-supplied mount callback, reveals their source at the caret,
and tears down plugin-owned behavior when the node or plugin leaves.
