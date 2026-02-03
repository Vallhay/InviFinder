/**
 * fetch.js — MTG Card Tracker data refresher
 *
 * Reads config.json → fetches each Moxfield source → writes data/cards.json
 * Runs inside GitHub Actions (no CORS issues, plain https).
 *
 * Phone numbers come from GitHub Secrets as env vars.
 * The secret names are listed in config.json → phoneSecretNames.
 *
 * Usage:  node fetch.js
 * Output: data/cards.json
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ═══════════════════════════════════════════════════════════════════════════
//  ⚙️ CONFIG — paste your Cloudflare Worker URL here
// ═══════════════════════════════════════════════════════════════════════════
const WORKER_URL = 'https://moxfield-proxy.faguaz.workers.dev';
// Example: 'https://moxfield-proxy.workers.dev'
//
// Deploy the worker.js file to Cloudflare Workers (free), then paste the URL here.
// ═══════════════════════════════════════════════════════════════════════════

// ─── helpers ────────────────────────────────────────────────────────────────

/** Fetch via the Cloudflare Worker proxy */
async function fetchViaCF(targetUrl) {
  const workerCall = `${WORKER_URL}?url=${encodeURIComponent(targetUrl)}`;
  return await httpGet(workerCall);
}

/** Simple GET that returns parsed JSON. */
function httpGet(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https:') ? https : http;
    protocol.get(url, { headers: { 'User-Agent': 'MTG-Card-Tracker-Fetcher/1.0' } }, (res) => {
      if (res.statusCode === 429 || res.statusCode >= 500) {
        // rate-limited or server error — wait and retry
        if (retries > 0) {
          const wait = res.statusCode === 429 ? 5000 : 2000;
          console.log(`  ↻ HTTP ${res.statusCode}, retrying in ${wait / 1000}s…`);
          setTimeout(() => httpGet(url, retries - 1).then(resolve).catch(reject), wait);
          res.resume(); // discard body
          return;
        }
        reject(new Error(`HTTP ${res.statusCode} after all retries`));
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end',  () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Bad JSON from ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

/** Sleep helper for rate-limiting politeness. */
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Moxfield fetchers ──────────────────────────────────────────────────────

const MOX_API = 'https://api2.moxfield.com';

/**
 * Fetch a single DECK.
 * GET /v2/decks/all/{id}  →  { mainboard: { "Name": { quantity } }, sideboard, … }
 */
async function fetchDeck(id) {
  console.log(`  GET deck ${id}`);
  const data = await fetchViaCF(`${MOX_API}/v2/decks/all/${id}`);

  const cards = [];
  const sections = ['mainboard', 'sideboard', 'commanders', 'considering', 'maybeboard'];
  for (const sec of sections) {
    const obj = data[sec];
    if (!obj || typeof obj !== 'object') continue;
    for (const [name, details] of Object.entries(obj)) {
      cards.push({ name: name.trim(), qty: details?.quantity ?? 1 });
    }
  }
  console.log(`  ✓ deck  → ${cards.length} cards`);
  return cards;
}

/**
 * Fetch a COLLECTION (paginated).
 * GET /v1/collections/search/{id}?pageNumber=N&pageSize=50&sortType=cardName&sortDirection=ascending
 * Response: { totalPages, data: [ { quantity, card: { name } } ] }
 */
async function fetchCollection(id) {
  let allCards   = [];
  let page       = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${MOX_API}/v1/collections/search/${id}`
      + `?sortType=cardName&sortDirection=ascending&pageNumber=${page}&pageSize=50`;

    console.log(`  GET collection page ${page}/${totalPages}`);
    const data = await fetchViaCF(url);

    if (page === 1) totalPages = data.totalPages || 1;

    if (Array.isArray(data.data)) {
      for (const item of data.data) {
        const name = item?.card?.name;
        const qty  = item?.quantity ?? 1;
        if (name) allCards.push({ name: name.trim(), qty });
      }
    }

    page++;
    // be polite to Moxfield — small delay between pages
    if (page <= totalPages) await sleep(300);
  }

  console.log(`  ✓ collection → ${allCards.length} cards`);
  return allCards;
}

// ─── URL parser (same logic as the frontend) ────────────────────────────────

function parseMoxfieldUrl(url) {
  const deckMatch = url.match(/\/decks\/([A-Za-z0-9_\-]+)/);
  if (deckMatch) return { type: 'deck', id: deckMatch[1] };

  const collMatch = url.match(/\/collection\/([A-Za-z0-9_\-]+)/);
  if (collMatch) return { type: 'collection', id: collMatch[1] };

  return null;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  // ── 1. read config ──
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

  // ── 2. fetch every source ──
  // Output structure:
  //   {
  //     "lastUpdated": "2026-02-03T06:00:00Z",
  //     "owners": [
  //       { "name": "Vallhay", "phone": "+54 …", "cardCount": 3063 },
  //       …
  //     ],
  //     "cards": {
  //       "lightning bolt": { "name": "Lightning Bolt", "owners": { "Vallhay": 4, "Friend1": 2 } },
  //       …
  //     }
  //   }

  const ownersMap = {};   // owner → { name, phone, cardCount }
  const cardsMap  = {};   // lowerName → { name, owners: { ownerName: qty } }

  for (const src of config.sources) {
    console.log(`\nProcessing: ${src.owner} (${src.type})`);

    const parsed = parseMoxfieldUrl(src.url);
    if (!parsed) {
      console.error(`  ✗ Could not parse URL: ${src.url}`);
      continue;
    }

    let cards;
    try {
      cards = parsed.type === 'deck'
        ? await fetchDeck(parsed.id)
        : await fetchCollection(parsed.id);
    } catch (e) {
      console.error(`  ✗ Failed to fetch: ${e.message}`);
      continue;
    }

    // register owner
    if (!ownersMap[src.owner]) {
      // pull phone from env secret (name defined in config)
      const secretKey = config.phoneSecretNames?.[src.owner];
      const phone     = secretKey ? (process.env[secretKey] || '') : '';
      ownersMap[src.owner] = { name: src.owner, phone, cardCount: 0 };
    }
    ownersMap[src.owner].cardCount += cards.length;

    // merge cards
    for (const { name, qty } of cards) {
      const key = name.toLowerCase();
      if (!cardsMap[key]) cardsMap[key] = { name, owners: {} };
      cardsMap[key].owners[src.owner] = (cardsMap[key].owners[src.owner] || 0) + qty;
    }

    // small pause between sources
    await sleep(1000);
  }

  // ── 3. write output ──
  const output = {
    lastUpdated: new Date().toISOString(),
    owners: Object.values(ownersMap),
    cards: cardsMap
  };

  const outDir  = path.join(__dirname, 'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  fs.writeFileSync(path.join(outDir, 'cards.json'), JSON.stringify(output, null, 2), 'utf8');

  console.log(`\n✓ Done. ${Object.keys(cardsMap).length} unique cards, ${Object.keys(ownersMap).length} owners.`);
  console.log(`  Written to data/cards.json`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
