const { chromium } = require('playwright');
const fs = require('fs');
const axios = require('axios');

const GOTO = { waitUntil: 'domcontentloaded', timeout: 90_000 };
const SKIP_ENRICH = process.env.SCRAPE_NO_ENRICH === '1';
const ENRICH_CONCURRENCY = Math.min(8, Math.max(1, Number(process.env.SCRAPE_ENRICH_CONCURRENCY || 3)));

// ---------------------------------------------------------------------------
// Page navigation helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Genre / category inference
// ---------------------------------------------------------------------------

/**
 * Text signals that map to a genre label.
 * Order matters — more specific patterns first.
 */
const GENRE_SIGNALS = [
  [/\bpunk\b/i, 'Punk'],
  [/\bhip[- ]?hop\b/i, 'Hip-hop'],
  [/\brap\b|\bgrime\b/i, 'Rap'],
  [/\bmetal\b|\bheavy metal\b|\bdeath metal\b|\bblack metal\b/i, 'Metal'],
  [/\bhard\s*rock\b/i, 'Hard Rock'],
  [/\bfolk\b|\bacoustic\b/i, 'Folk'],
  [/\bjazz\b/i, 'Jazz'],
  [/\bsoul\b/i, 'Soul'],
  [/\br\s*[&and]+\s*b\b/i, 'R&B'],
  [/\belectronic\b|\btechno\b|\bhouse\s*music\b|\bdrum\s*[&and]+\s*bass\b|\bd[&']?n[&']?b\b/i, 'Electronic'],
  [/\bcountry\b/i, 'Country'],
  [/\bclassical\b|\borchestra\b|\bsymphony\b|\bphilharmonic\b|\bopera\b|\bchamber\b/i, 'Classical'],
  [/\bregga[e]?\b|\bska\b/i, 'Reggae'],
  [/\bblues\b/i, 'Blues'],
  [/\bindier?\b/i, 'Indie'],
  [/\bpop\b/i, 'Pop'],
  [/\brock\b/i, 'Rock'],
  [/\bambi[ae]nt\b/i, 'Ambient'],
  [/\bgospel\b/i, 'Gospel'],
  [/\bcountry\b/i, 'Country'],
  [/\bworld\s*music\b/i, 'World Music'],
];

// ─── WMC availability helpers ────────────────────────────────────────────────

const WMC_AVAILABILITY_TIERS = {
  'good availability':                 { label: 'GOOD AVAILABILITY',              range: '0-30%',  mid: 15  },
  'moderate availability':             { label: 'MODERATE AVAILABILITY',          range: '31-60%', mid: 46  },
  'limited availability':              { label: 'LIMITED AVAILABILITY',           range: '61-90%', mid: 76  },
  'only wheelchair seating available': { label: 'ONLY WHEELCHAIR SEATING AVAILABLE', range: '91-99%', mid: 95  },
  'sold out':                          { label: 'SOLD OUT',                       range: '100%',   mid: 100 },
};

const WMC_AVAILABILITY_RANK = [
  'only wheelchair seating available',
  'limited availability',
  'moderate availability',
  'good availability',
];

const WMC_SUB_VENUES = [
  { match: 'cabaret',        label: 'Cabaret'        },
  { match: 'hoddinott hall', label: 'Hoddinott Hall'  },
  { match: 'weston studio',  label: 'Weston Studio'   },
  { match: 'dance house',    label: 'Dance House'     },
];

function wmcParseSubVenue(rawPrefix) {
  if (!rawPrefix) return null;
  const lower = rawPrefix.toLowerCase().trim();
  for (const { match, label } of WMC_SUB_VENUES) {
    if (lower.startsWith(match)) return label;
  }
  return null;
}

function wmcComputeAvailability(labels) {
  if (!labels.length) return null;
  const tiers = labels.map((l) => {
    const lower = l.toLowerCase().trim();
    for (const [key, tier] of Object.entries(WMC_AVAILABILITY_TIERS)) {
      if (lower.includes(key)) return tier;
    }
    return null;
  }).filter(Boolean);
  if (!tiers.length) return null;

  let bestTier = null;
  for (const rank of WMC_AVAILABILITY_RANK) {
    const match = tiers.find((t) => t.label.toLowerCase().includes(rank));
    if (match) { bestTier = match; break; }
  }

  const avgMid = Math.round(tiers.reduce((sum, t) => sum + t.mid, 0) / tiers.length);
  const hasLimitedOrWorse = tiers.some((t) => t.mid >= 76);
  const flooredAvg = hasLimitedOrWorse ? Math.max(avgMid, 50) : avgMid;

  const clamped = bestTier
    ? Math.min(Math.max(flooredAvg, 0), bestTier.mid === 15 ? 30 : bestTier.mid === 46 ? 60 : bestTier.mid === 76 ? 90 : bestTier.mid === 95 ? 99 : 100)
    : flooredAvg;

  return {
    availability:         bestTier?.label ?? null,
    availabilityRange:    bestTier?.range ?? null,
    availabilityEstimate: clamped,
  };
}
// ─── WMC popularity scoring ──────────────────────────────────────────────────

/**
 * Weekday demand weights for WMC.
 * Mid-week shows are harder to fill organically, so a sold-out Tuesday
 * implies stronger real demand than a sold-out Saturday.
 */
const WMC_WEEKDAY_WEIGHTS = {
  0: 0.70, // Sunday
  1: 1.00, // Monday
  2: 1.00, // Tuesday
  3: 0.95, // Wednesday
  4: 0.90, // Thursday
  5: 0.75, // Friday
  6: 0.60, // Saturday
};

/**
 * Derive a popularity score (0–100) and human-readable label for a single
 * WMC event using only data available from the current scrape.
 *
 * Inputs used:
 *   ev.availabilityEstimate  — % of seats sold (0 = empty, 100 = sold out)
 *   ev.date                  — raw date string from the production card
 *   ev.scrapedAt             — ISO timestamp set at scrape time (reference)
 *
 * Returns { popularityScore, popularityLabel } or null fields if the date
 * cannot be resolved (graceful degradation — no score is better than a wrong one).
 *
 * Algorithm:
 *   demandScore     = availabilityEstimate / 100           (0–1)
 *   leadMultiplier  = 0.4 + 0.6 * (daysUntil / 365)       (0.4–1.0, clamped)
 *   weekdayWeight   = WMC_WEEKDAY_WEIGHTS[dayOfWeek]       (0.6–1.0)
 *   raw             = demandScore * leadMultiplier * weekdayWeight * 100
 *   popularityScore = clamp(round(raw), 0, 100)
 */
function wmcComputePopularity(ev) {
  // Require a numeric availability estimate
  const estimate = ev.availabilityEstimate;
  if (estimate == null || Number.isNaN(Number(estimate))) {
    return { popularityScore: null, popularityLabel: null };
  }

  // ── 1. Resolve event date ──────────────────────────────────────────────────
  const scrapedAt = ev.scrapedAt || new Date().toISOString();
  const refDate   = new Date(scrapedAt);

  let eventDate = null;

  // Try the raw date string from the production card (e.g. "Fri 20 Jun" or
  // "20 Jun – 6 Jul 2025"). We reuse the same parse helpers used elsewhere.
  const rawDate = String(ev.date || '').trim();
  if (rawDate) {
    // Range: take the start date
    const range =
      tryParseUkRangeTwoDaysOneMonthYear(rawDate) ||
      tryParseSameMonthDayRange(rawDate)           ||
      tryParseDayMonthRangeYear(rawDate);
    if (range) {
      eventDate = range.start;
    } else {
      eventDate =
        tryParseShortUkDayMonYear(rawDate)                   ||
        tryParseDdMmYyyy(rawDate)                             ||
        tryParseWeekdayOrdinalMonthYear(rawDate)              ||
        tryParseOrdinalMonthOptionalYear(rawDate, scrapedAt)  ||
        tryParseMonthDayAtTime(rawDate, scrapedAt)            ||
        tryParseDayOrdinalMonthNoYear(rawDate, scrapedAt);
    }
  }

  // If the listing date is missing a year, also try the URL
  if (!eventDate && ev.url) {
    eventDate = tryParseDateFromListingUrl(ev.url, scrapedAt);
  }

  if (!eventDate || Number.isNaN(eventDate.getTime())) {
    // Cannot safely compute lead-time — return null scores rather than noise
    return { popularityScore: null, popularityLabel: null };
  }

  // ── 2. Lead-time component ─────────────────────────────────────────────────
  const msPerDay   = 86_400_000;
  const daysUntil  = Math.max(0, (eventDate.getTime() - refDate.getTime()) / msPerDay);
  const leadNorm   = Math.min(daysUntil, 365) / 365;      // 0 (imminent) → 1 (≥1 year away)
  const leadMultiplier = 0.7 + 0.3 * leadNorm;   // range: 0.70 – 1.00

  // ── 3. Weekday weight ──────────────────────────────────────────────────────
  const dayOfWeek     = eventDate.getDay();                // 0=Sun … 6=Sat
  const weekdayWeight = WMC_WEEKDAY_WEIGHTS[dayOfWeek] ?? 0.85;

  // ── 4. Demand pressure ────────────────────────────────────────────────────
  const hasLimitedOrWorse  = /limited|wheelchair|sold.?out/i.test(ev.availability || '');
  const isAtLeastMonthAway = daysUntil >= 30;
  const flooredEstimate    = (hasLimitedOrWorse && isAtLeastMonthAway)
    ? Math.max(Number(estimate), 60)
    : Number(estimate);
  const demandScore        = flooredEstimate / 100;

  // ── 5. Composite ──────────────────────────────────────────────────────────
  const raw            = demandScore * leadMultiplier * weekdayWeight * 100;
  let popularityScore = Math.min(100, Math.max(0, Math.round(raw)));
  if (/wheelchair|sold.?out/i.test(ev.availability || '')) popularityScore = Math.max(popularityScore, 80);

  // ── 6. Human-readable label ───────────────────────────────────────────────
  let popularityLabel;
  if      (popularityScore >= 75) popularityLabel = 'Very high demand';
  else if (popularityScore >= 50) popularityLabel = 'High demand';
  else if (popularityScore >= 30) popularityLabel = 'Moderate demand';
  else if (popularityScore >= 15) popularityLabel = 'Low demand';
  else                            popularityLabel = 'Very low demand';

  return { popularityScore, popularityLabel };
}

async function wmcWaitForAngularBind(page, timeout = 15_000) {
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
      { timeout }
    );
  } catch {}
}

