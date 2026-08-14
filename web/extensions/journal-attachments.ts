import { definePlugin } from '../src/plugins.js';
import type { EditorPlugin, PluginPresentationHandle } from '../src/plugins.js';
import type { PluginTransferPayload } from '@mde/plugin-sdk';

export type JournalMediaKind = 'image' | 'video' | 'audio' | 'file';

export interface AttachmentImportContext {
  readonly signal: AbortSignal;
  reportProgress(fraction: number): void;
}

export interface AttachmentImportOptions<TSource, TResult> {
  name: string;
  commandTitle: string;
  commandKeywords?: readonly string[];
  select(): Promise<readonly TSource[]>;
  import(source: TSource, context: AttachmentImportContext): Promise<TResult>;
  label(source: TSource): string;
  placeholder(source: TSource, uniqueReference: string): string;
  serialize(result: TResult, source: TSource): string;
  /** Convert a generic host/paste/drop payload into sources this importer owns. */
  sourcesFromTransfer?(payload: PluginTransferPayload): readonly TSource[];
  preview?(source: TSource): string | null;
  onImported?(result: TResult, source: TSource): void;
  onError?(error: unknown, source: TSource): void;
}

interface ImportJob<TSource> {
  id: number;
  source: TSource;
  controller: AbortController;
  placeholder: string;
  previewURL: string | null;
  progress: number;
}

/**
 * Generic async import pipeline for files, URLs, asset-library records, camera captures,
 * or host-defined objects. It owns no storage policy and serializes only durable results.
 */
export function attachmentImports<TSource, TResult>(
  options: AttachmentImportOptions<TSource, TResult>,
): EditorPlugin {
  return definePlugin({
    name: options.name,
    requires: {
      apiVersion: 1,
      capabilities: ['document', 'selection', 'transfers', 'commands', 'presentations'],
    },
    setup(context) {
      let nextID = 0;
      const jobs = new Map<number, ImportJob<TSource>>();
      let panel: PluginPresentationHandle | null = null;

      const render = () => {
        if (jobs.size === 0) {
          panel?.dismiss();
          panel = null;
          return;
        }
        const list = document.createElement('section');
        list.className = 'mde-upload-panel';
        list.setAttribute('aria-label', 'Imports');
        const heading = document.createElement('strong');
        heading.textContent = 'Adding content';
        list.appendChild(heading);
        for (const job of jobs.values()) {
          const row = document.createElement('div');
          row.className = 'mde-upload-row';
          const copy = document.createElement('span');
          copy.textContent = options.label(job.source);
          const progress = document.createElement('progress');
          progress.max = 1;
          progress.value = job.progress;
          progress.setAttribute('aria-label', `${copy.textContent} import progress`);
          const cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.textContent = 'Cancel';
          cancel.addEventListener('click', () => cancelJob(job));
          row.append(copy, progress, cancel);
          list.appendChild(row);
        }
        if (panel) panel.update({ element: list });
        else panel = context.showPresentation('imports', {
          element: list, anchor: 'editor', placement: 'below',
          dismissOnEscape: false, restoreFocus: false,
        });
      };

      const finish = (job: ImportJob<TSource>) => {
        if (!jobs.delete(job.id)) return;
        if (job.previewURL) URL.revokeObjectURL(job.previewURL);
        render();
      };
      const replacePlaceholder = (job: ImportJob<TSource>, replacement: string) => {
        const at = context.document.markdown.indexOf(job.placeholder);
        if (at < 0) return;
        context.document.transact({
          edits: [{ start: at, end: at + job.placeholder.length, text: replacement }],
          metadata: { label: 'Resolve import', origin: options.name },
        });
      };
      const cancelJob = (job: ImportJob<TSource>) => {
        job.controller.abort();
        replacePlaceholder(job, '');
        finish(job);
      };

      const insert = async (sources: readonly TSource[]) => {
        for (const source of sources) {
          const id = ++nextID;
          const controller = new AbortController();
          const previewURL = options.preview?.(source) ?? null;
          const uniqueReference = previewURL ?? `mde-import://${encodeURIComponent(options.name)}/${id}`;
          const placeholder = options.placeholder(source, uniqueReference);
          const range = context.selection.range ?? {
            start: context.document.length, end: context.document.length,
          };
          const caret = range.start + placeholder.length;
          context.document.transact({
            edits: [{ ...range, text: placeholder }],
            selection: { start: caret, end: caret },
            metadata: { label: 'Insert import', origin: options.name },
          });
          const job = { id, source, controller, placeholder, previewURL, progress: 0 };
          jobs.set(id, job);
          render();
          void options.import(source, {
            signal: controller.signal,
            reportProgress(fraction) {
              if (controller.signal.aborted) return;
              job.progress = Math.max(0, Math.min(1, fraction));
              render();
            },
          }).then((result) => {
            if (controller.signal.aborted) return;
            replacePlaceholder(job, options.serialize(result, source));
            options.onImported?.(result, source);
          }).catch((error) => {
            if (!controller.signal.aborted) {
              replacePlaceholder(job, '');
              options.onError?.(error, source);
            }
          }).finally(() => finish(job));
        }
      };

      context.registerCommand('add', {
        title: options.commandTitle,
        category: 'Insert', keywords: options.commandKeywords,
        key: 'o', primary: true,
        handler: () => { void options.select().then(insert); },
      });
      if (options.sourcesFromTransfer) {
        context.transfers.register('imports', {
          priority: 50,
          accepts: (payload): payload is PluginTransferPayload<TSource[]> =>
            options.sourcesFromTransfer!(payload).length > 0,
          handle: async (payload) => {
            const sources = options.sourcesFromTransfer!(payload);
            if (sources.length === 0) return false;
            await insert(sources);
            return true;
          },
        });
      }
      return () => {
        for (const job of jobs.values()) {
          job.controller.abort();
          if (job.previewURL) URL.revokeObjectURL(job.previewURL);
        }
        jobs.clear();
        panel?.dismiss('plugin-removed');
      };
    },
  });
}

