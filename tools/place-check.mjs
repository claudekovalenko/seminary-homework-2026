// Does the app hold your place when you tick something off?
//
//   node tools/place-check.mjs      (serve the repo on :8765 first)
//
// Measured by where a row actually sits on the screen before and after, not
// by the scroll offset — the offset can be identical while the page has moved
// underneath it, and can differ while nothing has visibly moved at all.
//
// Needs playwright-core and a Chromium; nothing in js/ depends on it.
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox','--proxy-server=direct://','--proxy-bypass-list=*'] });
const page = await browser.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2, hasTouch: true });
const errs = []; page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'networkidle' });
await page.waitForSelector('.hero');

const at = () => page.evaluate(() => Math.round(window.scrollY));

// Scroll well down the home page, to a checkbox you would actually be ticking.
await page.evaluate(() => window.scrollTo(0, 1400));
await page.waitForTimeout(200);
const before = await at();
const where = async (loc) => Math.round((await loc.boundingBox()).y);
const row = page.locator('.today-group .task').first();
await row.scrollIntoViewIfNeeded();
const rowWas = await where(row);
await row.locator('label.check .box').tap();
await page.waitForTimeout(400);
const rowNow = await where(row);
console.log('tick a checkbox   : row on screen at', rowWas, '-> ', rowNow, Math.abs(rowNow - rowWas) < 8 ? 'does not move' : 'MOVED');

// Starting a stopwatch redraws too.
const second = page.locator('.today-group .task').nth(2);
await second.scrollIntoViewIfNeeded();
const secondWas = await where(second);
await second.locator('.amount.timer').tap();
await page.waitForTimeout(400);
const secondNow = await where(second);
console.log('start a stopwatch : row on screen at', secondWas, '-> ', secondNow, Math.abs(secondNow - secondWas) < 8 ? 'does not move' : 'MOVED');
await page.locator('.running-stop').tap();
await page.waitForTimeout(300);

// But arriving at a different tab should still start at the top.
await page.click('.tab[data-view="plan"]');
await page.waitForTimeout(300);
console.log('change tab        : now at', await at(), ((await at()) === 0 ? 'top, as it should' : 'NOT at top'));

