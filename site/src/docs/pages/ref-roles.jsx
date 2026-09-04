import { Aside, H2, Lede, Note, SeeAlso, TableFrame } from '../../components/Doc.jsx';
import { Link } from '../../lib/router.jsx';

// Ids and names from crates/mde-core/src/registry.rs; classes from the applier's map in
// web/src/applier.ts. The three lists are the same nineteen entries in the same order,
// which is the property that makes an id a constant a theme can rely on.
const ROLES = [
  [0, 'heading', '.mde-heading', 'plus .mde-h1 … .mde-h6 for the level'],
  [1, 'marker', '.mde-marker', 'the syntax characters themselves'],
  [2, 'emphasis', '.mde-emphasis', ''],
  [3, 'strong', '.mde-strong', ''],
  [4, 'code.inline', '.mde-code-inline', ''],
  [5, 'code.block', '.mde-code-block', ''],
  [6, 'link', '.mde-link', 'the whole node'],
  [7, 'link.text', '.mde-link-text', 'the visible label'],
  [8, 'image', '.mde-image', 'carries the reference as its payload'],
  [9, 'quote', '.mde-quote', 'projects a rail; depth carries the nesting level'],
  [10, 'list.bullet', '.mde-list-bullet', 'payload is the exact marker; depth carries nesting'],
  [11, 'task.checkbox', '.mde-task-checkbox', 'a selection-aware projection plus the Hit toggle'],
  [12, 'rule', '.mde-rule', 'projects the source marker as a visual divider'],
  [13, 'strikethrough', '.mde-strikethrough', ''],
  [14, 'table', '.mde-table', 'the complete GFM table source'],
  [15, 'table.header', '.mde-table-header', 'the header row'],
  [16, 'table.delimiter', '.mde-table-delimiter', 'the alignment delimiter row'],
  [17, 'table.cell', '.mde-table-cell', 'each header or body cell'],
  [18, 'html', '.mde-html', 'inline HTML and HTML blocks'],
];

const STRUCTURE = [
  ['.mde-editor', 'the host element; the editor adds this and owns everything inside it'],
  ['.mde-line', 'one source line, including its trailing newline'],
  ['.mde-line-table', 'one editable source row inside a table'],
  ['.mde-line-table-start / -end', 'the outside edge and corner modifiers'],
  ['.mde-line-table-header / -delimiter', 'the two structural header-row modifiers'],
  ['.mde-table-widget / .mde-table-view', 'the wrapper and ignored presentation subtree'],
  ['.mde-rendered-table', 'the semantic HTML table shown while its source is not being edited'],
  ['.mde-line-concealed', 'a line that contributes only concealed source — zero height'],
  ['.mde-line-block', 'the line that draws a block widget, made block-level'],
  ['.mde-run', 'a run of characters carrying one set of roles'],
  ['.mde-list-unordered / -ordered', 'native bullet projection or aligned numeric marker'],
  ['.mde-task-projected / -checked', 'unchecked and checked task-list projections'],
  ['.mde-conceal', 'hairline; uses !important so it beats role styling'],
  ['.mde-widget', 'the wrapper around a host-drawn view'],
  ['.mde-widget-view', 'the host’s own element, marked data-mde-ignore'],
];

