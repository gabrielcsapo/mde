import type { EditorProjectionSnapshot, MarkdownEditor } from './editor.js';
import type { SelectionRange } from './core.js';

export interface SessionDocument {
  id: string;
  markdown: string;
  selection: SelectionRange | null;
  touchedAt: number;
}

/** A bounded, editor-agnostic set of open documents with deterministic save/switch. */
export class MarkdownSession {
  readonly editor: MarkdownEditor;
  readonly maxDocuments: number;
  readonly maxWarmDocuments: number;
  private documents = new Map<string, SessionDocument>();
  private warm = new Map<string, EditorProjectionSnapshot>();
  private activeId: string | null = null;

  constructor(
    editor: MarkdownEditor,
    options: { maxDocuments?: number; maxWarmDocuments?: number } = {},
  ) {
    this.editor = editor;
    this.maxDocuments = Math.max(1, options.maxDocuments ?? 16);
    this.maxWarmDocuments = Math.max(0, Math.min(
      this.maxDocuments,
      options.maxWarmDocuments ?? 4,
    ));
  }

  get activeDocumentId(): string | null { return this.activeId; }
  get openDocumentIds(): string[] { return [...this.documents.keys()]; }
  get warmDocumentIds(): string[] { return [...this.warm.keys()]; }

  open(id: string, markdown: string): void {
    if (!id.trim()) throw new Error('A session document id must not be empty');
    this.saveActive();
    const existing = this.documents.get(id);
    const document = existing ?? { id, markdown, selection: null, touchedAt: 0 };
    document.markdown = existing?.markdown ?? markdown;
    document.touchedAt = performance.now();
    this.documents.delete(id);
    this.documents.set(id, document);
    this.activeId = id;
    const projection = this.warm.get(id);
    if (!projection || projection.markdown !== document.markdown) {
      this.editor.setMarkdown(document.markdown);
    } else {
      this.editor.restoreProjection(projection);
      this.warm.delete(id);
      this.warm.set(id, projection);
    }
    if (document.selection) this.editor.setSelectionRange(document.selection);
    this.evictInactive();
  }

  switchTo(id: string): boolean {
    const document = this.documents.get(id);
    if (!document || id === this.activeId) return !!document;
    this.open(id, document.markdown);
    return true;
  }

  close(id: string): boolean {
    const existed = this.documents.delete(id);
    this.warm.delete(id);
    if (this.activeId === id) this.activeId = null;
    return existed;
  }

  snapshot(id: string): SessionDocument | null {
    if (id === this.activeId) this.saveActive();
    const value = this.documents.get(id);
    return value ? { ...value, selection: value.selection ? { ...value.selection } : null } : null;
  }

  saveActive(): void {
    if (!this.activeId) return;
    const document = this.documents.get(this.activeId);
    if (!document) return;
    document.markdown = this.editor.markdown;
    document.selection = globalThis.document.activeElement === this.editor.root
      ? this.editor.selectionRange()
      : document.selection;
    document.touchedAt = performance.now();
    if (this.maxWarmDocuments > 0) {
      this.warm.delete(this.activeId);
      this.warm.set(this.activeId, this.editor.captureProjection());
      while (this.warm.size > this.maxWarmDocuments) {
        const oldest = this.warm.keys().next().value;
        if (oldest === undefined) break;
        this.warm.delete(oldest);
      }
    }
  }

  destroy(): void {
    this.saveActive();
    this.documents.clear();
    this.warm.clear();
    this.activeId = null;
  }

  private evictInactive(): void {
    while (this.documents.size > this.maxDocuments) {
      const candidate = this.documents.keys().next().value;
      if (candidate === undefined) break;
      if (candidate === this.activeId) {
        const current = this.documents.get(candidate)!;
        this.documents.delete(candidate);
        this.documents.set(candidate, current);
        continue;
      }
      this.documents.delete(candidate);
      this.warm.delete(candidate);
    }
  }
}