async function wmcScrapeAvailability(context, eventUrl) {
  const perfUrl = `${eventUrl.replace(/\/$/, '')}/performances`;
  const page = await context.newPage();
  try {
    await page.goto(perfUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await wmcWaitForAngularBind(page);
    const labels = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          '.calendar-list-filter-list--performance-list .calendar-list-entry__availablity'
        )
      )
        .map((el) => el.innerText?.trim() ?? '')
        .filter((t) => t && !t.includes('{{'))
    );
    return wmcComputeAvailability(labels);
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

/**
 * Extract genre labels from any block of text by scanning against GENRE_SIGNALS.
 * Returns a deduplicated array.
 */
function extractGenreSignalsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const found = [];
  const seen = new Set();
  for (const [re, label] of GENRE_SIGNALS) {
    if (re.test(text) && !seen.has(label)) {
      seen.add(label);
      found.push(label);
    }
  }
  return found;
}

/**
 * Infer a single genre string from the event title alone (legacy helper kept
 * for the finalizeEvent fallback chain).
 */
function inferGenreFromTitle(title) {
  if (!title) return '';
  const t = title.toLowerCase();
  const pairs = [
    [/tribute|experience|vs the|sound of |celebrating /, 'Tribute / Covers'],
    [/\bdj\b| vs | b2b |club night|retro electro/, 'DJ / Club'],
    [/opera|ballet|orchestra|symphony|philharmonic/, 'Classical'],
    [/wrestling|wwe|mma|boxing|fc\b|rugby|match\b/, 'Sports'],
    [/comedy|stand[- ]?up|comedian/, 'Comedy'],
    [/musical|panto|pantomime|broadway/, 'Musical Theatre'],
  ];
  for (const [re, g] of pairs) if (re.test(t)) return g;
  return '';
}

/**
 * Determine the single primary category for an event.
 *
 * Rules applied in priority order:
 *   1. Explicit schema/listing category field (most reliable when present)
 *   2. Content signals across all text blobs (description, title, details…)
 *   3. Venue assumption as a last resort (least reliable)
 *
 * Default for music-first venues (Globe, Tramshed, Clwb, Depot, SU) = 'Music'.
 * Default for everything else = 'Other'.
 */
function inferPrimaryCategory(ev) {
  // --- 1. Explicit category field (New Theatre provides these via Trafalgar) ---
  const cat = String(ev.category || '').toLowerCase().trim();
  if (cat) {
    if (/comedy/.test(cat)) return 'Comedy';
    if (/musical/.test(cat)) return 'Musical Theatre';
    if (/opera|ballet|dance/.test(cat)) return 'Theatre';
    if (/play\b|drama|theatre/.test(cat)) return 'Theatre';
    if (/film|cinema/.test(cat)) return 'Film';
    if (/family/.test(cat)) return 'Family';
    if (/sport|wrestling|boxing|mma/.test(cat)) return 'Sports';
    if (/music/.test(cat)) return 'Music';
    if (/other|talk|lecture|event/.test(cat)) return 'Other';
  }

  // --- 2. Content signals ---
  const blob = [
    ev.title,
    ev.description,
    ev.shortDescription,
    ev.details,
    ev.genre,
    ev.subcategory,
    ev.eventKeywords,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // Comedy — check before Theatre so stand-up at theatres is correct
  if (/\bstand[- ]?up\b|\bcomedian\b|\bcomedy\s*(show|night|tour|gig|special)|\blive\s*comedy\b/.test(blob)) return 'Comedy';
  if (/\bcomedy\b/.test(blob) && !/\bmusical\s*comedy\b/.test(blob)) return 'Comedy';

  // Theatre / performing arts
  if (/\bmusical\b|\bpanto\b|\bpantomime\b|\bbroadway\b|\bwest\s*end\b/.test(blob)) return 'Musical Theatre';
  if (/\bopera\b|\bballet\b/.test(blob)) return 'Theatre';
  if (/\bplay\b|\bdrama\b|\btheatre\s*company\b|\bstage\s*show\b/.test(blob)) return 'Theatre';

  // Sports
  if (/\bwrestling\b|\bwwe\b|\bmma\b|\bboxing\b|\bfc\b|\brugby\b/.test(blob)) return 'Sports';

  // Film
  if (/\bfilm\b|\bcinema\b|\bscreening\b/.test(blob)) return 'Film';

  // Family
  if (/\bfamily\s*(show|event|fun|friendly)\b|\bchildren['\u2019]?s\b|\bkids\b/.test(blob)) return 'Family';

  // --- 3. Venue assumption (last resort) ---
  const venue = String(ev.venue || '').toLowerCase();

  // Music-first venues — default to Music
  if (/globe\s*cardiff|tramshed|clwb\s*ifor|depot\s*cardiff|cardiff\s*su|utilita|fuel|gate/.test(venue)) return 'Music';

  // Arts/theatre venues — default to Theatre only if no music signals
  if (/new\s*theatre|millennium\s*centre|wmc|the\s*gate/.test(venue)) return 'Theatre';

  return 'Other';
}

// ---------------------------------------------------------------------------
// Price helpers
// ---------------------------------------------------------------------------

function numPrice(v) {
  if (v == null) return NaN;
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isNaN(n) ? NaN : n;
}

function normalizeOffers(offers) {
  if (!offers) return {};
  const list = Array.isArray(offers) ? offers : [offers];
  let low = null;
  let high = null;
  let currency = null;

  for (const o of list) {
    if (!o || typeof o !== 'object') continue;
    const typ = o['@type'];
    const types = Array.isArray(typ) ? typ : typ ? [typ] : [];
    if (types.includes('AggregateOffer') || typ === 'AggregateOffer') {
      if (o.lowPrice != null) {
        const lp = numPrice(o.lowPrice);
        if (!Number.isNaN(lp)) low = low == null ? lp : Math.min(low, lp);
      }
      if (o.highPrice != null) {
        const hp = numPrice(o.highPrice);
        if (!Number.isNaN(hp)) high = high == null ? hp : Math.max(high, hp);
      }
      currency = o.priceCurrency || currency;
    }
    const ps = o.priceSpecification;
    if (ps) {
      const pss = Array.isArray(ps) ? ps : [ps];
      for (const spec of pss) {
        if (!spec || typeof spec !== 'object') continue;
        const p = numPrice(spec.price);
        if (!Number.isNaN(p)) {
          low = low == null ? p : Math.min(low, p);
          high = high == null ? p : Math.max(high, p);
          currency = spec.priceCurrency || o.priceCurrency || currency;
        }
      }
    }
    if (o.price != null) {
      const p = numPrice(o.price);
      if (!Number.isNaN(p)) {
        low = low == null ? p : Math.min(low, p);
        high = high == null ? p : Math.max(high, p);
        currency = o.priceCurrency || currency;
      }
    }
  }
  return { low, high, currency };
}

function scrapePriceFromVisibleText(text) {
  if (!text || text.length > 25_000) return {};
  const from =
    text.match(/\b(?:tickets?|entry|admission|price|from)\s*:?\s*from\s*£\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/\bfrom\s*£\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/\bstarting\s+at\s*£\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/\b(?:tickets?|prices?)\s+from\s*£\s*(\d+(?:\.\d+)?)/i);
  if (from) return { label: `from £${from[1]}`, low: Number(from[1]), currency: 'GBP' };
  const range = text.match(/£\s*(\d+(?:\.\d+)?)\s*[-–]\s*£\s*(\d+(?:\.\d+)?)/);
  if (range) return { label: `£${range[1]}–£${range[2]}`, low: Number(range[1]), high: Number(range[2]), currency: 'GBP' };
  const single = text.match(/£\s*(\d+(?:\.\d+)?)/);
  if (single) return { label: `£${single[1]}`, low: Number(single[1]), currency: 'GBP' };
  return {};
}

// ---------------------------------------------------------------------------
// Page enrichment (visits individual ticket pages)
// ---------------------------------------------------------------------------

async function fetchPageEnrichment(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 65_000 });
  await page.waitForLoadState('load').catch(() => {});
  const host = (() => {
    try { return new URL(url).hostname; } catch { return ''; }
  })();
  if (host.includes('tixr.com')) await new Promise((r) => setTimeout(r, 5_000));
  else await new Promise((r) => setTimeout(r, 900));

  return page.evaluate(() => {
    const meta = (sel) => document.querySelector(sel)?.getAttribute('content')?.trim() || '';

    const eventTypes = new Set([
      'Event', 'MusicEvent', 'TheaterEvent', 'TheatreEvent',
      'ComedyEvent', 'Festival', 'SportsEvent', 'DanceEvent',
    ]);

    function typesOf(node) {
      const t = node['@type'];
      return Array.isArray(t) ? t : t ? [t] : [];
    }

    const eventNodes = [];
    const graphOfferNodes = [];
    const breadcrumbTrails = [];
    const VISIT_CAP = 900;
    let visits = 0;

    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 18 || visits >= VISIT_CAP) return;
      visits++;
      if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
      const types = typesOf(node);
      if (types.some((x) => eventTypes.has(x))) eventNodes.push(node);
      if (types.some((x) => x === 'Offer' || x === 'AggregateOffer')) {
        const name = String(node.name || '').toLowerCase();
        if (!/merch|t[-]?shirt|hoodie|programme|parking|bundle\s+only|poster|vinyl|cd\b/.test(name)) {
          graphOfferNodes.push(node);
        }
      }
      if (types.includes('BreadcrumbList') && node.itemListElement) {
        const names = [];
        const els = Array.isArray(node.itemListElement) ? node.itemListElement : [node.itemListElement];
        for (const el of els) {
          if (!el || typeof el !== 'object') continue;
          let n = '';
          if (el.name) n = String(el.name).trim();
          else if (el.item && typeof el.item === 'object' && el.item.name) n = String(el.item.name).trim();
          if (n) names.push(n);
        }
        if (names.length >= 2) breadcrumbTrails.push(names.join(' > '));
      }
      for (const k of Object.keys(node)) {
        if (k === '@context') continue;
        const v = node[k];
        if (v && typeof v === 'object') walk(v, depth + 1);
      }
    }

    const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
    for (const s of scripts) {
      try { walk(JSON.parse(s.textContent), 0); } catch { /* ignore */ }
    }

    const score = (e) =>
      [e.description, e.startDate, e.endDate, e.image, e.offers, e.location, e.performer].filter(Boolean).length;
    const best = eventNodes.sort((a, b) => score(b) - score(a))[0] || null;

    function performerGenresOf(evLike) {
      if (!evLike) return '';
      const perf = evLike.performer;
      const list = Array.isArray(perf) ? perf : perf ? [perf] : [];
      const g = [];
      for (const p of list) {
        if (!p || typeof p !== 'object') continue;
        if (p.genre) {
          if (Array.isArray(p.genre)) {
            for (const x of p.genre) { const s = String(x || '').trim(); if (s) g.push(s); }
          } else {
            const s = String(p.genre || '').trim();
            if (s) g.push(s);
          }
        }
      }
      return [...new Set(g)].join(', ');
    }

    function performerNamesOf(evLike) {
      if (!evLike) return [];
      const perf = evLike.performer;
      const list = Array.isArray(perf) ? perf : perf ? [perf] : [];
      const names = [];
      for (const p of list) {
        if (p == null) continue;
        if (typeof p === 'string') { const s = p.trim(); if (s) names.push(s); continue; }
        if (typeof p === 'object' && p.name) { const s = String(p.name).trim(); if (s) names.push(s); }
      }
      const seen = new Set();
      const out = [];
      for (const n of names) { const k = n.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(n); }
      return out;
    }

    const ogDesc = meta('meta[property="og:description"]') || meta('meta[name="description"]');
    const ogImageRaw = meta('meta[property="og:image"]');
    const twitterImageRaw = meta('meta[name="twitter:image"]') || meta('meta[property="twitter:image"]') || '';
    const ogTitle = meta('meta[property="og:title"]');

    function absolutizeImageUrl(u) {
      const s = String(u || '').trim();
      if (!s || s.startsWith('data:')) return '';
      if (s.startsWith('//')) return `https:${s}`;
      try { return new URL(s, document.baseURI || location.href).href; } catch { return s; }
    }

    function collectLdImageUrls(val, bucket) {
      if (val == null) return;
      if (typeof val === 'string') { const a = absolutizeImageUrl(val); if (a) bucket.push(a); return; }
      if (Array.isArray(val)) { for (const x of val) collectLdImageUrls(x, bucket); return; }
      if (typeof val === 'object') {
        if (typeof val.url === 'string') collectLdImageUrls(val.url, bucket);
        if (typeof val.contentUrl === 'string') collectLdImageUrls(val.contentUrl, bucket);
      }
    }

    let description = '';
    let genre = '';
    let startDate = '';
    let endDate = '';
    const imageCandidateList = [];
    let offersFromEvent = null;
    let eventKeywords = '';
    let musicGenresFromSchema = [];
    let performerNames = [];

    if (best) {
      if (typeof best.description === 'string') description = best.description.trim();
      const g = best.genre;
      genre = Array.isArray(g) ? g.filter(Boolean).join(', ') : typeof g === 'string' ? g.trim() : '';
      const pg = performerGenresOf(best);

      const musicSet = new Set();
      const addFrom = (val) => {
        if (val == null) return;
        if (Array.isArray(val)) { for (const x of val) addFrom(x); return; }
        const s = String(val).trim();
        if (!s) return;
        for (const part of s.split(/[;,]/g)) { const q = String(part || '').trim(); if (q) musicSet.add(q); }
      };
      addFrom(g);
      addFrom(pg);
      musicGenresFromSchema = [...musicSet];
      performerNames = performerNamesOf(best);

      if (pg) {
        const parts = [...new Set([...genre.split(/,\s*/), ...pg.split(/,\s*/)].map((s) => s.trim()).filter(Boolean))];
        genre = parts.join(', ');
      }
      if (typeof best.keywords === 'string' && best.keywords.trim()) {
        eventKeywords = best.keywords.trim().slice(0, 220);
      }
      if (best.startDate) startDate = String(best.startDate);
      if (best.endDate) endDate = String(best.endDate);
      collectLdImageUrls(best.image, imageCandidateList);
      offersFromEvent = best.offers || null;
    }

    if (ogImageRaw) { const u = absolutizeImageUrl(ogImageRaw); if (u) imageCandidateList.push(u); }
    if (twitterImageRaw) { const u = absolutizeImageUrl(twitterImageRaw); if (u) imageCandidateList.push(u); }

    const imageSeen = new Set();
    const imageUrls = [];
    for (const u of imageCandidateList) {
      const key = String(u).toLowerCase();
      if (imageSeen.has(key)) continue;
      imageSeen.add(key);
      imageUrls.push(u);
    }
    const imageUrl = imageUrls[0] || '';

    if (!startDate) {
      const t =
        document.querySelector('time[datetime]') ||
        document.querySelector('[itemprop="startDate"][datetime]') ||
        document.querySelector('meta[itemprop="startDate"]');
      const raw = t?.getAttribute?.('datetime') || t?.getAttribute?.('content') || '';
      if (raw) startDate = String(raw).trim();
    }

    let breadcrumbTrail = '';
    for (const tr of breadcrumbTrails) { if (tr.length > breadcrumbTrail.length) breadcrumbTrail = tr; }

    let microLow = null;
    let microHigh = null;
    let microCur = '';
    for (const el of document.querySelectorAll('[itemprop="price"]')) {
      const raw = el.getAttribute('content') || el.textContent || '';
      const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
      if (!Number.isNaN(n) && n > 0) {
        microLow = microLow == null ? n : Math.min(microLow, n);
        microHigh = microHigh == null ? n : Math.max(microHigh, n);
      }
    }
    const curEl = document.querySelector('[itemprop="priceCurrency"]');
    if (curEl) microCur = (curEl.getAttribute('content') || '').trim();

    const bodyText = (document.body?.innerText || '').slice(0, 20_000);

    return {
      description: description || '',
      shortDescription: ogDesc || '',
      genre,
      musicGenresFromSchema,
      imageUrl,
      imageUrls,
      startDate,
      endDate,
      offersFromEvent,
      offersFromGraph: graphOfferNodes.slice(0, 48),
      breadcrumbTrail,
      eventKeywords,
      performerNames,
      microdataPrice:
        microLow != null && !Number.isNaN(microLow)
          ? { low: microLow, high: microHigh != null && !Number.isNaN(microHigh) ? microHigh : microLow, currency: microCur || 'GBP' }
          : null,
      ogTitle,
      bodySnippet: bodyText,
    };
  });
}

