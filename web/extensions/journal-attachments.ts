import { definePlugin } from '../src/plugins.js';
import type { EditorPlugin, EditorPluginContext, PluginPresentationHandle } from '../src/plugins.js';

export type JournalMediaKind = 'image' | 'video' | 'audio' | 'file';

export interface JournalAttachmentResult {
  reference: string;
  kind?: JournalMediaKind;
  alt?: string;
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface JournalAttachmentImportContext {
  readonly signal: AbortSignal;
  reportProgress(fraction: number): void;
}

export interface JournalAttachmentsOptions {
  /** Persist a dropped, pasted, or selected file and return its document reference. */
  importFile(file: File, context: JournalAttachmentImportContext): Promise<JournalAttachmentResult>;
  /** Override the browser file picker (for a native bridge or an existing asset library). */
  selectFiles?: () => Promise<readonly File[]>;
  accept?: string;
  multiple?: boolean;
  onImported?: (result: JournalAttachmentResult, file: File) => void;
  onError?: (error: unknown, file: File) => void;
}

interface Upload {
  id: number;
  file: File;
  controller: AbortController;
  placeholder: string;
  previewURL: string | null;
  progress: number;
}

/**
 * A production-shaped journal media workflow: picker, paste, drop, local previews,
 * cancellable async imports, progress, and host-owned durable references.
 */
export function journalAttachments(options: JournalAttachmentsOptions): EditorPlugin {
  return definePlugin({
    name: 'mde.journal.attachments',
    setup(context) {
      let nextID = 0;
      const uploads = new Map<number, Upload>();
      let panel: PluginPresentationHandle | null = null;

      const renderUploads = () => {
        if (uploads.size === 0) {
          panel?.dismiss();
          panel = null;
          return;
        }
        const list = document.createElement('section');
        list.className = 'mde-upload-panel';
        list.setAttribute('aria-label', 'Attachment uploads');
        const heading = document.createElement('strong');
        heading.textContent = 'Adding media';
        list.appendChild(heading);
        for (const upload of uploads.values()) {
          const row = document.createElement('div');
          row.className = 'mde-upload-row';
          const copy = document.createElement('span');
          copy.textContent = upload.file.name;
          const progress = document.createElement('progress');
          progress.max = 1;
          progress.value = upload.progress;
          progress.setAttribute('aria-label', `${upload.file.name} upload progress`);
          const cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.textContent = 'Cancel';
          cancel.addEventListener('click', () => cancelUpload(upload));
          row.append(copy, progress, cancel);
          list.appendChild(row);
        }
        if (panel) panel.update({ element: list });
        else panel = context.showPresentation('uploads', {
          element: list,
          anchor: 'editor',
          placement: 'below',
          dismissOnEscape: false,
          restoreFocus: false,
        });
      };

      const finish = (upload: Upload) => {
        if (!uploads.delete(upload.id)) return;
        if (upload.previewURL) URL.revokeObjectURL(upload.previewURL);
        renderUploads();
      };

      const removePlaceholder = (upload: Upload) => {
        const at = context.editor.markdown.indexOf(upload.placeholder);
        if (at >= 0) context.editor.replaceRange(at, at + upload.placeholder.length, '');
      };

      const cancelUpload = (upload: Upload) => {
        upload.controller.abort();
        removePlaceholder(upload);
        finish(upload);
      };

      const insertFiles = async (files: readonly File[]) => {
        for (const file of files) {
          const kind = mediaKind(file);
          const id = ++nextID;
          const controller = new AbortController();
          const previewURL = kind === 'file' ? null : URL.createObjectURL(file);
          const placeholderReference = previewURL ?? `mde-import://${id}/${encodeURIComponent(file.name)}`;
          const placeholder = attachmentMarkdown(kind, cleanAlt(file.name), placeholderReference);
          const range = context.editor.selectionRange() ?? {
            start: context.editor.markdown.length,
            end: context.editor.markdown.length,
          };
          context.editor.replaceRange(range.start, range.end, placeholder);
          const caret = range.start + placeholder.length;
          context.editor.setSelectionRange({ start: caret, end: caret });
          const upload: Upload = { id, file, controller, placeholder, previewURL, progress: 0 };
          uploads.set(id, upload);
          renderUploads();
          void options.importFile(file, {
            signal: controller.signal,
            reportProgress(fraction) {
              if (controller.signal.aborted) return;
              upload.progress = Math.max(0, Math.min(1, fraction));
              renderUploads();
            },
          }).then((result) => {
            if (controller.signal.aborted) return;
            const source = context.editor.markdown;
            const at = source.indexOf(upload.placeholder);
            if (at >= 0) {
              const replacement = attachmentMarkdown(
                result.kind ?? kind,
                result.alt ?? cleanAlt(file.name),
                result.reference,
              );
              context.editor.replaceRange(at, at + upload.placeholder.length, replacement);
            }
            options.onImported?.(result, file);
          }).catch((error) => {
            if (!controller.signal.aborted) {
              removePlaceholder(upload);
              options.onError?.(error, file);
            }
          }).finally(() => finish(upload));
        }
      };

      const chooseFiles = async () => {
        const files = options.selectFiles
          ? await options.selectFiles()
          : await browserFiles(options.accept ?? 'image/*,video/*,audio/*', options.multiple ?? true);
        await insertFiles(files);
      };

      context.registerCommand('add', {
        title: 'Add photo, video, or audio',
        category: 'Insert',
        keywords: ['attachment', 'media', 'file', 'journal'],
        key: 'o',
        primary: true,
        handler: () => { void chooseFiles(); },
      });
      context.onRoot('dragover', (event) => {
        if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
      });
      context.onRoot('drop', (event) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (files.length === 0) return;
        event.preventDefault();
        void insertFiles(files);
      });
      context.onRoot('paste', (event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length === 0) return;
        event.preventDefault();
        void insertFiles(files);
      });
      return () => {
        for (const upload of uploads.values()) {
          upload.controller.abort();
          if (upload.previewURL) URL.revokeObjectURL(upload.previewURL);
        }
        uploads.clear();
        panel?.dismiss('plugin-removed');
      };
    },
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
    picker.type = 'file';
    picker.accept = accept;
    picker.multiple = multiple;
    picker.addEventListener('change', () => resolve([...(picker.files ?? [])]), { once: true });
    picker.addEventListener('cancel', () => resolve([]), { once: true });
    picker.click();
  });
}
