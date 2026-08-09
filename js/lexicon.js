// Repair the words OCR misreads, using what English words actually look like.
//
// Tesseract confuses glyphs that look alike: b read as h, r as t, m as rn, a as
// 3. The result is text that is mostly right and locally nonsense —
// "incomprehensihility", "hetween", "hete" for "here". A reader can decode it,
// but slowly, and it poisons anything you search for or quote.
//
// The fix is to ask, for every word that is not English, whether some
// small glyph confusion away there is a word that is. Two rules keep this from
// inventing text:
//
//   * a word the document itself uses repeatedly is left alone, whatever the
//     dictionary thinks — that is how "Bavinck" and "perichoresis" survive;
//   * a word the lexicon already knows is only overruled by something hundreds
//     of times commoner, which is what separates "hete" (a real but vanishingly
//     rare word) from "here".
//
// Everything it changes is counted, so the reader can say how much it touched.

const LEXICON_URL = '../vendor/lexicon/en.txt';
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** word -> approximate number of occurrences in a large corpus. */
let table = null;
let loading = null;

/** Roughly the download, so the UI can say so before starting. */
export const LEXICON_KB = 800;

export async function load() {
  if (table) return table;
  if (loading) return loading;
  loading = (async () => {
    const res = await fetch(new URL(LEXICON_URL, import.meta.url).href);
    if (!res.ok) throw new Error(`Could not load the word list (${res.status})`);
    table = decode(await res.text());
    return table;
  })();
  return loading;
}

export const ready = () => Boolean(table);

/** Take the word list from text already in hand, instead of fetching it. */
export function hydrate(raw) {
  table = decode(raw);
  return table;
}

function decode(raw) {
  const split = raw.indexOf('\n');
  const codes = raw.slice(0, split);
  const lines = raw.slice(split + 1).split('\n');
  const map = new Map();
  let prev = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const word = prev.slice(0, B36.indexOf(line[0])) + line.slice(1);
    map.set(word, 2 ** ((codes.charCodeAt(i) - 35) / 3));
    prev = word;
  }
  return map;
}

/** How often this word turns up in ordinary English. 0 means: not a word. */
export function freqOf(word) {
  return table?.get(word) || 0;
}

// Glyph pairs a scanner genuinely mixes up. Not a list of typos: every entry is
// two shapes that look alike at 200 dpi through a photocopier.
const CONFUSABLE = [
  ['a', 'o e n u 3 ci'],
  ['b', 'h k 6 8 lo'],
  ['c', 'e o t'],
  ['d', 'cl ci a tl'],
  ['e', 'c o a 0 3'],
  ['f', 't r l'],
  ['g', 'q y 9 8'],
  ['h', 'b n li k lr'],
  ['i', 'l j 1 t'],
  ['j', 'i y'],
  ['k', 'h lc ic'],
  ['l', 'i 1 t e'],
  ['m', 'rn nn in ni'],
  ['n', 'h r u m ri'],
  ['o', 'c e 0 a u q'],
  ['p', 'n q'],
  ['q', 'g p o'],
  ['r', 't n i f v'],
  ['s', '5 8 a g'],
  ['t', 'f r l i'],
  ['u', 'n v ii o'],
  ['v', 'y u r'],
  ['w', 'vv v'],
  ['x', 'k v'],
  ['y', 'v g j'],
  ['z', '2 s'],
  ['0', 'o d'],
  ['1', 'l i t'],
  ['2', 'z'],
  ['3', 'a e 8'],
  ['4', 'a'],
  ['5', 's'],
  ['6', 'b g'],
  ['7', 't'],
  ['8', 'b s g'],
  ['9', 'g q'],
  ['rn', 'm'],
  ['cl', 'd'],
  ['ii', 'u n'],
  ['vv', 'w'],
  ['li', 'h'],
  ['ri', 'n'],
  ['nn', 'm'],
  ['lr', 'h k']
].map(([from, to]) => [from, to.split(' ')]);

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Every word one glyph confusion away from this one. */
function confusions(word) {
  const out = new Set();
  for (let i = 0; i < word.length; i++) {
    for (const [from, tos] of CONFUSABLE) {
      if (!word.startsWith(from, i)) continue;
      const head = word.slice(0, i);
      const tail = word.slice(i + from.length);
      for (const to of tos) out.add(head + to + tail);
    }
  }
  out.delete(word);
  return out;
}