// ---------------------------------------------------------------------------
// Offer / price merging
// ---------------------------------------------------------------------------

function mergeOffersIntoEvent(ev, offersRaw) {
  if (!offersRaw) return ev;
  const { low, high, currency } = normalizeOffers(offersRaw);
  const out = { ...ev };
  if (low != null && !Number.isNaN(low)) {
    out.ticketPriceFrom = out.ticketPriceFrom == null || Number.isNaN(out.ticketPriceFrom)
      ? low : Math.min(out.ticketPriceFrom, low);
  }
  if (high != null && !Number.isNaN(high)) {
    out.ticketPriceTo = out.ticketPriceTo == null || Number.isNaN(out.ticketPriceTo)
      ? high : Math.max(out.ticketPriceTo, high);
  }
  if (currency) out.ticketCurrency = currency;
  return out;
}

function mergeAllOfferBlobsIntoEvent(ev, blobs) {
  const flat = [];
  for (const b of blobs) {
    if (b == null) continue;
    if (Array.isArray(b)) { for (const x of b) { if (x != null && typeof x === 'object') flat.push(x); } }
    else if (typeof b === 'object') flat.push(b);
  }
  if (!flat.length) return ev;
  return mergeOffersIntoEvent(ev, flat);
}

// ---------------------------------------------------------------------------
// Date parsing helpers
// ---------------------------------------------------------------------------

function localNoon(y, m0, d) { return new Date(y, m0, d, 12, 0, 0); }
function startOfLocalDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function inferYearForMonthDay(scrapedAt, month0, day) {
  const ref = scrapedAt ? new Date(scrapedAt) : new Date();
  const r0 = startOfLocalDay(ref);
  let y = ref.getFullYear();
  let cand = startOfLocalDay(localNoon(y, month0, day));
  if (cand < r0) {
    const daysPast = (r0 - cand) / 86400000;
    if (daysPast <= 31) return y;
    return y + 1;
  }
  return y;
}

function parseMonthToken(tok) {
  if (!tok) return -1;
  const t = String(tok).toLowerCase().replace(/\./g, '');
  const map = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const k = t.length >= 3 ? t.slice(0, 3) : t;
  if (map[k] != null) return map[k];
  const full = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  for (let i = 0; i < 12; i++) { if (full[i].startsWith(t)) return i; }
  return -1;
}

function formatUkLongDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London',
    });
  } catch { return ''; }
}

function tryParseIsoToDate(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function tryParseShortUkDayMonYear(s) {
  const m = String(s).match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\b/i);
  if (!m) return null;
  const mo = parseMonthToken(m[3]);
  if (mo < 0) return null;
  const d = localNoon(Number(m[4]), mo, Number(m[2]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function tryParseUkRangeTwoDaysOneMonthYear(s) {
  const m = String(s).match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+(\d{1,2})\s*[-–]\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\b/i);
  if (!m) return null;
  const mo = parseMonthToken(m[5]);
  if (mo < 0) return null;
  const y = Number(m[6]);
  const d1 = localNoon(y, mo, Number(m[2]));
  const d2 = localNoon(y, mo, Number(m[4]));
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
  return { start: d1, end: d2 };
}

function tryParseDdMmYyyy(s) {
  const m = String(s).match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (!m) return null;
  const d = localNoon(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function tryParseDayOrdinalMonthNoYear(line, scrapedAt) {
  const m = String(line).trim().match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s*$/i);
  if (!m) return null;
  const mo = parseMonthToken(m[3]);
  if (mo < 0) return null;
  const day = Number(m[2]);
  const y = inferYearForMonthDay(scrapedAt, mo, day);
  const d = localNoon(y, mo, day);
  return Number.isNaN(d.getTime()) ? null : d;
}

function tryParseOrdinalMonthOptionalYear(s, scrapedAt) {
  const m = String(s).match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December)[a-z]*(?:\s+(\d{4}))?\b/i);
  if (!m) return null;
  const mo = parseMonthToken(m[2]);
  if (mo < 0) return null;
  const day = Number(m[1]);
  const y = m[3] ? Number(m[3]) : inferYearForMonthDay(scrapedAt, mo, day);
  const d = localNoon(y, mo, day);
  return Number.isNaN(d.getTime()) ? null : d;
}

function tryParseMonthDayAtTime(s, scrapedAt) {
  const m = String(s).match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December)[a-z]*\s+(\d{1,2})\b/i);
  if (!m) return null;
  const mo = parseMonthToken(m[1]);
  if (mo < 0) return null;
  const day = Number(m[2]);
  const y = inferYearForMonthDay(scrapedAt, mo, day);
  const d = localNoon(y, mo, day);
  return Number.isNaN(d.getTime()) ? null : d;
}

