import { CONFIG } from "../config.js";
import { fetchWithTimeout } from "../net/http.js";

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

const klinesCache = new Map();
const klinesInFlight = new Map();

function okxBar(interval) {
  if (interval === "1m") return "1m";
  throw new Error(`OKX candles: unsupported interval ${interval}`);
}

/**
 * OKX GET /api/v5/market/candles returns rows newest-first; we normalize to
 * Binance-shaped candles oldest-first (openTime ascending).
 */
export async function fetchOkxKlines({ interval, limit }) {
  const bar = okxBar(interval);
  const instId = "BTC-USDT";
  const cacheKey = `${instId}:${bar}:${limit}`;
  const cacheMs = CONFIG.binanceKlinesCacheMs;
  const cached = klinesCache.get(cacheKey);
  if (cached?.data?.length && Date.now() - cached.fetchedAt < cacheMs) {
    return cached.data;
  }
  if (cached?.data?.length) {
    if (cached.nextRefreshAt && Date.now() < cached.nextRefreshAt) {
      return cached.data;
    }
    if (!klinesInFlight.has(cacheKey)) {
      const refresh = fetchOkxKlinesFromNetwork({ bar, limit, cacheKey, instId })
        .catch((err) => {
          cached.nextRefreshAt = Date.now() + CONFIG.binanceRefreshRetryMs;
          console.warn(`⚠️  OKX klines refresh falhou; mantendo candles em cache: ${err?.message || err}`);
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

  const request = fetchOkxKlinesFromNetwork({ bar, limit, cacheKey, instId });
  klinesInFlight.set(cacheKey, request);
  try {
    return await request;
  } catch (err) {
    if (cached?.data?.length) {
      console.warn(`⚠️  OKX klines falhou; usando candles em cache: ${err?.message || err}`);
      return cached.data;
    }
    throw err;
  } finally {
    klinesInFlight.delete(cacheKey);
  }
}

async function fetchOkxKlinesFromNetwork({ bar, limit, cacheKey, instId }) {
  const url = new URL("https://www.okx.com/api/v5/market/candles");
  url.searchParams.set("instId", instId);
  url.searchParams.set("bar", bar);
  url.searchParams.set("limit", String(Math.min(300, Math.max(1, limit))));

  const res = await fetchWithTimeout(url, {}, {
    timeoutMs: CONFIG.httpTimeoutMs,
    label: "OKX candles"
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OKX candles HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (String(json.code) !== "0") {
    throw new Error(`OKX candles code=${json.code} msg=${json.msg || ""}`);
  }
  const rows = Array.isArray(json.data) ? json.data : [];
  const chronological = [...rows].reverse();
  const parsed = chronological.map((k) => {
    const openTime = Number(k[0]);
    const open = toNumber(k[1]);
    const high = toNumber(k[2]);
    const low = toNumber(k[3]);
    const close = toNumber(k[4]);
    const volume = toNumber(k[5]);
    const closeTime = Number.isFinite(openTime) ? openTime + 60_000 - 1 : NaN;
    return {
      openTime,
      open,
      high,
      low,
      close,
      volume,
      closeTime
    };
  });
  klinesCache.set(cacheKey, { data: parsed, fetchedAt: Date.now(), nextRefreshAt: 0 });
  return parsed;
}
