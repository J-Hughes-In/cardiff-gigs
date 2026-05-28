/**
 * debug-venues7.js — standalone scrape + normalise in one pass
 * Run:    node debug-venues4.js
 * Output: debug-venues7.json
 *
 * Each venue section in the output contains:
 *   { raw: [...], normalised: [...] }
 * so you can spot scrape vs normalisation bugs side-by-side.
 */

const { chromium } = require('playwright');
const fs = require('fs');

const TIMEOUT  = 20_000;
const SCRAPE_AT = new Date().toISOString();

// ─── Date helpers ─────────────────────────────────────────────────────────────

const DAY_NAMES   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

function parseGleeDate(raw) {
  if (!raw) return '';
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 4) return raw.trim();
  const [, dayNum, mon, year] = parts;
  const monthIdx = ['JAN','FEB','MAR','APR','MAY','JUN',
                    'JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(mon.toUpperCase());
  if (monthIdx === -1) return raw.trim();
  const d = new Date(Number(year), monthIdx, Number(dayNum));
  return `${DAY_NAMES[d.getDay()]}, ${dayNum} ${MONTH_NAMES[monthIdx]} ${year}`;
}

function parseParadiseDate(day, month) {
  if (!day || !month) return '';
  const dayMatch = day.match(/(\d+)/);
  if (!dayMatch) return `${day} ${month}`;
  const dayNum    = parseInt(dayMatch[1], 10);
  const monthClean = month.replace(/\d+/g, '').trim();
  const yearMatch  = month.match(/(\d{4})/);
  const year       = yearMatch ? yearMatch[1] : '';
  const monthIdx   = MONTH_NAMES.findIndex(m => m.toLowerCase() === monthClean.toLowerCase());
  if (monthIdx === -1) return `${day} ${month}`;
  const d = new Date(Number(year), monthIdx, dayNum);
  return `${DAY_NAMES[d.getDay()]}, ${dayNum} ${MONTH_NAMES[monthIdx]} ${year}`;
}



// ─── Chapter junk filter ──────────────────────────────────────────────────────

const CHAPTER_NAV_URL_PATTERNS = [
  /\/about(\/|$)/, /\/hire(\/|$)/, /\/visit(\/|$)/,
  /\/support-us(\/|$)/, /\/guide\//, /\/food-drink(\/|$)/,
];
const CHAPTER_NAV_TITLES = new Set([
  'CINEMA','THEATRE','GALLERY','FOOD & DRINK','VISIT','HIRE','SUPPORT US','ABOUT',
]);

function isChapterJunk(e) {
  const title = (e.title || '').trim();
  const url   = (e.url   || '').trim();
  const date  = (e.date  || '').trim();
  if (CHAPTER_NAV_TITLES.has(title.toUpperCase())) return true;
  if (url && CHAPTER_NAV_URL_PATTERNS.some(p => p.test(url))) return true;
  if (/first name|last name|email address/i.test(date)) return true;
  if (!date && !e.imageUrl && /[.!?]$/.test(title)) return true;
  if (!date && /^[A-Z\s'':–-]+$/.test(title) && title.includes(':')) return true;
  return false;
}

// ─── Normalisers ──────────────────────────────────────────────────────────────

/**
 * Clean a Glee Club title:
 *   "GoodFellas - live comedy at The Glee Club Cardiff" → "GoodFellas"
 *   "Robin\nMorgan" → "Robin Morgan"
 */
function cleanGleeTitle(raw) {
  return (raw || '')
    .replace(/\s*-\s*live\s.+$/i, '')  // strip " - live comedy/talk at …"
    .replace(/\s+/g, ' ')               // collapse newlines to single space
    .trim();
}