function tryParseDayMonthRangeYear(s) {
  const m = String(s).match(/(\d{1,2})\s+([A-Za-z]+)\s*[-–]\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  if (!m) return null;
  const m1 = parseMonthToken(m[2]);
  const m2 = parseMonthToken(m[4]);
  const y = Number(m[5]);
  if (m1 < 0 || m2 < 0) return null;
  const d1 = localNoon(y, m1, Number(m[1]));
  const d2 = localNoon(y, m2, Number(m[3]));
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
  return { start: d1, end: d2 };
}

function tryParseSameMonthDayRange(s) {
  const m = String(s).match(/(\d{1,2})\s*[-–]\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  if (!m) return null;
  const mo = parseMonthToken(m[3]);
  const y = Number(m[4]);
  if (mo < 0) return null;
  const d1 = localNoon(y, mo, Number(m[1]));
  const d2 = localNoon(y, mo, Number(m[2]));
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
  return { start: d1, end: d2 };
}

function tryParseWeekdayOrdinalMonthYear(s) {
  const m = String(s).match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})\b/i);
  if (!m) return null;
  const mo = parseMonthToken(m[3]);
  if (mo < 0) return null;
  const d = localNoon(Number(m[4]), mo, Number(m[2]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function firstMeaningfulLine(text) {
  if (!text) return '';
  const line = String(text).split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line || '';
}

function formatRangeLong(a, b) {
  const fa = formatUkLongDate(a);
  const fb = formatUkLongDate(b);
  if (!fa || !fb) return fa || fb;
  if (a.getTime() === b.getTime()) return fa;
  return `${fa} – ${fb}`;
}

function tryParseDateFromListingUrl(url, scrapedAt) {
  if (!url || typeof url !== 'string') return null;
  const u = url.toLowerCase();
  const m1 = u.match(/(\d{1,2})-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-(\d{4})\b/);
  if (m1) {
    const mo = parseMonthToken(m1[2]);
    if (mo < 0) return null;
    const d = localNoon(Number(m1[3]), mo, Number(m1[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m2 = u.match(/(\d{1,2})-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:-tickets|-[a-z0-9-]*tickets)/);
  if (m2) {
    const mo = parseMonthToken(m2[2]);
    if (mo < 0) return null;
    const day = Number(m2[1]);
    const y = inferYearForMonthDay(scrapedAt, mo, day);
    const d = localNoon(y, mo, day);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function deriveHumanEventDate(ev) {
  const scrapedAt = ev.scrapedAt || '';
  const rawDate = ev.date != null ? String(ev.date).trim() : '';
  const weakListingDate = rawDate && !/\d{4}/.test(rawDate);
  const blobs = [
    ev.eventStartDate,
    ...(weakListingDate ? [] : rawDate ? [rawDate] : []),
    firstMeaningfulLine(ev.details),
    firstMeaningfulLine(ev.description),
    firstMeaningfulLine(ev.shortDescription),
    ...(weakListingDate ? [rawDate] : []),
  ].filter(Boolean);

  const isoStart = tryParseIsoToDate(ev.eventStartDate);
  const isoEnd = tryParseIsoToDate(ev.eventEndDate);
  if (isoStart) {
    if (isoEnd && isoEnd.getTime() !== isoStart.getTime()) {
      const s0 = startOfLocalDay(isoStart);
      const s1 = startOfLocalDay(isoEnd);
      if (s0.getTime() !== s1.getTime()) return formatRangeLong(isoStart, isoEnd);
    }
    return formatUkLongDate(isoStart);
  }

  const urlDate = tryParseDateFromListingUrl(ev.url, scrapedAt);
  if (urlDate) return formatUkLongDate(urlDate);

  for (const raw of blobs) {
    const s = String(raw).trim();
    if (!s) continue;
    const r1 = tryParseUkRangeTwoDaysOneMonthYear(s.replace(/\s+/g, ' '));
    if (r1) return formatRangeLong(r1.start, r1.end);
    const r2 = tryParseDayMonthRangeYear(s);
    if (r2) return formatRangeLong(r2.start, r2.end);
    const r3 = tryParseSameMonthDayRange(s);
    if (r3) return formatRangeLong(r3.start, r3.end);
    const dShort = tryParseShortUkDayMonYear(s);
    if (dShort) return formatUkLongDate(dShort);
    const dSlash = tryParseDdMmYyyy(s);
    if (dSlash) return formatUkLongDate(dSlash);
    const gateDt = tryParseWeekdayOrdinalMonthYear(s);
    if (gateDt) return formatUkLongDate(gateDt);
    const dOrd = tryParseOrdinalMonthOptionalYear(s, scrapedAt);
    if (dOrd) return formatUkLongDate(dOrd);
    const dMonDay = tryParseMonthDayAtTime(s, scrapedAt);
    if (dMonDay) return formatUkLongDate(dMonDay);
    const dLine = tryParseDayOrdinalMonthNoYear(firstMeaningfulLine(s) || s, scrapedAt);
    if (dLine) return formatUkLongDate(dLine);
  }

  for (const raw of blobs) {
    const s = String(raw).trim();
    if (/\d{4}/.test(s) && s.length >= 8) return s;
  }

  const hay = [ev.title, rawDate, ev.details, ev.description, ev.shortDescription].filter(Boolean).join('\n');
  const h = hay.replace(/\s+/g, ' ');
  const rRange = tryParseUkRangeTwoDaysOneMonthYear(h);
  if (rRange) return formatRangeLong(rRange.start, rRange.end);
  const rDm = tryParseDayMonthRangeYear(hay);
  if (rDm) return formatRangeLong(rDm.start, rDm.end);
  const rSame = tryParseSameMonthDayRange(hay);
  if (rSame) return formatRangeLong(rSame.start, rSame.end);
  const dS = tryParseShortUkDayMonYear(h);
  if (dS) return formatUkLongDate(dS);
  const dSlash = tryParseDdMmYyyy(h);
  if (dSlash) return formatUkLongDate(dSlash);

  return '';
}

// ---------------------------------------------------------------------------
// Genre / music genre helpers
// ---------------------------------------------------------------------------

function tidyBreadcrumbTrail(raw) {
  let t = String(raw || '').trim();
  if (!t) return '';
  const noise = /^(home|events|what'?s\s*on|ticket(s)?|shop|store)\s*>\s*/i;
  for (let i = 0; i < 6 && noise.test(t); i++) t = t.replace(noise, '');
  return t.replace(/^>\s*|\s*>$/g, '').trim();
}

const GENERIC_LISTING_CATEGORIES = new Set([
  "what's on", 'whats on', 'events', 'home', 'tickets', 'ticket',
  'box office', 'venue', 'live music', 'music', 'whatson', 'what\u2019s on',
]);

function categoryAsGenreHint(raw) {
  const c = String(raw || '').trim();
  if (!c) return '';
  const low = c.toLowerCase().replace(/\s+/g, ' ');
  if (GENERIC_LISTING_CATEGORIES.has(low)) return '';
  return c;
}

function subcategoryLineAsGenreHint(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 72 || />/.test(s)) return '';
  return s.split(';')[0].trim();
}

function splitGenreStringToMusicGenres(genreString) {
  if (!genreString || typeof genreString !== 'string') return [];
  const parts = genreString.split(/[,;]/g).map((s) => String(s || '').trim()).filter(Boolean);
  return parts.slice(0, 12);
}

function unionMusicGenres(existing, incoming) {
  const out = [];
  const seen = new Set();
  const add = (s) => {
    if (s == null) return;
    const str = String(s).trim();
    if (!str) return;
    const k = str.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(str);
  };
  for (const s of existing || []) add(s);
  for (const s of incoming || []) add(s);
  return out;
}

// ---------------------------------------------------------------------------
// MusicBrainz genre lookup
// ---------------------------------------------------------------------------

function normalizeArtistNameForMb(name) {
  if (!name) return '';
  return String(name).replace(/\s+/g, ' ').trim();
}

function extractMusicBrainzGenreNames(mbArtistJson) {
  if (!mbArtistJson || typeof mbArtistJson !== 'object') return [];
  const list = Array.isArray(mbArtistJson.genres)
    ? mbArtistJson.genres
    : Array.isArray(mbArtistJson.tags) ? mbArtistJson.tags : [];
  const out = [];
  const seen = new Set();
  for (const g of list) {
    if (g == null) continue;
    const name = typeof g === 'string' ? g : g.name || g.genre || g.tag || '';
    const s = String(name || '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

async function fetchMusicBrainzGenresForArtistName(artistName, cacheByKey, mbUserAgent) {
  const raw = normalizeArtistNameForMb(artistName);
  if (!raw) return [];
  const key = raw.toLowerCase();
  if (cacheByKey.has(key)) return cacheByKey.get(key);
  const p = (async () => {
    try {
      const q = `artist:${raw}`;
      const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(q)}&fmt=json&limit=1`;
      const searchRes = await axios.get(searchUrl, { headers: { 'User-Agent': mbUserAgent }, timeout: 15_000 });
      const mbid = searchRes?.data?.artists?.[0]?.id;
      if (!mbid) return [];
      const artistUrl = `https://musicbrainz.org/ws/2/artist/${mbid}?inc=genres&fmt=json`;
      const artistRes = await axios.get(artistUrl, { headers: { 'User-Agent': mbUserAgent }, timeout: 15_000 });
      return extractMusicBrainzGenreNames(artistRes?.data);
    } catch { return []; }
  })();
  cacheByKey.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// Image URL helpers
// ---------------------------------------------------------------------------

const IMAGE_TRACKING_PARAMS = new Set([
  'utm_source','utm_medium','utm_campaign','utm_content','utm_term','utm_id',
  'fbclid','gclid','mc_cid','mc_eid','msclkid','_ga','ref',
]);

function normalizeHotlinkImageUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s || s.startsWith('data:')) return '';
  if (s.startsWith('//')) s = `https:${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    for (const k of [...u.searchParams.keys()]) {
      const lk = k.toLowerCase();
      if (IMAGE_TRACKING_PARAMS.has(lk) || lk.startsWith('utm_')) u.searchParams.delete(k);
    }
    u.hash = '';
    return u.toString();
  } catch { return s; }
}

function dedupeHotlinkImageUrls(urls) {
  const out = [];
  const seen = new Set();
  for (const raw of urls || []) {
    const n = normalizeHotlinkImageUrl(raw);
    if (!n) continue;
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

function mergeHotlinkImagesIntoEvent(ev, en) {
  const listingPool = [];
  if (ev.imageUrl) listingPool.push(ev.imageUrl);
  if (Array.isArray(ev.imageUrls)) listingPool.push(...ev.imageUrls);
  const detailPool = [];
  if (en?.imageUrl) detailPool.push(en.imageUrl);
  if (Array.isArray(en?.imageUrls)) detailPool.push(...en.imageUrls);
  const listing = dedupeHotlinkImageUrls(listingPool);
  const detail = dedupeHotlinkImageUrls(detailPool);
  const out = { ...ev };
  if (detail.length) {
    out.imageUrl = detail[0];
    out.imageUrls = dedupeHotlinkImageUrls([...detail, ...listing]).slice(0, 16);
    return out;
  }
  if (listing.length) {
    if (!String(out.imageUrl || '').trim()) out.imageUrl = listing[0];
    out.imageUrls = listing.slice(0, 16);
    return out;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Enrichment merging
// ---------------------------------------------------------------------------

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

  // Schema-derived music genres
  const schemaMusicGenres = Array.isArray(en.musicGenresFromSchema) ? en.musicGenresFromSchema : [];
  if (schemaMusicGenres.length) {
    const existing = Array.isArray(out.musicGenres) ? out.musicGenres : [];
    const merged = unionMusicGenres(existing, schemaMusicGenres);
    if (merged.length) out.musicGenres = merged;
  }


  out = mergeHotlinkImagesIntoEvent(out, en);

  if (en.startDate) out.eventStartDate = en.startDate;
  if (en.endDate) out.eventEndDate = en.endDate;

  out = mergeAllOfferBlobsIntoEvent(out, [en.offersFromEvent, en.offersFromGraph]);

  if (en.microdataPrice && en.microdataPrice.low != null && !Number.isNaN(en.microdataPrice.low)) {
    const low = en.microdataPrice.low;
    const high = en.microdataPrice.high;
    if (out.ticketPriceFrom == null || Number.isNaN(out.ticketPriceFrom)) {
      out.ticketPriceFrom = low;
      if (high != null && !Number.isNaN(high) && high !== low) out.ticketPriceTo = high;
      out.ticketCurrency = en.microdataPrice.currency || out.ticketCurrency || 'GBP';
    }
  }

  const trail = tidyBreadcrumbTrail(en.breadcrumbTrail);
  if (trail && !out.subcategory) out.subcategory = trail;
  if (en.eventKeywords && !out.eventKeywords) out.eventKeywords = String(en.eventKeywords).trim();

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

function tryAttachPriceFromListingText(ev) {
  if (ev.ticketPriceFrom != null && !Number.isNaN(ev.ticketPriceFrom)) return ev;
  const blob = [ev.details, ev.description, ev.shortDescription, ev.title].filter(Boolean).join('\n');
  const vis = scrapePriceFromVisibleText(blob);
  if (vis.low == null) return ev;
  return {
    ...ev,
    ticketPriceFrom: vis.low,
    ...(vis.high != null ? { ticketPriceTo: vis.high } : {}),
    ticketCurrency: vis.currency || ev.ticketCurrency || 'GBP',
    ticketPriceLabel: vis.label || ev.ticketPriceLabel,
  };
}

// ---------------------------------------------------------------------------
// Event finalisation
// ---------------------------------------------------------------------------

function finalizeEvent(ev) {
  // --- Build musicGenres array ---
  let musicGenres = Array.isArray(ev.musicGenres) ? [...ev.musicGenres] : [];

  // Supplement from genre string if musicGenres is empty
  if (!musicGenres.length && ev.genre) {
    musicGenres = splitGenreStringToMusicGenres(ev.genre);
  }

  // Supplement from title signals if still empty
  if (!musicGenres.length) {
    const titleSignals = extractGenreSignalsFromText(ev.title);
    if (titleSignals.length) musicGenres = titleSignals;
  }


  // --- Build genre string (human-readable) ---
  const musicGenreHint = musicGenres.length ? musicGenres.join(', ') : '';
  const genre = (
    ev.genre ||
    musicGenreHint ||
    categoryAsGenreHint(ev.category) ||
    ''
  ).trim();

  // --- Primary category (uses the improved function) ---
  const primaryCategory = inferPrimaryCategory({ ...ev, genre, musicGenres });

  // For non-music events, clear musicGenres to avoid noise
  // (e.g. a comedy show description mentioning "rock music" as context)
  const cleanedMusicGenres = primaryCategory === 'Music' ? musicGenres : [];

  const description =
    (ev.description || '').trim() ||
    (ev.shortDescription || '').trim() ||
    (ev.details || '').trim() ||
    '';

  let next = {
    ...ev,
    primaryCategory,
    ...(genre ? { genre } : {}),
    ...(description ? { description } : {}),
    ...(cleanedMusicGenres.length ? { musicGenres: cleanedMusicGenres } : {}),
  };

  // Remove musicGenres key entirely for non-music events to keep JSON clean
  if (primaryCategory !== 'Music') delete next.musicGenres;

  const date = deriveHumanEventDate(next);
  if (date) next.date = date;

  next = tryAttachPriceFromListingText(next);

  if (next.ticketPriceFrom != null && !next.ticketPriceLabel) {
    const cur = next.ticketCurrency || 'GBP';
    const sym = cur === 'GBP' ? '£' : `${cur} `;
    next.ticketPriceLabel =
      next.ticketPriceTo != null && next.ticketPriceTo !== next.ticketPriceFrom
        ? `${sym}${next.ticketPriceFrom}–${sym}${next.ticketPriceTo}`
        : `${sym}${next.ticketPriceFrom}`;
  }

  next = mergeHotlinkImagesIntoEvent(next, null);

  return next;
}

// ---------------------------------------------------------------------------
// Enrichment pipeline
// ---------------------------------------------------------------------------

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
        } catch { cache.set(url, null); }
        done++;
        if (done % 40 === 0 || done === uniqueUrls.length) {
          console.log(`  enriched ${done}/${uniqueUrls.length}`);
        }
      }
    } finally { await page.close(); }
  }

  await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, () => worker()));

  const WANT_MUSICBRAINZ = process.env.SCRAPE_MUSICBRAINZ === '1';
  const mbUserAgent = process.env.SCRAPE_MUSICBRAINZ_USER_AGENT || 'cardiff-gigs/1.0 (music genre enrichment)';
  const mbCacheByKey = new Map();
  const MUSICBRAINZ_CONCURRENCY = 3;

  const merged = new Array(allEvents.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: MUSICBRAINZ_CONCURRENCY }, async () => {
      while (i < allEvents.length) {
        const idx = i++;
        const ev = allEvents[idx];
        const en = ev.url ? cache.get(ev.url) : null;
        let out = mergeEnrichmentIntoEvent(ev, en);

        if (
          WANT_MUSICBRAINZ &&
          (!Array.isArray(out.musicGenres) || out.musicGenres.length === 0) &&
          en && Array.isArray(en.performerNames) && en.performerNames.length
        ) {
          let mergedGenres = Array.isArray(out.musicGenres) ? out.musicGenres : [];
          const names = en.performerNames.slice(0, 3);
          for (const n of names) {
            const genres = await fetchMusicBrainzGenresForArtistName(n, mbCacheByKey, mbUserAgent);
            mergedGenres = unionMusicGenres(mergedGenres, genres);
            if (mergedGenres.length >= 8) break;
          }
          if (mergedGenres.length) out.musicGenres = mergedGenres;
        }

        merged[idx] = finalizeEvent(out);
      }
    })
  );

  return merged;
}

// ---------------------------------------------------------------------------
// Venue scrapers
// ---------------------------------------------------------------------------

async function scrapeGlobe(context) {
  console.log('Scraping The Globe...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.globecardiff.co.uk/listings/', 'article.elementor-post');
  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('article.elementor-post')).map((item) => {
      let imageUrl = '';
      const img = item.querySelector('.elementor-post__thumbnail img, .elementor-post__card img, figure img, img[src], img[data-src], img[data-lazy-src]');
      if (img) {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
        if (raw && !raw.startsWith('data:')) {
          try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
        }
      }
      return {
        title: item.querySelector('h3.elementor-post__title a')?.innerText.trim() || '',
        details: item.querySelector('.elementor-post__excerpt p')?.innerText.trim() || '',
        url: item.querySelector('h3.elementor-post__title a')?.href || '',
        venue: 'The Globe Cardiff',
        scrapedAt: new Date().toISOString(),
        ...(imageUrl ? { imageUrl } : {}),
      };
    }).filter((e) => e.title);
  });
  await page.close();
  console.log(`  Globe: ${events.length} events`);
  return events;
}

async function scrapeWMC(context) {
  console.log('Scraping WMC...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.wmc.org.uk/en/whats-on/events', 'div.production-card');

  // Wait for Angular to compile the listing
  await page.waitForFunction(
    () => {
      const cards = document.querySelectorAll('div.production-card');
      if (cards.length === 0) return false;
      const title = cards[0].querySelector('h4.production-card__title');
      return title && !title.innerText.includes('{{');
    },
    { timeout: 15_000 }
  ).catch(() => {});

  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('div.production-card')).map((item) => {
      let imageUrl = '';
      const img = item.querySelector('img[src], img[data-src], img[data-lazy-src]');
      if (img) {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
        if (raw && !raw.startsWith('data:')) {
          try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
        }
      }
      const prefixEl = item.querySelector('p.production-card__prefix');
      const prefix = (!prefixEl || prefixEl.getAttribute('aria-hidden') === 'true')
        ? '' : prefixEl.innerText.trim();
      return {
        title:   item.querySelector('h4.production-card__title')?.innerText.trim() || '',
        date:    item.querySelector('p.production-card__date')?.innerText.trim() || '',
        url:     item.querySelector('a.production-card__link-overlay')?.href || '',
        venue:   'Wales Millennium Centre',
        scrapedAt: new Date().toISOString(),
        _prefix: prefix,
        ...(imageUrl ? { imageUrl } : {}),
      };
    }).filter((e) => e.title);
  });

  // Resolve sub-venues in Node scope where WMC_SUB_VENUES is defined
  for (const event of events) {
    const subVenue = wmcParseSubVenue(event._prefix);
    if (subVenue) event.subVenue = subVenue;
    delete event._prefix;
  }

  await page.close();
  console.log(`  WMC: ${events.length} events found, fetching availability...`);

  for (const event of events) {
    if (!event.url) continue;
    const computed = await wmcScrapeAvailability(context, event.url);
    if (computed) {
      event.availability         = computed.availability;
      event.availabilityRange    = computed.availabilityRange;
      event.availabilityEstimate = computed.availabilityEstimate;
      // Derive popularity from the availability + date + weekday we now have
      Object.assign(event, wmcComputePopularity(event));
    }
    
  }

  const withAvailability = events.filter((e) => e.availability).length;
  const withSubVenue     = events.filter((e) => e.subVenue).length;
  console.log(`  WMC: done. ${withAvailability}/${events.length} with availability, ${withSubVenue}/${events.length} with sub-venue.`);
  return events;
}

async function scrapeNewTheatre(context) {
  console.log('Scraping New Theatre...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://trafalgartickets.com/new-theatre-cardiff/en-GB/whats-on', 'body');
  await new Promise((r) => setTimeout(r, 2_000));

  // Dismiss cookie banner if present
  try {
    const cookieBtn = await page.$('button:has-text("Accept Cookies"), button:has-text("Allow Cookies"), button:has-text("Accept All")');
    if (cookieBtn && await cookieBtn.isVisible()) {
      await cookieBtn.click();
      await new Promise((r) => setTimeout(r, 1_000));
      console.log('  New Theatre: dismissed cookie banner');
    }
  } catch (_) {}

  // Click "Load more" repeatedly until it disappears
  let loadMoreClicks = 0;
  while (true) {
    try {
      const loadMoreBtn = await page.$('button:has-text("Load more")');
      if (!loadMoreBtn) break;
      const isVisible = await loadMoreBtn.isVisible();
      if (!isVisible) break;
      await loadMoreBtn.scrollIntoViewIfNeeded();
      await new Promise((r) => setTimeout(r, 500));
      await loadMoreBtn.click({ timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 1_500));
      loadMoreClicks++;
      if (loadMoreClicks > 20) break;
    } catch (_) {
      break; // button gone or unclickable — stop
    }
  }
  if (loadMoreClicks > 0) console.log(`  New Theatre: clicked Load More ${loadMoreClicks} times`);

  const domEvents = await page.evaluate(() => {
    const seen = new Set();
    const out = [];
    const anchors = [...document.querySelectorAll('a[href*="/new-theatre-cardiff/en-GB/event/"]')];
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const url = (href.startsWith('http') ? href : `https://trafalgartickets.com${href}`).split('?')[0];
      if (seen.has(url)) continue;
      const t = (a.innerText || '').replace(/\u00a0/g, ' ');
      const fromIdx = t.search(/\bfrom\s+£/i);
      const head = fromIdx >= 0 ? t.slice(0, fromIdx) : t;
      const ti = head.indexOf('###');
      let category = '';
      let title = '';
      if (ti >= 0) {
        category = head.slice(0, ti).replace(/\s+/g, ' ').trim();
        title = head.slice(ti + 3).replace(/\s+/g, ' ').trim();
      } else {
        title = a.querySelector('h2, h3, h4')?.innerText?.replace(/\s+/g, ' ').trim() || '';
      }
      const compact = head.replace(/\s+/g, ' ').trim();
      let date = '';
      const rangeM = compact.match(/\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+\d{1,2}\s*[-–]\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/i);
      if (rangeM) date = rangeM[1];
      if (!date) {
        const singleM = compact.match(/\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/i);
        if (singleM) date = singleM[1];
      }
      let ticketPriceFrom = null;
      let ticketPriceLabel = '';
      const pm = t.match(/from\s+£\s*([\d.]+)/i);
      if (pm) { ticketPriceFrom = Number(pm[1]); ticketPriceLabel = `from £${pm[1]}`; }
      if (!title || !date) continue;
      seen.add(url);
      let imageUrl = '';
      const imgEl = a.querySelector('img[src], img[data-src], img[data-lazy-src]');
      if (imgEl) {
        const raw = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || imgEl.getAttribute('data-lazy-src') || '';
        if (raw && !raw.startsWith('data:')) {
          try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
        }
      }
      const row = {
        title, date, url,
        venue: 'New Theatre Cardiff',
        scrapedAt: new Date().toISOString(),
      };
      if (imageUrl) row.imageUrl = imageUrl;
      if (category) row.category = category;
      if (ticketPriceFrom != null && !Number.isNaN(ticketPriceFrom)) {
        row.ticketPriceFrom = ticketPriceFrom;
        row.ticketCurrency = 'GBP';
        row.ticketPriceLabel = ticketPriceLabel;
      }
      out.push(row);
    }
    return out;
  });

  const html = await page.content();
  await page.close();

  const metaByGroupId = new Map();
  for (const match of html.matchAll(/\{\\?"eventGroupId\\?":\d+.*?\}/g)) {
    try {
      const obj = JSON.parse(match[0].replace(/\\"/g, '"').replace(/\\u0026/g, '&'));
      if (obj.eventGroupId == null || !obj.name) continue;
      const prev = metaByGroupId.get(obj.eventGroupId) || {};
      metaByGroupId.set(obj.eventGroupId, { ...prev, ...obj });
    } catch (_) {}
  }

  const slugToId = new Map();
  for (const [gid, obj] of metaByGroupId) {
    const slug = (obj.slugUrl || obj.urlSlug || '').toString();
    if (slug) slugToId.set(slug, gid);
  }

  function applyNewTheatreMeta(row, obj) {
    const cats = Array.isArray(obj.categories) ? obj.categories.filter(Boolean) : [];
    if (cats.length && !row.category) row.category = cats[0];
    if (cats.length > 1) row.subcategory = cats.slice(1).join('; ');
    if (obj.price != null && !Number.isNaN(Number(obj.price)) && row.ticketPriceFrom == null) {
      row.ticketPriceFrom = Number(obj.price);
      row.ticketCurrency = 'GBP';
      row.ticketPriceLabel = `from £${obj.price}`;
    }
    if (obj.subVenue) row.subVenue = obj.subVenue;
    if (obj.promoter) row.promoter = obj.promoter;
    if (cats.length === 1 && cats[0] && !row.genre) row.genre = cats[0];
    let metaImg = '';
    if (typeof obj.image === 'string' && obj.image.trim()) metaImg = obj.image.trim();
    else if (typeof obj.imageUrl === 'string' && obj.imageUrl.trim()) metaImg = obj.imageUrl.trim();
    else if (typeof obj.heroImage === 'string' && obj.heroImage.trim()) metaImg = obj.heroImage.trim();
    if (metaImg && !row.imageUrl) row.imageUrl = metaImg;
  }

  for (const row of domEvents) {
    const mid = row.url.match(/\/event\/(\d+)(?:\?|$)/);
    if (mid) { const o = metaByGroupId.get(Number(mid[1])); if (o) applyNewTheatreMeta(row, o); }
    const tail = row.url.split('/event/')[1];
    if (tail) {
      const slugKey = tail.split('?')[0];
      const gid = slugToId.get(slugKey);
      if (gid != null) { const o = metaByGroupId.get(gid); if (o) applyNewTheatreMeta(row, o); }
    }
    const byName = [...metaByGroupId.values()].find(
      (o) => o.name && row.title &&
        String(o.name).trim().toLowerCase() === String(row.title).trim().toLowerCase()
    );
    if (byName) applyNewTheatreMeta(row, byName);
  }

  console.log(`  New Theatre: ${domEvents.length} events`);
  return domEvents;
}

async function scrapeTramshed(context) {
  console.log('Scraping Tramshed...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.tramshedcardiff.com/', 'article.elementor-post');
  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('article.elementor-post')).map((item) => {
      let imageUrl = '';
      const img = item.querySelector('.elementor-post__thumbnail img, .elementor-post__card img, figure img, img[src], img[data-src], img[data-lazy-src]');
      if (img) {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
        if (raw && !raw.startsWith('data:')) {
          try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
        }
      }
      return {
        title: item.querySelector('h3.elementor-post__title a')?.innerText.trim() || '',
        details: item.querySelector('.elementor-post__excerpt p')?.innerText.trim() || '',
        url: item.querySelector('h3.elementor-post__title a')?.href || '',
        venue: 'Tramshed Cardiff',
        scrapedAt: new Date().toISOString(),
        ...(imageUrl ? { imageUrl } : {}),
      };
    }).filter((e) => e.title);
  });
  await page.close();
  console.log(`  Tramshed: ${events.length} events`);
  return events;
}

async function scrapeUtilitaArena(context) {
  console.log('Scraping Utilita Arena...');
  const page = await context.newPage();
  await gotoAndSettle(
    page,
    'https://www.livenation.co.uk/utilita-arena-cardiff-tickets-vdp3915',
    'li[data-testid="aedp-event"]'
  );
  await new Promise((r) => setTimeout(r, 2_000));

  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('li[data-testid="aedp-event"]')).map((item) => {
      const titleEl = item.querySelector('h4[data-testid="aedp-event-information-block-venuedetails"]');
      const timeEl = item.querySelector('time[datetime]');
      const timesEl = item.querySelector('p[data-testid="aedp-event-information-block-times"]');
      const supportEl = item.querySelector('p[data-testid="aedp-event-information-support-artists"]');
      const linkEl = item.querySelector('a');

      const title = titleEl?.innerText?.trim() || '';
      const datetime = timeEl?.getAttribute('datetime') || '';
      const times = timesEl?.innerText?.trim() || '';
      const support = supportEl?.innerText?.trim() || '';
      const href = linkEl?.getAttribute('href') || '';
      const url = href.startsWith('http') ? href : `https://www.livenation.co.uk${href}`;

      let imageUrl = '';
      const img = item.querySelector('img[src], img[data-src]');
      if (img) {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || '';
        if (raw && !raw.startsWith('data:')) {
          try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
        }
      }

      return {
        title,
        date: datetime,
        details: [times, support].filter(Boolean).join(' • '),
        url,
        venue: 'Utilita Arena Cardiff',
        scrapedAt: new Date().toISOString(),
        ...(imageUrl ? { imageUrl } : {}),
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

  // Slow incremental scroll to trigger lazy loading
  async function autoScroll() {
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 300;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 400);
      });
    });
  }

  let lastCount = 0;
  let unchangedRounds = 0;
  while (true) {
    await autoScroll();
    await new Promise(r => setTimeout(r, 3_000));
    const count = await page.evaluate(() =>
      document.querySelectorAll('li.fusion-layout-column').length
    );
    console.log(`  Depot scroll: events ${count}`);
    if (count === lastCount) {
      unchangedRounds++;
      if (unchangedRounds >= 3) break;
    } else {
      unchangedRounds = 0;
    }
    lastCount = count;
  }

  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('li.fusion-layout-column')).map((item) => {
      let imageUrl = '';
      const img = item.querySelector('.fusion-imageframe img, .fusion-featured-image img, img[src], img[data-src]');
      if (img) {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
        if (raw && !raw.startsWith('data:')) {
          try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
        }
      }
      return {
        title: item.querySelector('h2 a')?.innerText.trim() || '',
        date: item.querySelector('.fusion-text p')?.innerText.trim() || '',
        url: item.querySelector('a[href*="/event/"]')?.href || '',
        venue: 'Depot Cardiff',
        scrapedAt: new Date().toISOString(),
        ...(imageUrl ? { imageUrl } : {}),
      };
    }).filter((e) => e.title);
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
    return Array.from(document.querySelectorAll('div.event_item')).map((item) => {
      let imageUrl = '';
      const img = item.querySelector('img[src], img[data-src]');
      if (img) {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || '';
        if (raw && !raw.startsWith('data:')) {
          try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
        }
      }
      return {
        title: item.querySelector('a.msl_event_name')?.innerText.trim() || '',
        date: item.querySelector('dd.msl_event_time')?.innerText.trim() || '',
        location: item.querySelector('dd.msl_event_location')?.innerText.trim() || '',
        url: 'https://www.cardiffstudents.com' + (item.querySelector('a.msl_event_name')?.getAttribute('href') || ''),
        venue: 'Cardiff SU',
        scrapedAt: new Date().toISOString(),
        ...(imageUrl ? { imageUrl } : {}),
      };
    }).filter((e) => e.title);
  });
  await page.close();
  console.log(`  Cardiff SU: ${events.length} events`);
  return events;
}