export default function RefRoles() {
  return (
    <>
      <H2 id="builtin">The nineteen built-in roles</H2>
      <Lede>
        Built-in roles are interned first, so their ids are stable constants that renderers and
        themes rely on without a lookup. Extension roles — from a manifest, or from{' '}
        <code>internRole</code> at runtime — are interned after them, which is why anything at or
        above <code>19</code> needs <code>roleName(id)</code>.
      </Lede>
      <TableFrame className="mt-6">
        <thead>
          <tr>
            <th>Id</th>
            <th>Name</th>
            <th>Web class</th>
            <th className="desc">Notes</th>
          </tr>
        </thead>
        <tbody>
          {ROLES.map(([id, name, cls, note]) => (
            <tr key={id}>
              <td className="role">{id}</td>
              <td className="role">{name}</td>
              <td className="role">{cls}</td>
              <td className="desc">{note}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Note>
        The same ids are <code>Role.Heading …</code> in JavaScript, <code>Role.heading …</code> in
        Swift, and <code>MDE_ROLE_HEADING …</code> in C.
      </Note>
      <Note>
        Core parsing follows CommonMark. Tables, task-list checkboxes, and strikethrough are the
        deliberately enabled GitHub-flavored extensions. Source-only constructs such as escapes,
        entities, reference definitions, and hard or soft breaks need no role: the editor preserves
        their exact characters and lets the platform text engine draw them normally.
      </Note>

      <H2 id="extension-roles">An extension role becomes a class</H2>
      <p>
        The web applier turns any role it does not recognise into{' '}
        <code>.mde-ext-&lt;name&gt;</code>, with anything outside <code>[\w-]</code> replaced by a
        dash. So <code>pos-noun</code> is <code>.mde-ext-pos-noun</code> and a wikilink declared as{' '}
        <code>wikilink</code> is <code>.mde-ext-wikilink</code> — styling one is a matter of writing
        CSS, with no change to the editor or its theme.
      </p>
      <p>
        On Apple the equivalent is a key in <code>Theme.extensionRoles</code>, whose value is an
        attribute dictionary. Both are looked up by <em>name</em>, because an extension role’s id
        depends on manifest order and is not a constant.
      </p>
      <Aside tone="caution" title="Specificity">
        A role class and a built-in class are both single-class selectors, so source order decides
        between them. Load extension styling <em>after</em> <code>theme.css</code>, or a focus dim
        cannot dim a heading. <code>.mde-conceal</code> uses <code>!important</code> and therefore
        still wins over both — which is correct: a concealed marker must stay collapsed whatever a
        layer says about the text around it.
      </Aside>

      <H2 id="structure">Structural classes</H2>
      <Lede>
        The web renderer’s own scaffolding. A theme rarely needs these, but a host debugging layout
        will meet all of them.
      </Lede>
      <TableFrame className="mt-6">
        <thead>
          <tr>
            <th>Class</th>
            <th className="desc">What it is</th>
          </tr>
        </thead>
        <tbody>
          {STRUCTURE.map(([cls, what]) => (
            <tr key={cls}>
              <td className="role">{cls}</td>
              <td className="desc">{what}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Note>
        Everything inside a <code>data-mde-ignore</code> subtree is invisible to the editor’s tree
        walk, which is what stops a widget’s label from smuggling itself into the document.
      </Note>

      <H2 id="theming">Theming the web editor</H2>
      <Lede>
        <code>theme.css</code> reads five custom properties, each with a light-mode fallback
        baked in — so restyling the editor is setting variables on <code>.mde-editor</code>{' '}
        (or any ancestor), not forking the stylesheet.
      </Lede>
      <TableFrame className="mt-6">
        <thead>
          <tr>
            <th>Variable</th>
            <th className="desc">What it colours</th>
          </tr>
        </thead>
        <tbody>
          <tr><td className="role">--mde-text</td><td className="desc">body text</td></tr>
          <tr><td className="role">--mde-bg</td><td className="desc">the editor background</td></tr>
          <tr><td className="role">--mde-muted</td><td className="desc">markers, quotes, struck text</td></tr>
          <tr><td className="role">--mde-code-bg</td><td className="desc">inline and fenced code</td></tr>
          <tr><td className="role">--mde-accent</td><td className="desc">links, bullets, checkboxes, the caret</td></tr>
        </tbody>
      </TableFrame>
      <Note>
        Anything past colour — a different heading scale, another mono face — is ordinary CSS
        against the classes above, loaded <em>after</em> <code>theme.css</code> so equal-specificity
        rules win on source order. That is exactly how the two showcase extensions style their own
        roles, and how this site restyles the embedded editor. On Apple the same dial is{' '}
        <code>Theme</code>: attributes per role, resolved once.
      </Note>

      <SeeAlso
        links={[
          {
            to: '/docs/extend/layers',
            title: 'Host decoration layers',
            note: 'where a role invented at runtime comes from',
          },
          {
            to: '/docs/platforms/web',
            title: 'Web',
            note: 'why the line classes are shaped the way they are',
          },
        ]}
      />
    </>
  );
}
