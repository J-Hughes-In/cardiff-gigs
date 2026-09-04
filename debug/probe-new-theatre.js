/**
 * Temporary diagnostic probe for the New Theatre (Trafalgar Tickets) listing page.
 *
 * Answers: why does the listing yield only 10 events instead of ~120?
 * Prints DOM/pagination/network evidence so the scraper can be repaired.
 */
const { chromium } = require('playwright');

const LISTING = 'https://trafalgartickets.com/new-theatre-cardiff/en-GB/whats-on';
const EVENT_ANCHOR = 'a[href*="/new-theatre-cardiff/en-GB/event/"]';

(async () => {
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1365, height: 900 },
  });
  const page = await context.newPage();

  const xhr = [];
  page.on('request', (r) => {
    if (['xhr', 'fetch'].includes(r.resourceType())) xhr.push(`${r.method()} ${r.url()}`);
  });

  await page.goto(LISTING, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(3_000);

  try {
    const c = await page.$('button:has-text("Accept Cookies"), button:has-text("Allow Cookies"), button:has-text("Accept All")');
    if (c && await c.isVisible()) { await c.click(); await page.waitForTimeout(1_000); console.log('PROBE cookie: dismissed'); }
    else console.log('PROBE cookie: no banner matched');
  } catch (e) { console.log('PROBE cookie error:', e.message); }

  const anchors = async () => (await page.$$(EVENT_ANCHOR)).length;
  console.log('PROBE anchors after load:', await anchors());

  // 1. Does the old selector match anything at all?
  console.log('PROBE button:has-text("Load more") count:',
    (await page.$$('button:has-text("Load more")')).length);

  // 2. Every clickable-ish element whose text hints at pagination.
  const candidates = await page.evaluate(() => {
    const hint = /load|more|next|show|page|view all/i;
    const out = [];
    for (const el of document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')) {
      const txt = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (!txt || !hint.test(txt)) continue;
      out.push({
        tag: el.tagName,
        txt: txt.slice(0, 60),
        cls: String(el.className || '').slice(0, 100),
        href: el.getAttribute('href') || '',
        testid: el.getAttribute('data-testid') || el.getAttribute('data-test') || '',
        visible: !!(el.offsetParent || el.getClientRects().length),
      });
    }
    return out;
  });
  console.log('PROBE pagination candidates:', JSON.stringify(candidates, null, 1));

  // 3. Inline JSON payload size — does the HTML already carry every event?
  const html = await page.content();
  const groupIds = new Set();
  for (const m of html.matchAll(/\{\\?"eventGroupId\\?":(\d+)/g)) groupIds.add(m[1]);
  console.log('PROBE distinct eventGroupId in HTML:', groupIds.size);
  const nextData = html.match(/id="__NEXT_DATA__"/) ? 'yes' : 'no';
  console.log('PROBE __NEXT_DATA__ present:', nextData);
  console.log('PROBE html length:', html.length);
  for (const key of ['totalCount', 'totalResults', 'totalPages', 'pageSize', 'hasMore', 'itemCount']) {
    const m = html.match(new RegExp(`\\\\?"${key}\\\\?":\\s*("?[\\w.]+"?)`));
    if (m) console.log(`PROBE html key ${key}:`, m[1]);
  }

  // 4. Infinite scroll?
  for (let i = 1; i <= 4; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2_500);
    console.log(`PROBE anchors after scroll ${i}:`, await anchors());
  }

  // 5. Tail of the listing container, to see what replaced the button.
  const tail = await page.evaluate((sel) => {
    const list = [...document.querySelectorAll(sel)];
    const last = list[list.length - 1];
    if (!last) return 'no anchors';
    let box = last;
    for (let i = 0; i < 4 && box.parentElement; i++) box = box.parentElement;
    const sib = box.nextElementSibling;
    return {
      containerCls: String(box.className || '').slice(0, 120),
      nextSiblingHtml: sib ? sib.outerHTML.slice(0, 1200) : 'none',
      parentTailHtml: box.parentElement ? box.parentElement.outerHTML.slice(-1200) : 'none',
    };
  }, EVENT_ANCHOR);
  console.log('PROBE listing tail:', JSON.stringify(tail, null, 1));

  // 6. Query-string pagination?
  for (const q of ['?page=2', '?page=1&pageSize=200', '?skip=10']) {
    try {
      await page.goto(LISTING + q, { waitUntil: 'load', timeout: 60_000 });
      await page.waitForTimeout(2_500);
      const n = await anchors();
      const first = await page.evaluate((sel) =>
        (document.querySelector(sel)?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80), EVENT_ANCHOR);
      console.log(`PROBE ${q}: anchors=${n} first="${first}"`);
    } catch (e) {
      console.log(`PROBE ${q}: error ${e.message.split('\n')[0]}`);
    }
  }

  console.log('PROBE xhr requests:', JSON.stringify([...new Set(xhr)].slice(0, 40), null, 1));

  await browser.close();
})().catch((e) => { console.error('PROBE FAILED', e); process.exit(1); });