function normaliseGlee(events) {
  const out = [];
  const seenUrls = new Set();
  for (const e of (events || [])) {
    if (e.url && seenUrls.has(e.url)) continue;
    if (e.url) seenUrls.add(e.url);

    const dates     = e._dateInfo?.dates || [];
    const ticketUrl = e._dateInfo?.ticketUrl || '';
    const title     = cleanGleeTitle(e.title);

    // Skip "Comic To Be Announced/Confirmed" placeholder slots
    if (/comic.+to.+be.+(confirmed|announced)/i.test(title)) continue;

    const shows = e._dateInfo?.shows || [];

    if (dates.length === 0 && shows.length === 0) {
      out.push({ title, date: '', url: e.url||'', venue: e.venue||'Glee Club Cardiff',
                 scrapedAt: SCRAPE_AT, imageUrl: e.imageUrl||'', ticketUrl,
                 acts: [], showName: title });
    } else if (shows.length > 0) {
      // Use structured show data — showName overrides performer name as event title
      for (const s of shows) {
        const eventTitle = s.showName || title;
        out.push({
          title:     eventTitle,
          date:      parseGleeDate(s.date.replace(/ /g, '\n')),
          url:       e.url || '',
          venue:     e.venue || 'Glee Club Cardiff',
          scrapedAt: SCRAPE_AT,
          imageUrl:  e.imageUrl || '',
          ticketUrl,
          acts:      s.acts.length > 0 ? s.acts : [title],  // fallback: performer IS the act
          showName:  eventTitle,
        });
      }
    } else {
      for (const d of dates) {
        out.push({ title, date: parseGleeDate(d), url: e.url||'',
                   venue: e.venue||'Glee Club Cardiff',
                   scrapedAt: SCRAPE_AT, imageUrl: e.imageUrl||'', ticketUrl,
                   acts: [title], showName: title });
      }
    }
  }
  // Final pass: dedup by title+date (catches same show at two different URLs)
  const seen2 = new Set();
  return out.filter(e => {
    const key = `${e.title}|${e.date}`;
    if (seen2.has(key)) return false;
    seen2.add(key);
    return true;
  });
}

/**
 * Acapela embeds status in the title: "Not The Rolling Stones (SOLD OUT)"
 * Extract it, clean the title, and surface it as the availability field.
 */
function extractAcapelaStatus(title) {
  // Match trailing "(SOLD OUT)", "SOLD OUT", "(SELLING FAST)" etc.
  const m = title.match(/\s*[(-]?\s*(SOLD\s*OUT|SELLING\s*FAST|FEW\s*LEFT|LIMITED)\s*[)-]?\s*$/i);
  if (!m) return { cleanTitle: title.trim(), status: '' };
  return {
    cleanTitle: title.slice(0, m.index).trim(),
    status:     m[1].toUpperCase().replace(/\s+/g, ' '),
  };
}

function normaliseAcapela(events) {
  return (events || []).map(e => {
    const { cleanTitle, status } = extractAcapelaStatus(e.title || '');
    return {
      title:        cleanTitle,
      date:         e.date || '',
      url:          e.url || '',
      venue:        e.venue || 'Acapela',
      scrapedAt:    SCRAPE_AT,
      imageUrl:     e.imageUrl || '',
      availability: e.status || status,  // prefer scraped status, fall back to extracted
    };
  });
}

function normaliseParadise(events) {
  return (events || [])
    .filter(e => !e._probe)
    .map(e => ({
      title:       e.title || '',
      date:        parseParadiseDate(e.day, e.month),
      url:         '',
      venue:       e.venue || 'Paradise Garden Cardiff',
      scrapedAt:   SCRAPE_AT,
      imageUrl:    '',
      subVenue:    e.subVenue || '',
      description: e.description || '',
    }));
}

