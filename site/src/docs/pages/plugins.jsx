import { Aside, Clause, Clauses, H2, H3, Lede, Note, SeeAlso, TableFrame } from '../../components/Doc.jsx';
import SourceFigure from '../../components/SourceFigure.jsx';

const webExample = `import { slashCommandMenu } from '@mde/web/extensions/composer';
import { linkEditor, templatePicker } from '@mde/web/extensions/productivity';

editor.installPlugin(linkEditor());
editor.installPlugin(templatePicker(templates));
editor.installPlugin(slashCommandMenu()); // discovers both commands`;

const suggestionExample = `suggestionPlugin({
  name: 'journal.people',
  triggers: [{ trigger: '@' }],
  debounceMs: 120,
  loadingLabel: 'Searching people…',
  provider: async ({ query, signal }) =>
    api.people.search(query, { signal }),
});`;

const swiftExample = `let mentions = MarkdownSuggestionPlugin(
  name: "journal.people",
  triggers: [MarkdownSuggestionTrigger("@")],
  debounce: 0.12
) { request, complete in
  people.search(request.match.query, cancellation: request.cancellation, complete)
}

try editor.installPlugin(mentions)`;

const FEATURES = [
  ['Mentions, tags, wiki links', 'One suggestion engine; different trigger and insertion rules.'],
  ['Slash-command menu', 'Reads the central command registry, including commands added later.'],
  ['Floating formatting toolbar', 'Selection-anchored UI; source edits still go through editor history.'],
  ['Link and image-description editors', 'Accessible focused dialogs that preserve the underlying reference.'],
  ['Templates and find/replace', 'Discoverable commands usable from shortcuts, toolbars, or slash menus.'],
  ['Journal attachments', 'Picker, paste/drop, local preview, progress, cancellation, durable references.'],
];

export default function Plugins() {
  return (
    <>
      <H2 id="platform">A plugin platform, not a popup hook</H2>
      <Lede>
        Commands, floating UI, suggestions, and background work share one editor-owned lifecycle.
        A package can add the interactions people expect without changing the renderer or putting UI
        state in markdown.
      </Lede>
      <Clauses>
        <Clause title="Commands are discoverable">
          A command has an id, title, category, keywords, enabled and checked state, plus an optional
          shortcut. Toolbars and slash menus read the same registry. Shortcut conflicts have a
          deterministic winner and emit a diagnostic event.
        </Clause>
        <Clause title="Presentations are owned">
          A handle can update, reposition, or dismiss a view. Selection popovers flip above or below,
          viewport dialogs trap focus, Escape and outside interaction are configurable, and focus is
          restored on teardown.
        </Clause>
        <Clause title="Cleanup is atomic">
          Removing a plugin removes commands, views, listeners, layers, and in-flight work. Stale
          command and presentation handles become inert.
        </Clause>
      </Clauses>

      <H2 id="commands">Build menus from commands</H2>
      <SourceFigure path="editor-plugins.ts" lang="typescript" code={webExample} />
      <p className="mt-5">
        React exposes the same registry through <code>useEditorCommands</code> and the editor ref.
        Swift exposes <code>registeredPluginCommands</code>,{' '}
        <code>executePluginCommand(id:)</code>, and change notifications. No menu needs a private list.
      </p>

      <H2 id="suggestions">One suggestion engine</H2>
      <Lede>
        The shipped engine handles async latest-wins providers, cancellation, debounce, a bounded
        cache, fuzzy ranking, groups, loading and empty states, keyboard navigation, and IME input.
      </Lede>
      <SourceFigure path="people-plugin.ts" lang="typescript" code={suggestionExample} />
      <SourceFigure className="mt-5" path="PeoplePlugin.swift" lang="swift" code={swiftExample} />
      <Note>
        Identical in-flight queries are coalesced. This matters because browsers and TextKit can emit
        several selection callbacks while revealing a token at the caret.
      </Note>

      <H3 id="framework-ui">React and SwiftUI stay optional</H3>
      <p>
        <code>createReactPresentation</code> and <code>usePluginPresentation</code> render a React root
        through the framework-neutral presentation lifecycle.{' '}
        <code>showSwiftUIPresentation</code> does the same with a hosting view on UIKit and AppKit.
        Core packages do not take either framework as a dependency.
      </p>

      <H2 id="included">Included examples</H2>
      <TableFrame className="mt-6">
        <thead><tr><th>Plugin</th><th className="desc">What it demonstrates</th></tr></thead>
        <tbody>{FEATURES.map(([name, detail]) => (
          <tr key={name}><td>{name}</td><td className="desc">{detail}</td></tr>
        ))}</tbody>
      </TableFrame>

      <Aside tone="note" title="The document remains boring">
        A tag is still <code>#travel</code>, a wiki link is still <code>[[Day One]]</code>, and an
        attachment is still a short markdown reference. Plugins improve authoring; they do not create
        a proprietary document format.
      </Aside>

      <SeeAlso links={[
        { to: '/extend/journal', title: 'Journal integration', note: 'media import and persistence' },
        { to: '/extend/layers', title: 'Host decoration layers', note: 'non-interactive plugin output' },
        { to: '/reference/web', title: 'Web API', note: 'exact signatures' },
      ]} />
    </>
  );
}
