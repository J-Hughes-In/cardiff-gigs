const { chromium } = require('playwright');

async function scrape() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1365, height: 900 },
  });
  const page = await context.newPage();

  await page.goto('https://www.fuelrockclub.co.uk/events/', {
    waitUntil: 'networkidle',
    timeout: 60000
  });

  // Wait specifically for title text to appear
  await page.waitForFunction(() => {
    const el = document.querySelector('h3.elementor-post__title a');
    return el && el.innerText.trim().length > 0;
  }, { timeout: 15000 }).catch(() => console.log('title text never appeared'));

  const info = await page.evaluate(() => {
    const first = document.querySelector('article.elementor-post');
    if (!first) return 'no articles found';
    return {
      h3LinkText: first.querySelector('h3 a')?.innerText?.trim(),
      titleLinkHref: first.querySelector('.elementor-post__title a')?.href,
      imgSrc: first.querySelector('img')?.getAttribute('src'),
      allText: first.innerText?.slice(0, 300),
    };
  });

  console.log(JSON.stringify(info, null, 2));

  // Also try extracting all events
  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('article.elementor-post')).map(item => {
      const titleEl = item.querySelector('h3.elementor-post__title a');
      const img = item.querySelector('.elementor-post__thumbnail img');
      const raw = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
      // Fallback: derive title from URL slug
      const href = titleEl?.href || '';
      const slugTitle = href
        ? href.split('/').filter(Boolean).pop().replace(/-/g, ' ').toUpperCase()
        : '';
      return {
        title: titleEl?.innerText?.trim() || slugTitle,
        url: href,
        imageUrl: raw && !raw.startsWith('data:') ? raw : '',
        venue: 'Fuel Rock Club',
      };
    }).filter(e => e.title);
  });

  console.log(`\nEvents found: ${events.length}`);
  console.log(JSON.stringify(events.slice(0, 3), null, 2));

  await browser.close();
}

scrape().catch(console.error);