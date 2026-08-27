// Look at one benchmark page the way the pipeline sees it.
//
//   node tools/bench/inspect.mjs          # the default 0.9 degree photocopy
//   BENCH_SKEW=3 node tools/bench/inspect.mjs
//
// Prints the skew found and corrected, what the cleaning removed, and every
// line the layout pass kept, with its type size and where it sits. This is the
// tool for working out *why* a page came out the way it did; tools/bench/run.mjs
// says how well it came out.

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
await new Promise((r) => server.listen(8798, r));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--proxy-server=direct://', '--proxy-bypass-list=*']
});
const page = await browser.newPage();
page.setDefaultTimeout(600000);
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
const seen = await page.goto('http://127.0.0.1:8798/tools/bench/bench.html').then(() =>
  page.evaluate(([skew, mode]) => globalThis.debugBench(skew, mode), [Number(process.env.BENCH_SKEW ?? 0.9), process.env.BENCH_MODE || 'scan'])
);
await browser.close();
server.close();

console.log(`skew ${seen.skew.before} -> ${seen.skew.after}   specks removed ${seen.cleaned.specks}   engine confidence ${seen.confidence}%`);
console.log(`split: ${seen.split.body} lines of body, ${seen.split.notes} of notes; columns ${JSON.stringify(seen.split.columns)}\n`);
const sizes = seen.lines.map((l) => l.size).sort((a, b) => a - b);
console.log(`median type size ${sizes[Math.floor(sizes.length / 2)]}px\n`);
for (const line of seen.lines) {
  console.log(`${String(line.size).padStart(4)}px  y=${String(line.y).padStart(5)}  x=${line.x0}-${line.x1}  ${line.text}`);
}
