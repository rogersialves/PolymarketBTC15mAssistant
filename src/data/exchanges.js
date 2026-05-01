import { fetchBinanceJson } from "./binance.js";
import { CONFIG } from "../config.js";
import { fetchWithTimeout } from "../net/http.js";

const cache = {
  binance: { price: null, volume: null },
  coinbase: { price: null, volume: null },
  kraken: { price: null, volume: null }
};

let lastFetch = 0;
let tickerInFlight = null;

// FIX AG: Per-exchange failure cooldown. Coinbase and Kraken consistently fail with
// ECONNREFUSED (err=20) on this server — likely IP/ISP block. Each failed attempt
// opens a TLS connection that takes 1500-2900ms to die, and when simultaneous with
// 4 CLOB requests it saturates libuv's crypto thread pool (4 workers), causing
// 1000+ ms event loop freezes. Cooldown prevents wasted TLS attempts.
const TICKER_REFUSED_COOLDOWN_MS = 5 * 60_000;  // 5 min for ECONNREFUSED
const TICKER_ERROR_COOLDOWN_MS = 30_000;         // 30 s for other errors
const tickerCooldowns = new Map(); // exchangeName → cooldownUntilMs

function isTickerAvailable(name) {
  return Date.now() >= (tickerCooldowns.get(name) || 0);
}

function markTickerFailed(name, err) {
  const msg = String(err?.message || err || "");
  const isRefused = msg.includes("err=20") || msg.includes("ECONNREFUSED") || msg.includes("err_20");
  tickerCooldowns.set(name, Date.now() + (isRefused ? TICKER_REFUSED_COOLDOWN_MS : TICKER_ERROR_COOLDOWN_MS));
}

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export async function fetchBinanceTicker() {
  const data = await fetchBinanceJson("/api/v3/ticker/24hr", {
    symbol: CONFIG.symbol
  }, "Binance ticker");
  return { price: toNumber(data.lastPrice), volume: toNumber(data.volume) };
}

// FIX W: Informational-only sources. 1500ms timeout — when slow (observed at 2400ms)
// they hold TLS connections open that drive major-GC and RSS spikes. The stale cache
// value (up to exchangeTickerCacheMs=10s old) is sufficient for oracle-spread display.
const EXCHANGE_TICKER_TIMEOUT_MS = Number(process.env.EXCHANGE_TICKER_TIMEOUT_MS || 1_500);

export async function fetchCoinbaseTicker() {
  // CONFIG.symbol is BTCUSDT, Coinbase uses BTC-USD
  const res = await fetchWithTimeout("https://api.exchange.coinbase.com/products/BTC-USD/ticker", {}, {
    timeoutMs: EXCHANGE_TICKER_TIMEOUT_MS,
    label: "Coinbase ticker"
  });
  if (!res.ok) throw new Error("Coinbase error");
  const data = await res.json();
  return { price: toNumber(data.price), volume: toNumber(data.volume) };
}

export async function fetchKrakenTicker() {
  const res = await fetchWithTimeout("https://api.kraken.com/0/public/Ticker?pair=XBTUSD", {}, {
    timeoutMs: EXCHANGE_TICKER_TIMEOUT_MS,
    label: "Kraken ticker"
  });
  if (!res.ok) throw new Error("Kraken error");
  const data = await res.json();
  const ticker = data.result.XXBTZUSD;
  // c[0] is last trade closed price, v[1] is 24h volume
  return { price: toNumber(ticker.c[0]), volume: toNumber(ticker.v[1]) };
}

export function getExchangeTickers() {
  if (Date.now() - lastFetch > CONFIG.exchangeTickerCacheMs && !tickerInFlight) {
    lastFetch = Date.now();

    // FIX AG: Sequenced fetches — Binance first, then Coinbase/Kraken after Binance
    // resolves. This prevents 3 simultaneous TLS handshakes which (combined with 4
    // CLOB requests) saturated libuv's 4 crypto threads, causing 1000+ ms loop freezes.
    tickerInFlight = fetchBinanceTicker()
      .then(v => { cache.binance = v; })
      .catch(e => { console.warn(`⚠️  Binance ticker falhou: ${e?.message || e}`); })
      .then(() => {
        // After Binance, attempt Coinbase only if not in cooldown
        if (!isTickerAvailable("coinbase")) return null;
        return fetchCoinbaseTicker()
          .then(v => { cache.coinbase = v; })
          .catch(e => { markTickerFailed("coinbase", e); console.warn(`⚠️  Coinbase ticker falhou: ${e?.message || e}`); });
      })
      .then(() => {
        // After Coinbase, attempt Kraken only if not in cooldown
        if (!isTickerAvailable("kraken")) return null;
        return fetchKrakenTicker()
          .then(v => { cache.kraken = v; })
          .catch(e => { markTickerFailed("kraken", e); console.warn(`⚠️  Kraken ticker falhou: ${e?.message || e}`); });
      })
      .finally(() => { tickerInFlight = null; });
  }
  return cache;
}
