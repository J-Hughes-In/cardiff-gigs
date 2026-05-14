const { chromium } = require('playwright');

async function scrape() {
  const browser = await chromium.launch({
    headless: false
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',

    viewport: {
      width: 1365,
      height: 900
    },
  });

  const page = await context.newPage();

  console.log('Opening Fuel Rock Club events page...');

  await page.goto(
    'https://www.fuelrockclub.co.uk/events/',
    {
      waitUntil: 'networkidle',
      timeout: 60000
    }
  );

  console.log('Waiting for SociableKit iframe...');

  await page.waitForSelector(
    'iframe[src*="sociablekit"]',
    {
      timeout: 20000
    }
  );

  const iframeElement = await page.$(
    'iframe[src*="sociablekit"]'
  );

  if (!iframeElement) {
    throw new Error('SociableKit iframe not found');
  }

  const frame = await iframeElement.contentFrame();

  if (!frame) {
    throw new Error('Could not access iframe content');
  }

  console.log('Waiting for event cards inside iframe...');

  await frame.waitForSelector(
    '.sk-event-item',
    {
      timeout: 20000
    }
  );

  // Allow lazy content to finish rendering
  await frame.waitForTimeout(3000);

  const events = await frame.evaluate(() => {

    function cleanText(t) {
      return t?.replace(/\s+/g, ' ').trim() || '';
    }

    return Array.from(
      document.querySelectorAll('.sk-event-item')
    )
      .map(item => {

        const title =
          cleanText(
            item.querySelector(
              '.sk-event-item-title'
            )?.innerText
          );

        const url =
          item.querySelector(
            '.sk-event-item-fb-link'
          )?.href ||

          item.querySelector(
            '.sk-event-item-gettickets'
          )?.href ||

          '';

        const rawImage =
          item.querySelector('img')
            ?.getAttribute('src') || '';

        // THIS is the reliable date source
        const timeEl =
          item.querySelector(
            '.sk-event-item-date time'
          );

        const rawDate =
          cleanText(timeEl?.innerText);

        const isoDate =
          timeEl?.getAttribute('datetime') || '';

        return {
          title,

          date: rawDate,

          eventStartDate: isoDate,

          url,

          imageUrl:
            rawImage &&
            !rawImage.startsWith('data:')
              ? rawImage
              : '',

          venue: 'Fuel Rock Club',

          scrapedAt: new Date().toISOString(),

          primaryCategory: 'Music',

          genre: 'Music',

          // useful for debugging
          rawDate,
          isoDate
        };
      })
      .filter(e => e.title && e.url);
  });

  console.log('\n========== RESULTS ==========\n');

  console.log(
    JSON.stringify(events, null, 2)
  );

  console.log(
    `\nTotal events: ${events.length}`
  );

  await page.waitForTimeout(5000);

  await browser.close();
}

scrape().catch(err => {
  console.error(err);
  process.exit(1);
});