async function scrapeTheGate(context) {
  console.log('Scraping The Gate...');

  const page = await context.newPage();

  await gotoAndSettle(
    page,
    'https://www.thegate.org.uk/whats-on',
    '.sqs-html-content'
  );

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
      const paras = Array.from(
        block.querySelectorAll('p:not(.sqsrte-large)')
      )
        .map(p => cleanText(p.innerText))
        .filter(t =>
          t &&
          !dateLike(t) &&
          t.length > 30
        );

      return paras.join(' ') || '';
    }

    function pickSupport(block) {
      const paras = Array.from(
        block.querySelectorAll('p.sqsrte-large')
      )
        .map(p => cleanText(p.innerText))
        .filter(t =>
          t &&
          !dateLike(t)
        );

      return paras.join(', ') || '';
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

      if (!feBlock || !feBlock.parentElement) {
        return {
          imageUrl: '',
          url: 'https://www.thegate.org.uk/whats-on'
        };
      }

      const siblings = Array.from(feBlock.parentElement.children);
      const idx = siblings.indexOf(feBlock);

      let imageUrl = '';
      let url = '';

      // Search FORWARD first
      for (let i = idx; i < siblings.length; i++) {

        const sib = siblings[i];

        // Stop at next event
        if (
          i !== idx &&
          isEventStartBlock(sib)
        ) {
          break;
        }

        // Find ticket URL
        if (!url) {
          const a = sib.querySelector(`
            a[href*="gigantic"],
            a[href*="ticketmaster"],
            a[href*="seetickets"],
            a[href*="eventbrite"]
          `);

          if (a?.href) {
            url = a.href;
          }
        }

        // Find image
        if (!imageUrl) {

          const img = sib.querySelector(
            'img[data-src], img[src]'
          );

          if (img) {

            const src =
              img.getAttribute('data-src') ||
              img.getAttribute('src') ||
              '';

            if (
              src &&
              !src.startsWith('data:')
            ) {
              imageUrl = src;
            }
          }

          // Background image fallback
          if (!imageUrl) {

            const bgEl = sib.querySelector(
              '[style*="background-image"]'
            );

            if (bgEl) {

              const style =
                bgEl.getAttribute('style') || '';

              const match = style.match(
                /background-image:\s*url\(["']?(.*?)["']?\)/
              );

              if (match?.[1]) {
                imageUrl = match[1];
              }
            }
          }
        }
      }

      // Fallback backward search
      if (!imageUrl || !url) {

        for (let i = idx - 1; i >= 0; i--) {

          const sib = siblings[i];

          // Stop at previous event
          if (isEventStartBlock(sib)) {
            break;
          }

          if (!url) {

            const a = sib.querySelector(`
              a[href*="gigantic"],
              a[href*="ticketmaster"],
              a[href*="seetickets"],
              a[href*="eventbrite"]
            `);

            if (a?.href) {
              url = a.href;
            }
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

              if (
                src &&
                !src.startsWith('data:')
              ) {
                imageUrl = src;
              }
            }
          }
        }
      }

      return {
        imageUrl,
        url: url || 'https://www.thegate.org.uk/whats-on'
      };
    }

    return Array.from(
      document.querySelectorAll('.sqs-html-content')
    )
      .map(block => {

        const title = cleanText(
          block.querySelector('h2, h3, h4')?.innerText
        );

        const date = pickDate(block);

        if (!title || !date) {
          return null;
        }

        const description = pickDescription(block);

        const support = pickSupport(block);

        const {
          imageUrl,
          url
        } = findAssociatedData(block);

        return {
          title,
          date,

          ...(description
            ? { description }
            : {}),

          ...(support
            ? { support }
            : {}),

          ...(imageUrl
            ? { imageUrl }
            : {}),

          url,

          venue: 'The Gate Cardiff',

          scrapedAt: new Date().toISOString(),
        };
      })
      .filter(e => e && e.title && e.date);
  });

  await page.close();

  console.log(`  The Gate: ${events.length} events`);

  return events;
}