// And the timer strip is on the home page as well as everywhere else.
await page.click('.tab[data-view="today"]');
await page.waitForTimeout(250);
await page.locator('.today-group .task').first().locator('.amount.timer').tap();
await page.waitForTimeout(300);
await page.evaluate(() => window.scrollTo(0, 0));
console.log('on the home page  :', (await page.locator('#running-strip').innerText()).replace(/\n/g, ' | '));
// The reader redraws when you highlight, and must not lose your place either.
await page.locator('.running-stop').tap();
await page.waitForTimeout(200);
await page.evaluate(async () => {
  const state = JSON.parse(localStorage.getItem('seminary.v1') || '{}');
  state.library = { ...(state.library || {}), doc: { title: 'Swain', kind: 'file', fileName: 'd.pdf',
    text: { chars: 4000, pageCount: 1, totalPages: 1, complete: true, nextPage: 2, ocr: true } } };
  localStorage.setItem('seminary.v1', JSON.stringify(state));
  const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}. Theology does not begin with a question about God but with a confession that God has spoken, and the order of those two is the whole of it.`).join('\n\n');
  await new Promise((res) => {
    const req = indexedDB.open('seminary-library', 2);
    req.onupgradeneeded = () => { const db = req.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('text')) db.createObjectStore('text'); };
    req.onsuccess = () => { const t = req.result.transaction('text', 'readwrite');
      t.objectStore('text').put({ pages: [{ page: 1, text: long, notes: '' }], chars: 4000, pageCount: 1, totalPages: 1, ocr: true, complete: true }, 'doc');
      t.oncomplete = () => res(); };
  });
});
await page.goto('http://127.0.0.1:8765/index.html#read:doc', { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.reader p');
const para = page.locator('.reader p').nth(18);
await para.scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
const readingAt = await at();
const box = await para.boundingBox();
await page.mouse.move(box.x + 12, box.y + 8);
await page.mouse.down();
await page.mouse.move(box.x + 200, box.y + 8, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);
await page.locator('[data-action="highlight-selection"]').tap();
await page.waitForTimeout(500);
const paraNow = Math.round((await page.locator('.reader p').nth(18).boundingBox()).y);
console.log('highlight in reader: paragraph on screen at', Math.round(box.y), '-> ', paraNow, Math.abs(paraNow - Math.round(box.y)) < 8 ? 'does not move' : 'MOVED');

console.log('errors:', errs.length ? errs : 'none');
await browser.close();
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox','--proxy-server=direct://','--proxy-bypass-list=*'] });
const page = await browser.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2, hasTouch: true });
const errs = []; page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'networkidle' });
await page.waitForSelector('.hero');

const at = () => page.evaluate(() => Math.round(window.scrollY));

// Scroll well down the home page, to a checkbox you would actually be ticking.
await page.evaluate(() => window.scrollTo(0, 1400));
await page.waitForTimeout(200);
const before = await at();
const where = async (loc) => Math.round((await loc.boundingBox()).y);
const row = page.locator('.today-group .task').first();
await row.scrollIntoViewIfNeeded();
const rowWas = await where(row);
await row.locator('label.check .box').tap();
await page.waitForTimeout(400);
const rowNow = await where(row);
console.log('tick a checkbox   : row on screen at', rowWas, '-> ', rowNow, Math.abs(rowNow - rowWas) < 8 ? 'does not move' : 'MOVED');

// Starting a stopwatch redraws too.
const second = page.locator('.today-group .task').nth(2);
await second.scrollIntoViewIfNeeded();
const secondWas = await where(second);
await second.locator('.amount.timer').tap();
await page.waitForTimeout(400);
const secondNow = await where(second);
console.log('start a stopwatch : row on screen at', secondWas, '-> ', secondNow, Math.abs(secondNow - secondWas) < 8 ? 'does not move' : 'MOVED');
await page.locator('.running-stop').tap();
await page.waitForTimeout(300);

// But arriving at a different tab should still start at the top.
await page.click('.tab[data-view="plan"]');
await page.waitForTimeout(300);
console.log('change tab        : now at', await at(), ((await at()) === 0 ? 'top, as it should' : 'NOT at top'));

// And the timer strip is on the home page as well as everywhere else.
await page.click('.tab[data-view="today"]');
await page.waitForTimeout(250);
await page.locator('.today-group .task').first().locator('.amount.timer').tap();
await page.waitForTimeout(300);
await page.evaluate(() => window.scrollTo(0, 0));
console.log('on the home page  :', (await page.locator('#running-strip').innerText()).replace(/\n/g, ' | '));
// The reader redraws when you highlight, and must not lose your place either.
await page.locator('.running-stop').tap();
await page.waitForTimeout(200);
await page.evaluate(async () => {
  const state = JSON.parse(localStorage.getItem('seminary.v1') || '{}');
  state.library = { ...(state.library || {}), doc: { title: 'Swain', kind: 'file', fileName: 'd.pdf',
    text: { chars: 4000, pageCount: 1, totalPages: 1, complete: true, nextPage: 2, ocr: true } } };
  localStorage.setItem('seminary.v1', JSON.stringify(state));
  const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}. Theology does not begin with a question about God but with a confession that God has spoken, and the order of those two is the whole of it.`).join('\n\n');
  await new Promise((res) => {
    const req = indexedDB.open('seminary-library', 2);
    req.onupgradeneeded = () => { const db = req.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('text')) db.createObjectStore('text'); };
    req.onsuccess = () => { const t = req.result.transaction('text', 'readwrite');
      t.objectStore('text').put({ pages: [{ page: 1, text: long, notes: '' }], chars: 4000, pageCount: 1, totalPages: 1, ocr: true, complete: true }, 'doc');
      t.oncomplete = () => res(); };
  });
});
await page.goto('http://127.0.0.1:8765/index.html#read:doc', { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.reader p');
const para = page.locator('.reader p').nth(18);
await para.scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
const readingAt = await at();
const box = await para.boundingBox();
await page.mouse.move(box.x + 12, box.y + 8);
await page.mouse.down();
await page.mouse.move(box.x + 200, box.y + 8, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);
await page.locator('[data-action="highlight-selection"]').tap();
await page.waitForTimeout(500);
const paraNow = Math.round((await page.locator('.reader p').nth(18).boundingBox()).y);
console.log('highlight in reader: paragraph on screen at', Math.round(box.y), '-> ', paraNow, Math.abs(paraNow - Math.round(box.y)) < 8 ? 'does not move' : 'MOVED');

console.log('errors:', errs.length ? errs : 'none');
await browser.close();
