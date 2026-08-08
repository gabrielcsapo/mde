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

export interface WidgetProvider {
  /** Return null to fall through to resource resolution or styled source. */
  makeWidget(request: WidgetRequest): HTMLElement | null;
  /** Opt in only for widgets with their own interactive controls. */
  widgetWantsPointerEvents?(roleName: string | null): boolean;
}

export {};
