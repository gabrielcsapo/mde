# CommonMark conformance corpus

`spec.json` is the official CommonMark 0.31.2 example corpus, downloaded from
<https://spec.commonmark.org/0.31.2/spec.json>.

- SHA-256: `d431b29d97b6f73e69d547109cf5081578fac931e72afe95639ebe766c1b2a20`
- 652 examples
- CommonMark specification copyright © 2014-2024 John MacFarlane
- Licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)

The tests use the corpus both for base-CommonMark HTML conformance (normalizing only
serializer-level text quote escaping and inter-tag newlines) and for the editor's
stricter cross-platform decoration safety invariants.
