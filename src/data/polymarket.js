import { CONFIG } from "../config.js";
import { fetchWithTimeout } from "../net/http.js";

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

const EVENT_PAGE_PTB_CACHE = new Map();
const EVENT_PAGE_PTB_IN_FLIGHT = new Set();

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseUsdNumber(text) {
  if (!text) return null;
  const normalized = String(text).replace(/,/g, "").trim();
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function extractPriceToBeatFromHtml(html) {
  if (!html) return null;

  const patterns = [
    /Price\s*To\s*Beat\s*\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,
    /opening\s*["']?Price\s*to\s*Beat["']?\s*of\s*\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,
    /price\s*to\s*beat[^$\d]{0,80}\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    const number = parseUsdNumber(match?.[1]);
    if (number !== null) return number;
  }
  return null;
}

function findPriceToBeatInNextData(node, slug) {
  if (!node || typeof node !== "object") return null;

  if (!Array.isArray(node)) {
    const nodeSlug = String(node.slug ?? node.ticker ?? "");
    const eventMetadataPrice = toNumber(node.eventMetadata?.priceToBeat);
    if (nodeSlug === slug && eventMetadataPrice !== null) return eventMetadataPrice;

    const directPrice = toNumber(node.priceToBeat);
    if (nodeSlug === slug && directPrice !== null) return directPrice;
  }

  const values = Array.isArray(node) ? node : Object.values(node);
  for (const value of values) {
    const found = findPriceToBeatInNextData(value, slug);
    if (found !== null) return found;
  }
  return null;
}

async function fetchEventPageNextDataPriceToBeat(slug) {
  const htmlUrl = `https://polymarket.com/event/${encodeURIComponent(slug)}`;
  const htmlRes = await fetchWithTimeout(htmlUrl, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9"
    }
  }, { label: `Polymarket event shell ${slug}` });

  if (!htmlRes.ok) {
    throw new Error(`Polymarket event shell error: ${htmlRes.status}`);
  }

  const html = await htmlRes.text();
  const buildIdMatch = html.match(/\/_next\/static\/([^/]+)\/_buildManifest\.js/i);
  if (!buildIdMatch?.[1]) return { html, price: null };

  const nextDataUrl = `https://polymarket.com/_next/data/${buildIdMatch[1]}/en/event/${encodeURIComponent(slug)}.json?slug=${encodeURIComponent(slug)}`;
  const jsonRes = await fetchWithTimeout(nextDataUrl, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      "accept": "application/json,text/plain,*/*",
      "accept-language": "en-US,en;q=0.9"
    }
  }, { label: `Polymarket next data ${slug}` });

  if (!jsonRes.ok) {
    throw new Error(`Polymarket next data error: ${jsonRes.status}`);
  }

  const data = await jsonRes.json();
  return { html, price: findPriceToBeatInNextData(data, slug) };
}

export function getCachedEventPagePtb(slug) {
  return EVENT_PAGE_PTB_CACHE.get(slug)?.price ?? null;
}

export async function fetchEventPagePriceToBeat(slug) {
  const { html, price } = await fetchEventPageNextDataPriceToBeat(slug);
  if (price !== null) return price;
  return extractPriceToBeatFromHtml(html);
}

export async function ensureEventPagePtb(slug) {
  if (!slug) return null;
  if (EVENT_PAGE_PTB_CACHE.has(slug)) return EVENT_PAGE_PTB_CACHE.get(slug).price;
  if (EVENT_PAGE_PTB_IN_FLIGHT.has(slug)) return null;

  EVENT_PAGE_PTB_IN_FLIGHT.add(slug);
  try {
    const price = await fetchEventPagePriceToBeat(slug);
    if (price !== null) {
      EVENT_PAGE_PTB_CACHE.set(slug, { price, fetchedAt: Date.now() });
    }
    return price;
  } finally {
    EVENT_PAGE_PTB_IN_FLIGHT.delete(slug);
  }
}

