# Changesets

Every user-visible npm package change gets a small markdown file in this directory.

Run `pnpm changeset`, select the affected packages, choose the semantic version bump,
and write the sentence users should see in the changelog. Documentation, tests, and
internal-only work can use `pnpm changeset --empty` when a pull request needs an explicit
“no release” marker.

All four `@mdink/*` packages are a fixed group, so their versions stay aligned. Maintainers
run `pnpm version:packages` locally, review and commit the version changes, then run
`pnpm release:npm` interactively with npm two-factor authentication. See `RELEASING.md`.
