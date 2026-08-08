// Client-side search over the whole site.
//
// No search dependency, and not because dependencies are forbidden — because the corpus
// is about 40 KB of text across eighteen pages. An inverted index, stemming and BM25
// would all be measurable work to build and no work at all to notice: at this size a
// linear scan over pre-tokenised entries finishes in well under a millisecond, which is
// faster than the reader can see either way.
//
// What actually decides whether search feels good here is not the algorithm, it is what
// gets indexed and at what weight. Three sources, all of them already the single copy of
// their content:
//
//   * `virtual:mde-docs-corpus` — the prose under every `H2`/`H3`, extracted from the
//     page sources at build time (see `vite.config.js`).
//   * `docs/nav.js` — page titles, summaries, and the keywords a reader might type that
//     the prose never literally says ("quickstart", "wysiwyg", "npm").
//   * `lib/api.js` — every documented symbol, so `setLayer` and `reservedSize` are
//     findable by name and land on the right anchor.
//
// A result is a *section*, never a whole page: the point of the exercise is that someone
// can be sent to one idea.

import { corpus } from 'virtual:mde-docs-corpus';
import { API_PAGES } from './api.js';
import { PAGES } from '../docs/nav.js';

/** @typedef {{path: string, hash: string, page: string, group: string, title: string, kind: 'page'|'section'|'symbol', text: string, tokens: string[], boost: number}} Entry */

const tokenize = (s) =>
  s
    .toLowerCase()
    // Keep `.` and `-` inside words: `code.inline`, `plaintext-only`, `mde-core`.
    .split(/[^\p{L}\p{N}._-]+/u)
    .filter(Boolean);

/** @returns {Entry[]} */
function build() {
  /** @type {Entry[]} */
  const entries = [];

  for (const page of PAGES) {
    const sections = corpus[page.file] ?? [];

    for (const section of sections) {
      const isLead = !section.id;
      const title = isLead ? page.title : section.title;
      // The page's own entry carries its summary and keywords, so a search for a term
      // that appears nowhere in the prose still finds the page it belongs to.
      const text = isLead ? `${page.summary} ${page.keywords ?? ''} ${section.text}` : section.text;
      entries.push({
        path: page.path,
        hash: section.id ?? '',
        page: page.title,
        group: page.group.title,
        title,
        kind: isLead ? 'page' : 'section',
        text,
        tokens: [...new Set([...tokenize(title), ...tokenize(text)])],
        // A page beats one of its own sections when both match equally well.
        boost: isLead ? 1.4 : 1,
      });
    }
  }

  for (const { path, groups } of API_PAGES) {
    const page = PAGES.find((p) => p.path === path);
    for (const group of groups) {
      for (const symbol of group.symbols) {
        const text = `${symbol.signature} ${symbol.summary} ${symbol.note ?? ''}`;
        entries.push({
          path,
          hash: group.id,
          page: page?.title ?? path,
          group: page?.group.title ?? 'Reference',
          title: symbol.name,
          kind: 'symbol',
          text,
          tokens: [...new Set([...tokenize(symbol.name), ...tokenize(text)])],
          // A symbol is what someone searching for `setLayer` almost certainly wants.
          boost: 1.6,
        });
      }
    }
  }

  return entries;
}

/** Built once, on first use — nothing needs it until the reader opens search. */
let index = null;
const entries = () => (index ??= build());

/**
 * @param {string} query
 * @param {number} [limit]
 * @returns {(Entry & {score: number, snippet: {text: string, hit: boolean}[]})[]}
 */
export function search(query, limit = 12) {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const results = [];
  for (const entry of entries()) {
    let score = 0;
    const titleLower = entry.title.toLowerCase();

    for (const term of terms) {
      let best = 0;
      // Title matches are what a person is usually aiming at, so they dominate.
      if (titleLower === term) best = 60;
      else if (titleLower.startsWith(term)) best = 40;
      else if (titleLower.includes(term)) best = 26;

      for (const token of entry.tokens) {
        if (token === term) best = Math.max(best, 12);
        else if (token.startsWith(term)) best = Math.max(best, 7);
        else if (term.length > 3 && token.includes(term)) best = Math.max(best, 3);
      }

      // Every term has to appear somewhere: two words should narrow the results, not
      // widen them.
      if (best === 0) {
        score = 0;
        break;
      }
      score += best;
    }

    if (score > 0) results.push({ ...entry, score: score * entry.boost, snippet: [] });
  }

  results.sort((a, b) => b.score - a.score || a.title.length - b.title.length);
  return results.slice(0, limit).map((r) => ({ ...r, snippet: snippet(r.text, terms) }));
}

/**
 * A readable excerpt around the first matching term, split into plain and highlighted
 * runs so the caller can mark the hits without setting HTML.
 *
 * @param {string} text @param {string[]} terms
 * @returns {{text: string, hit: boolean}[]}
 */
function snippet(text, terms, width = 150) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  const from = at === -1 ? 0 : Math.max(0, at - 40);
  // Start on a word boundary, so an excerpt never opens mid-word.
  const start = from === 0 ? 0 : text.indexOf(' ', from) + 1;
  const slice = text.slice(start, start + width).trim();
  const body = (start > 0 ? '… ' : '') + slice + (start + width < text.length ? ' …' : '');

  const pattern = new RegExp(`(${terms.map(escape).join('|')})`, 'gi');
  return body
    .split(pattern)
    .filter(Boolean)
    .map((part) => ({ text: part, hit: terms.includes(part.toLowerCase()) }));
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
