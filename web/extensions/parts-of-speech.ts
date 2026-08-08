// Parts-of-speech highlighting — an extension, not a feature of the editor.
//
// Like `typewriter.ts`, nothing in `web/src/` knows this exists. It reads the document
// text, decides what each word is, and pushes a decoration layer (DESIGN §5.3).
//
// It is the more demanding of the two showcase extensions, because its decorations
// depend on *language*, which the markdown parser has no concept of and never will.
//
// A caveat worth stating plainly rather than burying: the tagger below is a heuristic —
// a closed-class word list plus suffix rules. It is not a real part-of-speech tagger and
// it will be wrong on genuinely ambiguous words ("book a flight" tags `book` as a noun).
// The Apple build uses the operating system's `NLTagger` and is much better. What is
// being demonstrated here is the *plumbing* — that a feature this far outside markdown
// can drive the editor's decoration pipeline without the editor knowing about it.

import type { MarkdownEditor } from '../src/editor.js';

const DETERMINERS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her',
  'its', 'our', 'their', 'some', 'any', 'no', 'every', 'each', 'either', 'neither',
]);

const PRONOUNS = new Set([
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'us', 'them', 'who',
  'whom', 'which', 'what', 'whose', 'someone', 'anyone', 'everyone', 'nothing',
]);

const PREPOSITIONS = new Set([
  'of', 'in', 'to', 'for', 'with', 'on', 'at', 'from', 'by', 'about', 'as', 'into',
  'like', 'through', 'after', 'over', 'between', 'out', 'against', 'during', 'without',
  'before', 'under', 'around', 'among', 'up', 'down', 'off', 'near', 'per',
]);

const CONJUNCTIONS = new Set([
  'and', 'but', 'or', 'nor', 'so', 'yet', 'because', 'although', 'though', 'while',
  'if', 'unless', 'until', 'whereas', 'than', 'that', 'when', 'where',
]);

// Auxiliaries and very common irregular verbs, which no suffix rule can reach.
const VERBS = new Set([
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had',
  'do', 'does', 'did', 'will', 'would', 'can', 'could', 'shall', 'should', 'may',
  'might', 'must', 'get', 'got', 'go', 'goes', 'went', 'gone', 'make', 'made',
  'say', 'says', 'said', 'see', 'saw', 'seen', 'take', 'took', 'taken', 'come',
  'came', 'know', 'knew', 'known', 'give', 'gave', 'given', 'find', 'found',
  'think', 'thought', 'tell', 'told', 'become', 'became', 'leave', 'left', 'put',
  'keep', 'kept', 'let', 'begin', 'began', 'seem', 'help', 'show', 'shown',
  'hear', 'heard', 'run', 'ran', 'move', 'moved', 'live', 'bring', 'brought',
  'write', 'wrote', 'written', 'read', 'draw', 'drew', 'stay', 'stays',
]);

const ADJECTIVES = new Set([
  'good', 'new', 'first', 'last', 'long', 'great', 'little', 'own', 'other', 'old',
  'right', 'big', 'high', 'different', 'small', 'large', 'next', 'early', 'young',
  'important', 'few', 'public', 'bad', 'same', 'able', 'best', 'better', 'whole',
  'real', 'clean', 'fast', 'simple', 'plain', 'quick', 'brown', 'lazy',
]);

const ADVERBS = new Set([
  'not', 'also', 'very', 'often', 'however', 'too', 'usually', 'really', 'early',
  'never', 'always', 'sometimes', 'together', 'likely', 'simply', 'still', 'just',
  'already', 'only', 'even', 'again', 'here', 'there', 'now', 'then', 'once',
  'rather', 'quite', 'almost', 'instead', 'exactly', 'deliberately',
]);

/**
 * A coarse tag for one lowercase word, or null for "leave it alone".
 *
 * Order matters: closed classes are decided by membership, and only then do suffix
 * rules run. A suffix rule that fired first would call "the" an adjective.
 */
export function tagWord(word) {
  const w = word.toLowerCase();

  if (DETERMINERS.has(w) || PRONOUNS.has(w) || PREPOSITIONS.has(w) || CONJUNCTIONS.has(w)) {
    return null;
  }
  if (ADVERBS.has(w)) return 'adverb';
  if (VERBS.has(w)) return 'verb';
  if (ADJECTIVES.has(w)) return 'adjective';

  // `-ly` is the strongest suffix signal in English, but "reply" and "apply" are not
  // adverbs, so require something before it that looks like a stem.
  if (w.length > 4 && w.endsWith('ly') && !/[aeiou]ly$/.test(w)) return 'adverb';

  if (w.length > 4 && (w.endsWith('ing') || w.endsWith('ed'))) return 'verb';
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) {
    // Ambiguous between a plural noun and a third-person verb; nouns are far more
    // common in prose, so this is the cheaper mistake.
    return 'noun';
  }
  if (
    w.length > 4 &&
    /(ous|ful|ive|able|ible|al|ic|ish|less|ary)$/.test(w)
  ) {
    return 'adjective';
  }
  if (
    w.length > 4 &&
    /(tion|sion|ness|ment|ity|ance|ence|ship|hood|ist|ism|er|or)$/.test(w)
  ) {
    return 'noun';
  }
  // Anything left that is a plain word is most often a noun in prose.
  if (w.length > 2) return 'noun';
  return null;
}

/** Word ranges over the document, as `[start, end, word]`. */
function words(text: string): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  const re = /[A-Za-z][A-Za-z'-]*/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length, m[0]]);
  return out;
}

export class PartsOfSpeech {
  static LAYER = 'parts-of-speech';

  editor: MarkdownEditor;
  enabled: boolean;
  roles: Record<'noun' | 'verb' | 'adjective' | 'adverb', number>;
  timer: number;
  onChange: () => void;

  /** @param {import('../src/editor.js').MarkdownEditor} editor */
  constructor(editor: MarkdownEditor) {
    this.editor = editor;
    this.enabled = false;
    this.roles = {
      noun: editor.internRole('pos-noun'),
      verb: editor.internRole('pos-verb'),
      adjective: editor.internRole('pos-adjective'),
      adverb: editor.internRole('pos-adverb'),
    };
    this.timer = 0;
    this.onChange = () => this.schedule();
  }

  toggle() {
    if (this.enabled) this.disable();
    else this.enable();
    return this.enabled;
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.editor.addEventListener('change', this.onChange);
    this.recompute();
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.editor.removeEventListener('change', this.onChange);
    clearTimeout(this.timer);
    this.editor.clearLayer(PartsOfSpeech.LAYER);
  }

  /**
   * Tagging the whole document on every keystroke would be wasteful, and the core
   * already slides existing spans over an edit so they stay on their words in the
   * meantime (DESIGN §5.3). Coalescing to idle is therefore invisible.
   */
  schedule() {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.recompute(), 150);
  }

  recompute() {
    if (!this.enabled) return;
    const text = this.editor.markdown;
    const spans = [];
    for (const [start, end, word] of words(text)) {
      const tag = tagWord(word);
      if (tag) spans.push({ start, end, role: this.roles[tag] });
    }
    this.editor.setLayer(PartsOfSpeech.LAYER, spans);
  }
}
