// Host-drawn widgets.
//
// Same seam as `WidgetProvider` on Apple (DESIGN §5): the core resolves syntax, ranges,
// reveal state, identity and the reference; the host only draws. Content that is fully
// described by the markdown itself (a callout's text) belongs here; anything that must
// be fetched belongs in a `ResourceResolver`.

/**
 * @typedef {object} WidgetRequest
 * @property {string|null} roleName  the name the manifest declared, e.g. "callout"
 * @property {string} source         the exact markdown the widget replaces
 * @property {string|null} payload   fence argument, directive body, delimited inner text
 * @property {import('./core.js').Decoration} decoration
 *
 * @typedef {object} WidgetProvider
 * @property {(request: WidgetRequest) => HTMLElement|null} makeWidget
 *   Return null to fall through to the resource resolver, and failing that to leave the
 *   range as ordinary styled text.
 * @property {((roleName: string|null) => boolean)} [widgetWantsPointerEvents]
 *   Whether this widget handles its own clicks. Defaults to false, and the default
 *   matters: a widget that captures clicks stops the caret ever reaching the source it
 *   replaced, so the reveal policy never fires and the content cannot be edited
 *   (DESIGN §4). Return true only for widgets with real controls, and give those an
 *   escape hatch back to the source.
 */

export {};