function normaliseChapter(events) {
  // Chapter only has one page of events but we scrape up to 5 pages,
  // each returning the same results. Deduplicate by URL (or title if no URL).
  const seen = new Set();
  const deduped = (events || []).filter(e => {
    const key = e.url || e.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped
    .filter(e => !isChapterJunk(e))
    .map(e => ({
      title:     e.title || '',
      date:      e.date || '',
      url:       e.url || '',
      venue:     e.venue || 'Chapter Arts Centre',
      scrapedAt: SCRAPE_AT,
      imageUrl:  e.imageUrl || '',
      category:  e.category || '',
    }));
}

/**
 * CultVR date format: "DD/MM/YYYY @ HH:MM - [DD/MM/YYYY @] HH:MM"
 * Convert to "DayName, D Month YYYY" using the start date.
 * Also filter out events whose start date is in the past.
 */
function parseCultVRDate(raw) {
  if (!raw) return { formatted: '', startDate: null };
  // Extract first DD/MM/YYYY
  const m = raw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return { formatted: raw, startDate: null };
  const [, dd, mm, yyyy] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  if (isNaN(d)) return { formatted: raw, startDate: null };
  return {
    formatted: `${DAY_NAMES[d.getDay()]}, ${Number(dd)} ${MONTH_NAMES[Number(mm) - 1]} ${yyyy}`,
    startDate: d,
  };
}

function normaliseCultVR(events) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return (events || [])
    .map(e => {
      const raw = e.date || e.datetime || '';
      const { formatted, startDate } = parseCultVRDate(raw);
      return {
        title:       e.title || '',
        date:        formatted,
        _startDate:  startDate,  // kept for filtering, stripped below
        url:         e.url || '',
        venue:       e.venue || 'CultVR',
        scrapedAt:   SCRAPE_AT,
        imageUrl:    e.imageUrl || '',
        description: e.description || '',
      };
    })
    .filter(e => !e._startDate || e._startDate >= today)
    .map(({ _startDate, ...rest }) => rest);  // remove internal field
}

/**
 * RWCMD images come wrapped as Next.js /_next/image?url=<encoded-cdn-url>&w=...
 * Decode to get the real CDN URL.
 */
function decodeRWCMDImageUrl(raw) {
  if (!raw) return '';
  if (!raw.includes('/_next/image')) return raw;
  try {
    const u = new URL(raw, 'https://www.rwcmd.ac.uk');
    return decodeURIComponent(u.searchParams.get('url') || '') || raw;
  } catch {
    return raw;
  }
}

function normaliseRWCMD(events) {
  return (events || []).map(e => ({
    title:     e.title || '',
    date:      e.date || '',
    dateEnd:   e.dateEnd || '',
    url:       e.url || '',
    venue:     e.venue || 'Royal Welsh College of Music & Drama',
    scrapedAt: SCRAPE_AT,
    imageUrl:  decodeRWCMDImageUrl(e.imageUrl || ''),
    subVenue:  e.subVenue || '',
    category:  e.category || '',
  }));
}



// ─── Scrapers ─────────────────────────────────────────────────────────────────

async function scrapeGleeClub(page) {
  await page.goto('https://www.glee.co.uk/cardiff/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForLoadState('networkidle').catch(() => {});

  // Step 1: collect performer page URLs from the listing
  const performerLinks = await page.evaluate(() => {
    const seen = new Set();
    const results = [];
    for (const el of document.querySelectorAll('[class*="event"]')) {
      for (const a of el.querySelectorAll('a[href*="/performer/"]')) {
        const url = a.href;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const title = a.getAttribute('aria-label') || a.getAttribute('data-caption') || a.innerText?.trim() || '';
        const img   = a.querySelector('img');
        results.push({
          title,
          url,
          imageUrl: img?.getAttribute('src') || img?.getAttribute('data-src') || '',
        });
      }
    }
    return results;
  });

  // Step 2: visit each performer page to get dates + ticket URL
  const events = [];
  for (const item of performerLinks) {
    const subPage = await page.context().newPage();
    try {
      await subPage.goto(item.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await subPage.waitForLoadState('networkidle').catch(() => {});

      const dateInfo = await subPage.evaluate(() => {
        // Each show on the performer page is a row/block containing:
        //   - A date like "SUN\n14\nJUN\n2026"
        //   - A show name like "GOODFELLAS: RICHARD BLACKWOOD, WHITE YARDIE & SLIM (18+)"
        //   - A list of acts (the performers on that night)
        // We try to capture all three per date occurrence.

        // Strategy: find all elements containing a month abbreviation (date markers),
        // then walk up to find the containing row and extract show name + acts from siblings.
        const MON_RE = /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/i;
        const DATE_BLOCK_RE = /(?:MON|TUE|WED|THU|THR|FRI|SAT|SUN)\s+\d{1,2}\s+(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+\d{4}/i;

        // Try to find structured date rows — Glee renders events in a table or
        // repeated div structure where each row has: date | show title | acts | book button
        const showRows = Array.from(document.querySelectorAll(
          'tr, [class*="show-row"], [class*="event-row"], [class*="ShowRow"], [class*="schedule-row"]'
        )).filter(el => MON_RE.test(el.innerText || ''));

        const shows = [];
        const seenDates = new Set();

        for (const row of showRows) {
          const text = row.innerText || '';
          const dateMatch = text.match(DATE_BLOCK_RE);
          if (!dateMatch) continue;
          const dateStr = dateMatch[0].replace(/\s+/g, ' ').trim();
          if (seenDates.has(dateStr)) continue;
          seenDates.add(dateStr);

          // Show name: first ALL-CAPS line that isn't the date itself and isn't just a venue
          const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
          const showNameLine = lines.find(l =>
            l.length > 5 &&
            l === l.toUpperCase() &&
            !DATE_BLOCK_RE.test(l) &&
            !/^(THE GLEE|GLEE CLUB|BOOK TICKET|TIMES|DOORS|LAST ENTRY|PRICE|ADV)/i.test(l)
          ) || '';

          // Acts: performer name links within the row (excludes Book Ticket links)
          const actLinks = Array.from(row.querySelectorAll('a[href*="/performer/"]'));
          const acts = [...new Set(actLinks.map(a => a.innerText?.trim()).filter(Boolean))];

          shows.push({ date: dateStr, showName: showNameLine, acts });
        }

        // Fallback: body text scan when no structured rows found
        if (shows.length === 0) {
          const bodyText = document.body?.innerText || '';
          const matches = bodyText.match(
            /(?:MON|TUE|WED|THU|THR|FRI|SAT|SUN)\s+\d{1,2}\s+(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+\d{4}/gi
          ) || [];
          for (const m of [...new Set(matches)]) {
            shows.push({ date: m.replace(/\s+/g, ' '), showName: '', acts: [] });
          }
        }

        const ticketLink = document.querySelector('a[href*="booking.glee.co.uk"]');
        const pageTitle  = document.title || '';

        // Also keep flat dates array for backward compat with normaliser
        const dates = shows.map(s => s.date.replace(/ /g, '\n').replace(
          /^(\w+)\n(\d+)\n(\w+)\n(\d+)$/, '$1\n$2\n$3\n$4'
        ));

        return { dates: [...new Set(dates)], shows, ticketUrl: ticketLink?.href || '', pageTitle };
      });

      events.push({
        title:     item.title,
        url:       item.url,
        imageUrl:  item.imageUrl,
        venue:     'Glee Club Cardiff',
        scrapedAt: SCRAPE_AT,
        _dateInfo: dateInfo,
      });
    } catch (err) {
      events.push({ ...item, venue: 'Glee Club Cardiff', scrapedAt: SCRAPE_AT, _dateInfo: { error: err.message } });
    } finally {
      await subPage.close();
    }
  }
  return events;
}

async function scrapeAcapela(page) {
  const allEvents = [];
  for (let p = 1; p <= 10; p++) {
    const url = p === 1 ? 'https://acapela.co.uk/whats-on' : `https://acapela.co.uk/whats-on/page/${p}/`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForLoadState('networkidle').catch(() => {});

    const pageEvents = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('article')).map(item => {
        const titleEl  = item.querySelector('h1,h2,h3,.entry-title,.post-title');
        const dateEl   = item.querySelector('time,.entry-date,.event-date,[class*="date"]');
        const linkEl   = item.querySelector('a[href*="/event"],a[href*="/whats-on"],.entry-title a,h2 a,h3 a');
        const img      = item.querySelector('img[src],img[data-src]');
        const statusEl = item.querySelector('[class*="status"],[class*="sold"],[class*="label"]');

        const raw = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
        return {
          title:    titleEl?.innerText?.trim() || '',
          date:     dateEl?.innerText?.trim() || dateEl?.getAttribute('datetime') || '',
          url:      linkEl?.href || '',
          imageUrl: raw && !raw.startsWith('data:') ? raw : '',
          status:   statusEl?.innerText?.trim() || '',
        };
      }).filter(e => e.title);
    });

    if (pageEvents.length === 0) break;
    allEvents.push(...pageEvents);
  }
  return allEvents;
}

async function scrapeParadiseGardens(page) {
  // Scrape current + next 3 months (e.g. "may2026", "june2026", ...)
  const now = new Date();
  const months = [];
  for (let i = 0; i < 4; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const name = MONTH_NAMES[d.getMonth()].toLowerCase() + d.getFullYear();
    months.push(name);
  }

  const allEvents = [];
  for (const month of months) {
    const url = `https://www.paradise-garden.co.uk/events/${month}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForLoadState('networkidle').catch(() => {});

    // Log the URL being attempted
    process.stdout.write(`      → ${url}\n`);
    // Wait for Squarespace content — try multiple selectors, give it up to 12s
    await page.waitForSelector(
      '.sqs-html-content, .sqs-block-html, .sqs-block-content, [data-block-type="2"], main',
      { timeout: 12000 }
    ).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    const data = await page.evaluate((monthStr) => {
      // Squarespace content block — try several selectors as class name varies by template
      const block = document.querySelector(
        '.sqs-html-content, .sqs-block-html, [data-block-type="2"] .sqs-block-content, ' +
        '.sqs-block-content, .entry-content, [data-type="text"]'
      );
      if (!block) {
        // Dump a probe so we can see what IS on the page
        const probe = {
          _probe: true,
          month: monthStr,
          url: location.href,
          selCounts: ['.sqs-html-content','.sqs-block-html','.sqs-block-content','[data-block-type]','article','section']
            .map(s => ({ sel: s, count: document.querySelectorAll(s).length })),
          bodySnippet: document.body?.innerText?.slice(0, 400) || '',
        };
        return [probe];
      }

      const events  = [];
      const children = Array.from(block.children);
      let currentDay = null;

      for (let i = 0; i < children.length; i++) {
        const el   = children[i];
        const tag  = el.tagName.toLowerCase();
        const text = el.innerText?.trim() || '';

        const isDay = (tag === 'h4' || (tag === 'p' && el.querySelector('strong'))) &&
          /^(mon|tue|wed|thur|fri|sat|sun)\s+\d{1,2}/i.test(text);

        if (isDay) { currentDay = text; continue; }

        if (tag === 'h3' && text && currentDay) {
          const descEl = children[i + 1];
          const desc   = descEl?.tagName?.toLowerCase() === 'p' && !descEl.querySelector('strong')
            ? descEl.innerText?.trim() : '';

          let title    = text;
          let subVenue = '';
          const sub    = text.match(/^(yurt|bar|garden)\s*:\s*/i);
          if (sub) { subVenue = sub[1].toLowerCase(); title = text.slice(sub[0].length).trim(); }

          events.push({ title, day: currentDay, month: monthStr, subVenue, description: desc });
        }
      }
      return events;
    }, month);

    allEvents.push(...data);
  }
  return allEvents;
}

async function scrapeChapter(page) {
  const allEvents = [];
  for (let p = 1; p <= 5; p++) {
    const url = p === 1
      ? 'https://www.chapter.org/whats-on'
      : `https://www.chapter.org/whats-on?page=${p}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForLoadState('networkidle').catch(() => {});

    const pageEvents = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('article')).map(item => {
        const titleEl = item.querySelector('h2,h3,h4,.title');
        const dateEl  = item.querySelector('time,[class*="date"],[datetime]');
        const linkEl  = item.querySelector('a[href]');
        const img     = item.querySelector('img[src],img[data-src],img[data-lazy]');
        const catEl   = item.querySelector('[class*="category"],[class*="tag"],[class*="genre"]');

        const raw   = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
        const title = titleEl?.innerText?.trim() || '';
        if (!title) return null;

        return {
          title,
          date:     dateEl?.innerText?.trim() || dateEl?.getAttribute('datetime') || '',
          url:      linkEl?.href || '',
          imageUrl: raw && !raw.startsWith('data:') ? raw : '',
          category: catEl?.innerText?.trim() || '',
        };
      }).filter(Boolean);
    });

    if (pageEvents.length === 0) break;
    allEvents.push(...pageEvents);
  }
  return allEvents;
}

