// Host-drawn widgets.
//
// Same seam as `WidgetProvider` on Apple (DESIGN §5): the core resolves syntax, ranges,
// reveal state, identity and the reference; the host only draws. Content that is fully
// described by the markdown itself (a callout's text) belongs here; anything that must
// be fetched belongs in a `ResourceResolver`.

import type { Decoration } from './core.js';

export interface WidgetRequest {
  roleName: string | null;
  source: string;
  payload: string | null;
  decoration: Decoration;
}

/** Services owned by the editor for one mounted widget. */
export interface WidgetRenderContext {
  /** Notify viewport and overlay managers after asynchronous content changes size. */
  requestLayout(): void;
}

/**
 * A lifecycle-aware widget. Returning a bare HTMLElement remains supported for simple
 * host renderers; plugins use this form when they own subscriptions, media, or code.
 */
export interface WidgetMount {
  element: HTMLElement;
  /** Called when a stable decoration is painted again without rebuilding the view. */
  update?(request: WidgetRequest, context: WidgetRenderContext): void;
  /** Called exactly once when the source node, renderer, editor, or cache entry leaves. */
  unmount?(): void;
  /** Opt in only when controls inside the view need pointer input. */
  wantsPointerEvents?: boolean;
}

export type WidgetResult = HTMLElement | WidgetMount;

export interface WidgetProvider {
  /** Return null to fall through to resource resolution or styled source. */
  makeWidget(request: WidgetRequest, context?: WidgetRenderContext): WidgetResult | null;
  /** Opt in only for widgets with their own interactive controls. */
  widgetWantsPointerEvents?(roleName: string | null): boolean;
}

/** One plugin-owned renderer registered into the editor's ordinary widget pipeline. */
export interface WidgetRenderer {
  matches(request: WidgetRequest): boolean;
  mount(request: WidgetRequest, context: WidgetRenderContext): WidgetResult | null;
}

export {};