export interface JournalAttachmentResult {
  reference: string;
  kind?: JournalMediaKind;
  alt?: string;
  metadata?: Readonly<Record<string, string | number | boolean>>;
}
export interface JournalAttachmentsOptions {
  importFile(file: File, context: AttachmentImportContext): Promise<JournalAttachmentResult>;
  selectFiles?: () => Promise<readonly File[]>;
  accept?: string;
  multiple?: boolean;
  onImported?: (result: JournalAttachmentResult, file: File) => void;
  onError?: (error: unknown, file: File) => void;
}

/** File-oriented convenience preset retained for journal applications. */
export function journalAttachments(options: JournalAttachmentsOptions): EditorPlugin {
  return attachmentImports<File, JournalAttachmentResult>({
    name: 'mde.journal.attachments',
    commandTitle: 'Add photo, video, or audio',
    commandKeywords: ['attachment', 'media', 'file', 'journal'],
    select: () => options.selectFiles
      ? Promise.resolve(options.selectFiles())
      : browserFiles(options.accept ?? 'image/*,video/*,audio/*', options.multiple ?? true),
    import: options.importFile,
    label: (file) => file.name,
    preview: (file) => mediaKind(file) === 'file' ? null : URL.createObjectURL(file),
    placeholder: (file, reference) => attachmentMarkdown(
      mediaKind(file), cleanAlt(file.name), reference,
    ),
    serialize: (result, file) => attachmentMarkdown(
      result.kind ?? mediaKind(file), result.alt ?? cleanAlt(file.name), result.reference,
    ),
    sourcesFromTransfer: (payload) => {
      if (payload.kind !== 'paste' && payload.kind !== 'drop') return [];
      const value = payload.value as { files?: readonly File[] };
      return value.files ?? [];
    },
    onImported: options.onImported,
    onError: options.onError,
  });
}

function mediaKind(file: File): JournalMediaKind {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'file';
}
function attachmentMarkdown(kind: JournalMediaKind, alt: string, reference: string): string {
  const safeAlt = alt.replaceAll(']', '\\]');
  const prefix = kind === 'image' ? '' : `${kind}: `;
  return `![${prefix}${safeAlt}](${reference})`;
}
function cleanAlt(filename: string): string {
  return filename.replace(/\.[^.]+$/u, '').replaceAll(/[-_]+/gu, ' ').trim() || 'attachment';
}
function browserFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const picker = document.createElement('input');
    picker.type = 'file'; picker.accept = accept; picker.multiple = multiple;
    picker.addEventListener('change', () => resolve([...(picker.files ?? [])]), { once: true });
    picker.addEventListener('cancel', () => resolve([]), { once: true });
    picker.click();
  });
}
