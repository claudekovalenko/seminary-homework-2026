// Tests for the parts that can be checked without a browser: hyphen decisions,
// word repair, and the image passes that clean a scan before it is read.
//
//   node tools/test.mjs
//
// The end-to-end reading accuracy is measured separately, in tools/bench.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// store.js reaches for localStorage as it loads; the settings it holds are not
// what is under test here, so a plain object stands in for it.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k)
};

const { resolveHyphens, JOIN } = await import('../js/pdftext.js');
const lexicon = await import('../js/lexicon.js');
const { despeckle, estimateSkew, sauvola, clearBorders } = await import('../js/imageprep.js');

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.log(`FAIL  ${what}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  }
}
function ok(what, condition, detail = '') {
  checks++;
  if (!condition) {
    failures++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ''}`);
  }
}

/* ---------- hyphens broken across lines and pages ---------- */

const hy = (text) => resolveHyphens([{ text }])[0].text;

// With no evidence either way, a broken word is put back together: typeset
// prose breaks words far more often than it hyphenates them.
check('broken word is joined', hy(`the metaphysi${JOIN}cal claim`), 'the metaphysical claim');

// ...unless the document itself uses the compound elsewhere.
check(
  'compound survives when the document uses it',
  resolveHyphens([{ text: `a load${JOIN}bearing wall` }, { text: 'every load-bearing wall matters' }])[0].text,
  'a load-bearing wall'
);
check(
  'joined form wins when that is what the document uses',
  resolveHyphens([{ text: `the self${JOIN}same hour` }, { text: 'the selfsame hour again' }])[0].text,
  'the selfsame hour'
);

// A word broken by the page break itself: the tail is on the next page.
const across = resolveHyphens([{ text: `an argument about the metaphysi${JOIN}` }, { text: 'cal claim it makes' }]);
check('word broken across pages, head', across[0].text, 'an argument about the metaphysical');
check('word broken across pages, tail', across[1].text, 'claim it makes');

// Footnotes are resolved on the same terms as the body.
check(
  'notes are resolved too',
  resolveHyphens([{ text: 'body', notes: `Institu${JOIN}tiones, III` }], ['text', 'notes'])[0].notes,
  'Institutiones, III'
);
check('no marker survives', hy(`ends with a stray ${JOIN}`).includes(JOIN), false);

/* ---------- word repair ---------- */

lexicon.hydrate(readFileSync(resolve(ROOT, 'vendor/lexicon/en.txt'), 'utf8'));
const settled = lexicon.settledWords(['Bavinck said so. Bavinck again, and Bavinck a third time.']);

check('h read for b is repaired', lexicon.repair('hetween', settled), 'between');
check('rn read for m is repaired', lexicon.repair('incornprehensible', settled), 'incomprehensible');
check('capitalised misreading is repaired', lexicon.repair('Cliristian', settled, true), 'Christian');
check('a name the document keeps using is left alone', lexicon.repair('Bavinck', settled, true), null);
check('an ordinary word is never second-guessed', lexicon.repair('die', settled), null);
check('nor is this one', lexicon.repair('arid', settled), null);
// ...but a word at the very bottom of the lexicon is exactly what a scanner
// turns "here" into, and that one is overruled.
check('a vanishingly rare word yields to a common one', lexicon.repair('hete', settled), 'here');
ok('a real word is not invented from nothing', lexicon.repair('perichoresis', settled, false) === null);

/* ---------- the image passes ---------- */

// A page of ruled lines, tilted by a known angle, is the one case where the
// right answer is known in advance.
function ruled(width, height, degrees, pitch = 40) {
  const grey = new Uint8Array(width * height).fill(255);
  const slope = Math.tan((degrees * Math.PI) / 180);
  for (let x = 0; x < width; x++) {
    const shift = (x - width / 2) * slope;
    for (let base = pitch; base < height - pitch; base += pitch) {
      const y = Math.round(base + shift);
      for (let t = 0; t < 6; t++) {
        const yy = y + t;
        if (yy >= 0 && yy < height) grey[yy * width + x] = 20;
      }
    }
  }
  return grey;
}

for (const angle of [-1.4, 2.1, 3.5, 5]) {
  const found = estimateSkew(ruled(900, 1200, angle), 900, 1200);
  ok(`skew of ${angle} degrees is found`, Math.abs(found - angle) <= 0.2, `found ${found.toFixed(2)}`);
}
ok('a straight page is left alone', estimateSkew(ruled(900, 1200, 0), 900, 1200) === 0);
// Under a degree the correction costs more in resampling than the tilt costs in
// accuracy, so it is deliberately reported as straight.
ok('a barely tilted page is left alone too', estimateSkew(ruled(900, 1200, 0.6), 900, 1200) === 0);

// Specks go; anything the size of a full stop stays.
{
  const w = 60;
  const h = 60;
  const binary = new Uint8Array(w * h).fill(255);
  const dot = (cx, cy, r) => {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) binary[y * w + x] = 0;
      }
    }
  };
  dot(10, 10, 0); // a single pixel of grain
  dot(30, 30, 3); // a full stop
  const removed = despeckle(binary, w, h);
  check('one speck removed', removed, 1);
  check('the speck is gone', binary[10 * w + 10], 255);
  check('the full stop is untouched', binary[30 * w + 30], 0);
}

// The black edge a copier leaves is wiped; the text beside it is not.
{
  const w = 200;
  const h = 100;
  const grey = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < 6; x++) grey[y * w + x] = 5;
  for (let y = 40; y < 60; y++) for (let x = 40; x < 160; x++) grey[y * w + x] = 30;
  clearBorders(grey, w, h);
  check('the copier edge is wiped', grey[50 * w + 2], 255);
  check('the type is kept', grey[50 * w + 100], 30);
}

// A page lit unevenly: one global threshold loses the dark side, a local one
// does not. This is the gutter shadow of every book scan.
{
  const w = 1200;
  const h = 400;
  const grey = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Paper fading from bright to dark across the page.
      grey[y * w + x] = Math.round(245 - (x / w) * 170);
    }
  }
  // Strokes of type: three pixels wide, as they are at 300 dpi, set as densely
  // as the letters in a word — which is what the local window has to work with
  // on a real page. Always the same amount darker than the paper beneath them.
  const marks = [];
  for (let i = 0; i < 100; i++) {
    const cx = 60 + i * 11;
    for (let y = 180; y < 220; y++) {
      for (let x = cx; x < cx + 3; x++) grey[y * w + x] = Math.max(0, grey[y * w + x] - 60);
    }
    marks.push({ x: cx + 1, y: 200 });
  }
  const binary = sauvola(grey, w, h);
  const read = marks.filter((m) => binary[m.y * w + m.x] === 0).length;

  // Not every stroke: the threshold is deliberately strict, because the setting
  // that catches the faintest ink on the brightest paper also promotes the
  // grain of a photocopy into ink, and that costs far more than it saves. The
  // claim being tested is the one that matters — that the shadow itself is not
  // read as ink, which is exactly what one threshold for the whole page does.
  ok('almost every stroke survives the shadow', read >= marks.length * 0.9, `${read} of ${marks.length}`);
  check('the dark side of the page is still paper', binary[20 * w + (w - 10)], 255);

  let global = 0;
  for (let i = 0; i < grey.length; i++) global += grey[i];
  global /= grey.length;
  let falseInk = 0;
  for (let y = 20; y < 40; y++) {
    for (let x = w - 200; x < w - 10; x++) if (grey[y * w + x] < global) falseInk++;
  }
  ok('one threshold for the whole page would have lost the dark side', falseInk > 3000, `${falseInk} pixels`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
