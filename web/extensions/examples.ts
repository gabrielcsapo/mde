import { definePlugin } from '../src/plugins.js';
import type { EditorPlugin } from '../src/plugins.js';

export interface BacklinkPluginOptions {
  resolve(title: string, signal: AbortSignal): Promise<{ title: string; href?: string } | null>;
  open?(title: string): void;
}

/** Async wiki-link discovery written solely against public capabilities. */
export function backlinks(options: BacklinkPluginOptions): EditorPlugin {
  return definePlugin({
    name: 'examples.backlinks',
    requires: { apiVersion: 1, capabilities: ['document', 'decorations', 'tasks', 'commands'] },
    setup(context) {
      const role = context.internRole('backlink');
      const refresh = () => context.scheduleAnalysis('links', async ({ markdown, signal }) => {
        const found = [...markdown.matchAll(/\[\[([^\]\n]+)\]\]/gu)];
        const results = await Promise.all(found.map(async (match) => ({
          match, resolved: await options.resolve(match[1].trim(), signal),
        })));
        return results.filter((entry) => entry.resolved).map(({ match }) => ({
          start: match.index!, end: match.index! + match[0].length, role,
        }));
      }, (spans) => context.setLayer('backlinks', spans), { delayMs: 40 });
      context.on('change', refresh);
      context.registerCommand('open', {
        title: 'Open backlink', category: 'Navigate', keywords: ['wiki', 'note'],
        enabled: () => {
          const at = context.selection.range?.start;
          return at != null && wikiLinkAt(context.document.markdown, at) != null;
        },
        handler: () => {
          const at = context.selection.range?.start;
          const link = at == null ? null : wikiLinkAt(context.document.markdown, at);
          if (link) options.open?.(link.title);
        },
      });
      refresh();
    },
  });
}

export interface MediaGalleryOptions {
  title?: string;
  onActivate?(reference: string): void;
}

/** A semantic image gallery rendered in a plugin-owned presentation. */
export function mediaGallery(options: MediaGalleryOptions = {}): EditorPlugin {
  return definePlugin({
    name: 'examples.media-gallery',
    requires: { apiVersion: 1, capabilities: ['semantics', 'commands', 'presentations'] },
    setup(context) {
      context.registerCommand('show', {
        title: options.title ?? 'Show media gallery',
        category: 'View', keywords: ['image', 'media', 'gallery'],
        handler: () => {
          const images = context.semantics.query({ roles: ['image'] });
          const gallery = document.createElement('section');
          gallery.className = 'mde-media-gallery';
          gallery.setAttribute('aria-label', options.title ?? 'Media gallery');
          const heading = document.createElement('h2');
          heading.textContent = options.title ?? 'Media gallery';
          gallery.appendChild(heading);
          const grid = document.createElement('div');
          grid.className = 'mde-media-gallery-grid';
          for (const image of images) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = image.payload ?? image.source;
            button.title = image.source;
            button.addEventListener('click', () => {
              if (image.payload) options.onActivate?.(image.payload);
              context.selection.set({ start: image.start, end: image.end });
              context.dismissPresentation('gallery');
            });
            grid.appendChild(button);
          }
          if (images.length === 0) grid.textContent = 'No images in this document.';
          gallery.appendChild(grid);
          context.showPresentation('gallery', {
            element: gallery, anchor: 'viewport', modal: true,
            dismissOnOutsidePointer: true,
          });
        },
      });
    },
  });
}

function wikiLinkAt(markdown: string, position: number): { title: string; start: number; end: number } | null {
  for (const match of markdown.matchAll(/\[\[([^\]\n]+)\]\]/gu)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (start <= position && position <= end) return { title: match[1].trim(), start, end };
  }
  return null;
}