async function scrapeFuel(context) {
  console.log('Scraping Fuel Rock Club...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.fuelrockclub.co.uk/events/', 'iframe[src*="sociablekit"]');

  // Wait for the SociableKit iframe to load
  const iframeElement = await page.$('iframe[src*="sociablekit"]');
  if (!iframeElement) {
    console.log('  Fuel: SociableKit iframe not found');
    await page.close();
    return [];
  }

  const frame = await iframeElement.contentFrame();
  if (!frame) {
    console.log('  Fuel: could not access iframe content');
    await page.close();
    return [];
  }

  await frame.waitForSelector('.sk-event-item', { timeout: 20_000 });
  await new Promise(r => setTimeout(r, 3_000));

  const events = await frame.evaluate(() => {
    function cleanText(t) {
      return t?.replace(/\s+/g, ' ').trim() || '';
    }

    return Array.from(document.querySelectorAll('.sk-event-item')).map(item => {
      const title = cleanText(item.querySelector('.sk-event-item-title')?.innerText);
      const url =
        item.querySelector('.sk-event-item-fb-link')?.href ||
        item.querySelector('.sk-event-item-gettickets')?.href ||
        '';
      const rawImage = item.querySelector('img')?.getAttribute('src') || '';
      const timeEl = item.querySelector('.sk-event-item-date time');
      const rawDate = cleanText(timeEl?.innerText);
      const isoDate = timeEl?.getAttribute('datetime') || '';

      return {
        title,
        date: rawDate,
        eventStartDate: isoDate,
        url,
        imageUrl: rawImage && !rawImage.startsWith('data:') ? rawImage : '',
        venue: 'Fuel Rock Club',
        scrapedAt: new Date().toISOString(),
      };
    }).filter(e => e.title && e.url);
  });

  await page.close();
  console.log(`  Fuel: ${events.length} events`);
  return events;
}

