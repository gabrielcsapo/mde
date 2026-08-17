import { Kind, definePlugin } from '@mde/web';
import type {
  EditorPlugin,
  PluginSemanticNode,
  WidgetRenderContext,
  WidgetRequest,
  WidgetResult,
} from '@mde/web';

export interface RawHTMLPluginOptions {
  /** Stable plugin identity. Defaults to `mde.raw-html`. */
  name?: string;
  /** Inline HTML arrives as individual tags; block HTML is enabled by default. */
  includeInline?: boolean;
  /** Claim only the HTML nodes this plugin understands. Defaults to every eligible node. */
  accepts?(node: PluginSemanticNode): boolean;
  /** Host-owned renderer. It decides trust, sandboxing, behavior, and cleanup. */
  mount(request: WidgetRequest, context: WidgetRenderContext): WidgetResult | null;
}

function touchesSelection(
  node: PluginSemanticNode,
  selection: { start: number; end: number } | null,
): boolean {
  if (!selection) return false;
  const lo = Math.min(selection.start, selection.end);
  const hi = Math.max(selection.start, selection.end);
  return lo === hi
    ? node.start <= lo && lo <= node.end
    : node.start < hi && node.end > lo;
}

/**
 * Project parser-recognized raw HTML through a host renderer while keeping the exact
 * source in the document. Moving the caret into a projected node removes its widget,
 * making every source character editable without teaching the core about HTML.
 */
export function rawHTMLPlugin(options: RawHTMLPluginOptions): EditorPlugin {
  const roleName = `${options.name ?? 'mde.raw-html'}:view`;
  return definePlugin({
    name: options.name ?? 'mde.raw-html',
    requires: {
      apiVersion: 1,
      capabilities: ['semantics', 'selection', 'decorations', 'renderers'],
    },
    setup(context) {
      const role = context.internRole(roleName);
      context.renderers.register('html', {
        matches: (request) => request.roleName === roleName,
        mount: options.mount,
      });

      const project = (selection = context.selection.isActive
        ? context.selection.range
        : null) => {
        const spans = context.semantics.query({ roles: ['html'] })
          .filter((node) => node.layer === 0)
          .filter((node) => node.payload === 'block' || options.includeInline === true)
          .filter((node) => options.accepts?.(node) ?? true)
          .filter((node) => !touchesSelection(node, selection))
          .map((node) => ({
            start: node.start,
            end: node.end,
            role,
            kind: node.payload === 'block' ? Kind.BlockWidget : Kind.InlineWidget,
          }));
        context.setLayer('views', spans);
      };

      context.on('change', () => project());
      context.on('selectionchange', (event) => project(event.detail.range));
      project();
    },
  });
}

export interface TrustedHTMLPluginOptions {
  name?: string;
  className?: string;
  accepts?(node: PluginSemanticNode): boolean;
}

/**
 * Reference renderer for trusted documents. Browsers intentionally do not run script
 * tags assigned through `innerHTML`; executable behavior belongs in a custom `mount`
 * callback, where listeners and teardown can be explicit.
 */
export function trustedHTMLPlugin(options: TrustedHTMLPluginOptions = {}): EditorPlugin {
  return rawHTMLPlugin({
    name: options.name ?? 'mde.trusted-html',
    accepts: options.accepts,
    mount(request) {
      const element = document.createElement('div');
      element.className = options.className ?? 'mde-raw-html';
      element.innerHTML = request.source;
      return { element, wantsPointerEvents: true };
    },
  });
}
