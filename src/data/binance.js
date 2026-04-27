import { CONFIG } from "../config.js";
import { fetchWithTimeout } from "../net/http.js";

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

const baseCooldownUntil = new Map();
let preferredBaseUrl = null;
const klinesCache = new Map();
const klinesInFlight = new Map();
let lastPriceCache = { value: null, fetchedAt: 0 };
let lastPriceInFlight = null;
let lastPriceNextRefreshAt = 0;

function getOrderedBases() {
  const bases = Array.isArray(CONFIG.binanceBaseUrls) && CONFIG.binanceBaseUrls.length
    ? CONFIG.binanceBaseUrls
    : [CONFIG.binanceBaseUrl];
  const unique = [...new Set(bases)];
  if (preferredBaseUrl && unique.includes(preferredBaseUrl)) {
    return [preferredBaseUrl, ...unique.filter((base) => base !== preferredBaseUrl)];
  }
  return unique;
}

export async function fetchBinanceJson(pathname, params = {}, label = "Binance request") {
  const bases = getOrderedBases();
  const errors = [];
  const requestStartedAt = Date.now();
  const failoverBudgetMs = Math.max(CONFIG.httpTimeoutMs, CONFIG.binanceFailoverBudgetMs || CONFIG.httpTimeoutMs);

  for (const baseUrl of bases) {
    const now = Date.now();
    const cooldownUntil = baseCooldownUntil.get(baseUrl) || 0;
    if (cooldownUntil > now) {
      errors.push(`${baseUrl}: cooldown ${Math.ceil((cooldownUntil - now) / 1000)}s`);
      continue;
    }

    const elapsedMs = now - requestStartedAt;
    const remainingBudgetMs = failoverBudgetMs - elapsedMs;
    if (remainingBudgetMs <= 0) {
      errors.push(`failover budget exceeded (${failoverBudgetMs}ms)`);
      break;
    }

    const url = new URL(pathname, baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    try {
      const res = await fetchWithTimeout(url, {}, {
        timeoutMs: Math.max(500, Math.min(CONFIG.httpTimeoutMs, remainingBudgetMs)),
        label: `${label} ${baseUrl}`
      });
      if (res.ok) {
        preferredBaseUrl = baseUrl;
        return await res.json();
      }
      const body = await res.text();
      errors.push(`${baseUrl}: ${res.status} ${body.slice(0, 220)}`);
      if (res.status === 451 || res.status === 403) {
        baseCooldownUntil.set(baseUrl, Date.now() + 10 * 60_000);
        continue;
      }
      baseCooldownUntil.set(baseUrl, Date.now() + 15_000);
    } catch (err) {
      const cause = err?.cause?.code || err?.cause?.message || "";
      errors.push(`${baseUrl}: ${err?.message || err}${cause ? ` (${cause})` : ""}`);
      baseCooldownUntil.set(baseUrl, Date.now() + 15_000);
    }
  }

  throw new Error(`${label} failed: ${errors.join(" | ")}`);
}

export async function fetchKlines({ interval, limit }) {
  const cacheKey = `${CONFIG.symbol}:${interval}:${limit}`;
  const cached = klinesCache.get(cacheKey);
  if (cached?.data?.length && Date.now() - cached.fetchedAt < CONFIG.binanceKlinesCacheMs) {
    return cached.data;
  }
  if (cached?.data?.length) {
    if (cached.nextRefreshAt && Date.now() < cached.nextRefreshAt) {
      return cached.data;
    }
    if (!klinesInFlight.has(cacheKey)) {
      const refresh = fetchKlinesFromNetwork({ interval, limit, cacheKey })
        .catch(err => {
          cached.nextRefreshAt = Date.now() + CONFIG.binanceRefreshRetryMs;
          console.warn(`⚠️  Binance klines refresh falhou; mantendo candles em cache: ${err?.message || err}`);
          return cached.data;
        })
        .finally(() => klinesInFlight.delete(cacheKey));
      klinesInFlight.set(cacheKey, refresh);
    }
    return cached.data;
  }
  if (klinesInFlight.has(cacheKey)) {
    return klinesInFlight.get(cacheKey);
  }

  const request = fetchKlinesFromNetwork({ interval, limit, cacheKey });
  klinesInFlight.set(cacheKey, request);

  try {
    return await request;
  } catch (err) {
    if (cached?.data?.length) {
      console.warn(`⚠️  Binance klines falhou; usando candles em cache: ${err?.message || err}`);
      return cached.data;
    }
    throw err;
  } finally {
    klinesInFlight.delete(cacheKey);
  }
}

async function fetchKlinesFromNetwork({ interval, limit, cacheKey }) {
  const data = await fetchBinanceJson("/api/v3/klines", {
    symbol: CONFIG.symbol,
    interval,
    limit
  }, "Binance klines");

  const parsed = data.map((k) => ({
    openTime: Number(k[0]),
    open: toNumber(k[1]),
    high: toNumber(k[2]),
    low: toNumber(k[3]),
    close: toNumber(k[4]),
    volume: toNumber(k[5]),
    closeTime: Number(k[6])
  }));
  klinesCache.set(cacheKey, { data: parsed, fetchedAt: Date.now(), nextRefreshAt: 0 });
  return parsed;
}

export async function fetchLastPrice() {
  if (lastPriceCache.value !== null && Date.now() - lastPriceCache.fetchedAt < CONFIG.binanceLastPriceCacheMs) {
    return lastPriceCache.value;
  }
  if (lastPriceCache.value !== null) {
    if (lastPriceNextRefreshAt && Date.now() < lastPriceNextRefreshAt) {
      return lastPriceCache.value;
    }
    if (!lastPriceInFlight) {
      lastPriceInFlight = fetchLastPriceFromNetwork()
        .catch(err => {
          lastPriceNextRefreshAt = Date.now() + CONFIG.binanceRefreshRetryMs;
          console.warn(`⚠️  Binance last price refresh falhou; mantendo preço em cache: ${err?.message || err}`);
          return lastPriceCache.value;
        })
        .finally(() => { lastPriceInFlight = null; });
    }
    return lastPriceCache.value;
  }
  if (lastPriceInFlight) return lastPriceInFlight;

  lastPriceInFlight = fetchLastPriceFromNetwork();

  try {
    return await lastPriceInFlight;
  } catch (err) {
    if (lastPriceCache.value !== null) {
      console.warn(`⚠️  Binance last price falhou; usando preço em cache: ${err?.message || err}`);
      return lastPriceCache.value;
    }
    throw err;
  } finally {
    lastPriceInFlight = null;
  }
}

async function fetchLastPriceFromNetwork() {
  const data = await fetchBinanceJson("/api/v3/ticker/price", {
    symbol: CONFIG.symbol
  }, "Binance last price");
  lastPriceCache = { value: toNumber(data.price), fetchedAt: Date.now() };
  lastPriceNextRefreshAt = 0;
  return lastPriceCache.value;
}