async function scrapePrincipality(context) {
  console.log('Scraping Principality Stadium...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.principalitystadium.wales/events-and-ticket-information/', 'div.event-aggregator-item');
  await new Promise(r => setTimeout(r, 2_000));

  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('div.event-aggregator-item')).map(item => {
      const titleEl = item.querySelector('.event-item-title h4 a');
      const dateEl = item.querySelector('.event-item-info span');
      const descEl = item.querySelector('.event-item-desc p');
      const linkEl = item.querySelector('a.event-item-link');
      const img = item.querySelector('img.sotic_images');
      const raw = img?.getAttribute('src') || '';
      const cats = Array.from(item.querySelectorAll('.event-item-category li a'))
        .map(a => a.innerText.trim()).join(', ');
      return {
        title: titleEl?.innerText.trim() || '',
        date: dateEl?.innerText.trim() || '',
        description: descEl?.innerText.trim() || '',
        category: cats,
        url: linkEl?.href || titleEl?.href || '',
        imageUrl: raw && !raw.startsWith('data:') ? raw : '',
        venue: 'Principality Stadium',
        scrapedAt: new Date().toISOString(),
      };
    }).filter(e => e.title);
  });

  await page.close();
  console.log(`  Principality: ${events.length} events`);
  return events;
}

async function scrapeSherman(context) {
  console.log('Scraping Sherman Theatre...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.shermantheatre.co.uk/whats-on/', 'div.card-event');
  await new Promise(r => setTimeout(r, 2_000));

  // Click "Show More" until it disappears
  let clicks = 0;
  while (true) {
    try {
      const btn = await page.$('a.load-more');
      if (!btn || !(await btn.isVisible())) break;
      await btn.scrollIntoViewIfNeeded();
      await new Promise(r => setTimeout(r, 500));
      await btn.click({ timeout: 10_000 });
      await new Promise(r => setTimeout(r, 1_500));
      clicks++;
      if (clicks > 20) break;
    } catch (_) { break; }
  }
  if (clicks > 0) console.log(`  Sherman: clicked Show More ${clicks} times`);

  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('div.card-event')).map(item => {
      const titleEl = item.querySelector('h3.card-title');
      const dateEl = item.querySelector('span.date');
      const descEl = item.querySelector('.card-description');
      const catEl = item.querySelector('.item-categories span');
      const linkEl = item.querySelector('a.card-link');
      const imgEl = item.querySelector('div.card-image[data-src]');
      const raw = imgEl?.getAttribute('data-src') || '';
      return {
        title: titleEl?.innerText.trim() || '',
        date: dateEl?.innerText.trim() || '',
        description: descEl?.innerText.trim() || '',
        category: catEl?.innerText.trim() || '',
        url: linkEl?.href || '',
        imageUrl: raw && !raw.startsWith('data:') ? raw : '',
        venue: 'Sherman Theatre',
        scrapedAt: new Date().toISOString(),
      };
    }).filter(e => e.title);
  });

  await page.close();
  console.log(`  Sherman: ${events.length} events`);
  return events;
}