/** The classic one-letter edits, for misreadings no confusion table predicts. */
function edits(word) {
  const out = new Set();
  for (let i = 0; i < word.length; i++) {
    const head = word.slice(0, i);
    out.add(head + word.slice(i + 1)); // dropped a letter
    for (const c of LETTERS) {
      out.add(head + c + word.slice(i + 1)); // read it as another
      out.add(head + c + word.slice(i)); // invented one
    }
  }
  for (const c of LETTERS) out.add(word + c);
  out.delete(word);
  return out;
}

// A word in ordinary use is never second-guessed. This is the rule that matters
// most: without it, "die" becomes "the" and "arid" becomes "and", because those
// are a single glyph apart and thousands of times commoner. No frequency ratio
// is a safe substitute — "the" outnumbers almost everything by that margin.
// Only words at the very bottom of the lexicon, which no ordinary page contains,
// can be overruled at all.
const RARE = 150;
// ...and then only by something thousands of times commoner, which for a word
// this rare means any word in ordinary use.
const OVERRULE_RATIO = 5000;
const OVERRULE_FLOOR = 2e4;
// An unknown capitalised word mid-sentence is a name until proved otherwise, so
// it takes a famous word to displace one. This is what keeps "Bavinck" whole
// while still letting "Cliristian" become "Christian".
const NAME_FLOOR = 5e4;
// Even a word in no dictionary is not repaired towards something rarer still.
const UNKNOWN_FLOOR = 90;
// A wholesale re-spelling, when no glyph confusion explains the word, takes more.
const FLOOR_EDIT = 5000;
// Two-letter words carry no signal — half the alphabet is one edit from "in".
const MIN_LENGTH = 3;
const MIN_LENGTH_KNOWN = 4;
const CAP = 40000;

function best(candidates, floor) {
  let bestWord = null;
  let bestFreq = floor;
  for (const c of candidates) {
    const f = freqOf(c);
    if (f > bestFreq) {
      bestFreq = f;
      bestWord = c;
    }
  }
  return bestWord ? { word: bestWord, freq: bestFreq } : null;
}

/**
 * A word split in two by a lost space — "toa" for "to a". Only worth doing when
 * both halves are far commoner than the run-together form, which is what stops
 * "into" becoming "in to".
 */
// Words that cannot follow an article. "ina" is "in a"; "ais" is not "a is".
const NEVER_AFTER_ARTICLE = new Set('in is as an at of on or to be by it he we if so no up us do my me and the a'.split(' '));
const ARTICLES = new Set(['a', 'an', 'the']);
// ...and pronouns an article cannot follow. "ita" is not "it a".
const NEVER_BEFORE_ARTICLE = new Set(['it', 'he', 'she', 'we', 'they', 'i', 'you', 'him', 'her']);

function unsplit(word, base) {
  const need = Math.max(1e6, base * 2000);
  let found = null;
  for (let i = 1; i < word.length; i++) {
    const left = word.slice(0, i);
    const right = word.slice(i);
    if (left.length < 2 && !'ai'.includes(left)) continue;
    if (right.length < 2 && !'ai'.includes(right)) continue;
    // "isis" is not "is is", and "toto" is not "to to".
    if (left === right) continue;
    if (ARTICLES.has(left) && NEVER_AFTER_ARTICLE.has(right)) continue;
    if (ARTICLES.has(right) && NEVER_BEFORE_ARTICLE.has(left)) continue;
    const weakest = Math.min(freqOf(left), freqOf(right));
    if (weakest < need) continue;
    if (!found || weakest > found.freq) found = { word: `${left} ${right}`, freq: weakest };
  }
  return found;
}

