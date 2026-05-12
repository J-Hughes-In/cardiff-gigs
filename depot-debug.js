const { chromium } = require('playwright');
const fs = require('fs');

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 300;

      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;

        window.scrollBy(0, distance);
        totalHeight += distance;

        console.log(`Scrolling... ${totalHeight}/${scrollHeight}`);

        // Stop once we've reached the bottom
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 400); // slower scrolling speed
    });
  });
}

async function scrape() {
  const browser = await chromium.launch({
    headless: false
  });

  const page = await browser.newPage();

  // Optional: log possible API/event requests
  page.on('response', async (response) => {
    const url = response.url();

    if (
      url.includes('event') ||
      url.includes('api') ||
      url.includes('wp-json')
    ) {
      console.log('Possible API request:', url);
    }
  });

  await page.goto('https://depotcardiff.com/events/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  console.log('Page loaded');

  // Initial wait
  await page.waitForTimeout(3000);

  let lastCount = 0;
  let unchangedRounds = 0;

  while (true) {
    console.log('Starting scroll round...');

    // Slowly scroll down
    await autoScroll(page);

    // Wait for lazy-loaded events to appear
    await page.waitForTimeout(3000);

    const count = await page.evaluate(() => {
      return document.querySelectorAll('li.fusion-layout-column').length;
    });

    const height = await page.evaluate(() => {
      return document.body.scrollHeight;
    });

    console.log(`Height: ${height} | Events found: ${count}`);

    // If no new events loaded after several attempts, stop
    if (count === lastCount) {
      unchangedRounds++;
      console.log(`No new events (${unchangedRounds}/3)`);

      if (unchangedRounds >= 3) {
        console.log('Finished scrolling');
        break;
      }
    } else {
      unchangedRounds = 0;
    }

    lastCount = count;
  }

  // Save debug HTML
  const html = await page.content();
  fs.writeFileSync('depot-debug.html', html);

  console.log('Saved depot-debug.html');

  // Example: extract events
  const events = await page.evaluate(() => {
    return Array.from(
      document.querySelectorAll('li.fusion-layout-column')
    ).map((el) => {
      const title =
        el.querySelector('h2, h3, .fusion-title-heading')?.innerText?.trim() ||
        '';

      const link = el.querySelector('a')?.href || '';

      return {
        title,
        link
      };
    });
  });

  console.log(`Extracted ${events.length} events`);

  fs.writeFileSync(
    'depot-events.json',
    JSON.stringify(events, null, 2)
  );

  console.log('Saved depot-events.json');

  await browser.close();
}

scrape().catch(console.error);