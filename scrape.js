const { chromium } = require('playwright');
const fs = require('fs');

async function scrapeGlobe(browser) {
  console.log('Scraping The Globe...');
  const page = await browser.newPage();
  await page.goto('https://www.globecardiff.co.uk/listings/', { waitUntil: 'networkidle' });
  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('article.elementor-post')).map(item => ({
      title: item.querySelector('h3.elementor-post__title a')?.innerText.trim() || '',
      details: item.querySelector('.elementor-post__excerpt p')?.innerText.trim() || '',
      url: item.querySelector('h3.elementor-post__title a')?.href || '',
      venue: 'The Globe Cardiff',
      scrapedAt: new Date().toISOString()
    })).filter(e => e.title);
  });
  await page.close();
  console.log(`  Globe: ${events.length} events`);
  return events;
}

async function scrapeWMC(browser) {
  console.log('Scraping WMC...');
  const page = await browser.newPage();
  await page.goto('https://www.wmc.org.uk/en/whats-on/events', { waitUntil: 'networkidle' });
  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('div.production-card')).map(item => ({
      title: item.querySelector('h4.production-card__title')?.innerText.trim() || '',
      date: item.querySelector('p.production-card__date')?.innerText.trim() || '',
      url: item.querySelector('a.production-card__link-overlay')?.href || '',
      venue: 'Wales Millennium Centre',
      scrapedAt: new Date().toISOString()
    })).filter(e => e.title);
  });
  await page.close();
  console.log(`  WMC: ${events.length} events`);
  return events;
}

async function scrapeNewTheatre(browser) {
  console.log('Scraping New Theatre...');
  const page = await browser.newPage();
  await page.goto('https://trafalgartickets.com/new-theatre-cardiff/en-GB/whats-on', { waitUntil: 'networkidle' });
  const html = await page.content();
  await page.close();
  const matches = html.matchAll(/\{\\?"eventGroupId\\?":\d+.*?\}/g);
  const events = [];
  const seen = new Set();
  for (const match of matches) {
    try {
      const obj = JSON.parse(match[0].replace(/\\"/g, '"').replace(/\\u0026/g, '&'));
      if (obj.eventGroupId && obj.name && !seen.has(obj.eventGroupId)) {
        seen.add(obj.eventGroupId);
        events.push({
          title: obj.name,
          category: obj.categories?.[0] || '',
          url: `https://trafalgartickets.com/new-theatre-cardiff/en-GB/event/${obj.eventGroupId}`,
          venue: 'New Theatre Cardiff',
          scrapedAt: new Date().toISOString()
        });
      }
    } catch (e) {}
  }
  console.log(`  New Theatre: ${events.length} events`);
  return events;
}

async function scrapeTramshed(browser) {
  console.log('Scraping Tramshed...');
  const page = await browser.newPage();
  await page.goto('https://www.tramshedcardiff.com/', { waitUntil: 'networkidle' });
  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('article.elementor-post')).map(item => ({
      title: item.querySelector('h3.elementor-post__title a')?.innerText.trim() || '',
      details: item.querySelector('.elementor-post__excerpt p')?.innerText.trim() || '',
      url: item.querySelector('h3.elementor-post__title a')?.href || '',
      venue: 'Tramshed Cardiff',
      scrapedAt: new Date().toISOString()
    })).filter(e => e.title);
  });
  await page.close();
  console.log(`  Tramshed: ${events.length} events`);
  return events;
}

async function scrapeDepot(browser) {
  console.log('Scraping Depot...');
  const page = await browser.newPage();
  await page.goto('https://depotcardiff.com/events/', { waitUntil: 'networkidle' });
  // Scroll to trigger lazy loading
  await page.evaluate(async () => {
    for (let i = 0; i < 10; i++) {
      window.scrollBy(0, 600);
      await new Promise(r => setTimeout(r, 300));
    }
  });
  await page.waitForTimeout(1000);
  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('li.fusion-layout-column')).map(item => ({
      title: item.querySelector('h2 a')?.innerText.trim() || '',
      date: item.querySelector('.fusion-text p')?.innerText.trim() || '',
      url: item.querySelector('a[href*="/event/"]')?.href || '',
      venue: 'Depot Cardiff',
      scrapedAt: new Date().toISOString()
    })).filter(e => e.title);
  });
  await page.close();
  console.log(`  Depot: ${events.length} events`);
  return events;
}

async function scrapeCardiffSU(browser) {
  console.log('Scraping Cardiff SU...');
  const page = await browser.newPage();
  await page.goto('https://www.cardiffstudents.com/whatson/live-music/', { waitUntil: 'networkidle' });
  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('div.event_item')).map(item => ({
      title: item.querySelector('a.msl_event_name')?.innerText.trim() || '',
      date: item.querySelector('dd.msl_event_time')?.innerText.trim() || '',
      location: item.querySelector('dd.msl_event_location')?.innerText.trim() || '',
      url: 'https://www.cardiffstudents.com' + (item.querySelector('a.msl_event_name')?.getAttribute('href') || ''),
      venue: 'Cardiff SU',
      scrapedAt: new Date().toISOString()
    })).filter(e => e.title);
  });
  await page.close();
  console.log(`  Cardiff SU: ${events.length} events`);
  return events;
}

async function scrapeTheGate(browser) {
  console.log('Scraping The Gate...');
  const page = await browser.newPage();
  await page.goto('https://www.thegate.org.uk/whats-on', { waitUntil: 'networkidle' });
  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.sqs-html-content')).map(block => ({
      title: block.querySelector('h2, h4')?.innerText.trim() || '',
      date: block.querySelector('p strong u, p u strong')?.innerText.trim() || '',
      url: 'https://www.thegate.org.uk/whats-on',
      venue: 'The Gate Cardiff',
      scrapedAt: new Date().toISOString()
    })).filter(e => e.title && e.date);
  });
  await page.close();
  console.log(`  The Gate: ${events.length} events`);
  return events;
}

async function scrapeClwb(browser) {
  console.log('Scraping Clwb Ifor Bach...');
  const page = await browser.newPage();
  await page.goto('https://clwb.net/whats-on/', { waitUntil: 'networkidle' });
  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('li.grid-item')).map(item => ({
      title: item.querySelector('h3.grid-item-title')?.innerText.trim() || '',
      date: item.querySelector('p.date-translate')?.innerText.trim() || '',
      details: Array.from(item.querySelectorAll('p.grid-item-support:not(.date-translate)')).map(p => p.innerText.trim()).join(' • '),
      url: item.querySelector('a')?.href || '',
      venue: 'Clwb Ifor Bach',
      scrapedAt: new Date().toISOString()
    })).filter(e => e.title);
  });
  await page.close();
  console.log(`  Clwb: ${events.length} events`);
  return events;
}

async function scrapeAll() {
  const browser = await chromium.launch();

  const allEvents = [
    ...await scrapeGlobe(browser),
    ...await scrapeWMC(browser),
    ...await scrapeNewTheatre(browser),
    ...await scrapeTramshed(browser),
    ...await scrapeDepot(browser),
    ...await scrapeCardiffSU(browser),
    ...await scrapeTheGate(browser),
    ...await scrapeClwb(browser),
  ];

  await browser.close();

  fs.writeFileSync('events.json', JSON.stringify(allEvents, null, 2));
  console.log(`\nTotal: ${allEvents.length} events saved to events.json`);
}

scrapeAll().catch(console.error);