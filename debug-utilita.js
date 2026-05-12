const { chromium } = require('playwright');
const fs = require('fs');

async function scrape() {
  const browser = await chromium.launch({ headless: false }); // visible browser so we can see what happens
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1365, height: 900 },
  });
  const page = await context.newPage();

  await page.goto('https://www.livenation.co.uk/utilita-arena-cardiff-tickets-vdp3915', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await new Promise(r => setTimeout(r, 5000)); // wait for JS to render

  const html = await page.content();
  fs.writeFileSync('utilita-debug.html', html);
  console.log('Saved utilita-debug.html');

  await browser.close();
}

scrape().catch(console.error);