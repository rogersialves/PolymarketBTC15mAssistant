import { fetchBinanceJson } from "./binance.js";
import { CONFIG } from "../config.js";
import { fetchWithTimeout } from "../net/http.js";

const cache = {
  binance: { price: null, volume: null },
  coinbase: { price: null, volume: null },
  kraken: { price: null, volume: null }
};

let lastFetch = 0;

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

export async function fetchCoinbaseTicker() {
  // CONFIG.symbol is BTCUSDT, Coinbase uses BTC-USD
  const res = await fetchWithTimeout("https://api.exchange.coinbase.com/products/BTC-USD/ticker", {}, {
    timeoutMs: CONFIG.httpTimeoutMs,
    label: "Coinbase ticker"
  });
  if (!res.ok) throw new Error("Coinbase error");
  const data = await res.json();
  return { price: toNumber(data.price), volume: toNumber(data.volume) };
}

export async function fetchKrakenTicker() {
  const res = await fetchWithTimeout("https://api.kraken.com/0/public/Ticker?pair=XBTUSD", {}, {
    timeoutMs: CONFIG.httpTimeoutMs,
    label: "Kraken ticker"
  });
  if (!res.ok) throw new Error("Kraken error");
  const data = await res.json();
  const ticker = data.result.XXBTZUSD;
  // c[0] is last trade closed price, v[1] is 24h volume
  return { price: toNumber(ticker.c[0]), volume: toNumber(ticker.v[1]) };
}

export function getExchangeTickers() {
  if (Date.now() - lastFetch > CONFIG.exchangeTickerCacheMs) {
    lastFetch = Date.now();
    Promise.allSettled([
      fetchBinanceTicker(),
      fetchCoinbaseTicker(),
      fetchKrakenTicker()
    ]).then(([binance, coinbase, kraken]) => {
      if (binance.status === "fulfilled") cache.binance = binance.value;
      else console.warn(`⚠️  Binance ticker falhou: ${binance.reason?.message || binance.reason}`);
      if (coinbase.status === "fulfilled") cache.coinbase = coinbase.value;
      else console.warn(`⚠️  Coinbase ticker falhou: ${coinbase.reason?.message || coinbase.reason}`);
      if (kraken.status === "fulfilled") cache.kraken = kraken.value;
      else console.warn(`⚠️  Kraken ticker falhou: ${kraken.reason?.message || kraken.reason}`);
    });
  }
  return cache;
}
