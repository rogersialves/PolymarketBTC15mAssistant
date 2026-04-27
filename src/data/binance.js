import { CONFIG } from "../config.js";
import { fetchWithTimeout } from "../net/http.js";

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

const baseCooldownUntil = new Map();
let preferredBaseUrl = null;
const klinesCache = new Map();
let lastPriceCache = { value: null, fetchedAt: 0 };

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
  const now = Date.now();

  for (const baseUrl of bases) {
    const cooldownUntil = baseCooldownUntil.get(baseUrl) || 0;
    if (cooldownUntil > now) {
      errors.push(`${baseUrl}: cooldown ${Math.ceil((cooldownUntil - now) / 1000)}s`);
      continue;
    }

    const url = new URL(pathname, baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    try {
      const res = await fetchWithTimeout(url, {}, {
        timeoutMs: CONFIG.httpTimeoutMs,
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

  try {
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
    klinesCache.set(cacheKey, { data: parsed, fetchedAt: Date.now() });
    return parsed;
  } catch (err) {
    if (cached?.data?.length) {
      console.warn(`⚠️  Binance klines falhou; usando candles em cache: ${err?.message || err}`);
      return cached.data;
    }
    throw err;
  }
}

export async function fetchLastPrice() {
  if (lastPriceCache.value !== null && Date.now() - lastPriceCache.fetchedAt < CONFIG.binanceLastPriceCacheMs) {
    return lastPriceCache.value;
  }

  try {
    const data = await fetchBinanceJson("/api/v3/ticker/price", {
      symbol: CONFIG.symbol
    }, "Binance last price");
    lastPriceCache = { value: toNumber(data.price), fetchedAt: Date.now() };
    return lastPriceCache.value;
  } catch (err) {
    if (lastPriceCache.value !== null) {
      console.warn(`⚠️  Binance last price falhou; usando preço em cache: ${err?.message || err}`);
      return lastPriceCache.value;
    }
    throw err;
  }
}
