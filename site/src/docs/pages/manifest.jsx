import {
  Aside,
  Footnote,
  H2,
  H3,
  Lede,
  Note,
  SeeAlso,
  TableFrame,
} from '../../components/Doc.jsx';
import SourceFigure from '../../components/SourceFigure.jsx';
import { Link } from '../../lib/router.jsx';
import { extensionsToml, manifestBinary, manifestJs } from '../../lib/snippets.js';

const BLOCK_FIELDS = [
  ['name', 'string', 'The role name. Interned after the built-ins, and what the theme styles.'],
  ['syntax', 'table', 'How the block is recognised — a fence, or a directive. See below.'],
  ['render', 'enum', 'style · inline_widget · block_widget · hit'],
  ['reveal', 'enum', 'never · caret_in_node · caret_in_line · caret_in_block. Defaults to never.'],
];

const BLOCK_SYNTAX = [
  [
    '{ kind = "fence", info = "callout" }',
    'A fenced code block whose info string starts with that word. CommonMark already parses it, so it costs the core nothing and no outside tool can corrupt it.',
  ],
  [
    '{ kind = "directive", marker = ":::", name = "chart" }',
    'A marker-delimited block. Lighter visually, and needs a custom block scan.',
  ],
];

const INLINE_SYNTAX = [
  [
    '{ kind = "pattern", regex = "@[a-zA-Z0-9_-]+" }',
    'A regular expression, compiled once at registry construction and never on the edit path.',
  ],
  [
    '{ kind = "delimited", open = "[[", close = "]]" }',
    'A literal open and close pair. The payload is what sits between them.',
  ],
];

const PREFILTERS = [
  ['@[a-zA-Z0-9_-]+', '@', 'a leading literal'],
  ['^#tag', '#', 'a leading anchor does not change which bytes can appear'],
  ['a?bc', '—', 'a quantifier can make the first character optional'],
  ['[abc]+', '—', 'a class is not a fixed byte'],
  ['\\d+', '—', 'an escape could be a literal or a class, so it is refused'],
  ['(foo|bar)', '—', 'an alternation has no single first byte'],
];

