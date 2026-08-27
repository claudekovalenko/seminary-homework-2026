// Read the benchmark page and score what came back.
//
//   node tools/bench/run.mjs [label]
//
// Prints character and word error rates for the body and the footnotes, so a
// change to the pipeline can be judged rather than admired. The page is
// deterministic, so two runs differ only by the code under test.

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain',
  '.traineddata': 'application/octet-stream'
};

const server = createServer(async (req, res) => {
  try {
    const path = resolve(ROOT, '.' + normalize(decodeURIComponent(req.url.split('?')[0])));
    if (!path.startsWith(ROOT)) throw new Error('outside root');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(8799, r));

const norm = (s) =>
  String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

/** Levenshtein distance over two rows rather than a whole matrix. */
function distance(a, b) {
  if (a.length === b.length && String(a) === String(b)) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[b.length];
}

const wordsOf = (s) =>
  norm(s)
    .toLowerCase()
    .replace(/[^a-z0-9' -]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

function score(truth, got) {
  const t = norm(truth);
  const g = norm(got);
  const tw = wordsOf(truth);
  const gw = wordsOf(got);
  return {
    cer: t.length ? distance(t, g) / t.length : 0,
    wer: tw.length ? distance(tw, gw) / tw.length : 0,
    chars: t.length,
    words: tw.length
  };
}

const { BODY, NOTES, EMPHASIS } = await import('./truth.js');

// Emphasis travels as two private-use markers; the grader strips them for the
// text comparison and reads them separately for the emphasis one.
const EM = '\uE001';
const STRONG = '\uE002';
const bare = (text) => String(text).replaceAll(EM, '').replaceAll(STRONG, '');

/** The words the bench actually set in italic and in bold. */
function intended(marked) {
  const italic = [];
  const bold = [];
  for (const word of marked.split(/\s+/)) {
    const plain = word.replace(/[*]/g, '').replace(/[^A-Za-z0-9'-]/g, '').toLowerCase();
    if (!plain) continue;
    if (/^\*\*/.test(word)) bold.push(plain);
    else if (/^\*/.test(word)) italic.push(plain);
    // A run like "*ad extra*" marks its opening word only; the rest of the run
    // is carried by the closing asterisk on the last word of it.
    else if (/\*[.,;:]?$/.test(word)) italic.push(plain);
  }
  return { italic, bold };
}

/** ...and the words that came back marked. */
function reported(text) {
  const out = { italic: [], bold: [] };
  const scan = (marker, into) => {
    const parts = String(text).split(marker);
    for (let i = 1; i < parts.length; i += 2) {
      for (const word of parts[i].split(/\s+/)) {
        const plain = word.replace(/[^A-Za-z0-9'-]/g, '').toLowerCase();
        if (plain) out[into].push(plain);
      }
    }
  };
  scan(EM, 'italic');
  scan(STRONG, 'bold');
  return out;
}

function agreement(want, got) {
  const pool = [...got];
  let hit = 0;
  for (const word of want) {
    const at = pool.indexOf(word);
    if (at >= 0) {
      pool.splice(at, 1);
      hit++;
    }
  }
  return {
    found: hit,
    wanted: want.length,
    reported: got.length,
    recall: want.length ? hit / want.length : 1,
    precision: got.length ? hit / got.length : want.length ? 0 : 1
  };
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--proxy-server=direct://', '--proxy-bypass-list=*']
});
const page = await browser.newPage();
page.setDefaultTimeout(600000);
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
page.on('console', (m) => m.type() === 'error' && console.error('CONSOLE', m.text()));
await page.goto('http://127.0.0.1:8799/tools/bench/bench.html');
const mode = process.env.BENCH_MODE || 'scan';
const skew = Number(process.env.BENCH_SKEW ?? 0.9);
const result = await page.evaluate(([m, s]) => globalThis.runBench(m, s), [mode, skew]);
await browser.close();
server.close();

const label = (process.argv[2] || 'run') + ' [' + mode + (mode === 'scan' ? ' skew ' + skew : '') + ']';
const body = result.pages.map((p) => p.text).join('\n\n');
const notes = result.pages.map((p) => p.notes).join('\n\n');
const truthBody = mode === 'columns' ? BODY : `${BODY}\n\n${EMPHASIS.replace(/\*/g, '')}`;
const b = score(truthBody, bare(body));
const n = score(NOTES, bare(notes));
const pct = (x) => (x * 100).toFixed(2) + '%';

console.log('\n=== ' + label + ' ===');
console.log('time            ' + (result.ms / 1000).toFixed(1) + 's   repaired words: ' + result.repaired);
console.log('body   CER ' + pct(b.cer).padStart(7) + '   WER ' + pct(b.wer).padStart(7) + '   (' + b.chars + ' chars, ' + b.words + ' words)');
console.log('notes  CER ' + pct(n.cer).padStart(7) + '   WER ' + pct(n.wer).padStart(7) + '   (' + n.chars + ' chars, ' + n.words + ' words)');
if (mode !== 'columns') {
  const want = intended(EMPHASIS);
  const got = reported(body);
  const it = agreement(want.italic, got.italic);
  const bo = agreement(want.bold, got.bold);
  console.log('italic ' + it.found + '/' + it.wanted + ' found, ' + it.reported + ' marked   (recall ' + pct(it.recall) + ', precision ' + pct(it.precision) + ')');
  console.log('bold   ' + bo.found + '/' + bo.wanted + ' found, ' + bo.reported + ' marked   (recall ' + pct(bo.recall) + ', precision ' + pct(bo.precision) + ')');
}

console.log('\n--- body as read (first 700 chars) ---\n' + bare(body).slice(0, 700));
console.log('\n--- notes as read ---\n' + bare(notes).slice(0, 400));
