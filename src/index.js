import "dotenv/config";
import { CONFIG, WINDOW_PRESETS, applyWindowPreset } from "./config.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "./data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, computeRsiSeries, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { computeBollingerBands } from "./indicators/bollingerBands.js";
import { computeStochasticRsi } from "./indicators/stochasticRsi.js";
import { computeEmaCross } from "./indicators/emaCross.js";
import { computeObv } from "./indicators/obv.js";
import { computeAtr } from "./indicators/atr.js";
import { detectRegime } from "./engines/regime.js";
import { getExchangeTickers } from "./data/exchanges.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";
import { appendCsvRow, countVwapCrosses, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";

// ─── VWAP cross counter ──────────────────────────────────────────
// countVwapCrosses imported from ./utils.js

applyGlobalProxyFromEnv();

// ─── Formatting helpers ──────────────────────────────────────────

function formatTimeLeft(totalMinutes) {
  const totalSeconds = Math.max(0, Math.floor(totalMinutes * 60));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  lightRed: "\x1b[91m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m"
};

function screenWidth() {
  const width = Number(process.stdout?.columns);
  return Number.isFinite(width) && width >= 40 ? width : 80;
}

function separatorLine(character = "─") {
  const width = screenWidth();
  return `${ANSI.white}${character.repeat(width)}${ANSI.reset}`;
}

function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch {
    // ignore
  }
  process.stdout.write(text);
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function padLabel(label, width) {
  const visibleLength = stripAnsi(label).length;
  if (visibleLength >= width) return label;
  return label + " ".repeat(width - visibleLength);
}

function centerText(text, width) {
  const visibleLength = stripAnsi(text).length;
  if (visibleLength >= width) return text;
  const leftPad = Math.floor((width - visibleLength) / 2);
  const rightPad = width - visibleLength - leftPad;
  return " ".repeat(leftPad) + text + " ".repeat(rightPad);
}

const LABEL_WIDTH = 16;
function keyValue(label, value) {
  const paddedLabel = padLabel(String(label), LABEL_WIDTH);
  return `${paddedLabel}${value}`;
}

function sectionTitle(title) {
  return `${ANSI.white}${title}${ANSI.reset}`;
}

function colorPriceLine({ label, price, previousPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) {
    return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  }

  const currentValue = Number(price);
  const prevValue = previousPrice === null || previousPrice === undefined ? null : Number(previousPrice);

  let color = ANSI.reset;
  let arrow = "";
  if (prevValue !== null && Number.isFinite(prevValue) && Number.isFinite(currentValue) && currentValue !== prevValue) {
    if (currentValue > prevValue) {
      color = ANSI.green;
      arrow = " ↑";
    } else {
      color = ANSI.red;
      arrow = " ↓";
    }
  }

  const formatted = `${prefix}${formatNumber(currentValue, decimals)}`;
  return `${label}: ${color}${formatted}${arrow}${ANSI.reset}`;
}

function formatSignedDelta(delta, basePrice) {
  if (delta === null || basePrice === null || basePrice === 0) return `${ANSI.gray}-${ANSI.reset}`;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const percentage = (Math.abs(delta) / Math.abs(basePrice)) * 100;
  return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${percentage.toFixed(2)}%`;
}

function colorByNarrative(text, narrative) {
  if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`;
  if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`;
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

function formatNarrativeValue(label, value, narrative) {
  return `${label}: ${colorByNarrative(value, narrative)}`;
}

function narrativeFromSign(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value)) || Number(value) === 0) return "NEUTRAL";
  return Number(value) > 0 ? "LONG" : "SHORT";
}

function narrativeFromSlope(slope) {
  if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return "NEUTRAL";
  return Number(slope) > 0 ? "LONG" : "SHORT";
}

function formatProbabilityPercent(probability, digits = 0) {
  if (probability === null || probability === undefined || !Number.isFinite(Number(probability))) return "-";
  return `${(Number(probability) * 100).toFixed(digits)}%`;
}

function formatEasternTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
  } catch {
    return "-";
  }
}

function getBtcSession(now = new Date()) {
  const hour = now.getUTCHours();
  const inAsia = hour >= 0 && hour < 8;
  const inEurope = hour >= 7 && hour < 16;
  const inUs = hour >= 13 && hour < 22;

  if (inEurope && inUs) return "Europe/US overlap";
  if (inAsia && inEurope) return "Asia/Europe overlap";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

// ─── Price-to-beat extraction ────────────────────────────────────
// parsePriceToBeatFromText, extractNumericFromMarket, priceToBeatFromPolymarketMarket
// moved to ./data/polymarket.js (not called in this file)

const dumpedMarketSlugs = new Set();

function safeFileSlug(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

// ─── Polymarket market resolution ────────────────────────────────

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

async function resolveCurrentMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const allMarkets = flattenEventMarkets(events);
  const selectedMarket = pickLatestLiveMarket(allMarkets);

  marketCache.market = selectedMarket;
  marketCache.fetchedAtMs = now;
  return selectedMarket;
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentMarket();

  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);

  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null;
  let downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const outcomeLabel = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (outcomeLabel.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (outcomeLabel.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());

  const gammaUpPrice = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaDownPrice = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return {
      ok: false,
      reason: "missing_token_ids",
      market,
      outcomes,
      clobTokenIds,
      outcomePrices
    };
  }

  let upClobPrice = null;
  let downClobPrice = null;
  let upOrderBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downOrderBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

  try {
    const [upBuyPrice, downBuyPrice, upOrderBook, downOrderBook] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
      fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);

    upClobPrice = upBuyPrice;
    downClobPrice = downBuyPrice;
    upOrderBookSummary = summarizeOrderBook(upOrderBook);
    downOrderBookSummary = summarizeOrderBook(downOrderBook);
  } catch {
    upClobPrice = null;
    downClobPrice = null;
    upOrderBookSummary = {
      bestBid: Number(market.bestBid) || null,
      bestAsk: Number(market.bestAsk) || null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
    downOrderBookSummary = {
      bestBid: null,
      bestAsk: null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
  }

  return {
    ok: true,
    market,
    tokens: { upTokenId, downTokenId },
    prices: {
      up: upClobPrice ?? gammaUpPrice,
      down: downClobPrice ?? gammaDownPrice
    },
    orderbook: {
      up: upOrderBookSummary,
      down: downOrderBookSummary
    }
  };
}

// ─── Timer color helper ──────────────────────────────────────────

function getTimerColor(minutesLeft) {
  const { greenAbove, yellowAbove } = CONFIG.timerColors;
  const maxWindow = CONFIG.candleWindowMinutes;

  if (minutesLeft >= greenAbove && minutesLeft <= maxWindow) return ANSI.green;
  if (minutesLeft >= yellowAbove && minutesLeft < greenAbove) return ANSI.yellow;
  if (minutesLeft >= 0 && minutesLeft < yellowAbove) return ANSI.red;
  return ANSI.reset;
}

// ─── Window selection prompt ─────────────────────────────────────

function promptWindowSelection() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const envDefault = Number(process.env.CANDLE_WINDOW_MINUTES) || 5;

    console.log("");
    console.log(`${ANSI.white}╔══════════════════════════════════════╗${ANSI.reset}`);
    console.log(`${ANSI.white}║  BTC Polymarket Assistant             ║${ANSI.reset}`);
    console.log(`${ANSI.white}╠══════════════════════════════════════╣${ANSI.reset}`);
    console.log(`${ANSI.white}║                                      ║${ANSI.reset}`);
    console.log(`${ANSI.white}║${ANSI.reset}  ${ANSI.green}[1]${ANSI.reset}  5 min   (btc-updown-5m)       ${ANSI.white}║${ANSI.reset}`);
    console.log(`${ANSI.white}║${ANSI.reset}  ${ANSI.yellow}[2]${ANSI.reset}  15 min  (btc-up-or-down-15m)  ${ANSI.white}║${ANSI.reset}`);
    console.log(`${ANSI.white}║                                      ║${ANSI.reset}`);
    console.log(`${ANSI.white}╚══════════════════════════════════════╝${ANSI.reset}`);
    console.log("");

    const defaultLabel = envDefault === 15 ? "2" : "1";

    rl.question(`  Escolha [1/2] (default: ${defaultLabel}): `, (answer) => {
      rl.close();
      const trimmed = (answer ?? "").trim();

      if (trimmed === "2" || trimmed === "15") {
        resolve(15);
      } else if (trimmed === "1" || trimmed === "5") {
        resolve(5);
      } else {
        // Empty or invalid → use env default
        resolve(envDefault);
      }
    });
  });
}

// ─── Main loop ───────────────────────────────────────────────────

async function main() {
  const selectedWindow = await promptWindowSelection();
  applyWindowPreset(selectedWindow);

  console.log(`\n🔧 Window: ${CONFIG.candleWindowMinutes} min | Series: ${CONFIG.polymarket.seriesSlug} (${CONFIG.polymarket.seriesId})\n`);

  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream = startChainlinkPriceStream({});

  let previousSpotPrice = null;
  let previousChainlinkPrice = null;
  let previousCoinbasePrice = null;
  let previousKrakenPrice = null;
  let previousBybitPrice = null;
  let previousOkxPrice = null;
  let priceToBeatState = { slug: null, value: null, setAtMs: null };

  // ── Snapshot CSV: grava uma linha por fechamento de candle ──
  let snapshotSavedForSlug = null;

  const snapshotCsvHeader = [
    "timestamp",
    "market_slug",
    "window_min",
    "time_left_min",
    // Indicadores
    "ta_predict_long_pct",
    "ta_predict_short_pct",
    "heiken_color",
    "heiken_streak",
    "rsi",
    "rsi_slope",
    "macd_hist",
    "macd_label",
    "delta_1m_usd",
    "delta_1m_pct",
    "delta_3m_usd",
    "delta_3m_pct",
    "vwap_price",
    "vwap_distance_pct",
    "vwap_slope_label",
    "bollinger_pctB",
    "bollinger_bw_pct",
    "bollinger_squeeze",
    "stoch_rsi_k",
    "stoch_rsi_d",
    "stoch_rsi_cross",
    "ema_cross_label",
    "ema_cross_spread",
    "obv_slope",
    "obv_divergence",
    "atr_value",
    "atr_level",
    // Polymarket
    "poly_up_price",
    "poly_down_price",
    "poly_liquidity",
    "price_to_beat",
    // Preços spot
    "chainlink_price",
    "binance_price",
    "binance_vol_24h",
    "coinbase_price",
    "coinbase_vol_24h",
    "kraken_price",
    "kraken_vol_24h",
    "bybit_price",
    "bybit_vol_24h",
    "okx_price",
    "okx_vol_24h",
    // Oracle
    "oracle_lag_ms",
    "binance_vs_oracle_usd",
    "oracle_spread_pct",
    // Decisão
    "regime",
    "signal",
    "edge_up",
    "edge_down",
    "recommendation"
  ];

  const csvHeader = [
    "timestamp",
    "entry_minute",
    "time_left_min",
    "regime",
    "signal",
    "model_up",
    "model_down",
    "mkt_up",
    "mkt_down",
    "edge_up",
    "edge_down",
    "recommendation"
  ];

  while (true) {
    const candleTiming = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    // ── Live price ticks ──
    const binanceTick = binanceStream.getLast();
    const binanceLivePrice = binanceTick?.price ?? null;
    const binanceTickTs = binanceTick?.ts ?? null;

    const polymarketTick = polymarketLiveStream.getLast();
    const polymarketLivePrice = polymarketTick?.price ?? null;

    const chainlinkTick = chainlinkStream.getLast();
    const chainlinkLivePrice = chainlinkTick?.price ?? null;
    const chainlinkTickTs = chainlinkTick?.updatedAt ?? null;

    try {
      // ── Fetch all data in parallel ──
      const chainlinkPricePromise = polymarketLivePrice !== null
        ? Promise.resolve({ price: polymarketLivePrice, updatedAt: polymarketTick?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkLivePrice !== null
          ? Promise.resolve({ price: chainlinkLivePrice, updatedAt: chainlinkTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const [candles1m, binanceLastPrice, chainlinkData, polymarketData] = await Promise.all([
        fetchKlines({ interval: "1m", limit: 240 }),
        fetchLastPrice(),
        chainlinkPricePromise,
        fetchPolymarketSnapshot()
      ]);

      // ── Settlement timing ──
      const settlementMs = polymarketData.ok && polymarketData.market?.endDate ? new Date(polymarketData.market.endDate).getTime() : null;
      const settlementMinutesLeft = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
      const minutesLeft = settlementMinutesLeft ?? candleTiming.remainingMinutes;

      // ── Price arrays ──
      const closePrices = candles1m.map((candle) => candle.close);

      // ── VWAP ──
      const sessionVwap = computeSessionVwap(candles1m);
      const vwapSeries = computeVwapSeries(candles1m);
      const currentVwap = vwapSeries[vwapSeries.length - 1];

      const slopeLookback = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope = vwapSeries.length >= slopeLookback ? (currentVwap - vwapSeries[vwapSeries.length - slopeLookback]) / slopeLookback : null;
      const vwapDistance = currentVwap ? (binanceLastPrice - currentVwap) / currentVwap : null;

      // ── RSI ──
      const currentRsi = computeRsi(closePrices, CONFIG.rsiPeriod);
      const rsiSeries = computeRsiSeries(closePrices, CONFIG.rsiPeriod).filter(v => v !== null);
      const rsiMovingAverage = sma(rsiSeries, CONFIG.rsiMaPeriod);
      const rsiSlope = slopeLast(rsiSeries, 3);

      // ── MACD ──
      const macdResult = computeMacd(closePrices, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

      // ── Heiken Ashi ──
      const heikenAshiCandles = computeHeikenAshi(candles1m);
      const heikenAshiStreak = countConsecutive(heikenAshiCandles);

      // ── Bollinger Bands ──
      const bollingerResult = computeBollingerBands(closePrices, CONFIG.bollingerPeriod, CONFIG.bollingerStdDev);

      // ── Stochastic RSI ──
      const stochRsiResult = computeStochasticRsi(closePrices, CONFIG.stochRsiPeriod, CONFIG.stochRsiPeriod, CONFIG.stochRsiSmooth, CONFIG.stochRsiSmooth);

      // ── EMA Cross 9/21 ──
      const emaCrossResult = computeEmaCross(closePrices, CONFIG.emaFast, CONFIG.emaSlow);

      // ── OBV ──
      const obvResult = computeObv(candles1m, CONFIG.obvSlopeLookback);

      // ── ATR ──
      const atrResult = computeAtr(candles1m, CONFIG.atrPeriod);

      // ── VWAP crosses + volume ──
      const vwapCrossCount = countVwapCrosses(closePrices, vwapSeries, 20);
      const recentVolume = candles1m.slice(-20).reduce((sum, candle) => sum + candle.volume, 0);
      const averageVolume = candles1m.slice(-120).reduce((sum, candle) => sum + candle.volume, 0) / 6;

      const failedVwapReclaim = currentVwap !== null && vwapSeries.length >= 3
        ? closePrices[closePrices.length - 1] < currentVwap && closePrices[closePrices.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      // ── Regime detection ──
      const regimeInfo = detectRegime({
        price: binanceLastPrice,
        vwap: currentVwap,
        vwapSlope,
        vwapCrossCount,
        volumeRecent: recentVolume,
        volumeAvg: averageVolume
      });

      // ── Probability scoring ──
      const directionScore = scoreDirection({
        price: binanceLastPrice,
        vwap: currentVwap,
        vwapSlope,
        rsi: currentRsi,
        rsiSlope,
        macd: macdResult,
        heikenColor: heikenAshiStreak.color,
        heikenCount: heikenAshiStreak.count,
        failedVwapReclaim,
        bollinger: bollingerResult,
        stochRsi: stochRsiResult,
        emaCross: emaCrossResult,
        obv: obvResult,
        atr: atrResult
      });

      const timeAdjustedProb = applyTimeAwareness(directionScore.rawBullishProbability, minutesLeft, CONFIG.candleWindowMinutes);

      // ── Polymarket prices + edge ──
      const marketPriceUp = polymarketData.ok ? polymarketData.prices.up : null;
      const marketPriceDown = polymarketData.ok ? polymarketData.prices.down : null;
      const edgeResult = computeEdge({ modelUp: timeAdjustedProb.adjustedUp, modelDown: timeAdjustedProb.adjustedDown, marketYes: marketPriceUp, marketNo: marketPriceDown });

      // ── Decision ──
      const decision = decide({
        remainingMinutes: minutesLeft,
        edgeUp: edgeResult.edgeUp,
        edgeDown: edgeResult.edgeDown,
        modelUp: timeAdjustedProb.adjustedUp,
        modelDown: timeAdjustedProb.adjustedDown,
        phases: CONFIG.phases
      });

      // ── Derived display values ──
      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";

      const macdLabel = macdResult === null
        ? "-"
        : macdResult.hist < 0
          ? (macdResult.histDelta !== null && macdResult.histDelta < 0 ? "bearish (expanding)" : "bearish")
          : (macdResult.histDelta !== null && macdResult.histDelta > 0 ? "bullish (expanding)" : "bullish");

      const latestCandle = candles1m.length ? candles1m[candles1m.length - 1] : null;
      const latestClose = latestCandle?.close ?? null;
      const closePrev1m = candles1m.length >= 2 ? candles1m[candles1m.length - 2]?.close ?? null : null;
      const closePrev3m = candles1m.length >= 4 ? candles1m[candles1m.length - 4]?.close ?? null : null;
      const delta1m = latestClose !== null && closePrev1m !== null ? latestClose - closePrev1m : null;
      const delta3m = latestClose !== null && closePrev3m !== null ? latestClose - closePrev3m : null;

      // ── Narratives ──
      const heikenNarrative = (heikenAshiStreak.color ?? "").toLowerCase() === "green" ? "LONG" : (heikenAshiStreak.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
      const rsiNarrative = narrativeFromSlope(rsiSlope);
      const macdNarrative = narrativeFromSign(macdResult?.hist ?? null);
      const vwapNarrative = narrativeFromSign(vwapDistance);

      // ── Prediction display ──
      const probUp = timeAdjustedProb?.adjustedUp ?? null;
      const probDown = timeAdjustedProb?.adjustedDown ?? null;
      const predictNarrative = (probUp !== null && probDown !== null && Number.isFinite(probUp) && Number.isFinite(probDown))
        ? (probUp > probDown ? "LONG" : probDown > probUp ? "SHORT" : "NEUTRAL")
        : "NEUTRAL";
      const predictDisplayValue = `${ANSI.green}LONG${ANSI.reset} ${ANSI.green}${formatProbabilityPercent(probUp, 0)}${ANSI.reset} / ${ANSI.red}SHORT${ANSI.reset} ${ANSI.red}${formatProbabilityPercent(probDown, 0)}${ANSI.reset}`;

      // ── Polymarket display ──
      const marketUpDisplay = `${marketPriceUp ?? "-"}${marketPriceUp === null || marketPriceUp === undefined ? "" : "¢"}`;
      const marketDownDisplay = `${marketPriceDown ?? "-"}${marketPriceDown === null || marketPriceDown === undefined ? "" : "¢"}`;
      const polymarketHeaderValue = `${ANSI.green}↑ UP${ANSI.reset} ${marketUpDisplay}  |  ${ANSI.red}↓ DOWN${ANSI.reset} ${marketDownDisplay}`;

      // ── Indicator lines ──
      const heikenDisplayValue = `${heikenAshiStreak.color ?? "-"} x${heikenAshiStreak.count}`;
      const heikenLine = formatNarrativeValue("Heiken Ashi", heikenDisplayValue, heikenNarrative);

      const rsiArrow = rsiSlope !== null && rsiSlope < 0 ? "↓" : rsiSlope !== null && rsiSlope > 0 ? "↑" : "-";
      const rsiDisplayValue = `${formatNumber(currentRsi, 1)} ${rsiArrow}`;
      const rsiLine = formatNarrativeValue("RSI", rsiDisplayValue, rsiNarrative);

      const macdLine = formatNarrativeValue("MACD", macdLabel, macdNarrative);

      const delta1Narrative = narrativeFromSign(delta1m);
      const delta3Narrative = narrativeFromSign(delta3m);
      const deltaDisplayValue = `${colorByNarrative(formatSignedDelta(delta1m, latestClose), delta1Narrative)} | ${colorByNarrative(formatSignedDelta(delta3m, latestClose), delta3Narrative)}`;

      const vwapDisplayValue = `${formatNumber(currentVwap, 0)} (${formatPct(vwapDistance, 2)}) | slope ${vwapSlopeLabel}`;
      const vwapLine = formatNarrativeValue("VWAP", vwapDisplayValue, vwapNarrative);

      // ── New indicator display lines ──
      const bollingerNarrative = bollingerResult === null ? "NEUTRAL" : bollingerResult.percentB < 0.2 ? "LONG" : bollingerResult.percentB > 0.8 ? "SHORT" : "NEUTRAL";
      const bollingerDisplayValue = bollingerResult === null ? "-" : `${bollingerResult.percentB.toFixed(2)} (%B) | BW ${(bollingerResult.bandwidth * 100).toFixed(2)}%${bollingerResult.isSqueeze ? " SQUEEZE" : ""}`;

      const stochRsiNarrative = stochRsiResult === null ? "NEUTRAL" : stochRsiResult.oversold ? "LONG" : stochRsiResult.overbought ? "SHORT" : stochRsiResult.crossUp ? "LONG" : stochRsiResult.crossDown ? "SHORT" : "NEUTRAL";
      const stochRsiCrossLabel = stochRsiResult === null ? "" : stochRsiResult.crossUp ? " ✕UP" : stochRsiResult.crossDown ? " ✕DN" : "";
      const stochRsiDisplayValue = stochRsiResult === null ? "-" : `K ${stochRsiResult.k.toFixed(0)} / D ${stochRsiResult.d.toFixed(0)}${stochRsiCrossLabel}${stochRsiResult.overbought ? " OB" : stochRsiResult.oversold ? " OS" : ""}`;

      const emaCrossNarrative = emaCrossResult === null ? "NEUTRAL" : emaCrossResult.bullish ? "LONG" : "SHORT";
      const emaCrossLabel = emaCrossResult === null ? "-" : emaCrossResult.crossUp ? "CROSS ↑" : emaCrossResult.crossDown ? "CROSS ↓" : emaCrossResult.bullish ? "bullish" : "bearish";
      const emaCrossSpreadText = emaCrossResult === null ? "" : ` ($${Math.abs(emaCrossResult.spread).toFixed(0)})`;
      const emaCrossDisplayValue = emaCrossResult === null ? "-" : `${emaCrossLabel}${emaCrossSpreadText}`;

      const obvNarrative = obvResult === null ? "NEUTRAL" : obvResult.divergence === "bullish_div" ? "LONG" : obvResult.divergence === "bearish_div" ? "SHORT" : obvResult.slope > 0 ? "LONG" : obvResult.slope < 0 ? "SHORT" : "NEUTRAL";
      const obvDivLabel = obvResult === null ? "" : obvResult.divergence === "bullish_div" ? " DIV↑" : obvResult.divergence === "bearish_div" ? " DIV↓" : "";
      const obvDisplayValue = obvResult === null ? "-" : `${obvResult.slope > 0 ? "↑" : obvResult.slope < 0 ? "↓" : "─"} ${obvResult.divergence === "confirming" ? "confirming" : "DIVERGENCE"}${obvDivLabel}`;

      const atrDisplayValue = atrResult === null ? "-" : `$${atrResult.atr.toFixed(2)} (${atrResult.volatilityLevel})`;

      // ── Signal ──
      const signalLabel = decision.action === "ENTER" ? (decision.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE";

      // ── Spread + liquidity ──
      const spreadUp = polymarketData.ok ? polymarketData.orderbook.up.spread : null;
      const spreadDown = polymarketData.ok ? polymarketData.orderbook.down.spread : null;
      const maxSpread = spreadUp !== null && spreadDown !== null ? Math.max(spreadUp, spreadDown) : (spreadUp ?? spreadDown);
      const liquidityAmount = polymarketData.ok
        ? (Number(polymarketData.market?.liquidityNum) || Number(polymarketData.market?.liquidity) || null)
        : null;

      // ── Spot + chainlink prices ──
      const spotPrice = binanceLivePrice ?? binanceLastPrice;
      const chainlinkPrice = chainlinkData?.price ?? null;
      const marketSlug = polymarketData.ok ? String(polymarketData.market?.slug ?? "") : "";

      const marketStartMs = polymarketData.ok && polymarketData.market?.eventStartTime ? new Date(polymarketData.market.eventStartTime).getTime() : null;

      // ── Price-to-beat latch ──
      if (marketSlug && priceToBeatState.slug !== marketSlug) {
        priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
      }

      if (priceToBeatState.slug && priceToBeatState.value === null && chainlinkPrice !== null) {
        const nowMs = Date.now();
        const canLatch = marketStartMs === null ? true : nowMs >= marketStartMs;
        if (canLatch) {
          priceToBeatState = { slug: priceToBeatState.slug, value: Number(chainlinkPrice), setAtMs: nowMs };
        }
      }

      const priceToBeat = priceToBeatState.slug === marketSlug ? priceToBeatState.value : null;

      // ── Current price display ──
      const chainlinkPriceBaseLine = colorPriceLine({
        label: "CURRENT PRICE",
        price: chainlinkPrice,
        previousPrice: previousChainlinkPrice,
        decimals: 2,
        prefix: "$"
      });

      const priceToBeatDelta = (chainlinkPrice !== null && priceToBeat !== null && Number.isFinite(chainlinkPrice) && Number.isFinite(priceToBeat))
        ? chainlinkPrice - priceToBeat
        : null;
      const priceToBeatDeltaColor = priceToBeatDelta === null
        ? ANSI.gray
        : priceToBeatDelta > 0
          ? ANSI.green
          : priceToBeatDelta < 0
            ? ANSI.red
            : ANSI.gray;
      const priceToBeatDeltaText = priceToBeatDelta === null
        ? `${ANSI.gray}-${ANSI.reset}`
        : `${priceToBeatDeltaColor}${priceToBeatDelta > 0 ? "+" : priceToBeatDelta < 0 ? "-" : ""}$${Math.abs(priceToBeatDelta).toFixed(2)}${ANSI.reset}`;
      const chainlinkPriceDisplayValue = chainlinkPriceBaseLine.split(": ")[1] ?? chainlinkPriceBaseLine;
      const chainlinkPriceLine = keyValue("CURRENT PRICE:", `${chainlinkPriceDisplayValue} (${priceToBeatDeltaText})`);

      // ── Dump market JSON for debugging ──
      if (polymarketData.ok && polymarketData.market) {
        const slug = safeFileSlug(polymarketData.market.slug || polymarketData.market.id || "market");
        if (slug && !dumpedMarketSlugs.has(slug)) {
          dumpedMarketSlugs.add(slug);
          try {
            fs.mkdirSync("./logs", { recursive: true });
            fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(polymarketData.market, null, 2), "utf8");
          } catch {
            // ignore
          }
        }
      }

      // ── Binance spot display ──
      const exchanges = getExchangeTickers();

      // ── Oracle Lag & Spread ──
      const oracleLagMs = (binanceTickTs !== null && chainlinkTickTs !== null)
        ? Math.abs(binanceTickTs - chainlinkTickTs)
        : null;
      const binanceVsOracle = (spotPrice !== null && chainlinkPrice !== null && Number.isFinite(spotPrice) && Number.isFinite(chainlinkPrice))
        ? spotPrice - chainlinkPrice
        : null;
      const exchangePrices = [
        exchanges.binance.price, exchanges.coinbase.price, exchanges.kraken.price,
        exchanges.bybit.price, exchanges.okx.price
      ].filter(p => p !== null && Number.isFinite(p));
      const oracleSpreadPct = (exchangePrices.length >= 2 && chainlinkPrice !== null && Number.isFinite(chainlinkPrice) && chainlinkPrice > 0)
        ? ((Math.max(...exchangePrices) - Math.min(...exchangePrices)) / chainlinkPrice) * 100
        : null;
      
      const binancePrice = exchanges.binance.price ?? spotPrice;
      const binanceVolume = exchanges.binance.volume ? `${formatNumber(exchanges.binance.volume, 1)} BTC` : "-";
      const binanceSpotBaseLine = colorPriceLine({ label: "BTC (Binance)", price: binancePrice, previousPrice: previousSpotPrice, decimals: 0, prefix: "$" });
      const binanceVsChainlinkDiff = (binancePrice !== null && chainlinkPrice !== null && Number.isFinite(binancePrice) && Number.isFinite(chainlinkPrice) && chainlinkPrice !== 0)
        ? (() => {
          const diffUsd = binancePrice - chainlinkPrice;
          const diffPct = (diffUsd / chainlinkPrice) * 100;
          const sign = diffUsd > 0 ? "+" : diffUsd < 0 ? "-" : "";
          return ` (${sign}$${Math.abs(diffUsd).toFixed(2)}, ${sign}${Math.abs(diffPct).toFixed(2)}%)`;
        })()
        : "";
      const binanceSpotDisplayValue = ((binanceSpotBaseLine + binanceVsChainlinkDiff).split(": ")[1] ?? binanceSpotBaseLine) + ` | Vol: ${binanceVolume}`;
      const binanceSpotLine = keyValue("BTC (Binance):", binanceSpotDisplayValue);

      // ── Coinbase spot display ──
      const coinbasePrice = exchanges.coinbase.price;
      const coinbaseVolume = exchanges.coinbase.volume ? `${formatNumber(exchanges.coinbase.volume, 1)} BTC` : "-";
      const coinbaseSpotBaseLine = colorPriceLine({ label: "BTC (Coinbase)", price: coinbasePrice, previousPrice: previousCoinbasePrice, decimals: 0, prefix: "$" });
      const coinbaseVsChainlinkDiff = (coinbasePrice !== null && chainlinkPrice !== null && Number.isFinite(coinbasePrice) && Number.isFinite(chainlinkPrice) && chainlinkPrice !== 0)
        ? (() => {
          const diffUsd = coinbasePrice - chainlinkPrice;
          const diffPct = (diffUsd / chainlinkPrice) * 100;
          const sign = diffUsd > 0 ? "+" : diffUsd < 0 ? "-" : "";
          return ` (${sign}$${Math.abs(diffUsd).toFixed(2)}, ${sign}${Math.abs(diffPct).toFixed(2)}%)`;
        })()
        : "";
      const coinbaseSpotDisplayValue = ((coinbaseSpotBaseLine + coinbaseVsChainlinkDiff).split(": ")[1] ?? coinbaseSpotBaseLine) + ` | Vol: ${coinbaseVolume}`;
      const coinbaseSpotLine = keyValue("BTC (Coinbase):", coinbaseSpotDisplayValue);

      // ── Kraken spot display ──
      const krakenPrice = exchanges.kraken.price;
      const krakenVolume = exchanges.kraken.volume ? `${formatNumber(exchanges.kraken.volume, 1)} BTC` : "-";
      const krakenSpotBaseLine = colorPriceLine({ label: "BTC (Kraken)", price: krakenPrice, previousPrice: previousKrakenPrice, decimals: 0, prefix: "$" });
      const krakenVsChainlinkDiff = (krakenPrice !== null && chainlinkPrice !== null && Number.isFinite(krakenPrice) && Number.isFinite(chainlinkPrice) && chainlinkPrice !== 0)
        ? (() => {
          const diffUsd = krakenPrice - chainlinkPrice;
          const diffPct = (diffUsd / chainlinkPrice) * 100;
          const sign = diffUsd > 0 ? "+" : diffUsd < 0 ? "-" : "";
          return ` (${sign}$${Math.abs(diffUsd).toFixed(2)}, ${sign}${Math.abs(diffPct).toFixed(2)}%)`;
        })()
        : "";
      const krakenSpotDisplayValue = ((krakenSpotBaseLine + krakenVsChainlinkDiff).split(": ")[1] ?? krakenSpotBaseLine) + ` | Vol: ${krakenVolume}`;
      const krakenSpotLine = keyValue("BTC (Kraken):", krakenSpotDisplayValue);

      // ── Bybit spot display ──
      const bybitPrice = exchanges.bybit.price;
      const bybitVolume = exchanges.bybit.volume ? `${formatNumber(exchanges.bybit.volume, 1)} BTC` : "-";
      const bybitSpotBaseLine = colorPriceLine({ label: "BTC (Bybit)", price: bybitPrice, previousPrice: previousBybitPrice, decimals: 0, prefix: "$" });
      const bybitVsChainlinkDiff = (bybitPrice !== null && chainlinkPrice !== null && Number.isFinite(bybitPrice) && Number.isFinite(chainlinkPrice) && chainlinkPrice !== 0)
        ? (() => {
          const diffUsd = bybitPrice - chainlinkPrice;
          const diffPct = (diffUsd / chainlinkPrice) * 100;
          const sign = diffUsd > 0 ? "+" : diffUsd < 0 ? "-" : "";
          return ` (${sign}$${Math.abs(diffUsd).toFixed(2)}, ${sign}${Math.abs(diffPct).toFixed(2)}%)`;
        })()
        : "";
      const bybitSpotDisplayValue = ((bybitSpotBaseLine + bybitVsChainlinkDiff).split(": ")[1] ?? bybitSpotBaseLine) + ` | Vol: ${bybitVolume}`;
      const bybitSpotLine = keyValue("BTC (Bybit):", bybitSpotDisplayValue);

      // ── OKX spot display ──
      const okxPrice = exchanges.okx.price;
      const okxVolume = exchanges.okx.volume ? `${formatNumber(exchanges.okx.volume, 1)} BTC` : "-";
      const okxSpotBaseLine = colorPriceLine({ label: "BTC (OKX)", price: okxPrice, previousPrice: previousOkxPrice, decimals: 0, prefix: "$" });
      const okxVsChainlinkDiff = (okxPrice !== null && chainlinkPrice !== null && Number.isFinite(okxPrice) && Number.isFinite(chainlinkPrice) && chainlinkPrice !== 0)
        ? (() => {
          const diffUsd = okxPrice - chainlinkPrice;
          const diffPct = (diffUsd / chainlinkPrice) * 100;
          const sign = diffUsd > 0 ? "+" : diffUsd < 0 ? "-" : "";
          return ` (${sign}$${Math.abs(diffUsd).toFixed(2)}, ${sign}${Math.abs(diffPct).toFixed(2)}%)`;
        })()
        : "";
      const okxSpotDisplayValue = ((okxSpotBaseLine + okxVsChainlinkDiff).split(": ")[1] ?? okxSpotBaseLine) + ` | Vol: ${okxVolume}`;
      const okxSpotLine = keyValue("BTC (OKX):", okxSpotDisplayValue);

      // ── Market info ──
      const titleLine = polymarketData.ok ? `${polymarketData.market?.question ?? "-"}` : "-";
      const marketLine = keyValue("Market:", polymarketData.ok ? (polymarketData.market?.slug ?? "-") : "-");

      // ── Timer colors ──
      const timerColor = getTimerColor(minutesLeft);
      const polymarketTimerColor = settlementMinutesLeft !== null ? getTimerColor(settlementMinutesLeft) : ANSI.reset;

      // ── Render dashboard ──
      const lines = [
        titleLine,
        marketLine,
        keyValue("Time left:", `${timerColor}${formatTimeLeft(minutesLeft)}${ANSI.reset}`),
        "",
        separatorLine(),
        "",
        keyValue("TA Predict:", `${predictDisplayValue}  ${ANSI.dim}${ANSI.gray}← Consenso (>55% bias claro, ~50% neutro/indecisão)${ANSI.reset}`),
        keyValue("Heiken Ashi:", `${heikenLine.split(": ")[1] ?? heikenLine}  ${ANSI.dim}${ANSI.gray}← Tendência limpa (verde=alta, vermelho=baixa, doji=alerta de reversão)${ANSI.reset}`),
        keyValue("RSI:", `${rsiLine.split(": ")[1] ?? rsiLine}  ${ANSI.dim}${ANSI.gray}← Velocidade/Momentum (>70 rápido overbought, <30 rápido oversold, setas=aceleração)${ANSI.reset}`),
        keyValue("MACD:", `${macdLine.split(": ")[1] ?? macdLine}  ${ANSI.dim}${ANSI.gray}← Direção/Força (expanding=acelerando, contracting=perdendo força, cross=inversão)${ANSI.reset}`),
        keyValue("Delta 1/3:", `${`Delta 1/3Min: ${deltaDisplayValue}`.split(": ")[1] ?? deltaDisplayValue}  ${ANSI.dim}${ANSI.gray}← Agressão micro (+compra, -venda, diferença=briga/pullback)${ANSI.reset}`),
        keyValue("VWAP:", `${vwapLine.substring(vwapLine.indexOf(": ") + 2)}  ${ANSI.dim}${ANSI.gray}← Âncora máster (Acima=bull, %alto=ímã | UP=comprador, DOWN=vendedor, FLAT=empacado)${ANSI.reset}`),
        keyValue("Bollinger:", `${colorByNarrative(bollingerDisplayValue, bollingerNarrative)}  ${ANSI.dim}${ANSI.gray}← Limites (%B>0.8 teto, <0.2 chão, Squeeze=compressão/movimento explosivo iminente)${ANSI.reset}`),
        keyValue("Stoch RSI:", `${colorByNarrative(stochRsiDisplayValue, stochRsiNarrative)}  ${ANSI.dim}${ANSI.gray}← Super oscilador (OB/OS exaustão, K cross D em extremo=sinal rápido)${ANSI.reset}`),
        keyValue("EMA 9/21:", `${colorByNarrative(emaCrossDisplayValue, emaCrossNarrative)}  ${ANSI.dim}${ANSI.gray}← Rastreador clássico (Cross=reversão, distância em $=força da tendência)${ANSI.reset}`),
        keyValue("OBV:", `${colorByNarrative(obvDisplayValue, obvNarrative)}  ${ANSI.dim}${ANSI.gray}← Dinheiro real da jogada (Confirming=movimento sustentável, DIV=alerta de fakeout/armadilha)${ANSI.reset}`),
        keyValue("ATR:", `${ANSI.gray}${atrDisplayValue}${ANSI.reset}  ${ANSI.dim}${ANSI.gray}← Velocidade/Oscilação (High=alvo e stop maiores, Low=mercado mastigando/travado)${ANSI.reset}`),
        "",
        separatorLine(),
        "",
        keyValue("POLYMARKET:", polymarketHeaderValue),
        liquidityAmount !== null ? keyValue("Liquidity:", formatNumber(liquidityAmount, 0)) : null,
        settlementMinutesLeft !== null ? keyValue("Time left:", `${polymarketTimerColor}${formatTimeLeft(settlementMinutesLeft)}${ANSI.reset}`) : null,
        keyValue("PRICE TO BEAT: ", priceToBeat !== null ? `$${formatNumber(priceToBeat, 0)}` : `${ANSI.gray}-${ANSI.reset}`),
        chainlinkPriceLine,
        "",
        separatorLine(),
        "",
        binanceSpotLine,
        coinbaseSpotLine,
        krakenSpotLine,
        bybitSpotLine,
        okxSpotLine,
        keyValue("Oracle Lag:", `${oracleLagMs !== null ? `${(oracleLagMs / 1000).toFixed(1)}s` : "-"}  ${ANSI.dim}${ANSI.gray}| Spread: ${oracleSpreadPct !== null ? `${oracleSpreadPct.toFixed(3)}%` : "-"} | Bin vs Oracle: ${binanceVsOracle !== null ? `${binanceVsOracle > 0 ? "+" : ""}$${binanceVsOracle.toFixed(2)}` : "-"}${ANSI.reset}`),
        "",
        separatorLine(),
        "",
        keyValue("ET | Session:", `${ANSI.white}${formatEasternTime(new Date())}${ANSI.reset} | ${ANSI.white}${getBtcSession(new Date())}${ANSI.reset}`),
        "",
        separatorLine(),
        centerText(`${ANSI.dim}${ANSI.gray}created by @krajekis${ANSI.reset}`, screenWidth())
      ].filter((line) => line !== null);

      renderScreen(lines.join("\n") + "\n");

      // ── Update previous prices ──
      previousSpotPrice = exchanges.binance.price ?? spotPrice ?? previousSpotPrice;
      previousCoinbasePrice = exchanges.coinbase.price ?? previousCoinbasePrice;
      previousKrakenPrice = exchanges.kraken.price ?? previousKrakenPrice;
      previousBybitPrice = exchanges.bybit.price ?? previousBybitPrice;
      previousOkxPrice = exchanges.okx.price ?? previousOkxPrice;
      previousChainlinkPrice = chainlinkPrice ?? previousChainlinkPrice;

      // ── Snapshot CSV Logic (grava nos últimos segundos do candle) ──
      const shouldSnapshot = marketSlug && minutesLeft <= 0.15 && snapshotSavedForSlug !== marketSlug;

      if (marketSlug && snapshotSavedForSlug !== null && snapshotSavedForSlug !== marketSlug) {
        // Novo candle detectado: resetar flag para permitir snapshot do próximo
        snapshotSavedForSlug = null;
      }

      if (shouldSnapshot) {
        snapshotSavedForSlug = marketSlug;
        appendCsvRow("./logs/snapshots.csv", snapshotCsvHeader, [
          new Date().toISOString(),
          marketSlug,
          CONFIG.candleWindowMinutes,
          minutesLeft.toFixed(3),
          timeAdjustedProb?.adjustedUp,
          timeAdjustedProb?.adjustedDown,
          heikenAshiStreak?.color,
          heikenAshiStreak?.count,
          currentRsi,
          rsiSlope,
          macdResult?.hist,
          macdLabel,
          delta1m,
          delta1m !== null && latestClose !== null ? (delta1m / latestClose) * 100 : null,
          delta3m,
          delta3m !== null && latestClose !== null ? (delta3m / latestClose) * 100 : null,
          currentVwap,
          vwapDistance !== null ? vwapDistance * 100 : null,
          vwapSlopeLabel,
          bollingerResult?.percentB,
          bollingerResult !== null ? bollingerResult.bandwidth * 100 : null,
          bollingerResult?.isSqueeze,
          stochRsiResult?.k,
          stochRsiResult?.d,
          stochRsiCrossLabel,
          emaCrossLabel,
          emaCrossResult?.spread,
          obvResult?.slope,
          obvResult?.divergence,
          atrResult?.atr,
          atrResult?.volatilityLevel,
          marketPriceUp,
          marketPriceDown,
          liquidityAmount,
          priceToBeat,
          chainlinkPrice,
          exchanges.binance.price,
          exchanges.binance.volume,
          exchanges.coinbase.price,
          exchanges.coinbase.volume,
          exchanges.kraken.price,
          exchanges.kraken.volume,
          exchanges.bybit.price,
          exchanges.bybit.volume,
          exchanges.okx.price,
          exchanges.okx.volume,
          oracleLagMs,
          binanceVsOracle,
          oracleSpreadPct,
          regimeInfo.regime,
          signalLabel,
          edgeResult.edgeUp,
          edgeResult.edgeDown,
          decision.action === "ENTER" ? `${decision.side}:${decision.phase}:${decision.strength}` : "NO_TRADE"
        ]);
      }

      // ── Log to CSV ──
      appendCsvRow("./logs/signals.csv", csvHeader, [
        new Date().toISOString(),
        candleTiming.elapsedMinutes.toFixed(3),
        minutesLeft.toFixed(3),
        regimeInfo.regime,
        signalLabel,
        timeAdjustedProb.adjustedUp,
        timeAdjustedProb.adjustedDown,
        marketPriceUp,
        marketPriceDown,
        edgeResult.edgeUp,
        edgeResult.edgeDown,
        decision.action === "ENTER" ? `${decision.side}:${decision.phase}:${decision.strength}` : "NO_TRADE"
      ]);
    } catch (err) {
      console.log("────────────────────────────");
      console.log(`Error: ${err?.message ?? String(err)}`);
      console.log("────────────────────────────");
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

main();
