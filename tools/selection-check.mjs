// Does highlighting work the way a thumb uses it?
//
//   node tools/selection-check.mjs      (serve the repo on :8765 first)
//
// The reader is driven by real drags and real taps here, because the synthetic
// selections an earlier test used never touched the two things that actually
// break on a phone: a drag that crosses a paragraph boundary, and a selection
// the browser collapses the instant you touch the button. Both looked fine
// under a scripted selection and both left the feature dead in the hand.
//
// Needs playwright-core and a Chromium; nothing in js/ depends on it.
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox','--proxy-server=direct://','--proxy-bypass-list=*'] });
const errs = [];

async function reader() {
  const context = await browser.newContext({ viewport: { width: 430, height: 900 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('.hero');
  await page.evaluate(async () => {
    const state = JSON.parse(localStorage.getItem('seminary.v1') || '{}');
    state.library = { ...(state.library || {}), 'doc': { title: 'Swain', kind: 'file', fileName: 'd.pdf',
      text: { chars: 900, pageCount: 1, totalPages: 1, complete: true, nextPage: 2, ocr: true } } };
    localStorage.setItem('seminary.v1', JSON.stringify(state));
    await new Promise((res, rej) => {
      const req = indexedDB.open('seminary-library', 2);
      req.onupgradeneeded = () => { const db = req.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('text')) db.createObjectStore('text'); };
      req.onsuccess = () => { const t = req.result.transaction('text', 'readwrite');
        t.objectStore('text').put({ pages: [{ page: 1,
          text: 'Theology does not begin with a question about God but with a confession that God has spoken. The order matters here.\n\nIf the enquiry came first, the God at the end of it would be whatever the enquiry could reach, and the reach of any creature is short.',
          notes: '' }], chars: 900, pageCount: 1, totalPages: 1, ocr: true, complete: true }, 'doc');
        t.oncomplete = () => res(); t.onerror = () => rej(t.error); };
      req.onerror = () => rej(req.error);
    });
  });
  await page.goto('http://127.0.0.1:8765/index.html#read:doc', { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.reader p');
  return page;
}

const drag = async (page, fromPara, toPara, toX = 180) => {
  const a = await page.locator('.reader p').nth(fromPara).boundingBox();
  const b = await page.locator('.reader p').nth(toPara).boundingBox();
  await page.mouse.move(a.x + 12, a.y + 10);
  await page.mouse.down();
  await page.mouse.move(b.x + toX, b.y + 12, { steps: 16 });
  await page.mouse.up();
  await page.waitForTimeout(250);
};
const stored = (page) => page.evaluate(() => (JSON.parse(localStorage.getItem('seminary.v1')).highlights || {}).doc?.length || 0);

// 1. A drag that stays inside one paragraph.
{
  const page = await reader();
  await drag(page, 0, 0, 200);
  await page.locator('[data-action="highlight-selection"]').click();
  await page.waitForTimeout(300);
  console.log('inside one paragraph  : bar offered, highlights stored =', await stored(page), '| marks on screen =', await page.locator('.reader mark').count());
  await page.context().close();
}

// 2. A drag that runs past the end of one paragraph into the next.
{
  const page = await reader();
  await drag(page, 0, 1, 150);
  const offered = (await page.locator('#selection-bar').getAttribute('hidden')) === null;
  console.log('across two paragraphs : bar offered =', offered, '| says "' + (await page.locator('#selection-count').innerText()) + '"');
  await page.locator('[data-action="highlight-selection"]').click();
  await page.waitForTimeout(300);
  console.log('                        highlights stored =', await stored(page), '| marks on screen =', await page.locator('.reader mark').count());
  await page.context().close();
}

// 3. The selection is gone before the tap lands — what a touch device does.
{
  const page = await reader();
  await drag(page, 1, 1, 180);
  await page.evaluate(() => document.getSelection().removeAllRanges());
  await page.waitForTimeout(150);
  const stillOffered = (await page.locator('#selection-bar').getAttribute('hidden')) === null;
  await page.locator('[data-action="highlight-selection"]').click();
  await page.waitForTimeout(300);
  console.log('selection lost at tap : bar still offered =', stillOffered, '| highlights stored =', await stored(page));
  await page.context().close();
}

// 4. Touching the text again puts the bar away.
{
  const page = await reader();
  await drag(page, 0, 0, 200);
  const box = await page.locator('.reader p').nth(1).boundingBox();
  await page.mouse.click(box.x + 40, box.y + 10);
  await page.waitForTimeout(250);
  console.log('tapping elsewhere     : bar hidden again =', await page.evaluate(() => document.getElementById('selection-bar')?.hidden));
  await page.context().close();
}

console.log('errors:', errs.length ? errs : 'none');
await browser.close();
