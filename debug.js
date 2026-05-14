const { chromium } = require('playwright');

async function scrape() {
  const browser = await chromium.launch({ headless: false });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1365, height: 900 },
  });

  const page = await context.newPage();

  await page.goto('https://www.thegate.org.uk/whats-on', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  await new Promise((r) => setTimeout(r, 4000));

  const events = await page.evaluate(() => {
    const dateLike = (t) =>
      t &&
      /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.test(t) &&
      /\d{4}/.test(t);

    function cleanText(t) {
      return t?.replace(/\s+/g, ' ').trim() || '';
    }

    function pickDate(block) {
      const trySelectors = [
        'p strong u',
        'p u strong',
        'p span[style*="text-decoration:underline"] strong',
        'p span[style*="text-decoration: underline"] strong',
      ];

      for (const sel of trySelectors) {
        const el = block.querySelector(sel);
        const t = cleanText(el?.innerText);
        if (dateLike(t)) return t;
      }

      for (const el of block.querySelectorAll('p.sqsrte-large strong')) {
        const t = cleanText(el.innerText);
        if (dateLike(t)) return t;
      }

      return '';
    }

    function pickDescription(block) {
      return Array.from(block.querySelectorAll('p:not(.sqsrte-large)'))
        .map((p) => cleanText(p.innerText))
        .filter((t) => t && !dateLike(t) && t.length > 30)
        .join(' ');
    }

    function pickSupport(block) {
      return Array.from(block.querySelectorAll('p.sqsrte-large'))
        .map((p) => cleanText(p.innerText))
        .filter((t) => t && !dateLike(t))
        .join(', ');
    }

    function getFeBlock(node) {
      while (node && !node.classList?.contains('fe-block')) {
        node = node.parentElement;
      }
      return node;
    }

    function isEventStartBlock(sib) {
      return !!sib.querySelector(
        '.sqs-html-content h1, .sqs-html-content h2, .sqs-html-content h3, .sqs-html-content h4'
      );
    }

    function findAssociatedData(textBlock) {
      const feBlock = getFeBlock(textBlock);

      if (!feBlock?.parentElement) {
        return {
          imageUrl: '',
          url: 'https://www.thegate.org.uk/whats-on',
        };
      }

      const siblings = Array.from(feBlock.parentElement.children);
      const idx = siblings.indexOf(feBlock);

      let imageUrl = '';
      let url = '';

      // Forward search
      for (let i = idx; i < siblings.length; i++) {
        const sib = siblings[i];

        if (i !== idx && isEventStartBlock(sib)) break;

        if (!url) {
          const a = sib.querySelector(`
            a[href*="gigantic"],
            a[href*="ticketmaster"],
            a[href*="seetickets"],
            a[href*="eventbrite"]
          `);

          if (a?.href) url = a.href;
        }

        if (!imageUrl) {
          const img = sib.querySelector('img[data-src], img[src]');

          if (img) {
            const src =
              img.getAttribute('data-src') ||
              img.getAttribute('src') ||
              '';

            if (src && !src.startsWith('data:')) {
              imageUrl = src;
            }
          }

          if (!imageUrl) {
            const bg = sib.querySelector(
              '[style*="background-image"]'
            );

            if (bg) {
              const style = bg.getAttribute('style') || '';
              const match = style.match(
                /background-image:\s*url\(["']?(.*?)["']?\)/
              );

              if (match?.[1]) imageUrl = match[1];
            }
          }
        }
      }

      // Backward fallback
      if (!imageUrl || !url) {
        for (let i = idx - 1; i >= 0; i--) {
          const sib = siblings[i];

          if (isEventStartBlock(sib)) break;

          if (!url) {
            const a = sib.querySelector(`
              a[href*="gigantic"],
              a[href*="ticketmaster"],
              a[href*="seetickets"],
              a[href*="eventbrite"]
            `);

            if (a?.href) url = a.href;
          }

          if (!imageUrl) {
            const img = sib.querySelector(
              'img[data-src], img[src]'
            );

            if (img) {
              const src =
                img.getAttribute('data-src') ||
                img.getAttribute('src') ||
                '';

              if (src && !src.startsWith('data:')) {
                imageUrl = src;
              }
            }
          }
        }
      }

      return {
        imageUrl,
        url: url || 'https://www.thegate.org.uk/whats-on',
      };
    }

    return Array.from(
      document.querySelectorAll('.sqs-html-content')
    )
      .map((block) => {
        const title = cleanText(
          block.querySelector('h2,h3,h4')?.innerText
        );

        const date = pickDate(block);

        if (!title || !date) return null;

        const description = pickDescription(block);
        const support = pickSupport(block);

        const { imageUrl, url } =
          findAssociatedData(block);

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
      })
      .filter(Boolean);
  });

  console.log(JSON.stringify(events, null, 2));
  console.log(`\nTotal: ${events.length} events`);

  await browser.close();
}

scrape().catch(console.error);