async function scrapeCultVR(page) {
  const allEvents = [];
  for (let p = 1; p <= 5; p++) {
    const url = p === 1
      ? 'https://www.cultvr.cymru/whats-on/'
      : `https://www.cultvr.cymru/whats-on/page/${p}/`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForLoadState('networkidle').catch(() => {});

    const pageEvents = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('article.event,article.post,.event')).map(item => {
        const titleEl   = item.querySelector('h1,h2,h3,.entry-title');
        const dateEl    = item.querySelector('time[datetime],.event-date,[class*="date"]');
        const linkEl    = item.querySelector('a[href]');
        const img       = item.querySelector('img[src],img[data-src]');
        const excerptEl = item.querySelector('.entry-excerpt,.entry-summary,p');

        const raw      = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
        const datetime = dateEl?.getAttribute('datetime') || '';

        return {
          title:       titleEl?.innerText?.trim() || '',
          date:        dateEl?.innerText?.trim() || '',
          datetime,
          url:         linkEl?.href || '',
          imageUrl:    raw && !raw.startsWith('data:') ? raw : '',
          description: excerptEl?.innerText?.trim().slice(0, 200) || '',
        };
      }).filter(e => e.title);
    });

    if (pageEvents.length === 0) break;
    allEvents.push(...pageEvents);
  }
  return allEvents;
}

