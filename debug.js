/**
 * debug.js — scrape all WMC events with availability + sub-venue
 * Run: node debug.js
 * Requires: availability.js in the same directory
 */

const { chromium } = require('playwright');
const { computeAvailability } = require('./availability');

const LISTING_URL = 'https://www.wmc.org.uk/en/whats-on/events';
const TIMEOUT = 15_000;

const SUB_VENUES = [
  { match: 'cabaret',        label: 'Cabaret'        },
  { match: 'hoddinott hall', label: 'Hoddinott Hall'  },
  { match: 'weston studio',  label: 'Weston Studio'   },
  { match: 'dance house',    label: 'Dance House'     },
];

function parseSubVenue(rawPrefix) {
  if (!rawPrefix) return null;
  const lower = rawPrefix.toLowerCase().trim();
  for (const { match, label } of SUB_VENUES) {
    if (lower.startsWith(match)) return label;
  }
  return null;
}

async function gotoAndSettle(page, url, selector) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForSelector(selector, { timeout: TIMEOUT });
  } catch {
    await page.waitForLoadState('networkidle').catch(() => {});
  }
}

async function waitForAngularBind(page) {
  try {
    await page.waitForFunction(
      () => {
        const list = document.querySelector('.calendar-list-filter-list--performance-list');
        if (!list) return false;
        if (list.classList.contains('ng-hide')) {
          return !!document.querySelector('.events-error:not(.ng-hide)');
        }
        const availDivs = list.querySelectorAll('.calendar-list-entry__availablity');
        if (availDivs.length === 0) return true;
        return Array.from(availDivs).some((el) => !el.innerText.includes('{{'));
      },
      { timeout: TIMEOUT }
    );
  } catch {}
}

async function getAvailability(context, eventUrl) {
  const page = await context.newPage();
  try {
    await page.goto(`${eventUrl.replace(/\/$/, '')}/performances`, { waitUntil: 'domcontentloaded' });
    await waitForAngularBind(page);
    const labels = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          '.calendar-list-filter-list--performance-list .calendar-list-entry__availablity'
        )
      )
        .map((el) => el.innerText?.trim() ?? '')
        .filter((t) => t && !t.includes('{{'))
    );
    return computeAvailability(labels);
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const listPage = await context.newPage();
  await gotoAndSettle(listPage, LISTING_URL, 'div.production-card');

  // Wait for Angular to compile titles
  await listPage.waitForFunction(
    () => {
      const cards = document.querySelectorAll('div.production-card');
      if (cards.length === 0) return false;
      const title = cards[0].querySelector('h4.production-card__title');
      return title && !title.innerText.includes('{{');
    },
    { timeout: TIMEOUT }
  ).catch(() => {});

  const events = await listPage.evaluate(() =>
    Array.from(document.querySelectorAll('div.production-card')).map((item) => {
      const prefixEl = item.querySelector('p.production-card__prefix');
      const prefix = (!prefixEl || prefixEl.getAttribute('aria-hidden') === 'true')
        ? ''
        : prefixEl.innerText.trim();
      return {
        title:   item.querySelector('h4.production-card__title')?.innerText.trim() || '',
        date:    item.querySelector('p.production-card__date')?.innerText.trim() || '',
        url:     item.querySelector('a.production-card__link-overlay')?.href || '',
        _prefix: prefix,
      };
    }).filter((e) => e.title && e.url)
  );
  await listPage.close();

  // Resolve sub-venues in Node scope
  for (const event of events) {
    const subVenue = parseSubVenue(event._prefix);
    if (subVenue) event.subVenue = subVenue;
    delete event._prefix;
  }

  console.log(`Found ${events.length} events\n`);

  const results = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const subTag = event.subVenue ? ` [${event.subVenue}]` : '';
    process.stdout.write(`[${String(i + 1).padStart(2)}/${events.length}] ${event.title}${subTag}... `);

    const computed = await getAvailability(context, event.url);

    if (computed) {
      process.stdout.write(`${computed.availability} (~${computed.availabilityEstimate}%)\n`);
      results.push({ ...event, ...computed });
    } else {
      process.stdout.write(`no availability data\n`);
      results.push({ ...event });
    }
  }

  console.log('\n' + JSON.stringify(results, null, 2));

  await browser.close();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});