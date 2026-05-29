const fs = require("fs");
const path = require("path");

const EVENTS_FILE = path.join(__dirname, "events.json");
const COMEDIANS_FILE = path.join(__dirname, "comedians.json");
const REVIEW_FILE = path.join(__dirname, "comedian-review.json");

const REQUEST_DELAY = 2500;
const RETRY_LOW_CONFIDENCE = true;
const MIN_CONFIDENCE_TO_KEEP = 75;

const KNOWN_ALIASES = {
  "the eternal shame of sue perkins": "Sue Perkins",
  "beefy’s big weekender": null,
  "beefy's big weekender": null,
  "beefy’s comedy club": null,
  "beefy's comedy club": null,
  "piff & pop's magic shoppe": "Piff the Magic Dragon",
  "piff & pop’s magic shoppe": "Piff the Magic Dragon",
};

const IGNORE_TITLES = [
  "cowboys comedy",
  "the last laugh",
  "legend",
  "thespians",
  "beauty and the beast",
  "that'll be the day",
  "a christmas carol goes wrong",
  "kitsch & sync",
  "immersive cabaret",
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function normalize(str = "") {
  return str
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseName(str = "") {
  return str
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

function looksLikeComedyEvent(event) {
  const text = normalize([
    event.title,
    event.category,
    event.genre,
    event.description,
    event.shortDescription,
  ].filter(Boolean).join(" "));

  return [
    "comedy",
    "comedian",
    "stand-up",
    "stand up",
    "comic",
    "panel show",
    "magic",
    "cabaret",
  ].some(word => text.includes(word));
}

function extractNameCandidates(event) {
  const candidates = new Set();

  const title = event.title || "";
  const lowerTitle = normalize(title);

  if (IGNORE_TITLES.some(t => lowerTitle.includes(t))) {
    return [];
  }

  if (KNOWN_ALIASES[lowerTitle]) {
    candidates.add(KNOWN_ALIASES[lowerTitle]);
  }

  // Beefy's Big Weekender: Jason Manford
  // Beefy's Comedy Club: Guz Khan
  const beefyMatch = title.match(/Beefy[’']s (?:Big Weekender|Comedy Club):\s*(.+)$/i);
  if (beefyMatch) {
    candidates.add(cleanName(beefyMatch[1]));
  }

  // Standard title formats
  let cleanTitle = cleanName(title);
  if (cleanTitle) candidates.add(cleanTitle);

  const text = [
    event.shortDescription || "",
    event.description || "",
  ].join(" ");

  // Named-person style phrases from descriptions
  const descriptionPatterns = [
    /(?:comedian|comic|magician|performer|star|host|actor|writer)\s+([A-Z][A-Za-z’'&.-]+(?:\s+[A-Z][A-Za-z’'&.-]+){1,3})/g,
    /([A-Z][A-Za-z’'&.-]+(?:\s+[A-Z][A-Za-z’'&.-]+){1,3}),?\s+(?:comedian|comic|magician|performer|star|host|actor|writer)/g,
    /(?:featuring|starring|with|from)\s+([A-Z][A-Za-z’'&.-]+(?:\s+[A-Z][A-Za-z’'&.-]+){1,3})/g,
    /known as\s+([A-Z][A-Za-z’'&.-]+(?:\s+[A-Z][A-Za-z’'&.-]+){1,4})/g,
    /\(([A-Z][A-Za-z’'&.-]+(?:\s+[A-Z][A-Za-z’'&.-]+){1,3})\)/g,
  ];

  for (const pattern of descriptionPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const name = cleanName(match[1]);
      if (name) candidates.add(name);
    }
  }

  // Specific useful edge cases
  if (/Penn Jillette/i.test(text)) candidates.add("Penn Jillette");
  if (/Piff the Magic Dragon/i.test(text)) candidates.add("Piff the Magic Dragon");
  if (/John van der Put/i.test(text)) candidates.add("John van der Put");

  return [...candidates]
    .filter(Boolean)
    .filter(name => name.length > 3)
    .filter(name => !isBadCandidate(name));
}