async function scrapeRWCMD(page) {
  const allEvents = [];
  for (let p = 1; p <= 10; p++) {
    const url = p === 1
      ? 'https://www.rwcmd.ac.uk/whats-on/our-events'
      : `https://www.rwcmd.ac.uk/whats-on/our-events?p=${p}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForLoadState('networkidle').catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    const pageEvents = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('article')).map(item => {
        const titleEl = item.querySelector('h3,h2');
        const dateEl  = item.querySelector('p[class*="text-black"],p[class*="font-light"],p');
        const catEl   = item.querySelector('span[class*="uppercase"],span[class*="font-medium"]');
        const linkEl  = item.closest('a[href]') || item.querySelector('a[href]');
        const img     = item.querySelector('img[src],img[data-src]');

        const raw          = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
        const dateAndVenue = dateEl?.innerText?.trim() || '';
        // "DD Month YYYY - DD Month YYYY, Venue"
        const dp = dateAndVenue.match(/^([\d\w\s]+?)\s*[-–]\s*([\d\w\s]+?),\s*(.+)$/);

        return {
          title:    titleEl?.innerText?.trim() || '',
          date:     dp?.[1]?.trim() || dateAndVenue,
          dateEnd:  dp?.[2]?.trim() || '',
          subVenue: dp?.[3]?.trim() || '',
          category: catEl?.innerText?.trim() || '',
          url:      linkEl?.href
                      ? (linkEl.href.startsWith('http') ? linkEl.href : `https://www.rwcmd.ac.uk${linkEl.getAttribute('href')}`)
                      : '',
          imageUrl: raw && !raw.startsWith('data:') ? raw : '',
        };
      }).filter(e => e.title);
    });

    if (pageEvents.length === 0) break;
    allEvents.push(...pageEvents);
  }
  return allEvents;
}



