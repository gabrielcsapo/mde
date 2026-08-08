// Syntax highlighting for the excerpts this site quotes.
//
// An earlier version of this file hand-tagged four snippets token by token and said, with
// some justification, that shipping a tokeniser for four of them would be a dependency
// for no legibility gained. There are more than a dozen now, in five languages, and
// hand-tagging is no longer the cheap option — it is a few hundred lines of `t('p', '(')`
// in which a wrong colour is invisible and a wrong character is a lie about the source.
//
// So: one regex, about forty lines, no grammar and no dependency. It knows comments,
// strings, numbers, keywords, capitalised names and call sites, which is every
// distinction these excerpts actually make. It does not know scope, types, or JSX, and
// nothing here asks it to.
//
// Class names (`k` keyword, `t` type, `s` string, `c` comment, `p` punctuation,
// `f` function, `n` number) are styled under `.src` in site.css.

/** @typedef {{cls: string|null, text: string}} Token */

const KEYWORDS = {
  javascript: new Set(
    ('const let var function return class extends new import export from default async await ' +
      'if else for while switch case break continue throw try catch finally typeof instanceof ' +
      'this null undefined true false get set static of in delete void yield')
      .split(' ')
  ),
  swift: new Set(
    ('let var func class struct enum protocol extension import return if else guard for while ' +
      'switch case default break continue throws throw try catch defer init deinit public ' +
      'private internal open final static override self nil true false where as is some any ' +
      'weak unowned lazy mutating inout typealias associatedtype convenience required')
      .split(' ')
  ),
  rust: new Set(
    ('fn let mut struct enum impl trait pub use mod match if else for while loop return ' +
      'self Self const static crate move ref as dyn where unsafe true false')
      .split(' ')
  ),
  c: new Set(
    ('const void struct typedef enum unsigned signed static extern return if else for while ' +
      'sizeof bool size_t uint8_t uint32_t uint64_t int32_t char')
      .split(' ')
  ),
  toml: new Set([]),
  bash: new Set('cd export set if then fi for do done echo'.split(' ')),
  text: new Set([]),
};

/** Which line-comment marker a language uses. `#` in JavaScript would eat a fragment. */
const HASH_COMMENTS = new Set(['toml', 'bash', 'text']);

/**
 * Tokenise a snippet.
 *
 * @param {'javascript'|'swift'|'rust'|'c'|'toml'|'bash'|'text'} lang
 * @param {string} source
 * @returns {Token[]}
 */
export function tag(lang, source) {
  const keywords = KEYWORDS[lang] ?? new Set();
  const comment = HASH_COMMENTS.has(lang) ? '#[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
  const re = new RegExp(
    `(${comment})` + // 1 comment
      `|('(?:\\\\.|[^'\\\\])*'|"(?:\\\\.|[^"\\\\])*"|\`(?:\\\\.|[^\`\\\\])*\`)` + // 2 string
      '|(\\b\\d[\\w.]*)' + // 3 number
      '|([A-Za-z_$][\\w$]*)' + // 4 word
      '|([^\\sA-Za-z0-9_$]+)', // 5 punctuation
    'g'
  );

  /** @type {Token[]} */
  const out = [];
  const push = (cls, text) => {
    if (!text) return;
    // Runs of the same class merge, which keeps the DOM small on long comments.
    const last = out[out.length - 1];
    if (last && last.cls === cls) last.text += text;
    else out.push({ cls, text });
  };

  let at = 0;
  let m;
  while ((m = re.exec(source)) !== null) {
    push(null, source.slice(at, m.index));
    at = re.lastIndex;

    if (m[1]) push('c', m[1]);
    else if (m[2]) push('s', m[2]);
    else if (m[3]) push('n', m[3]);
    else if (m[4]) {
      const word = m[4];
      if (keywords.has(word)) push('k', word);
      // A capitalised name is a type in every language quoted here.
      else if (/^[A-Z]/.test(word)) push('t', word);
      // Followed by `(` — a call, or a declaration of one.
      else if (source[re.lastIndex] === '(') push('f', word);
      else push(null, word);
    } else push('p', m[5]);
  }
  push(null, source.slice(at));
  return out;
}