async function scrapeCanopi(context) {
  console.log('Scraping Canopi...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.thecanopi.org/events', 'article.eventlist-event');
  await new Promise(r => setTimeout(r, 2_000));

  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('article.eventlist-event')).filter(item => {
      // Exclude past events
      return !item.classList.contains('eventlist-event--past');
    }).map(item => {
      const titleEl = item.querySelector('h1.eventlist-title a, h2.eventlist-title a');
      const dateEl = item.querySelector('time.event-date');
      const excerptEl = item.querySelector('.eventlist-excerpt');
      const img = item.querySelector('img[data-src], img[src]');
      const raw = img?.getAttribute('data-src') || img?.getAttribute('src') || '';
      return {
        title: titleEl?.innerText.trim() || '',
        date: dateEl?.getAttribute('datetime') || dateEl?.innerText.trim() || '',
        description: excerptEl?.innerText.trim() || '',
        url: titleEl?.href || '',
        imageUrl: raw && !raw.startsWith('data:') ? raw : '',
        venue: 'Canopi Cardiff',
        scrapedAt: new Date().toISOString(),
      };
    }).filter(e => e.title);
  });

  await page.close();
  console.log(`  Canopi: ${events.length} events`);
  return events;
}

async function scrapeClwb(context) {
  console.log('Scraping Clwb Ifor Bach...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://clwb.net/whats-on/', '#eventsListings li.grid-item');
  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#eventsListings li.grid-item')).map((item) => {
      let imageUrl = '';
      const img = item.querySelector('figure img, .grid-item-image img, img[src], img[data-src]');
      if (img) {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
        if (raw && !raw.startsWith('data:')) {
          try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
        }
      }
      return {
        title: item.querySelector('h3.grid-item-title')?.innerText.trim() || '',
        date: item.querySelector('p.grid-item-support.date-translate, p.date-translate')?.innerText.trim() || '',
        details: Array.from(item.querySelectorAll('p.grid-item-support:not(.date-translate)'))
          .map((p) => p.innerText.trim()).join(' • '),
        url:
          item.querySelector('a.tickets-button, a[href*="seetickets"], a[href*="fatsoma"], figure a, .grid-item-image a')?.href ||
          item.querySelector('a[href^="http"]')?.href || '',
        venue: 'Clwb Ifor Bach',
        scrapedAt: new Date().toISOString(),
        ...(imageUrl ? { imageUrl } : {}),
      };
    }).filter((e) => e.title);
  });
  await page.close();
  console.log(`  Clwb: ${events.length} events`);
  return events;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function normalizeUrlForDedupe(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    u.hash = '';
    u.search = '';
    const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.hostname.toLowerCase()}${path}`.toLowerCase();
  } catch { return s.split('?')[0].split('#')[0].replace(/\/+$/, '').trim().toLowerCase(); }
}

function normalizeTitleForDedupe(t) {
  return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const GENERIC_LISTING_URLS = new Set([
  normalizeUrlForDedupe('https://www.thegate.org.uk/whats-on'),
]);

function eventDedupeKey(ev) {
  const url = typeof ev.url === 'string' ? ev.url.trim() : '';
  const nu = normalizeUrlForDedupe(url);
  if (nu && /^https?:\/\//i.test(url) && !GENERIC_LISTING_URLS.has(nu)) return `url:${nu}`;
  const title = normalizeTitleForDedupe(ev.title);
  const date = String(ev.date || ev.eventStartDate || '').trim().toLowerCase();
  const venue = String(ev.venue || '').trim().toLowerCase();
  return `meta:${title}|${date}|${venue}`;
}

function dedupeEventsPreservingOrder(events) {
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const ev of events) {
    const k = eventDedupeKey(ev);
    if (seen.has(k)) { dropped++; continue; }
    seen.add(k);
    out.push(ev);
  }
  return { events: out, dropped };
}

function findDuplicateEventGroups(events) {
  if (!Array.isArray(events)) return [];
  const map = new Map();
  for (let i = 0; i < events.length; i++) {
    const k = eventDedupeKey(events[i]);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  }
  return [...map.entries()].filter(([, idxs]) => idxs.length > 1).map(([key, indices]) => ({ key, indices }));
}

function summarizeEventLine(ev, index) {
  const bits = [
    typeof index === 'number' ? `[${index}]` : '',
    (ev.title || '(no title)').slice(0, 80),
    ev.date ? `— ${String(ev.date).slice(0, 60)}` : '',
    ev.venue ? `@ ${ev.venue}` : '',
    ev.url ? `<${String(ev.url).slice(0, 90)}${String(ev.url).length > 90 ? '…' : ''}>` : '',
  ];
  return bits.filter(Boolean).join(' ');
}

function printDuplicateReview(events) {
  const groups = findDuplicateEventGroups(events);
  if (!groups.length) {
    console.log(`No duplicates among ${events.length} events.`);
    return { groups: [], redundant: 0 };
  }
  let redundant = 0;
  console.log(`\nDuplicate review: ${groups.length} group(s) among ${events.length} events\n`);
  for (let g = 0; g < groups.length; g++) {
    const { key, indices } = groups[g];
    redundant += indices.length - 1;
    console.log(`--- Group ${g + 1} (${indices.length} rows) ${key.slice(0, 120)}`);
    for (const i of indices) console.log(`  ${summarizeEventLine(events[i], i)}`);
    console.log('');
  }
  console.log(`Summary: ${redundant} redundant row(s) could be dropped.`);
  return { groups, redundant };
}

// ---------------------------------------------------------------------------
// Main scrape orchestration
// ---------------------------------------------------------------------------

async function scrapeAll() {
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1365, height: 900 },
  });

  async function safeScrap(fn, name, retries = 2) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try { return await fn(); } catch (e) {
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
    ...await safeScrap(() => scrapeFuel(context), 'Fuel'),
    ...await safeScrap(() => scrapePrincipality(context), 'Principality'),
    ...await safeScrap(() => scrapeSherman(context), 'Sherman'),
    ...await safeScrap(() => scrapeCanopi(context), 'Canopi'),
  ];

  allEvents = await enrichAllEvents(context, allEvents);

  await browser.close();

  const { events: deduped, dropped } = dedupeEventsPreservingOrder(allEvents);
  if (dropped > 0) console.log(`\nRemoved ${dropped} duplicate event row(s).`);

  // Preserve original scrapedAt for events we've seen before
  let previousEvents = [];
  if (fs.existsSync('events.json')) {
    try {
      previousEvents = JSON.parse(fs.readFileSync('events.json', 'utf8'));
    } catch (_) {}
  }

  // Build a lookup of previous scrapedAt by dedupe key
  const previousScrapedAt = new Map();
  for (const ev of previousEvents) {
    const k = eventDedupeKey(ev);
    if (ev.scrapedAt && !previousScrapedAt.has(k)) {
      previousScrapedAt.set(k, ev.scrapedAt);
    }
  }

  // Apply: keep old scrapedAt if event existed before, otherwise it's new
  const now = new Date().toISOString();
  let newCount = 0;
  const final = deduped.map(ev => {
    const k = eventDedupeKey(ev);
    const existing = previousScrapedAt.get(k);
    if (existing) {
      return { ...ev, scrapedAt: existing };
    } else {
      newCount++;
      return { ...ev, scrapedAt: now };
    }
  });

  if (newCount > 0) console.log(`\n${newCount} new event(s) detected since last scrape`);

  fs.writeFileSync('events.json', JSON.stringify(final, null, 2));
  console.log(`Total: ${final.length} events saved to events.json`);
}

// ---------------------------------------------------------------------------
// CLI entry points
// ---------------------------------------------------------------------------

if (require.main === module && process.argv.includes('--dates-only')) {
  const list = JSON.parse(fs.readFileSync('events.json', 'utf8'));
  const out = list.map((ev) => finalizeEvent(ev));
  fs.writeFileSync('events.json', JSON.stringify(out, null, 2));
  const missing = out.filter((e) => !e.date || !String(e.date).trim()).length;
  console.log(`--dates-only: wrote ${out.length} events (${missing} still missing date)`);
} else if (require.main === module && process.argv.includes('--review-duplicates')) {
  const list = JSON.parse(fs.readFileSync('events.json', 'utf8'));
  if (!Array.isArray(list)) { console.error('events.json must be a JSON array.'); process.exit(1); }
  printDuplicateReview(list);
  if (process.argv.includes('--strict') && findDuplicateEventGroups(list).length) process.exit(1);
} else if (require.main === module && process.argv.includes('--dedupe-events')) {
  const list = JSON.parse(fs.readFileSync('events.json', 'utf8'));
  if (!Array.isArray(list)) { console.error('events.json must be a JSON array.'); process.exit(1); }
  const finalized = list.map((ev) => finalizeEvent(ev));
  printDuplicateReview(finalized);
  const { events: deduped, dropped } = dedupeEventsPreservingOrder(finalized);
  if (dropped > 0) {
    fs.writeFileSync('events.json', JSON.stringify(deduped, null, 2));
    console.log(`\n--dedupe-events: wrote ${deduped.length} events (removed ${dropped}).`);
  } else {
    console.log('\n--dedupe-events: nothing to remove.');
  }
} else if (require.main === module && process.argv.includes('--music-genre-stats')) {
  const list = JSON.parse(fs.readFileSync('events.json', 'utf8'));
  if (!Array.isArray(list)) { console.error('events.json must be a JSON array.'); process.exit(1); }
  const total = list.length;
  const musicGenresFilled = list.filter((e) => Array.isArray(e.musicGenres) && e.musicGenres.length > 0).length;
  const genreFilled = list.filter((e) => typeof e.genre === 'string' && e.genre.trim()).length;
  console.log(`--music-genre-stats`);
  console.log(`  total events: ${total}`);
  console.log(`  musicGenres filled: ${musicGenresFilled} (${total ? Math.round((musicGenresFilled / total) * 100) : 0}%)`);
  console.log(`  genre filled: ${genreFilled}`);
} else if (require.main === module) {
  scrapeAll().catch(console.error);
}