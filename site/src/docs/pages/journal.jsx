import { Aside, Clause, Clauses, H2, H3, Lede, Note, SeeAlso } from '../../components/Doc.jsx';
import SourceFigure from '../../components/SourceFigure.jsx';

const webJournal = `editor.installPlugin(journalAttachments({
  async importFile(file, { signal, reportProgress }) {
    const asset = await journalAssets.store(file, { signal, reportProgress });
    return { reference: asset.path, alt: asset.description, metadata: asset.metadata };
  },
}));`;

const swiftJournal = `final class JournalAssets: JournalAttachmentImporting {
  func selectAttachments(completion: @escaping ([URL]) -> Void) {
    // Present PhotosPicker, UIDocumentPicker, or NSOpenPanel.
  }

  func importAttachment(_ url: URL, progress: @escaping (Double) -> Void,
                        completion: @escaping (Result<JournalAttachmentImportResult, Error>) -> Void)
    -> JournalAttachmentImportCancellation? { /* copy or upload */ }
}

try editor.installPlugin(JournalAttachments(importer: assets))`;

export default function Journal() {
  return (
    <>
      <H2 id="flow">Media is an import workflow</H2>
      <Lede>
        A journaling editor has to feel instant even when persistence is not. The attachment plugin
        inserts a local preview first, then swaps only that markdown reference after the host finishes
        copying or uploading the asset.
      </Lede>
      <Clauses>
        <Clause title="Immediate">
          Picker, paste, and drop all enter the same path. Images, video, and audio appear from a local
          URL before network or database work finishes.
        </Clause>
        <Clause title="Cancellable">
          Every import owns a cancellation signal and progress value. Removing the plugin cancels all
          outstanding work; late completions cannot mutate the document.
        </Clause>
        <Clause title="Durable">
          The host returns the short reference it can resolve on the next launch. Bytes and temporary
          object URLs never become the saved document format.
        </Clause>
      </Clauses>

      <H2 id="web">Web and React</H2>
      <SourceFigure path="journal-editor.ts" lang="typescript" code={webJournal} />
      <p className="mt-5">
        The extension accepts a custom picker for an existing asset library. Without one it uses the
        browser file picker and also handles files pasted or dropped on the editor. React installs the
        same plugin object through its <code>plugins</code> prop.
      </p>

      <H2 id="apple">iOS and macOS</H2>
      <SourceFigure path="JournalAssets.swift" lang="swift" code={swiftJournal} />
      <p className="mt-5">
        The protocol deliberately leaves presentation to the app: an iPhone journal may use
        <code>PhotosPicker</code>, macOS may use <code>NSOpenPanel</code>, and a document app may use a
        security-scoped picker. Paste, drop, and share-sheet URLs call the same <code>add(_:)</code>
        method, so persistence and cancellation are still tested once.
      </p>

      <H3 id="metadata">Metadata belongs beside the asset</H3>
      <p>
        Dimensions, duration, MIME type, capture date, and an accessibility description can travel in
        the import result for the journal database. Markdown stores the reference and alt text; the
        resource resolver supplies the richer preview and remembered display size.
      </p>
      <Note>
        The image-description command is enabled only when the caret is inside an image token, making
        alt text editable from a toolbar or slash menu without reparsing markdown in the plugin.
      </Note>

      <Aside tone="caution" title="Do not persist preview URLs">
        Browser <code>blob:</code> URLs and temporary Apple file URLs are presentation aids. Always
        replace them with an application-owned reference before saving or syncing the entry.
      </Aside>

      <SeeAlso links={[
        { to: '/concepts/widgets', title: 'Widgets and references', note: 'how media is resolved' },
        { to: '/extend/plugins', title: 'Interactive plugins', note: 'commands and floating UI' },
        { to: '/internals/performance', title: 'Performance', note: 'heavy-media budgets' },
      ]} />
    </>
  );
}