export async function fetchMarketBySlug(slug) {
  const url = new URL("/markets", CONFIG.gammaBaseUrl);
  url.searchParams.set("slug", slug);

  const res = await fetchWithTimeout(url, {}, { label: "Gamma market by slug" });
  if (!res.ok) {
    throw new Error(`Gamma markets error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const market = Array.isArray(data) ? data[0] : data;
  if (!market) return null;

  return market;
}

export async function fetchMarketsBySeriesSlug({ seriesSlug, limit = 50 }) {
  const url = new URL("/markets", CONFIG.gammaBaseUrl);
  url.searchParams.set("seriesSlug", seriesSlug);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("enableOrderBook", "true");
  url.searchParams.set("limit", String(limit));

  const res = await fetchWithTimeout(url, {}, { label: "Gamma markets by series" });
  if (!res.ok) {
    throw new Error(`Gamma markets(series) error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function fetchLiveEventsBySeriesId({ seriesId, limit = 20 }) {
  const url = new URL("/events", CONFIG.gammaBaseUrl);
  url.searchParams.set("series_id", String(seriesId));
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", String(limit));

  const res = await fetchWithTimeout(url, {}, { label: "Gamma events by series" });
  if (!res.ok) {
    throw new Error(`Gamma events(series_id) error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export function flattenEventMarkets(events) {
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    const markets = Array.isArray(e.markets) ? e.markets : [];
    for (const m of markets) {
      out.push(m);
    }
  }
  return out;
}

export async function fetchActiveMarkets({ limit = 200, offset = 0 } = {}) {
  const url = new URL("/markets", CONFIG.gammaBaseUrl);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("enableOrderBook", "true");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));

  const res = await fetchWithTimeout(url, {}, { label: "Gamma active markets" });
  if (!res.ok) {
    throw new Error(`Gamma markets(active) error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function safeTimeMs(x) {
  if (!x) return null;
  const t = new Date(x).getTime();
  return Number.isFinite(t) ? t : null;
}

export function pickLatestLiveMarket(markets, nowMs = Date.now()) {
  if (!Array.isArray(markets) || markets.length === 0) return null;

  const enriched = markets
    .map((m) => {
      const endMs = safeTimeMs(m.endDate);
      const startMs = safeTimeMs(m.eventStartTime ?? m.startTime ?? m.startDate);
      return { m, endMs, startMs };
    })
    .filter((x) => x.endMs !== null);

  const live = enriched
    .filter((x) => {
      const started = x.startMs === null ? true : x.startMs <= nowMs;
      return started && nowMs < x.endMs;
    })
    .sort((a, b) => a.endMs - b.endMs);

  if (live.length) return live[0].m;

  const upcoming = enriched
    .filter((x) => nowMs < x.endMs)
    .sort((a, b) => a.endMs - b.endMs);

  return upcoming.length ? upcoming[0].m : null;
}

function marketHasSeriesSlug(market, seriesSlug) {
  if (!market || !seriesSlug) return false;

  const events = Array.isArray(market.events) ? market.events : [];
  for (const e of events) {
    const series = Array.isArray(e.series) ? e.series : [];
    for (const s of series) {
      if (String(s.slug ?? "").toLowerCase() === String(seriesSlug).toLowerCase()) return true;
    }
    if (String(e.seriesSlug ?? "").toLowerCase() === String(seriesSlug).toLowerCase()) return true;
  }
  if (String(market.seriesSlug ?? "").toLowerCase() === String(seriesSlug).toLowerCase()) return true;
  return false;
}

export function filterBtcUpDown15mMarkets(markets, { seriesSlug, slugPrefix } = {}) {
  const prefix = (slugPrefix ?? "").toLowerCase();
  const wantedSeries = (seriesSlug ?? "").toLowerCase();

  return (Array.isArray(markets) ? markets : []).filter((m) => {
    const slug = String(m.slug ?? "").toLowerCase();
    const matchesPrefix = prefix ? slug.startsWith(prefix) : false;
    const matchesSeries = wantedSeries ? marketHasSeriesSlug(m, wantedSeries) : false;
    return matchesPrefix || matchesSeries;
  });
}

export async function fetchClobPrice({ tokenId, side }) {
  const url = new URL("/price", CONFIG.clobBaseUrl);
  url.searchParams.set("token_id", tokenId);
  url.searchParams.set("side", side);

  const res = await fetchWithTimeout(url, {}, { label: "CLOB price" });
  if (!res.ok) {
    throw new Error(`CLOB price error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return toNumber(data.price);
}

export async function fetchOrderBook({ tokenId }) {
  const url = new URL("/book", CONFIG.clobBaseUrl);
  url.searchParams.set("token_id", tokenId);

  const res = await fetchWithTimeout(url, {}, { label: "CLOB order book" });
  if (!res.ok) {
    throw new Error(`CLOB book error: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

export function summarizeOrderBook(book, depthLevels = 5) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];

  const bestBid = bids.length
    ? bids.reduce((best, lvl) => {
        const p = toNumber(lvl.price);
        if (p === null) return best;
        if (best === null) return p;
        return Math.max(best, p);
      }, null)
    : null;

  const bestAsk = asks.length
    ? asks.reduce((best, lvl) => {
        const p = toNumber(lvl.price);
        if (p === null) return best;
        if (best === null) return p;
        return Math.min(best, p);
      }, null)
    : null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

  const bidLiquidity = bids.slice(0, depthLevels).reduce((acc, x) => acc + (toNumber(x.size) ?? 0), 0);
  const askLiquidity = asks.slice(0, depthLevels).reduce((acc, x) => acc + (toNumber(x.size) ?? 0), 0);

  return {
    bestBid,
    bestAsk,
    spread,
    bidLiquidity,
    askLiquidity
  };
}

// ─── Market price-to-beat extraction helpers ─────────────────────────────────

/**
 * Extracts the price-to-beat value from known direct fields or by walking the
 * market object tree looking for numeric keys that match common field names.
 */
export function extractNumericFromMarket(market) {
  const directKeys = ["priceToBeat","price_to_beat","strikePrice","strike_price","strike","threshold","thresholdPrice","threshold_price","targetPrice","target_price","referencePrice","reference_price"];
  for (const key of directKeys) {
    const value = market?.[key];
    const number = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
    if (Number.isFinite(number)) return number;
  }
  const visited = new Set();
  const stack = [{ obj: market, depth: 0 }];
  while (stack.length) {
    const { obj, depth } = stack.pop();
    if (!obj || typeof obj !== "object" || visited.has(obj) || depth > 6) continue;
    visited.add(obj);
    const entries = Array.isArray(obj) ? obj.entries() : Object.entries(obj);
    for (const [key, value] of entries) {
      if (value && typeof value === "object") { stack.push({ obj: value, depth: depth + 1 }); continue; }
      if (!/(price|strike|threshold|target|beat)/i.test(String(key))) continue;
      const number = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
      if (Number.isFinite(number) && number > 1000 && number < 2_000_000) return number;
    }
  }
  return null;
}

/**
 * Extracts the price-to-beat from the market question/title text as a fallback.
 */
export function parsePriceToBeatFromText(market) {
  const text = String(market?.question ?? market?.title ?? "");
  if (!text) return null;
  const match = text.match(/price\s*to\s*beat[^\d$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!match) return null;
  const raw = match[1].replace(/,/g, "");
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

/**
 * Returns the price-to-beat for a market. Title parsing is canonical (the
 * question text always contains the exact PTB). Heuristic walk is fallback
 * only — it can capture spurious numeric fields close to the real PTB and
 * has previously caused stale latches that contaminated simulated outcomes.
 */
export function priceToBeatFromMarket(market) {
  return parsePriceToBeatFromText(market) ?? extractNumericFromMarket(market);
}

/**
 * Same as priceToBeatFromMarket but returns the source ("title" or "walk")
 * so callers can prefer canonical title results over heuristic walks.
 */
export function priceToBeatFromMarketWithSource(market) {
  const fromTitle = parsePriceToBeatFromText(market);
  if (fromTitle !== null) return { value: fromTitle, source: "title" };
  const fromWalk = extractNumericFromMarket(market);
  if (fromWalk !== null) return { value: fromWalk, source: "walk" };
  return { value: null, source: null };
}

// ─── Market outcome resolution (canonical truth from Polymarket) ─────────────

function safeJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

/**
 * Resolves the outcome of a Polymarket BTC up/down market using its
 * canonical `outcomePrices` field. Returns:
 *   "UP"   — the UP token settled at $1
 *   "DOWN" — the DOWN token settled at $1
 *   null   — market not yet resolved or shape unrecognized
 *
 * Uses the `outcomes` array (e.g. ["Up","Down"]) to map indices to sides
 * rather than assuming a fixed order, which makes it robust to schema drift.
 */
export function resolveMarketOutcome(market) {
  if (!market || !market.closed) return null;
  const outcomes      = safeJsonArray(market.outcomes);
  const outcomePrices = safeJsonArray(market.outcomePrices).map(p => parseFloat(p));
  if (outcomes.length !== 2 || outcomePrices.length !== 2) return null;
  if (!outcomePrices.every(p => p === 0 || p === 1)) return null;
  if (!outcomePrices.some(p => p === 1)) return null;

  const upIdx   = outcomes.findIndex(o => /up/i.test(String(o)));
  const downIdx = outcomes.findIndex(o => /down/i.test(String(o)));
  if (upIdx < 0 || downIdx < 0) return null;

  if (outcomePrices[upIdx] === 1)   return "UP";
  if (outcomePrices[downIdx] === 1) return "DOWN";
  return null;
}