/** Give the repair the shape of the word it replaces. */
function matchCase(original, replacement) {
  if (original === original.toUpperCase() && /[A-Z]{2}/.test(original)) return replacement.toUpperCase();
  if (/^[A-Z]/.test(original)) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

/**
 * Correct one word, or return null to leave it alone.
 * `settled` holds the words this document uses often enough to be deliberate;
 * `isName` marks a capitalised word that is not opening a sentence.
 */
export function repair(token, settled, isName = false) {
  const lower = token.toLowerCase();
  if (lower.length < MIN_LENGTH || !/[a-z]/.test(lower)) return null;
  if (settled?.has(lower)) return null;

  const base = freqOf(lower);

  // A lost space, as in "toa" for "to a". Worth testing even against a word the
  // lexicon knows, but only at three letters or fewer: at four, real words like
  // "fora" and "nota" start turning up and would be pulled apart. Never against
  // a capitalised word, since "Asa" and "Isa" are names, not "as a".
  const splittable = !isName && lower.length <= 6 && (base <= RARE || lower.length <= 3);
  const split = splittable ? unsplit(lower, base) : null;

  if (base > RARE) return split ? matchCase(token, split.word) : null;
  if (base && lower.length < MIN_LENGTH_KNOWN) return null;

  const floor = base
    ? Math.max(OVERRULE_FLOOR, base * OVERRULE_RATIO)
    : isName
      ? NAME_FLOOR
      : UNKNOWN_FLOOR;

  let pick = best(confusions(lower), floor);

  // Nothing one confusion away: try two, which is where a bad photocopy lands.
  if (!pick && lower.length <= 18) {
    const wider = new Set();
    for (const near of confusions(lower)) {
      for (const far of confusions(near)) {
        wider.add(far);
        if (wider.size > CAP) break;
      }
      if (wider.size > CAP) break;
    }
    wider.delete(lower);
    pick = best(wider, floor);
  }

  // Still nothing, and not a word at all: allow any single-letter re-reading,
  // but only towards a word common enough that the guess is barely one.
  if (!pick && !base && !isName) pick = best(edits(lower), Math.max(floor, FLOOR_EDIT));

  if (split && (!pick || split.freq > pick.freq)) pick = split;

  return pick ? matchCase(token, pick.word) : null;
}

/**
 * The document's own settled vocabulary: words it uses repeatedly. A scanner's
 * mistakes are erratic, so anything that keeps recurring is almost certainly
 * what the page really says — a name, a technical term, a foreign word.
 */
export function settledWords(texts) {
  const seen = new Map();
  for (const text of texts) {
    for (const word of String(text).toLowerCase().match(/[a-z][a-z'-]*/g) || []) {
      seen.set(word, (seen.get(word) || 0) + 1);
    }
  }
  const settled = new Set();
  for (const [word, count] of seen) if (count >= 3) settled.add(word);
  return settled;
}

/** Run the repair over a whole page, reporting how many words it changed. */
export function repairText(text, settled) {
  let changed = 0;
  let words = 0;
  const whole = String(text);
  const out = whole.replace(/[A-Za-z][A-Za-z'’-]*/g, (token, offset) => {
    words++;
    // A capital only means "name" in the middle of a sentence. At the start of
    // one it means nothing, and in a heading everything is capitalised.
    const before = whole.slice(Math.max(0, offset - 12), offset);
    const opening = offset === 0 || /(^|[.!?:;•—–]|\n)["'“”‘’)\]]?\s*$/.test(before);
    const isName = /^[A-Z][a-z]/.test(token) && !opening;
    const fixed = repair(token.replace(/’/g, "'"), settled, isName);
    if (!fixed || fixed === token) return token;
    changed++;
    return fixed;
  });
  return { text: out, changed, words };
}

/**
 * Repair every page of an extraction in place, returning the same shape plus a
 * tally. Footnotes get the same treatment as the body.
 */
export function repairPages(pages) {
  const settled = settledWords(pages.flatMap((p) => [p.text, p.notes].filter(Boolean)));
  let changed = 0;
  let words = 0;
  const out = pages.map((page) => {
    const body = repairText(page.text || '', settled);
    const notes = page.notes ? repairText(page.notes, settled) : null;
    changed += body.changed + (notes?.changed || 0);
    words += body.words + (notes?.words || 0);
    return { ...page, text: body.text, ...(notes ? { notes: notes.text } : {}) };
  });
  return { pages: out, changed, words };
}
