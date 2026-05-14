const { chromium } = require('playwright');

async function scrape() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1365, height: 900 },
  });
  const page = await context.newPage();

  await page.goto('https://www.thegate.org.uk/whats-on', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await new Promise(r => setTimeout(r, 3000));

  const events = await page.evaluate(() => {
    const dateLike = (t) =>
      t && /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.test(t) && /\d{4}/.test(t);

    function pickDate(block) {
      const trySelectors = [
        'p strong u', 'p u strong',
        'p span[style*="text-decoration:underline"] strong',
        'p span[style*="text-decoration: underline"] strong',
      ];
      for (const sel of trySelectors) {
        const el = block.querySelector(sel);
        const t = el?.innerText?.trim();
        if (dateLike(t)) return t;
      }
      for (const el of block.querySelectorAll('p.sqsrte-large strong')) {
        const t = el.innerText.trim();
        if (dateLike(t)) return t;
      }
      return '';
    }

    function pickDescription(block) {
      const paras = Array.from(block.querySelectorAll('p:not(.sqsrte-large)'))
        .map(p => p.innerText.trim())
        .filter(t => t && !dateLike(t) && t.length > 30);
      return paras.join(' ') || '';
    }

    function pickSupport(block) {
      const paras = Array.from(block.querySelectorAll('p.sqsrte-large'))
        .map(p => p.innerText.trim())
        .filter(t => t && !dateLike(t));
      return paras.join(', ') || '';
    }

    function findNearbyImage(textBlock) {
      let node = textBlock;
      for (let i = 0; i < 6; i++) {
        if (!node.parentElement) break;
        node = node.parentElement;
        if (node.classList.contains('fe-block')) break;
      }
      const parent = node.parentElement;
      if (!parent) return '';
      const siblings = Array.from(parent.children);
      const idx = siblings.indexOf(node);
      const searchRange = siblings.slice(Math.max(0, idx - 3), idx + 4);
      for (const sib of searchRange) {
        const img = sib.querySelector('img[data-src], img[src]');
        if (img) {
          const src = img.getAttribute('data-src') || img.getAttribute('src') || '';
          if (src && !src.startsWith('data:')) return src;
        }
      }
      return '';
    }

    function findTicketUrl(textBlock) {
      let node = textBlock;
      for (let i = 0; i < 6; i++) {
        if (!node.parentElement) break;
        node = node.parentElement;
        if (node.classList.contains('fe-block')) break;
      }
      const parent = node.parentElement;
      if (!parent) return 'https://www.thegate.org.uk/whats-on';
      const siblings = Array.from(parent.children);
      const idx = siblings.indexOf(node);
      const searchRange = siblings.slice(Math.max(0, idx - 3), idx + 4);
      for (const sib of searchRange) {
        const a = sib.querySelector('a[href*="gigantic"], a[href*="ticketmaster"], a[href*="seetickets"], a[href*="eventbrite"]');
        if (a) return a.href;
      }
      return 'https://www.thegate.org.uk/whats-on';
    }

    return Array.from(document.querySelectorAll('.sqs-html-content')).map(block => {
      const title = block.querySelector('h2, h3, h4')?.innerText.trim() || '';
      const date = pickDate(block);
      if (!title || !date) return null;
      const description = pickDescription(block);
      const support = pickSupport(block);
      const imageUrl = findNearbyImage(block);
      const url = findTicketUrl(block);
      return {
        title,
        date,
        ...(description ? { description } : {}),
        ...(support ? { support } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        url,
        venue: 'The Gate Cardiff',
        scrapedAt: new Date().toISOString(),
      };
    }).filter(e => e && e.title && e.date);
  });

  console.log(JSON.stringify(events, null, 2));
  console.log(`\nTotal: ${events.length} events`);

  await browser.close();
}

scrape().catch(console.error);