export default function Manifest() {
  return (
    <>
      <H2 id="declarative">Declarative data, not code in the parser</H2>
      <Lede>
        Day-one extension capabilities are custom <strong>block types</strong> and custom{' '}
        <strong>inline tokens</strong>. Both are data. No extension code runs inside the parser —
        that is what keeps the hot path fast, keeps behaviour identical across platforms, and keeps
        it safe.
      </Lede>
      <p>
        Wasm plugins were considered and rejected: iOS forbids JIT, so it would mean shipping an
        interpreter into the per-keystroke path to buy flexibility neither day-one capability needs.
        For the features a manifest genuinely cannot describe, there is a second mechanism —{' '}
        <Link to="/extend/layers">host decoration layers</Link>.
      </p>
      <SourceFigure className="mt-8" path="extensions.toml" lang="toml" code={extensionsToml} />
      <Footnote>
        The host ships this manifest plus one widget renderer per platform. The core resolves
        syntax, ranges, capture groups, reveal state and identity; the host only draws. This exact
        manifest is what the <Link to="/try">demo editor</Link> is running.
      </Footnote>

      <H2 id="fields">Fields</H2>
      <Lede>
        <code>[[block]]</code> and <code>[[inline]]</code> take the same four fields. Only{' '}
        <code>syntax</code> differs between them.
      </Lede>
      <TableFrame className="mt-6">
        <thead>
          <tr>
            <th>Field</th>
            <th>Type</th>
            <th className="desc">Meaning</th>
          </tr>
        </thead>
        <tbody>
          {BLOCK_FIELDS.map(([field, type, meaning]) => (
            <tr key={field}>
              <td className="role">{field}</td>
              <td>{type}</td>
              <td className="desc">{meaning}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>

      <H3 id="block-syntax">Block syntax</H3>
      <TableFrame className="mt-5">
        <thead>
          <tr>
            <th className="desc">syntax</th>
            <th className="desc">Matches</th>
          </tr>
        </thead>
        <tbody>
          {BLOCK_SYNTAX.map(([syntax, meaning]) => (
            <tr key={syntax}>
              <td className="role">{syntax}</td>
              <td className="desc">{meaning}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Note>
        A fence rule matches on the <em>first word</em> of the info string, so{' '}
        <code>```callout</code> and <code>```callout warning</code> are both the callout block — and
        the remainder becomes the decoration’s payload, which is how the host knows to draw the
        second one as a warning.
      </Note>

      <H3 id="inline-syntax">Inline syntax</H3>
      <TableFrame className="mt-5">
        <thead>
          <tr>
            <th className="desc">syntax</th>
            <th className="desc">Matches</th>
          </tr>
        </thead>
        <tbody>
          {INLINE_SYNTAX.map(([syntax, meaning]) => (
            <tr key={syntax}>
              <td className="role">{syntax}</td>
              <td className="desc">{meaning}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Note>
        Patterns are compiled with <code>regex-lite</code>. An invalid one is a construction error
        naming the rule, not a panic and not a rule that silently never matches.
      </Note>

      <H2 id="prefilter">Every inline rule gets a prefilter, when one is provable</H2>
      <Lede>
        <code>regex-lite</code> has no literal prescan, so <code>@[a-zA-Z0-9_-]+</code> walked every
        byte of every text run looking for an <code>@</code> that was not there — 3.5 ms on 100 KB
        of prose with zero matches, 26× the cost of the markdown parse itself.
      </Lede>
      <p>
        So the registry extracts a byte that every match must contain, and checks for it first. The
        extraction is deliberately timid: anything that is not an unambiguous leading literal
        returns nothing, which just means the rule keeps its old cost. A wrong answer here would
        silently drop matches, so the bar is proof rather than likelihood.
      </p>
      <TableFrame className="mt-6 max-w-[820px]">
        <thead>
          <tr>
            <th>Pattern</th>
            <th>Prefilter</th>
            <th className="desc">Why</th>
          </tr>
        </thead>
        <tbody>
          {PREFILTERS.map(([pattern, byte, why]) => (
            <tr key={pattern}>
              <td className="role">{pattern}</td>
              <td>{byte}</td>
              <td className="desc">{why}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Note>
        A delimited rule always has one: the first byte of its opening string. There is a test for
        each row above.
      </Note>

      <H2 id="roles-and-ids">Names become roles</H2>
      <p>
        Every <code>name</code> in the manifest is interned as a role, after the fourteen built-ins
        and in manifest order. Renderers and themes can therefore rely on the built-in ids being
        stable constants, and look extension roles up by name — <code>roleName(id)</code> on both
        platforms. On the web an unknown role becomes the class{' '}
        <code>.mde-ext-&lt;name&gt;</code>; on Apple it is a key in{' '}
        <code>Theme.extensionRoles</code>.
      </p>

      <H2 id="binary">The binary form, for the web</H2>
      <Lede>
        TOML stays the authoring format across platforms, but shipping a TOML parser into wasm cost
        about 350 KB for a parse that happens once at startup. The web build drops it and takes a
        compact binary encoding instead.
      </Lede>
      <SourceFigure className="mt-6" path="crates/mde-core/src/registry.rs" lang="text" code={manifestBinary} />
      <p className="mt-6">
        Nobody writes those bytes by hand. <code>encodeManifest</code> in{' '}
        <code>web/src/manifest.ts</code> takes the same manifest as a plain object and produces
        them, and a round-trip test asserts the two forms build identical registries.
      </p>
      <SourceFigure className="mt-5" path="web/examples/vanilla/host.js" lang="javascript" code={manifestJs} />

      <Aside tone="caution" title="A malformed manifest">
        On Apple, <code>MarkdownEngine(manifest:)</code> returns nil and{' '}
        <code>MarkdownTextView(manifest:)</code> falls back to no extensions rather than trapping —
        check it at startup if you would rather fail loudly. On the web,{' '}
        <code>newEngine</code> throws. A truncated binary manifest is an error, never a panic; there
        is a test that cuts one at five different lengths.
      </Aside>

      <SeeAlso
        links={[
          {
            to: '/extend/layers',
            title: 'Host decoration layers',
            note: 'for the features a manifest cannot describe',
          },
          {
            to: '/concepts/widgets',
            title: 'Widgets and references',
            note: 'what the host does with a block_widget once it is declared',
          },
          {
            to: '/reference/roles',
            title: 'Roles and CSS classes',
            note: 'the built-in ids an extension is interned after',
          },
        ]}
      />
    </>
  );
}