// ─── Techniquest scraper ──────────────────────────────────────────────────────

async function scrapeTechiquest(page) {
  await page.goto('https://www.techniquest.org/discover/whats-on/', {
    waitUntil: 'domcontentloaded', timeout: TIMEOUT,
  });
  await page.waitForLoadState('networkidle').catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  return page.evaluate(() => {
    // Only want "For Adults" evening events — filter by that label
    // Techniquest uses WordPress; events are typically in article or .card elements
    // Each adult event should have a "For adults" badge/tag

    const allCards = Array.from(document.querySelectorAll(
      'article, .event-card, .card, [class*="event"], li[class*="post"]'
    )).filter(el => el.querySelector('h2,h3,h4'));

    const events = [];
    for (const card of allCards) {
      const text = card.innerText || '';
      // Only keep cards that mention "For adults" (case-insensitive)
      if (!/for adults/i.test(text)) continue;

      const titleEl = card.querySelector('h2,h3,h4,[class*="title"]');
      const dateEl  = card.querySelector('time,[class*="date"],[datetime]');
      const linkEl  = card.querySelector('a[href]');
      const img     = card.querySelector('img[src],img[data-src],img[data-lazy]');

      const raw  = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
      const href = linkEl?.getAttribute('href') || '';

      events.push({
        title:    titleEl?.innerText?.trim() || '',
        date:     dateEl?.innerText?.trim() || dateEl?.getAttribute('datetime') || '',
        url:      href.startsWith('http') ? href : (href ? `https://www.techniquest.org${href}` : ''),
        imageUrl: raw && !raw.startsWith('data:') ? raw : '',
        tag:      'For Adults',
      });
    }

    // If structured cards found nothing, fall back to body text scan
    if (events.length === 0) {
      return [{
        _probe: true,
        url: location.href,
        selCounts: ['article','.card','[class*="event"]','[class*="post"]','li'].map(s => ({
          sel: s, count: document.querySelectorAll(s).length,
        })),
        forAdultsCount: (document.body?.innerText?.match(/for adults/gi) || []).length,
        bodySnippet: (document.body?.innerText || '').slice(0, 600),
      }];
    }
    return events;
  });
}

