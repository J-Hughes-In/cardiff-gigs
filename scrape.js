const { chromium } = require('playwright');
const fs = require('fs');

const GOTO = { waitUntil: 'domcontentloaded', timeout: 90_000 };
const SKIP_ENRICH = process.env.SCRAPE_NO_ENRICH === '1';
const ENRICH_CONCURRENCY = Math.min(8, Math.max(1, Number(process.env.SCRAPE_ENRICH_CONCURRENCY || 3)));

/** Avoid networkidle: it often never settles (analytics, SSE). Wait for real markup instead. */
async function gotoAndSettle(page, url, contentSelector) {
  await page.goto(url, GOTO);
  await page.waitForLoadState('load').catch(() => {});
  if (contentSelector) {
    try {
      await page.waitForSelector(contentSelector, { state: 'attached', timeout: 45_000 });
    } catch (_) {
      /* venue may genuinely have no matching nodes */
    }
  }
}

function inferGenreFromTitle(title) {
  if (!title) return '';
  const t = title.toLowerCase();
  const pairs = [
    [/tribute|experience|vs the|sound of |celebrating /, 'Tribute / covers'],
    [/\bdj\b| vs | b2b |club night|retro electro/, 'DJ / club'],
    [/opera|ballet|orchestra|symphony|philharmonic/, 'Classical'],
    [/wrestling|wwe|mma|boxing|fc\b|rugby|match\b/, 'Sports'],
    [/comedy|stand[- ]?up|comedian/, 'Comedy'],
    [/musical|panto|pantomime|broadway/, 'Musical theatre'],
  ];
  for (const [re, g] of pairs) if (re.test(t)) return g;
  return '';
}

function inferPrimaryCategory(ev) {
  const blob = [
    ev.title,
    ev.venue,
    ev.category,
    ev.genre,
    ev.subcategory,
    ev.description,
    ev.shortDescription,
    ev.details,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const comedy = /comedy|stand[- ]?up|comedian|mock the week|live podcast|poetry slam/;
  const theatre = /theatre|musical|opera|ballet|panto|drama|play\b|broadway|national theatre|graduation/;
  const sport = /wwe|wrestling|mma|boxing|match\b|fc |rugby|arena football/;
  if (sport.test(blob)) return 'Sports';
  if (comedy.test(blob)) return 'Comedy';
  if (theatre.test(blob)) return 'Theatre';
  if (/new theatre|wmc|millennium centre|the gate/.test((ev.venue || '').toLowerCase())) return 'Theatre';
  if (/arena|globe|tramshed|clwb|depot|su\b|live nation|music|tour|concert|band|festival/.test(blob)) return 'Music';
  return 'Other';
}

function normalizeOffers(offers) {
  if (!offers) return {};
  const list = Array.isArray(offers) ? offers : [offers];
  let low = null;
  let high = null;
  let currency = null;
  let labelParts = [];

  for (const o of list) {
    if (!o || typeof o !== 'object') continue;
    const typ = o['@type'];
    if (typ === 'AggregateOffer') {
      if (o.lowPrice != null) low = Number(o.lowPrice);
      if (o.highPrice != null) high = Number(o.highPrice);
      currency = o.priceCurrency || currency;
    }
    if (o.price != null && !Number.isNaN(Number(o.price))) {
      const p = Number(o.price);
      low = low == null ? p : Math.min(low, p);
      high = high == null ? p : Math.max(high, p);
      currency = o.priceCurrency || currency;
    }
    if (o.name && /sale|ticket|price/i.test(o.name)) labelParts.push(o.name);
  }
  return { low, high, currency };
}

function scrapePriceFromVisibleText(text) {
  if (!text || text.length > 25_000) return {};
  const from = text.match(/from\s*£\s*(\d+(?:\.\d+)?)/i);
  if (from) return { label: `from £${from[1]}`, low: Number(from[1]), currency: 'GBP' };
  const range = text.match(/£\s*(\d+(?:\.\d+)?)\s*[-–]\s*£\s*(\d+(?:\.\d+)?)/);
  if (range) return { label: `£${range[1]}–£${range[2]}`, low: Number(range[1]), high: Number(range[2]), currency: 'GBP' };
  const single = text.match(/£\s*(\d+(?:\.\d+)?)/);
  if (single) return { label: `£${single[1]}`, low: Number(single[1]), currency: 'GBP' };
  return {};
}

async function fetchPageEnrichment(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 65_000 });
  await page.waitForLoadState('load').catch(() => {});
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  if (host.includes('tixr.com')) await new Promise((r) => setTimeout(r, 5_000));
  else await new Promise((r) => setTimeout(r, 900));

  return page.evaluate(() => {
    const meta = (sel) => document.querySelector(sel)?.getAttribute('content')?.trim() || '';

    const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
    const events = [];
    for (const s of scripts) {
      let j;
      try {
        j = JSON.parse(s.textContent);
      } catch {
        continue;
      }
      const acc = [];
      const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(visit);
          return;
        }
        const t = node['@type'];
        const types = Array.isArray(t) ? t : t ? [t] : [];
        const eventTypes = new Set([
          'Event',
          'MusicEvent',
          'TheaterEvent',
          'TheatreEvent',
          'ComedyEvent',
          'Festival',
          'SportsEvent',
          'DanceEvent',
        ]);
        if (types.some((x) => eventTypes.has(x))) acc.push(node);
        if (node['@graph']) visit(node['@graph']);
      };
      visit(j);
      events.push(...acc);
    }

    const score = (e) =>
      [e.description, e.startDate, e.endDate, e.image, e.offers, e.location, e.performer].filter(Boolean).length;
    const best = events.sort((a, b) => score(b) - score(a))[0] || null;

    const ogDesc = meta('meta[property="og:description"]') || meta('meta[name="description"]');
    const ogImage = meta('meta[property="og:image"]');
    const ogTitle = meta('meta[property="og:title"]');

    let description = '';
    let genre = '';
    let startDate = '';
    let endDate = '';
    let imageUrl = ogImage || '';
    let offersRaw = null;

    if (best) {
      if (typeof best.description === 'string') description = best.description.trim();
      const g = best.genre;
      genre = Array.isArray(g) ? g.filter(Boolean).join(', ') : typeof g === 'string' ? g.trim() : '';
      if (best.startDate) startDate = String(best.startDate);
      if (best.endDate) endDate = String(best.endDate);
      const img = best.image;
      if (!imageUrl && img) {
        if (typeof img === 'string') imageUrl = img;
        else if (Array.isArray(img) && img[0]) imageUrl = typeof img[0] === 'string' ? img[0] : img[0].url || '';
        else if (img?.url) imageUrl = img.url;
      }
      offersRaw = best.offers || null;
    }

    const bodyText = (document.body?.innerText || '').slice(0, 20_000);

    return {
      description: description || '',
      shortDescription: ogDesc || '',
      genre,
      imageUrl: imageUrl || '',
      imageUrls: [],
      startDate,
      endDate,
      offersRaw,
      ogTitle,
      bodySnippet: bodyText,
    };
  });
}