function cleanName(name = "") {
  let result = name.trim();

  result = result.replace(/\(.*?\)/g, "");
  result = result.replace(/\[.*?\]/g, "");
  result = result.replace(/\.\.\.$/, "");
  result = result.replace(/:+$/, "");

  const splitters = [
    " With Special Guests",
    " with Special Guests",
    " plus ",
    " Plus ",
    " featuring ",
    " Featuring ",
    " presents ",
    " Presents ",
    " - ",
    " – ",
    " — ",
    " | ",
  ];

  for (const splitter of splitters) {
    if (result.includes(splitter)) {
      result = result.split(splitter)[0].trim();
    }
  }

  // Do NOT split Beefy's titles before special handling
  if (!/Beefy[’']s/i.test(result) && result.includes(":")) {
    result = result.split(":")[0].trim();
  }

  return result.trim();
}

function isBadCandidate(name) {
  const n = normalize(name);

  const bad = [
    "book your",
    "new theatre",
    "cardiff",
    "main auditorium",
    "official trafalgar",
    "america's got talent",
    "world-renowned duo",
    "side-splitting comedy",
    "jaw-dropping magic",
    "mr piffles",
    "act one",
    "act two",
    "these shows",
    "their brand-new",
  ];

  return bad.some(x => n.includes(x));
}

async function fetchWithRetry(url, retries = 4) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "CardiffEventsComedianRanker/1.0 (local script)",
      },
    });

    if (response.status === 429) {
      const wait = attempt * 10000;
      console.log(`Rate limited. Waiting ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }

    return response;
  }

  throw new Error("Too many 429 responses");
}

function wikipediaUrlFromTitle(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

async function wikipediaSummary(title) {
  const slug = encodeURIComponent(title.replace(/ /g, "_"));
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`;

  const response = await fetchWithRetry(url);

  if (!response.ok) return null;

  const data = await response.json();

  if (data.type === "https://mediawiki.org/wiki/HyperSwitch/errors/not_found") {
    return null;
  }

  return {
    title: data.title,
    extract: data.extract || "",
    description: data.description || "",
    url: data.content_urls?.desktop?.page || wikipediaUrlFromTitle(data.title),
    source: "direct",
  };
}

async function wikipediaSearch(query) {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;

  const response = await fetchWithRetry(url);

  if (!response.ok) return [];

  const data = await response.json();
  return data?.query?.search || [];
}

async function findWikipediaPage(name) {
  const directAttempts = [
    name,
    name.replace(/’/g, "'"),
    name.replace(/:/g, ""),
    `${name} (comedian)`,
    `${name} (actor)`,
  ];

  for (const attempt of directAttempts) {
    const page = await wikipediaSummary(attempt);
    if (page) return page;
    await sleep(500);
  }

  const searches = [
    name,
    `${name} comedian`,
    `${name} stand-up comedian`,
    `${name} actor comedian`,
    `${name} comedy`,
  ];

  for (const query of searches) {
    const results = await wikipediaSearch(query);

    if (!results.length) {
      await sleep(500);
      continue;
    }

    const best = results[0];

    return {
      title: best.title,
      extract: stripHtml(best.snippet || ""),
      pageSize: best.size || 0,
      url: wikipediaUrlFromTitle(best.title),
      source: "search",
    };
  }

  return null;
}

function stripHtml(str = "") {
  return str.replace(/<[^>]*>/g, "");
}

function calculateConfidence(inputName, page) {
  if (!page) return 0;

  const input = normalize(inputName);
  const title = normalize(page.title || "");
  const text = normalize(`${page.title || ""} ${page.description || ""} ${page.extract || ""}`);

  let confidence = 20;

  if (title === input) confidence += 55;
  else if (title.includes(input) || input.includes(title)) confidence += 35;

  if (text.includes("comedian")) confidence += 15;
  if (text.includes("stand-up") || text.includes("stand up")) confidence += 10;
  if (text.includes("actor") || text.includes("writer") || text.includes("presenter")) confidence += 5;
  if (page.source === "direct") confidence += 10;

  // Penalise obvious ambiguous/non-comedy matches
  if (
    !text.includes("comedian") &&
    !text.includes("comedy") &&
    !text.includes("stand-up") &&
    !text.includes("stand up") &&
    !text.includes("magician")
  ) {
    confidence -= 25;
  }

  return Math.max(0, Math.min(100, confidence));
}

function calculatePopularity(page, confidence) {
  if (!page) return 10;

  let score = 30;

  const text = normalize(`${page.description || ""} ${page.extract || ""}`);
  const size = page.pageSize || text.length;

  if (size > 300) score += 5;
  if (size > 800) score += 5;
  if (size > 1500) score += 5;
  if (size > 3000) score += 5;
  if (size > 8000) score += 5;

  const keywords = [
    "bbc",
    "channel 4",
    "netflix",
    "award",
    "bafta",
    "taskmaster",
    "panel show",
    "stand-up",
    "tour",
    "television",
    "radio",
    "live at the apollo",
    "have i got news for you",
    "mock the week",
    "8 out of 10 cats",
  ];

  for (const keyword of keywords) {
    if (text.includes(keyword)) score += 3;
  }

  if (confidence < 60) score -= 15;
  if (confidence < 40) score -= 20;

  return Math.max(10, Math.min(100, Math.round(score)));
}

function scoreToTier(score) {
  if (score >= 85) return "S";
  if (score >= 70) return "A";
  if (score >= 55) return "B";
  if (score >= 40) return "C";
  return "D";
}

function shouldRetryExisting(entry) {
  if (!entry) return true;
  if (entry.status === "failed") return true;
  if (entry.status === "uncertain") return true;
  if (RETRY_LOW_CONFIDENCE && (entry.confidence || 0) < MIN_CONFIDENCE_TO_KEEP) return true;
  return false;
}

async function processCandidate(name, sourceEvent) {
  const page = await findWikipediaPage(name);
  const confidence = calculateConfidence(name, page);
  const popularityScore = calculatePopularity(page, confidence);

  const status =
    !page ? "failed" :
    confidence >= MIN_CONFIDENCE_TO_KEEP ? "success" :
    "uncertain";

  return {
    name,
    matchedTitle: page?.title || null,
    wikipedia: Boolean(page),
    wikipediaUrl: page?.url || null,
    popularityScore,
    tier: scoreToTier(popularityScore),
    confidence,
    status,
    source: page?.source || null,
    sourceEventTitle: sourceEvent?.title || null,
    lastUpdated: new Date().toISOString(),
  };
}

async function main() {
  const events = loadJson(EVENTS_FILE, []);
  const cache = loadJson(COMEDIANS_FILE, {});
  const review = [];

  const candidates = new Map();

  for (const event of events) {
    if (!looksLikeComedyEvent(event)) continue;

    const names = extractNameCandidates(event);

    for (const name of names) {
      const key = normalize(name);

      if (!candidates.has(key)) {
        candidates.set(key, {
          name,
          event,
        });
      }
    }
  }

  console.log(`Found ${candidates.size} comedian candidates`);

  for (const [key, candidate] of candidates) {
    const existing = cache[key];

    if (!shouldRetryExisting(existing)) {
      console.log(`Using cached: ${candidate.name}`);
      continue;
    }

    console.log(`Looking up ${candidate.name}...`);

    try {
      const result = await processCandidate(candidate.name, candidate.event);
      cache[key] = result;

      console.log(
        `${candidate.name} → score=${result.popularityScore}, confidence=${result.confidence}, status=${result.status}`
      );

      if (result.status !== "success") {
        review.push(result);
      }

      saveJson(COMEDIANS_FILE, cache);
      await sleep(REQUEST_DELAY);
    } catch (err) {
      console.error(`${candidate.name}: ${err.message}`);

      cache[key] = {
        name: candidate.name,
        matchedTitle: null,
        wikipedia: false,
        wikipediaUrl: null,
        popularityScore: 10,
        tier: "D",
        confidence: 0,
        status: "failed",
        error: err.message,
        sourceEventTitle: candidate.event?.title || null,
        lastUpdated: new Date().toISOString(),
      };

      review.push(cache[key]);
      saveJson(COMEDIANS_FILE, cache);

      await sleep(REQUEST_DELAY);
    }
  }

  const reviewItems = Object.values(cache)
    .filter(item => item.status !== "success" || (item.confidence || 0) < MIN_CONFIDENCE_TO_KEEP)
    .sort((a, b) => (a.confidence || 0) - (b.confidence || 0));

  saveJson(COMEDIANS_FILE, cache);
  saveJson(REVIEW_FILE, reviewItems);

  console.log(`Saved ${Object.keys(cache).length} comedians to comedians.json`);
  console.log(`Saved ${reviewItems.length} review items to comedian-review.json`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});