function normaliseTechiquest(events) {
  return (events || []).filter(e => !e._probe).map(e => ({
    title:     e.title || '',
    date:      e.date || '',
    url:       e.url || '',
    venue:     'Techniquest',
    scrapedAt: SCRAPE_AT,
    imageUrl:  e.imageUrl || '',
    tag:       e.tag || 'For Adults',
  }));
}

// ─── Porters scraper ──────────────────────────────────────────────────────────

async function scrapePorters(page) {
  await page.goto('https://www.porterscardiff.org/events-1', {
    waitUntil: 'domcontentloaded', timeout: TIMEOUT,
  });
  await page.waitForLoadState('networkidle').catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  // Events are inside a SociableKit iframe — navigate directly to it
  const iframeSrc = 'https://widgets.sociablekit.com/facebook-page-events/iframe/170662';
  await page.goto(iframeSrc, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForLoadState('networkidle').catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  // Click "Load more events..." repeatedly until no button remains
  let loadMoreClicks = 0;
  while (loadMoreClicks < 10) {
    const btn = await page.$('.sk_fb_events_load_more_btn');
    if (!btn) break;
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) break;
    await btn.click();
    await new Promise(r => setTimeout(r, 2000));
    loadMoreClicks++;
  }

  return page.evaluate(() => {
    // SociableKit renders Facebook events as .sk-fb-event or similar cards
    const CARD_SELS = [
      '.sk-fb-event', '.sk_fb_event', '[class*="sk-event"]',
      '[class*="sk_event"]', '[class*="event-item"]', '.event',
    ];

    let cards = [];
    for (const sel of CARD_SELS) {
      const found = Array.from(document.querySelectorAll(sel))
        .filter(el => el.querySelector('h2,h3,h4,[class*="title"]') || el.innerText?.trim().length > 20);
      if (found.length > 0) { cards = found; break; }
    }

    // Fallback: any div/li with date-like content
    if (cards.length === 0) {
      cards = Array.from(document.querySelectorAll('div,li'))
        .filter(el => {
          const t = el.innerText?.trim() || '';
          return t.length > 30 && /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t);
        })
        .slice(0, 50);
    }

    if (cards.length === 0) {
      return [{
        _probe: true,
        url: location.href,
        selCounts: ['.sk-fb-event','.sk_fb_event','[class*="event"]','div','li'].map(s => ({
          sel: s, count: document.querySelectorAll(s).length,
        })),
        bodySnippet: (document.body?.innerText || '').slice(0, 800),
      }];
    }

    return cards.map(card => {
      const titleEl = card.querySelector('h2,h3,h4,[class*="title"],[class*="name"]');
      const dateEl  = card.querySelector('time,[class*="date"],[class*="when"]');
      const linkEl  = card.querySelector('a[href]');
      const img     = card.querySelector('img[src],img[data-src]');

      const raw  = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
      const href = linkEl?.getAttribute('href') || '';

      return {
        title:    titleEl?.innerText?.trim() || card.innerText?.split('\n')[0]?.trim() || '',
        date:     dateEl?.innerText?.trim() || dateEl?.getAttribute('datetime') || '',
        url:      href.startsWith('http') ? href : '',
        imageUrl: raw && !raw.startsWith('data:') ? raw : '',
      };
    }).filter(e => e.title);
  });
}