function mergeOffersIntoEvent(ev, offersRaw) {
  if (!offersRaw) return ev;
  const { low, high, currency } = normalizeOffers(offersRaw);
  const out = { ...ev };
  if (low != null && !Number.isNaN(low)) out.ticketPriceFrom = low;
  if (high != null && !Number.isNaN(high)) out.ticketPriceTo = high;
  if (currency) out.ticketCurrency = currency;
  return out;
}

function mergeEnrichmentIntoEvent(ev, en) {
  if (!en) return ev;
  let out = { ...ev };

  const desc = (en.description || '').trim();
  const shortD = (en.shortDescription || '').trim();
  if (desc && desc.length > (out.description || '').length) out.description = desc;
  if (shortD) {
    out.shortDescription = shortD;
    if (!out.description) out.description = shortD;
  }
  if (en.genre && !out.genre) out.genre = en.genre;

  const img = (en.imageUrl || '').trim();
  if (img) {
    out.imageUrl = img;
    out.imageUrls = [img];
  }

  if (en.startDate) out.eventStartDate = en.startDate;
  if (en.endDate) out.eventEndDate = en.endDate;

  out = mergeOffersIntoEvent(out, en.offersRaw);

  if (out.ticketPriceFrom == null && en.bodySnippet) {
    const vis = scrapePriceFromVisibleText(en.bodySnippet);
    if (vis.low != null) {
      out.ticketPriceFrom = vis.low;
      if (vis.high != null) out.ticketPriceTo = vis.high;
      out.ticketCurrency = vis.currency || 'GBP';
      out.ticketPriceLabel = vis.label;
    }
  }

  return out;
}

function finalizeEvent(ev) {
  const genre = (ev.genre || ev.subcategory || inferGenreFromTitle(ev.title) || '').trim();
  const primaryCategory = inferPrimaryCategory({ ...ev, genre });
  const description =
    (ev.description || '').trim() ||
    (ev.shortDescription || '').trim() ||
    (ev.details || '').trim() ||
    '';

  const next = {
    ...ev,
    primaryCategory,
    ...(genre ? { genre } : {}),
    ...(description ? { description } : {}),
  };

  if (next.ticketPriceFrom != null && !next.ticketPriceLabel) {
    const cur = next.ticketCurrency || 'GBP';
    const sym = cur === 'GBP' ? '£' : `${cur} `;
    next.ticketPriceLabel =
      next.ticketPriceTo != null && next.ticketPriceTo !== next.ticketPriceFrom
        ? `${sym}${next.ticketPriceFrom}–${sym}${next.ticketPriceTo}`
        : `${sym}${next.ticketPriceFrom}`;
  }

  return next;
}