function normalisePorters(events) {
  return (events || []).filter(e => !e._probe).map(e => ({
    title:     e.title || '',
    date:      e.date || '',
    url:       e.url || '',
    venue:     'Porters Cardiff',
    scrapedAt: SCRAPE_AT,
    imageUrl:  e.imageUrl || '',
  }));
}

// ─── Venue config ─────────────────────────────────────────────────────────────

const VENUES = [
  {
    key:        'Glee Club',
    scrape:     scrapeGleeClub,
    normalise:  normaliseGlee,
  },
  {
    key:        'Acapela',
    scrape:     scrapeAcapela,
    normalise:  normaliseAcapela,
  },
  {
    key:        'Paradise Gardens',
    scrape:     scrapeParadiseGardens,
    normalise:  normaliseParadise,
  },
  {
    key:        'Chapter',
    scrape:     scrapeChapter,
    normalise:  normaliseChapter,
  },
  {
    key:        'CultVR',
    scrape:     scrapeCultVR,
    normalise:  normaliseCultVR,
  },
  {
    key:        'RWCMD',
    scrape:     scrapeRWCMD,
    normalise:  normaliseRWCMD,
  },
  {
    key:        'Techniquest',
    scrape:     scrapeTechiquest,
    normalise:  normaliseTechiquest,
  },
  {
    key:        'Porters',
    scrape:     scrapePorters,
    normalise:  normalisePorters,
  },
  // Jacobs Roof Garden: skipped — mostly generic bar listings
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
               '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const debugOutput    = {};   // raw + normalised per venue
  const allNormalised  = [];   // flat merged list for events.json

  for (const { key, scrape, normalise } of VENUES) {
    process.stdout.write(`  Scraping ${key}... `);
    let raw = [];
    try {
      const page = await context.newPage();
      raw = await scrape(page).finally(() => page.close());
      const normalised = normalise(raw);
      debugOutput[key] = { raw, normalised };
      allNormalised.push(...normalised);
      process.stdout.write(`done (${raw.length} raw → ${normalised.length} normalised)\n`);
    } catch (err) {
      debugOutput[key] = { error: err.message, raw: [] };
      process.stdout.write(`ERROR: ${err.message.split('\n')[0]}\n`);
    }
  }

  await browser.close();

  // Sort all events chronologically; undated events go to the end
  allNormalised.sort((a, b) => {
    const da = new Date(a.date), db = new Date(b.date);
    const av = a.date && !isNaN(da), bv = b.date && !isNaN(db);
    if (!av && !bv) return 0;
    if (!av) return 1;
    if (!bv) return -1;
    return da - db;
  });

  // Write the side-by-side debug file
  fs.writeFileSync('debug-venues7.json', JSON.stringify(debugOutput, null, 2));
  console.log(`\nDebug output  → debug-venues7.json`);

  // Also write the clean merged events file
  fs.writeFileSync('events.json', JSON.stringify(allNormalised, null, 2));
  console.log(`Events output → events.json (${allNormalised.length} total events)`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});