async function enrichAllEvents(context, allEvents) {
  if (SKIP_ENRICH) {
    console.log('\nSkipping detail enrichment (SCRAPE_NO_ENRICH=1).');
    return allEvents.map(finalizeEvent);
  }

  const gateListing = 'https://www.thegate.org.uk/whats-on';
  const uniqueUrls = [
    ...new Set(
      allEvents
        .map((e) => e.url)
        .filter((u) => u && /^https?:\/\//i.test(u) && u.split('?')[0] !== gateListing)
    ),
  ];

  console.log(`\nEnriching ${uniqueUrls.length} unique ticket URLs (concurrency ${ENRICH_CONCURRENCY})...`);
  const cache = new Map();
  const queue = [...uniqueUrls];
  let done = 0;

  async function worker() {
    const page = await context.newPage();
    try {
      while (queue.length) {
        const url = queue.shift();
        try {
          const raw = await fetchPageEnrichment(page, url);
          cache.set(url, raw);
        } catch {
          cache.set(url, null);
        }
        done++;
        if (done % 40 === 0 || done === uniqueUrls.length) {
          console.log(`  enriched ${done}/${uniqueUrls.length}`);
        }
      }
    } finally {
      await page.close();
    }
  }

  await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, () => worker()));

  const merged = allEvents.map((ev) => {
    const en = ev.url ? cache.get(ev.url) : null;
    return finalizeEvent(mergeEnrichmentIntoEvent(ev, en));
  });

  return merged;
}

async function scrapeGlobe(context) {
  console.log('Scraping The Globe...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.globecardiff.co.uk/listings/', 'article.elementor-post');
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

async function scrapeWMC(context) {
  console.log('Scraping WMC...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.wmc.org.uk/en/whats-on/events', 'div.production-card');
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

async function scrapeNewTheatre(context) {
  console.log('Scraping New Theatre...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://trafalgartickets.com/new-theatre-cardiff/en-GB/whats-on', 'body');
  await new Promise(r => setTimeout(r, 2_000));
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
        const cats = Array.isArray(obj.categories) ? obj.categories.filter(Boolean) : [];
        const row = {
          title: obj.name,
          category: cats[0] || '',
          url: `https://trafalgartickets.com/new-theatre-cardiff/en-GB/event/${obj.eventGroupId}`,
          venue: 'New Theatre Cardiff',
          scrapedAt: new Date().toISOString(),
        };
        if (cats.length > 1) row.subcategory = cats.slice(1).join('; ');
        if (obj.price != null && !Number.isNaN(Number(obj.price))) {
          row.ticketPriceFrom = Number(obj.price);
          row.ticketCurrency = 'GBP';
          row.ticketPriceLabel = `from £${obj.price}`;
        }
        if (obj.subVenue) row.subVenue = obj.subVenue;
        if (obj.promoter) row.promoter = obj.promoter;
        if (cats.length === 1 && cats[0]) row.genre = cats[0];
        events.push(row);
      }
    } catch (e) {}
  }
  console.log(`  New Theatre: ${events.length} events`);
  return events;
}

async function scrapeTramshed(context) {
  console.log('Scraping Tramshed...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.tramshedcardiff.com/', 'article.elementor-post');
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

const UTILITA_ARENA_LN =
  'https://www.livenation.co.uk/utilita-arena-cardiff-tickets-vdp3915';

async function scrapeUtilitaArena(context) {
  console.log('Scraping Utilita Arena (Live Nation)...');
  const page = await context.newPage();
  await gotoAndSettle(
    page,
    UTILITA_ARENA_LN,
    'main li.MuiStack-root h4.MuiTypography-header4'
  );
  await new Promise((r) => setTimeout(r, 2_000));
  const events = await page.evaluate(() => {
    const isEventHref = (href) =>
      href &&
      href.includes('livenation.co.uk/event/') &&
      !href.includes('/event/allevents');

    const rows = [...document.querySelectorAll('li.MuiStack-root')].filter((li) => {
      const a = li.querySelector('a[href*="/event/"]');
      return a && isEventHref(a.href) && li.querySelector('h4.MuiTypography-header4');
    });

    return rows.map((li) => {
      const title = li.querySelector('h4.MuiTypography-header4')?.innerText?.trim() || '';
      const date = li.querySelector('[data-testid="aedp-event-information-block-times"]')?.innerText?.trim() || '';
      const support =
        li.querySelector('[data-testid="aedp-event-information-support-artists"]')?.innerText?.trim() || '';
      const url =
        [...li.querySelectorAll('a[href*="/event/"]')].find((a) => isEventHref(a.href))?.href || '';
      return {
        title,
        date,
        ...(support ? { support } : {}),
        url,
        venue: 'Utilita Arena Cardiff',
        scrapedAt: new Date().toISOString(),
      };
    }).filter((e) => e.title && e.url);
  });
  await page.close();
  console.log(`  Utilita Arena: ${events.length} events`);
  return events;
}

async function scrapeDepot(context) {
  console.log('Scraping Depot...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://depotcardiff.com/events/', 'li.fusion-layout-column');
  await page.evaluate(async () => {
    for (let i = 0; i < 10; i++) {
      window.scrollBy(0, 600);
      await new Promise(r => setTimeout(r, 300));
    }
  });
  await new Promise(r => setTimeout(r, 1_000));
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

async function scrapeCardiffSU(context) {
  console.log('Scraping Cardiff SU...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.cardiffstudents.com/whatson/live-music/', 'div.event_item, .msl_eventlist');
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

async function scrapeTheGate(context) {
  console.log('Scraping The Gate...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.thegate.org.uk/whats-on', '.sqs-html-content');
  const events = await page.evaluate(() => {
    const dateLike = (t) =>
      t && /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.test(t) && /\d{4}/.test(t);

    function pickDate(block) {
      const trySelectors = [
        'p strong u',
        'p u strong',
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

    return Array.from(document.querySelectorAll('.sqs-html-content')).map(block => ({
      title: block.querySelector('h2, h3, h4')?.innerText.trim() || '',
      date: pickDate(block),
      url: 'https://www.thegate.org.uk/whats-on',
      venue: 'The Gate Cardiff',
      scrapedAt: new Date().toISOString()
    })).filter(e => e.title && e.date);
  });
  await page.close();
  console.log(`  The Gate: ${events.length} events`);
  return events;
}

async function scrapeClwb(context) {
  console.log('Scraping Clwb Ifor Bach...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://clwb.net/whats-on/', '#eventsListings li.grid-item');
  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#eventsListings li.grid-item')).map(item => ({
      title: item.querySelector('h3.grid-item-title')?.innerText.trim() || '',
      date: item.querySelector('p.grid-item-support.date-translate, p.date-translate')?.innerText.trim() || '',
      details: Array.from(item.querySelectorAll('p.grid-item-support:not(.date-translate)')).map(p => p.innerText.trim()).join(' • '),
      url: item.querySelector('a.tickets-button, a[href*="seetickets"], a[href*="fatsoma"], figure a, .grid-item-image a')?.href
        || item.querySelector('a[href^="http"]')?.href || '',
      venue: 'Clwb Ifor Bach',
      scrapedAt: new Date().toISOString()
    })).filter(e => e.title);
  });
  await page.close();
  console.log(`  Clwb: ${events.length} events`);
  return events;
}

async function safeScrap(fn, name, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        console.log(`  ${name}: attempt ${attempt + 1} failed (${e.message.split('\n')[0]}), retrying...`);
        await new Promise(r => setTimeout(r, 3_000));
      }
    }
  }
  console.log(`  ${name} failed: ${lastErr.message.split('\n')[0]}`);
  return [];
}

async function scrapeAll() {
  const browser = await chromium.launch({
    args: ['--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1365, height: 900 },
  });

  let allEvents = [
    ...await safeScrap(() => scrapeGlobe(context), 'Globe'),
    ...await safeScrap(() => scrapeWMC(context), 'WMC'),
    ...await safeScrap(() => scrapeNewTheatre(context), 'New Theatre'),
    ...await safeScrap(() => scrapeTramshed(context), 'Tramshed'),
    ...await safeScrap(() => scrapeUtilitaArena(context), 'Utilita Arena'),
    ...await safeScrap(() => scrapeDepot(context), 'Depot'),
    ...await safeScrap(() => scrapeCardiffSU(context), 'Cardiff SU'),
    ...await safeScrap(() => scrapeTheGate(context), 'The Gate'),
    ...await safeScrap(() => scrapeClwb(context), 'Clwb'),
  ];

  allEvents = await enrichAllEvents(context, allEvents);

  await browser.close();

  fs.writeFileSync('events.json', JSON.stringify(allEvents, null, 2));
  console.log(`\nTotal: ${allEvents.length} events saved to events.json`);
}

scrapeAll().catch(console.error);
