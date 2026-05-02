/**
 * serverScalp.js — Fase 1 Operacional Scalp-Only
 *
 * Entrypoint mínimo focado em manter operacional Scalp Force 5m + 15m
 * (DRY e LIVE). Pausa todo o resto (análises, históricos não-Scalp,
 * sync de resolução). Ver MEMORY.md sessão 29-30/04/2026 para o backlog
 * Fase 2.
 *
 * Uso: `npm run start:scalp` → http://localhost:3000
 */

import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import "dotenv/config";

// Diagnostics — subscribe ANTES de qualquer tráfego HTTP.
import { startEventLoopMonitor } from "./diagnostics/eventLoopMonitor.js";
import { startHttpDebug } from "./diagnostics/httpDebug.js";
import { startMemoryMonitor } from "./diagnostics/memoryMonitor.js";
import { diagLog } from "./diagnostics/diagSink.js";
startEventLoopMonitor();
startHttpDebug();
startMemoryMonitor();

import express from "express";
import http from "node:http";
import v8 from "node:v8";
import { WebSocketServer } from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG, WINDOW_PRESETS, applyWindowPreset } from "./config.js";
import { applyLiveCloseToLatestCandle, primeBinanceFeedHosts } from "./data/binance.js";
import { fetchIndicatorMarketBundle } from "./data/indicatorMarketFetch.js";
import { buildFeedSourcesSnapshot } from "./data/feedSources.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import { fetchChainlinkBtcUsd, ensurePtbForSlug, getCachedPtbForSlug } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  priceToBeatFromMarketWithSource,
  ensureEventPagePtb,
  getCachedEventPagePtb,
  parsePriceToBeatFromText,
  extractNumericFromMarket,
  isBtcUpDownWindowSlug
} from "./data/polymarket.js";
import { getExchangeTickers } from "./data/exchanges.js";

import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, computeRsiSeries, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { computeBollingerBands } from "./indicators/bollingerBands.js";
import { computeStochasticRsi } from "./indicators/stochasticRsi.js";
import { computeEmaCross } from "./indicators/emaCross.js";
import { computeObv } from "./indicators/obv.js";
import { computeAtr } from "./indicators/atr.js";

import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";
import {
  createScalpRuntime,
  advanceScalp,
  buildScalpCardPayload,
  buildScalpStripPayload,
  closedTradeToCsvRow,
  computeExchangeMedian,
  migrateScalpTradesCsvIfNeeded,
  SCALP_CSV_HEADER
} from "./engines/scalpForce.js";
import { buildSimSignalDirectionStrings } from "./engines/simSignalStrings.js";

import { PolyTrader } from "./polyTrader.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import {
  appendCsvRow,
  countVwapCrosses,
  getCandleWindowTiming,
  pruneOldLogs
} from "./utils.js";
import { isPostgresEnabled } from "./storage/db.js";
import { ensureRuntimeEventSchema, insertRuntimeEvent } from "./storage/runtimeEventStore.js";
import { mergeRuntimeScalpTradesIntoWallet } from "./scalp/mergeRuntimeScalpTradesIntoWallet.js";
import {
  buildScalpStrategyGraphFromConfig,
  embedConfigIntoScalpGraph,
  compileScalpStrategyGraphToPatch,
  SCALP_DIRECTION_EXCHANGE_KEYS,
  getScalpDirectionSourceKeys,
  exchangePricesForMedianFromKeys
} from "./scalp/strategyGraph.js";
import {
  coerceScalpBindingFamilies,
  marketSlugAllowedForScalpBinding
} from "./scalp/slugBinding.js";
import { ensureTradeHistorySchema } from "./storage/tradeHistoryStore.js";

applyGlobalProxyFromEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ────────────────────────────────────────────────────────
// Diagnostics local helper
// ────────────────────────────────────────────────────────

function logEngineDiagnostic(event, data, level = "warn") {
  const line = `[watchdog] ${event} ${JSON.stringify(data)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  if (isPostgresEnabled()) {
    insertRuntimeEvent({
      eventType: event,
      timeframe: data?.timeframe || data?.tf || null,
      marketSlug: data?.marketSlug || null,
      timestamp: new Date().toISOString(),
      raw: data
    }).catch(() => { /* swallow — diagnostics não pode quebrar o app */ });
  }
}

// ────────────────────────────────────────────────────────
// Express + WebSocket
// ────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// Endpoints Fase 2 (pausados) — devolvem 503 limpo para o frontend não logar erro silencioso.
const PHASE_2_DISABLED = (req, res) => res.status(503).json({
  error: "phase_1_scalp_only",
  message: "Endpoint disponibilizado na Fase 2. Modo atual: Scalp-Only."
});
app.get("/api/trade-history", PHASE_2_DISABLED);
app.post("/api/resolve-trades", PHASE_2_DISABLED);
app.get("/api/analysis/:tf", PHASE_2_DISABLED);

app.post("/api/client-log", (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const event = String(body.event || "client_event").slice(0, 80);
  logEngineDiagnostic(`client.${event}`, {
    tf: body.tf || null,
    data: body.data || {},
    ip: req.ip,
    userAgent: String(req.headers["user-agent"] || "").slice(0, 160)
  }, body.level === "error" ? "error" : "warn");
  res.json({ ok: true });
});

function broadcast(payload) {
  if (!payload) return;
  const json = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try { client.send(json); } catch { /* ignore */ }
    }
  }
}

// ────────────────────────────────────────────────────────
// PolyTrader
// ────────────────────────────────────────────────────────

const polyTrader = new PolyTrader();
polyTrader.init().catch(err => console.error("PolyTrader init failed:", err));

// ────────────────────────────────────────────────────────
// Trading config (Scalp-only — DRY e LIVE por timeframe)
// ────────────────────────────────────────────────────────

const SCALP_5M = "Scalp Force 5m";
const SCALP_15M = "Scalp Force 15m";
const SCALP_INDICATORS = [SCALP_5M, SCALP_15M];
const DEFAULT_STAKE = 1;
const RUNTIME_CONFIG_PATH = path.join(__dirname, "..", "logs", "trading_config.runtime.json");

function makeDefaultScalpConfig(timeframeMinutes) {
  return {
    stakeUsd: 1,
    entryMinPct: 50,
    entryMaxPct: 55,
    takeProfitPct: 75,
    minExitPct: 58,
    tpExitMode: "exit",
    tpTrailCents: 3,
    tpForceExitEnabled: true,
    tpForceFailTicks: 2,
    trailingArmingCents: 2,
    trailingCushionCents: 3,
    maxEntriesPerCandle: 2,
    entryOpenWindowSec: timeframeMinutes === 15 ? 30 : 20,
    maxHoldSec: timeframeMinutes === 15 ? 300 : 150,
    minSharesFloor: 5,
    maxEffectiveStakeUsd: 10,
    enabled: false,
    liveMode: false
  };
}

const tradingConfig = {
  indicatorConfigs: {
    [SCALP_5M]: makeDefaultScalpConfig(5),
    [SCALP_15M]: makeDefaultScalpConfig(15)
  },
  /** @type {Record<string, { allowedSlugFamilies?: string[], graph?: object | null }>} */
  scalpStrategyBindings: {
    [SCALP_5M]: { allowedSlugFamilies: ["btc-updown-5m"], graph: null },
    [SCALP_15M]: { allowedSlugFamilies: ["btc-updown-15m"], graph: null }
  }
};

function buildScalpBindingsPayload() {
  const out = {};
  for (const name of SCALP_INDICATORS) {
    const cfg = getScalpConfig(name);
    const entry = tradingConfig.scalpStrategyBindings[name] || {};
    const families = coerceScalpBindingFamilies(name);
    let graph = entry.graph;
    if (!graph || typeof graph !== "object") {
      graph = embedConfigIntoScalpGraph(buildScalpStrategyGraphFromConfig(cfg, name), cfg);
    } else {
      graph = embedConfigIntoScalpGraph(graph, cfg);
    }
    out[name] = { allowedSlugFamilies: [...families], graph };
  }
  return out;
}

function getScalpConfig(name) { return tradingConfig.indicatorConfigs[name]; }
function isScalpEnabled(name) { return Boolean(tradingConfig.indicatorConfigs[name]?.enabled); }
function isScalpLive(name)    { return Boolean(tradingConfig.indicatorConfigs[name]?.liveMode); }

function clampNumber(val, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function mergeScalpConfigPatch(current, patch) {
  if (!patch || typeof patch !== "object") return current;
  const next = { ...current };
  const numericFields = {
    stakeUsd: [0.1, 10_000], entryMinPct: [0, 100], entryMaxPct: [0, 100],
    takeProfitPct: [0, 100], minExitPct: [0, 100], tpTrailCents: [0, 100],
    tpForceFailTicks: [1, 20], trailingArmingCents: [0, 100], trailingCushionCents: [0, 100],
    maxEntriesPerCandle: [1, 20], entryOpenWindowSec: [1, 3600], maxHoldSec: [1, 86_400],
    minSharesFloor: [0, 10_000], maxEffectiveStakeUsd: [0.1, 10_000]
  };
  for (const [field, [min, max]] of Object.entries(numericFields)) {
    if (patch[field] === undefined) continue;
    const v = clampNumber(patch[field], min, max);
    if (v !== null) {
      next[field] = field.endsWith("Sec") || field === "tpForceFailTicks" || field === "minSharesFloor" || field === "maxEntriesPerCandle"
        ? Math.round(v)
        : Math.round(v * 100) / 100;
    }
  }
  if (patch.tpExitMode !== undefined) next.tpExitMode = patch.tpExitMode === "trail" ? "trail" : "exit";
  if (typeof patch.tpForceExitEnabled === "boolean") next.tpForceExitEnabled = patch.tpForceExitEnabled;
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (typeof patch.liveMode === "boolean") next.liveMode = patch.liveMode;
  if (Number.isFinite(next.entryMinPct) && Number.isFinite(next.entryMaxPct) && next.entryMinPct > next.entryMaxPct) {
    const mid = (next.entryMinPct + next.entryMaxPct) / 2;
    next.entryMinPct = mid;
    next.entryMaxPct = mid;
  }
  return next;
}

function buildConfigPayload() {
  const indicatorConfigs = {};
  for (const name of SCALP_INDICATORS) {
    indicatorConfigs[name] = { ...getScalpConfig(name) };
  }
  return {
    allIndicators: SCALP_INDICATORS,
    scalpIndicators: SCALP_INDICATORS,
    only15mIndicators: [SCALP_15M],
    only5mIndicators:  [SCALP_5M],
    enabledIndicators5m: isScalpEnabled(SCALP_5M)  ? [SCALP_5M]  : [],
    enabledIndicators15m: isScalpEnabled(SCALP_15M) ? [SCALP_15M] : [],
    stakesPerIndicator: Object.fromEntries(SCALP_INDICATORS.map(n => [n, getScalpConfig(n).stakeUsd])),
    indicatorConfigs,
    scalpStrategyBindings: buildScalpBindingsPayload(),
    dryRun: polyTrader.dryRun,
    maxStake: polyTrader.maxStake,
    initialized: polyTrader.initialized,
    walletAddress: polyTrader.wallet?.address || null,
    operationalMode: "scalp_only_phase_1"
  };
}

function loadPersistedTradingConfig() {
  try {
    if (!fs.existsSync(RUNTIME_CONFIG_PATH)) return;
    const raw = fs.readFileSync(RUNTIME_CONFIG_PATH, "utf8");
    const payload = JSON.parse(raw);
    if (payload?.indicatorConfigs && typeof payload.indicatorConfigs === "object") {
      for (const name of SCALP_INDICATORS) {
        const persisted = payload.indicatorConfigs[name];
        if (persisted && typeof persisted === "object") {
          tradingConfig.indicatorConfigs[name] = mergeScalpConfigPatch(
            tradingConfig.indicatorConfigs[name],
            persisted
          );
        }
      }
    }
    if (Array.isArray(payload?.enabledIndicators5m) && payload.enabledIndicators5m.includes(SCALP_5M)) {
      tradingConfig.indicatorConfigs[SCALP_5M].enabled = true;
    }
    if (Array.isArray(payload?.enabledIndicators15m) && payload.enabledIndicators15m.includes(SCALP_15M)) {
      tradingConfig.indicatorConfigs[SCALP_15M].enabled = true;
    }
    if (payload?.scalpStrategyBindings && typeof payload.scalpStrategyBindings === "object") {
      for (const name of SCALP_INDICATORS) {
        const b = payload.scalpStrategyBindings[name];
        if (!b || typeof b !== "object") continue;
        tradingConfig.scalpStrategyBindings[name] = {
          allowedSlugFamilies: coerceScalpBindingFamilies(name),
          graph: b.graph && typeof b.graph === "object" ? b.graph : null
        };
      }
    }
    console.log(`⚙️  [Config] runtime carregado de ${RUNTIME_CONFIG_PATH}`);
  } catch (err) {
    console.warn(`⚠️  [Config] falha ao carregar runtime: ${err?.message || err}`);
  }
}

function savePersistedTradingConfig() {
  try {
    const payload = {
      version: 1,
      operationalMode: "scalp_only_phase_1",
      savedAt: new Date().toISOString(),
      enabledIndicators5m:  isScalpEnabled(SCALP_5M)  ? [SCALP_5M]  : [],
      enabledIndicators15m: isScalpEnabled(SCALP_15M) ? [SCALP_15M] : [],
      indicatorConfigs: Object.fromEntries(
        SCALP_INDICATORS.map(name => [name, { ...getScalpConfig(name) }])
      ),
      scalpStrategyBindings: buildScalpBindingsPayload()
    };
    fs.mkdirSync(path.dirname(RUNTIME_CONFIG_PATH), { recursive: true });
    const tmp = `${RUNTIME_CONFIG_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmp, RUNTIME_CONFIG_PATH);
  } catch (err) {
    console.warn(`⚠️  [Config] falha ao salvar runtime: ${err?.message || err}`);
  }
}

// ────────────────────────────────────────────────────────
// Inlined helpers — copiados de server.js para Fase 1
// (Phase 2: extrair para src/scalp/scalpServerHelpers.js compartilhado)
// ────────────────────────────────────────────────────────

function persistRuntimeRow({ eventType, timeframe, marketSlug, timestamp, header, values, filePath }) {
  if (isPostgresEnabled()) {
    insertRuntimeEvent({ eventType, timeframe, marketSlug, timestamp, header, values }).catch(err => {
      logEngineDiagnostic("runtime_event_insert_error", {
        eventType, timeframe, marketSlug,
        error: err?.message || String(err)
      }, "error");
    });
    return;
  }
  appendCsvRow(filePath, header, values);
}

function makeScalpWallet(name) {
  return { name, balance: 0, trades: 0, wins: 0, losses: 0, invested: 0, returned: 0, history: [] };
}

function applyScalpTradeToWallet(wallet, trade) {
  if (!wallet || !trade) return;
  const pnl = Number(trade.pnlUsd);
  const invested = Number(trade.effectiveStakeUsd ?? trade.stakeUsd);
  const returned = Number.isFinite(invested) && Number.isFinite(pnl) ? invested + pnl : 0;
  const normalized = {
    ts: trade.exitTime || trade.entryTime || null,
    slug: trade.marketSlug || "",
    windowMin: Number(trade.windowMin) || null,
    side: trade.side || "",
    entryPrice: Number(trade.entryPrice) || 0,
    exitPrice: Number(trade.exitPrice) || 0,
    exitReason: trade.exitReason || "",
    holdSeconds: Number(trade.holdSeconds) || 0,
    stake: Number(trade.stakeUsd) || 0,
    effectiveStake: Number.isFinite(invested) ? invested : 0,
    shares: Number(trade.shares) || 0,
    pnl: Number.isFinite(pnl) ? pnl : 0,
    tokenId: trade.tokenId || trade.token_id || "",
    orderId: trade.orderId || trade.order_id || ""
  };
  wallet.trades++;
  if (normalized.pnl >= 0) wallet.wins++;
  else wallet.losses++;
  wallet.invested += normalized.effectiveStake;
  wallet.returned += Math.max(0, returned);
  wallet.balance += normalized.pnl;
  wallet.history.push(normalized);
}

function readScalpWalletFromCsv(csvPath, indicatorName) {
  // Versão simplificada: sem lookup de trade_history.json — preserva as colunas
  // tokenId/orderId que já estão no CSV. Phase 1 não precisa enriquecer.
  const wallet = makeScalpWallet(indicatorName);
  if (!fs.existsSync(csvPath)) return wallet;
  try {
    const raw = fs.readFileSync(csvPath, "utf8").trim();
    if (!raw) return wallet;
    const lines = raw.split("\n").map(l => l.replace(/\r$/, ""));
    const header = lines[0]?.split(",") || [];
    const idx = (name) => header.indexOf(name);
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const indicator = cols[idx("indicator")] || indicatorName;
      if (indicator !== indicatorName) continue;
      applyScalpTradeToWallet(wallet, {
        indicator,
        marketSlug: cols[idx("market_slug")],
        windowMin: Number(cols[idx("window_min")]),
        side: cols[idx("side")],
        entryPrice: Number(cols[idx("entry_price")]),
        exitPrice: Number(cols[idx("exit_price")]),
        entryTime: cols[idx("entry_time")],
        exitTime: cols[idx("exit_time")],
        holdSeconds: Number(cols[idx("hold_seconds")]),
        exitReason: cols[idx("exit_reason")],
        stakeUsd: Number(cols[idx("stake_usd")]),
        effectiveStakeUsd: Number(cols[idx("effective_stake_usd")]),
        shares: Number(cols[idx("shares")]),
        pnlUsd: Number(cols[idx("pnl_usd")]),
        tokenId: idx("token_id") >= 0 ? (cols[idx("token_id")] || "") : "",
        orderId: idx("order_id") >= 0 ? (cols[idx("order_id")] || "") : ""
      });
    }
  } catch (err) {
    console.warn(`⚠️  Falha ao ler scalp wallet ${csvPath}: ${err?.message || err}`);
  }
  return wallet;
}

function formatTimeLeft(totalMinutes) {
  const totalSeconds = Math.max(0, Math.floor(totalMinutes * 60));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatEasternTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(now);
  } catch { return "-"; }
}

function getBtcSession(now = new Date()) {
  const hour = now.getUTCHours();
  if (hour >= 13 && hour < 16) return "Europe/US overlap";
  if (hour === 7)              return "Asia/Europe overlap";
  if (hour < 7)                return "Asia";
  if (hour < 13)               return "Europe";
  if (hour < 22)               return "US";
  return "Off-hours";
}

// ────────────────────────────────────────────────────────
// Polymarket resolver — versão lean (sem orderbook, sem PTB page scrape)
// ────────────────────────────────────────────────────────

const POLYMARKET_SNAPSHOT_TIMEOUT_MS = Number(process.env.POLYMARKET_SNAPSHOT_TIMEOUT_MS || 5_000);

// Backoff compartilhado entre engines — quando Gamma falha em UMA engine,
// AMBAS entram em backoff (evita inflight[gamma=2]).
let _sharedGammaLastTimeoutMs = 0;
let _sharedGammaConsecFailures = 0;
function _gammaBackoffMs() {
  return Math.min(20_000 * Math.pow(2, _sharedGammaConsecFailures), 300_000);
}

function timeoutAfter(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms).unref();
  });
}
function withTimeout(promise, ms, label) {
  return Promise.race([promise, timeoutAfter(ms, label)]);
}

// CLOB price fetcher SHARED entre engines (5m e 15m) com circuit breaker.
//
// Causa raiz da cascade RSS (29-30/04): cada `fetchClobPrice` que pendura no
// TLS handshake aloca ~30MB de TLS context em memória nativa. Múltiplos sockets
// pendurados cascatear → RSS 165→444MB em 30s → loopLag 3.2s → processo morto.
//
// Solução: tirar CLOB do path do tick. Background fetcher com:
//  - throttle: max 1 fetch a cada CLOB_FETCH_INTERVAL_MS (3s default)
//  - dedupe:   nunca 2 fetches concorrentes por tokenId
//  - circuit breaker: 3 falhas consecutivas → suspende 60s
//  - timeout agressivo: 1500ms hardcoded
//
// Tick lê do cache. Se cache stale ou breaker aberto, fallback automático para
// gammaPrices (atualizadas via Gamma /events a cada polymarketResolveCacheMs).
const CLOB_CACHE_TTL_MS = Number(process.env.POLYMARKET_CLOB_CACHE_TTL_MS || 5_000);
const CLOB_FETCH_INTERVAL_MS = Number(process.env.POLYMARKET_CLOB_FETCH_INTERVAL_MS || 3_000);
const CLOB_FETCH_TIMEOUT_MS = Number(process.env.POLYMARKET_CLOB_FETCH_TIMEOUT_MS || 1_500);
const CLOB_BREAKER_THRESHOLD = 3;
const CLOB_BREAKER_OPEN_MS = 60_000;

const _clobCache = new Map();        // tokenId → { price, fetchedAt }
const _clobInFlight = new Set();      // tokenId currently being fetched
let _clobConsecFailures = 0;
let _clobBreakerOpenUntil = 0;

function _clobBreakerOpen() {
  return Date.now() < _clobBreakerOpenUntil;
}
function _clobCacheFresh(tokenId) {
  const entry = _clobCache.get(tokenId);
  return entry && (Date.now() - entry.fetchedAt < CLOB_CACHE_TTL_MS);
}
function _getClobPrice(tokenId) {
  const entry = _clobCache.get(tokenId);
  return entry && _clobCacheFresh(tokenId) ? entry.price : null;
}

// Fire-and-forget refresh — NUNCA awaitada pelo caller. Atualiza cache em
// background. Se trava no TLS, isso fica isolado aqui (não bloqueia tick).
function _maybeRefreshClobPrice(tokenId) {
  if (!tokenId) return;
  if (_clobInFlight.has(tokenId)) return;
  if (_clobBreakerOpen()) return;
  const entry = _clobCache.get(tokenId);
  if (entry && Date.now() - entry.fetchedAt < CLOB_FETCH_INTERVAL_MS) return;

  _clobInFlight.add(tokenId);
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort(new Error(`CLOB price timeout after ${CLOB_FETCH_TIMEOUT_MS}ms`));
  }, CLOB_FETCH_TIMEOUT_MS);

  fetchClobPrice({ tokenId, side: "buy", signal: abort.signal })
    .then((price) => {
      if (Number.isFinite(price)) {
        _clobCache.set(tokenId, { price, fetchedAt: Date.now() });
        _clobConsecFailures = 0;
      }
    })
    .catch(() => {
      _clobConsecFailures = Math.min(_clobConsecFailures + 1, 100);
      if (_clobConsecFailures >= CLOB_BREAKER_THRESHOLD) {
        _clobBreakerOpenUntil = Date.now() + CLOB_BREAKER_OPEN_MS;
        if (_clobConsecFailures === CLOB_BREAKER_THRESHOLD) {
          console.warn(`⚠️  CLOB circuit breaker OPEN por ${CLOB_BREAKER_OPEN_MS / 1000}s (3 falhas consecutivas) — usando gammaPrices`);
        }
      }
    })
    .finally(() => {
      clearTimeout(timer);
      _clobInFlight.delete(tokenId);
    });
}

function createPolymarketResolver(preset, tfLabel) {
  const cache = { market: null, fetchedAtMs: 0 };
  let resolveInFlight = null;

  function getCachedMarket() { return cache.market; }

  async function resolve() {
    const now = Date.now();
    if (cache.market && now - cache.fetchedAtMs < CONFIG.polymarketResolveCacheMs) return cache.market;
    if (now - _sharedGammaLastTimeoutMs < _gammaBackoffMs()) {
      if (cache.market) return cache.market;
      throw Object.assign(new Error("Gamma API in backoff — no cached market yet"), { name: "GammaBackoff" });
    }
    if (resolveInFlight) return resolveInFlight;

    resolveInFlight = (async () => {
      try {
        const events = await fetchLiveEventsBySeriesId({ seriesId: preset.seriesId, limit: 25 });
        const allMarkets = flattenEventMarkets(events);
        const selected = pickLatestLiveMarket(allMarkets);
        cache.market = selected;
        cache.fetchedAtMs = Date.now();
        _sharedGammaConsecFailures = 0;
        return selected;
      } catch (err) {
        const msg = err?.message || String(err);
        if (/timeout/i.test(msg)) {
          _sharedGammaLastTimeoutMs = Date.now();
          _sharedGammaConsecFailures = Math.min(_sharedGammaConsecFailures + 1, 10);
        }
        if (cache.market) {
          console.warn(`⚠️  Polymarket fetch falhou; usando cache: ${msg}`);
          return cache.market;
        }
        throw err;
      } finally {
        resolveInFlight = null;
      }
    })();
    return resolveInFlight;
  }

  async function fetchSnapshot() {
    // Snapshot agora SÓ chama Gamma /events (cacheado por polymarketResolveCacheMs).
    // CLOB prices vêm de cache de background fetcher. ZERO chamadas CLOB no tick path.
    const market = await resolve();
    if (!market) return { ok: false };

    const outcomes = Array.isArray(market.outcomes)
      ? market.outcomes
      : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
    const outcomePrices = Array.isArray(market.outcomePrices)
      ? market.outcomePrices
      : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);
    const clobTokenIds = Array.isArray(market.clobTokenIds)
      ? market.clobTokenIds
      : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

    let upTokenId = null, downTokenId = null;
    for (let i = 0; i < outcomes.length; i++) {
      const label = String(outcomes[i]).toLowerCase();
      const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
      if (!tokenId) continue;
      if (label === "up") upTokenId = tokenId;
      if (label === "down") downTokenId = tokenId;
    }

    const upIdx = outcomes.findIndex(x => String(x).toLowerCase() === "up");
    const downIdx = outcomes.findIndex(x => String(x).toLowerCase() === "down");
    const gammaUp = upIdx >= 0 ? Number(outcomePrices[upIdx]) : null;
    const gammaDown = downIdx >= 0 ? Number(outcomePrices[downIdx]) : null;

    if (!upTokenId || !downTokenId) return { ok: false, market };

    // Read cached CLOB prices (sem await — instantâneo).
    const upClobPrice = _getClobPrice(upTokenId);
    const downClobPrice = _getClobPrice(downTokenId);
    const clobFresh = upClobPrice !== null && downClobPrice !== null;

    // Fire-and-forget refresh em background. Não bloqueia o tick.
    _maybeRefreshClobPrice(upTokenId);
    _maybeRefreshClobPrice(downTokenId);

    // Fallback: se CLOB indisponível, usa gammaPrices.
    const finalUp = clobFresh ? upClobPrice : (Number.isFinite(gammaUp) ? gammaUp : null);
    const finalDown = clobFresh ? downClobPrice : (Number.isFinite(gammaDown) ? gammaDown : null);
    const priceFresh = finalUp !== null && finalDown !== null;
    const priceSource = clobFresh ? "clob" : (priceFresh ? "gamma" : "unavailable");

    return {
      ok: true,
      market,
      prices: { up: finalUp, down: finalDown },
      gammaPrices: { up: gammaUp, down: gammaDown },
      priceFresh,
      priceSource,
      priceFetchedAt: Date.now(),
      tokenIds: { up: upTokenId, down: downTokenId },
      clobBreakerOpen: _clobBreakerOpen()
    };
  }

  return { resolve, fetchSnapshot, getCachedMarket };
}

// ────────────────────────────────────────────────────────
// Scalp Engine factory (Fase 1 — sem SIM dispatch, sem analysis)
// ────────────────────────────────────────────────────────

const CHAINLINK_STEP_TIMEOUT_MS = Number(process.env.CHAINLINK_STEP_TIMEOUT_MS || 3_500);
/** Após troca de slug: não usar latch Chainlink ao vivo nem heurística Gamma "walk" (evita PTB errado nos primeiros ticks). */
const SCALP_PTB_WARMUP_MS = Number(process.env.SCALP_PTB_WARMUP_MS || 10_000);

function createScalpEngine(windowMinutes, sharedStreams) {
  const preset = WINDOW_PRESETS[windowMinutes];
  const tfLabel = `${windowMinutes}m`;
  const polyResolver = createPolymarketResolver(preset, tfLabel);

  let previousChainlinkPrice = null;
  let scalpPtbFallbackState = { slug: null, value: null };
  /** Primeiro preço do WS Polymarket (Chainlink) com updatedAt ≥ abertura da janela — alinha ao site vs agregador on-chain. */
  let scalpPtbStreamOpen = { slug: null, value: null };
  let scalpPtbWarmup = { slug: null, startedAtMs: 0 };

  const scalpIndicatorName = windowMinutes === 15 ? SCALP_15M : SCALP_5M;
  const scalpRuntime = createScalpRuntime(scalpIndicatorName, windowMinutes);
  const scalpCsvPath = `./logs/scalp_trades_${tfLabel}.csv`;
  migrateScalpTradesCsvIfNeeded(scalpCsvPath);
  const scalpWallet = readScalpWalletFromCsv(scalpCsvPath, scalpIndicatorName);
  const scalpCumulative = { [scalpIndicatorName]: scalpWallet.balance };

  const tfConfig = {
    ...CONFIG,
    candleWindowMinutes: windowMinutes,
    vwapSlopeLookbackMinutes: preset.vwapSlopeLookbackMinutes,
    phases: preset.phases,
    timerColors: preset.timerColors
  };

  async function timedStep(name, fn) {
    const startedAt = Date.now();
    try {
      const result = await fn();
      const durationMs = Date.now() - startedAt;
      if (durationMs >= CONFIG.slowTickMs) {
        logEngineDiagnostic("slow_step", { timeframe: tfLabel, step: name, durationMs }, "warn");
      }
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      logEngineDiagnostic("step_error", {
        timeframe: tfLabel, step: name, durationMs, error: err?.message || String(err)
      }, "error");
      throw err;
    }
  }

  let tickInFlightPromise = null;
  let tickReentryLastLoggedAt = 0;
  let lastTickPayload = null;

  async function tick() {
    if (tickInFlightPromise) {
      const now = Date.now();
      if (now - tickReentryLastLoggedAt >= CONFIG.watchdogMs) {
        tickReentryLastLoggedAt = now;
        logEngineDiagnostic("tick_reentry_blocked", { timeframe: tfLabel }, "warn");
      }
      if (lastTickPayload) {
        return {
          ...lastTickPayload,
          data: {
            ...lastTickPayload.data,
            watchdog: { ...(lastTickPayload.data?.watchdog || {}), staleTick: true, tickReentryBlocked: true }
          }
        };
      }
      throw new Error(`${tfLabel} tick anterior ainda em execução`);
    }

    tickInFlightPromise = (async () => {
      const tickStartedAt = Date.now();
      const candleTiming = getCandleWindowTiming(windowMinutes);

      // Streams cached values
      const binanceTick = sharedStreams.binanceStream.getLast();
      const binanceLivePrice = binanceTick?.price ?? null;
      const binanceTickTs = binanceTick?.ts ?? null;
      const polymarketTick = sharedStreams.polymarketLiveStream.getLast();
      const polymarketLivePrice = polymarketTick?.price ?? null;
      const polymarketLiveReceivedAt = polymarketTick?.receivedAt ?? null;
      const polymarketLiveAgeMs = polymarketLiveReceivedAt ? Date.now() - polymarketLiveReceivedAt : null;
      const polymarketCurrentFresh = polymarketLivePrice !== null
        && polymarketLiveAgeMs !== null
        && polymarketLiveAgeMs <= CONFIG.polymarketCurrentPriceMaxAgeMs;
      const polymarketCurrentPrice = polymarketCurrentFresh ? polymarketLivePrice : null;

      const chainlinkTick = sharedStreams.chainlinkStream.getLast();
      const chainlinkLivePrice = chainlinkTick?.price ?? null;
      const chainlinkTickTs = chainlinkTick?.updatedAt ?? null;

      const chainlinkPricePromise = polymarketCurrentFresh
        ? Promise.resolve({ price: polymarketLivePrice, updatedAt: polymarketTick?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkLivePrice !== null
          ? Promise.resolve({ price: chainlinkLivePrice, updatedAt: chainlinkTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const chainlinkStep = timedStep("chainlink.price", async () => {
        try {
          return await withTimeout(chainlinkPricePromise, CHAINLINK_STEP_TIMEOUT_MS, `chainlink price ${tfLabel}`);
        } catch (err) {
          const fallbackPrice = chainlinkLivePrice ?? previousChainlinkPrice ?? null;
          if (fallbackPrice !== null) {
            return {
              price: fallbackPrice,
              updatedAt: chainlinkTickTs ?? Date.now(),
              source: chainlinkLivePrice !== null ? "chainlink_ws" : "chainlink_cache"
            };
          }
          throw err;
        }
      });
      const polymarketStep = timedStep("polymarket.snapshot", async () => {
        try {
          return await withTimeout(polyResolver.fetchSnapshot(), POLYMARKET_SNAPSHOT_TIMEOUT_MS, `polymarket snapshot ${tfLabel}`);
        } catch (err) {
          const cachedMarket = polyResolver.getCachedMarket();
          if (cachedMarket) {
            console.warn(`⚠️  [${tfLabel}] polymarket snapshot timeout; usando cache: ${err?.message || err}`);
            return {
              ok: true, market: cachedMarket,
              prices: { up: null, down: null }, gammaPrices: { up: null, down: null },
              priceFresh: false, priceSource: "timeout_cache",
              priceFetchedAt: Date.now(), tokenIds: { up: null, down: null }
            };
          }
          throw err;
        }
      });

      const useOkxCandles = CONFIG.indicatorCandleSource === "okx";
      const {
        candles1m,
        taLastPrice,
        binanceSpot,
        chainlinkData,
        polymarketData,
        indicatorSourceEffective
      } = await fetchIndicatorMarketBundle({
        useOkxCandles,
        binanceLivePrice,
        chainlinkStep,
        polymarketStep,
        timedStep
      });

      const candles1mLive = applyLiveCloseToLatestCandle(candles1m, taLastPrice);

      // Settlement / candle timing
      const settlementMs = polymarketData.ok && polymarketData.market?.endDate
        ? new Date(polymarketData.market.endDate).getTime() : null;
      const settlementMinutesLeft = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
      const minutesLeft = settlementMinutesLeft ?? candleTiming.remainingMinutes;

      // Indicators (último candle 1m alinhado ao last price REST/WS — evita “congelado” entre polls de klines)
      const closePrices = candles1mLive.map(c => c.close);
      const sessionVwap = computeSessionVwap(candles1mLive);
      const vwapSeries = computeVwapSeries(candles1mLive);
      const currentVwap = vwapSeries[vwapSeries.length - 1];
      const slopeLookback = tfConfig.vwapSlopeLookbackMinutes;
      const vwapSlope = vwapSeries.length >= slopeLookback
        ? (currentVwap - vwapSeries[vwapSeries.length - slopeLookback]) / slopeLookback : null;
      const vwapDistance = currentVwap ? (taLastPrice - currentVwap) / currentVwap : null;
      const currentRsi = computeRsi(closePrices, CONFIG.rsiPeriod);
      const rsiSeries = computeRsiSeries(closePrices, CONFIG.rsiPeriod).filter(v => v !== null);
      const rsiSlope = slopeLast(rsiSeries, 3);
      const macdResult = computeMacd(closePrices, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);
      const heikenAshiCandles = computeHeikenAshi(candles1mLive);
      const heikenAshiStreak = countConsecutive(heikenAshiCandles);
      const bollingerResult = computeBollingerBands(closePrices, CONFIG.bollingerPeriod, CONFIG.bollingerStdDev);
      const stochRsiResult = computeStochasticRsi(closePrices, CONFIG.stochRsiPeriod, CONFIG.stochRsiPeriod, CONFIG.stochRsiSmooth, CONFIG.stochRsiSmooth);
      const emaCrossResult = computeEmaCross(closePrices, CONFIG.emaFast, CONFIG.emaSlow);
      const obvResult = computeObv(candles1mLive, CONFIG.obvSlopeLookback);
      const atrResult = computeAtr(candles1mLive, CONFIG.atrPeriod);
      const vwapCrossCount = countVwapCrosses(closePrices, vwapSeries, 20);
      const recentVolume = candles1mLive.slice(-20).reduce((s, c) => s + c.volume, 0);
      const averageVolume = candles1mLive.slice(-120).reduce((s, c) => s + c.volume, 0) / 6;
      const failedVwapReclaim = currentVwap !== null && vwapSeries.length >= 3
        ? closePrices[closePrices.length - 1] < currentVwap && closePrices[closePrices.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      const regimeInfo = detectRegime({ price: taLastPrice, vwap: currentVwap, vwapSlope, vwapCrossCount, volumeRecent: recentVolume, volumeAvg: averageVolume });
      const directionScore = scoreDirection({
        price: taLastPrice, vwap: currentVwap, vwapSlope, rsi: currentRsi, rsiSlope,
        macd: macdResult, heikenColor: heikenAshiStreak.color, heikenCount: heikenAshiStreak.count,
        failedVwapReclaim, bollinger: bollingerResult, stochRsi: stochRsiResult,
        emaCross: emaCrossResult, obv: obvResult, atr: atrResult
      });
      const timeAdjustedProb = applyTimeAwareness(directionScore.rawBullishProbability, minutesLeft, windowMinutes);

      // Polymarket prices + tokenIds
      const marketPriceUp = polymarketData.ok ? polymarketData.prices.up : null;
      const marketPriceDown = polymarketData.ok ? polymarketData.prices.down : null;
      const polymarketPricesFresh = Boolean(polymarketData.ok && polymarketData.priceFresh);
      const upTokenId = polymarketData.ok ? polymarketData.tokenIds?.up : null;
      const downTokenId = polymarketData.ok ? polymarketData.tokenIds?.down : null;
      const edgeResult = computeEdge({ modelUp: timeAdjustedProb.adjustedUp, modelDown: timeAdjustedProb.adjustedDown, marketYes: marketPriceUp, marketNo: marketPriceDown });
      const decision = decide({ remainingMinutes: minutesLeft, edgeUp: edgeResult.edgeUp, edgeDown: edgeResult.edgeDown, modelUp: timeAdjustedProb.adjustedUp, modelDown: timeAdjustedProb.adjustedDown, phases: tfConfig.phases });

      // Derived labels
      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";
      const macdLabel = macdResult === null ? "-"
        : macdResult.hist < 0
          ? (macdResult.histDelta !== null && macdResult.histDelta < 0 ? "bearish (expanding)" : "bearish")
          : (macdResult.histDelta !== null && macdResult.histDelta > 0 ? "bullish (expanding)" : "bullish");
      const latestCandle = candles1mLive.length ? candles1mLive[candles1mLive.length - 1] : null;
      const latestClose = latestCandle?.close ?? null;
      const closePrev1m = candles1mLive.length >= 2 ? candles1mLive[candles1mLive.length - 2]?.close ?? null : null;
      const closePrev3m = candles1mLive.length >= 4 ? candles1mLive[candles1mLive.length - 4]?.close ?? null : null;
      const delta1m = latestClose !== null && closePrev1m !== null ? latestClose - closePrev1m : null;
      const delta3m = latestClose !== null && closePrev3m !== null ? latestClose - closePrev3m : null;
      const signalLabel = decision.action === "ENTER" ? (decision.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE";

      const spotPrice = binanceLivePrice ?? binanceSpot;
      const chainlinkPrice = chainlinkData?.price ?? null;
      const marketSlug = polymarketData.ok ? String(polymarketData.market?.slug ?? "") : "";
      const marketTitle = polymarketData.ok ? String(polymarketData.market?.title ?? polymarketData.market?.question ?? "") : "";

      // ── Price To Beat (PTB) ──
      // Ordem: página Polymarket → [btc-updown] 1º tick do WS Polymarket com horário ≥ abertura
      // → Chainlink on-chain no timestamp do slug (Polygon; pode divergir $ do stream do site)
      // → Gamma (title / walk) → latch ao vivo após warmup.
      // Nos primeiros SCALP_PTB_WARMUP_MS: não usar walk nem latch legacy (mantém stream_open ativo).
      const ptbNow = Date.now();
      if (marketSlug) {
        if (scalpPtbWarmup.slug !== marketSlug) {
          scalpPtbWarmup = { slug: marketSlug, startedAtMs: ptbNow };
          scalpPtbFallbackState = { slug: marketSlug, value: null };
          scalpPtbStreamOpen = { slug: marketSlug, value: null };
        }
        ensureEventPagePtb(marketSlug).catch(() => {});
        ensurePtbForSlug(marketSlug).catch(() => {});
      }

      const ptbWarmupActive = Boolean(
        marketSlug
        && scalpPtbWarmup.slug === marketSlug
        && (ptbNow - scalpPtbWarmup.startedAtMs) < SCALP_PTB_WARMUP_MS
      );

      let slugStartUnix = null;
      if (isBtcUpDownWindowSlug(marketSlug)) {
        const segs = marketSlug.split("-");
        const tail = Number(segs[segs.length - 1]);
        if (Number.isFinite(tail) && tail > 1_000_000_000) slugStartUnix = tail;
      }
      if (slugStartUnix !== null
          && scalpPtbStreamOpen.slug === marketSlug
          && scalpPtbStreamOpen.value === null
          && polymarketCurrentFresh
          && polymarketCurrentPrice !== null) {
        const utMs = polymarketTick?.updatedAt;
        const recvAt = polymarketTick?.receivedAt;
        let acceptStreamOpen = false;
        if (utMs != null && Number.isFinite(utMs)) {
          const wsSec = Math.floor(Number(utMs) / 1000);
          acceptStreamOpen = wsSec >= slugStartUnix;
        } else if (recvAt != null
            && recvAt >= scalpPtbWarmup.startedAtMs
            && ptbNow >= slugStartUnix * 1000) {
          acceptStreamOpen = true;
        }
        if (acceptStreamOpen) scalpPtbStreamOpen.value = polymarketCurrentPrice;
      }

      const pagePtb = marketSlug ? getCachedEventPagePtb(marketSlug) : null;
      const chainHistPtb = marketSlug ? getCachedPtbForSlug(marketSlug) : null;
      const ptbResult = polymarketData.ok && polymarketData.market
        ? priceToBeatFromMarketWithSource(polymarketData.market)
        : { value: null, source: null };

      let ptbChosenSource = null;
      let chosenPtb = null;
      if (pagePtb !== null && Number.isFinite(pagePtb)) {
        chosenPtb = pagePtb;
        ptbChosenSource = "event_page";
      } else if (isBtcUpDownWindowSlug(marketSlug)
          && scalpPtbStreamOpen.value !== null
          && Number.isFinite(scalpPtbStreamOpen.value)) {
        chosenPtb = scalpPtbStreamOpen.value;
        ptbChosenSource = "chainlink_stream_open";
      } else if (chainHistPtb !== null && Number.isFinite(chainHistPtb)) {
        chosenPtb = chainHistPtb;
        ptbChosenSource = "chainlink_window";
      } else if (ptbResult.source === "title" && ptbResult.value !== null) {
        chosenPtb = ptbResult.value;
        ptbChosenSource = "gamma_title";
      } else if (!ptbWarmupActive && ptbResult.source === "walk" && ptbResult.value !== null) {
        chosenPtb = ptbResult.value;
        ptbChosenSource = "gamma_walk";
      }

      if (!ptbWarmupActive && scalpPtbFallbackState.slug === marketSlug && scalpPtbFallbackState.value === null && chainlinkPrice !== null) {
        scalpPtbFallbackState.value = chainlinkPrice;
      }
      const latchedPtb = scalpPtbFallbackState.slug === marketSlug ? scalpPtbFallbackState.value : null;
      const priceToBeatForScalp = chosenPtb ?? (!ptbWarmupActive ? latchedPtb : null);
      if (priceToBeatForScalp !== null && ptbChosenSource === null && latchedPtb !== null && priceToBeatForScalp === latchedPtb) {
        ptbChosenSource = "chainlink_live_latch";
      }

      const ptbCandidates = {
        event_page: pagePtb,
        chainlink_stream_open: scalpPtbStreamOpen.value,
        chainlink_window: chainHistPtb,
        gamma_title: polymarketData.ok && polymarketData.market
          ? parsePriceToBeatFromText(polymarketData.market)
          : null,
        gamma_walk: polymarketData.ok && polymarketData.market
          ? extractNumericFromMarket(polymarketData.market)
          : null,
        chainlink_live_latch: latchedPtb,
        chainlink_live_now: chainlinkPrice
      };

      const ptbCompareFootnote = isBtcUpDownWindowSlug(marketSlug)
        ? "Nesta série (slug btc-updown-5m/15m), a API Gamma não inclui priceToBeat no mercado e o título só tem o intervalo de tempo. O _next/data da página também não traz priceToBeat para a janela ativa. O PTB do site segue o Chainlink via stream Polymarket: usamos o primeiro tick do WS com horário ≥ abertura (stream abertura). A linha «Chainlink (timestamp do slug)» é o agregador on-chain na Polygon — pode afastar-se alguns dólares do stream."
        : null;

      // Exchange median (usado pelo Scalp para direção) — mediana só das bolsas
      // marcadas no canvas (nó Direção); spread oracle continua nas cinco feeds.
      const exchanges = getExchangeTickers();
      const scalpCfgForMedian = getScalpConfig(scalpIndicatorName);
      const dirGraph = tradingConfig.scalpStrategyBindings[scalpIndicatorName]?.graph ?? null;
      const exchangeMedianSources = getScalpDirectionSourceKeys(dirGraph, scalpCfgForMedian, scalpIndicatorName);
      const { prices: directionExchangePrices, keysWithPrice: exchangeMedianSourcesWithPrice }
        = exchangePricesForMedianFromKeys(exchanges, exchangeMedianSources);
      const scalpExchangeMedian = computeExchangeMedian(directionExchangePrices);
      const allOracleExchangePrices = SCALP_DIRECTION_EXCHANGE_KEYS.map(k => exchanges[k]?.price)
        .filter(p => p !== null && Number.isFinite(p));

      const oracleLagMs = (binanceTickTs !== null && chainlinkTickTs !== null)
        ? Math.abs(binanceTickTs - chainlinkTickTs) : null;
      const binanceVsOracle = (spotPrice !== null && chainlinkPrice !== null
        && Number.isFinite(spotPrice) && Number.isFinite(chainlinkPrice))
        ? spotPrice - chainlinkPrice : null;
      const taVsOracle = (taLastPrice !== null && chainlinkPrice !== null
        && Number.isFinite(taLastPrice) && Number.isFinite(chainlinkPrice))
        ? taLastPrice - chainlinkPrice : null;
      const oracleSpreadPct = (allOracleExchangePrices.length >= 2 && chainlinkPrice !== null
        && Number.isFinite(chainlinkPrice) && chainlinkPrice > 0)
        ? ((Math.max(...allOracleExchangePrices) - Math.min(...allOracleExchangePrices)) / chainlinkPrice) * 100 : null;

      const liquidityAmount = polymarketData.ok
        ? (Number(polymarketData.market?.liquidityNum) || Number(polymarketData.market?.liquidity) || null)
        : null;
      const priceToBeatDelta = (polymarketCurrentPrice !== null && priceToBeatForScalp !== null)
        ? polymarketCurrentPrice - priceToBeatForScalp : null;

      // Stoch / EMA labels
      const stochRsiCrossLabel = stochRsiResult === null ? ""
        : stochRsiResult.crossUp ? " ✕UP"
        : stochRsiResult.crossDown ? " ✕DN" : "";
      const emaCrossLabel = emaCrossResult === null ? "-"
        : emaCrossResult.crossUp ? "CROSS ↑"
        : emaCrossResult.crossDown ? "CROSS ↓"
        : emaCrossResult.bullish ? "bullish" : "bearish";

      // ── Scalp Force advance ──
      const scalpConfig = scalpCfgForMedian;
      const scalpEnabled = isScalpEnabled(scalpIndicatorName);
      const scalpStatusBefore = scalpRuntime.status;

      const simSignalDirections = buildSimSignalDirectionStrings({
        timeAdjustedProb,
        heikenAshiStreak,
        macdLabel,
        delta3m,
        bollingerResult,
        obvResult,
        currentRsi,
        emaCrossLabel,
        vwapDistance
      });
      const simSignals = {
        ...simSignalDirections,
        decision,
        directionScore,
        timeAdjustedProb,
        regime: regimeInfo,
        macd: macdResult,
        rsi: { value: currentRsi, slope: rsiSlope },
        bollinger: bollingerResult,
        stochRsi: stochRsiResult,
        emaCross: emaCrossResult,
        obv: obvResult,
        atr: atrResult,
        heikenAshi: heikenAshiStreak,
        delta: { d1m: delta1m, d3m: delta3m },
        vwap: { price: currentVwap, slope: vwapSlope, distance: vwapDistance, slopeLabel: vwapSlopeLabel }
      };

      const slugOk = marketSlugAllowedForScalpBinding(marketSlug, scalpIndicatorName);
      const scalpAdvance = advanceScalp(scalpRuntime, {
        nowMs: Date.now(),
        marketSlug,
        candleElapsedMs: candleTiming.elapsedMs,
        priceToBeat: priceToBeatForScalp,
        currentPrice: polymarketCurrentPrice,
        exchangeMedian: scalpExchangeMedian,
        marketPriceUp,
        marketPriceDown,
        signals: simSignals,
        config: scalpConfig,
        enabled: scalpEnabled && polymarketCurrentFresh && polymarketPricesFresh && slugOk
      });

      // ── LIVE dispatch (entry + exit) ──
      const LIVE_EXIT_REASONS = ["tp_hit", "tp_trailing_stop", "tp_force_fail", "timeout_min_exit", "timeout_force_exit", "decay_stop_min_exit", "decay_stop_force_exit", "trailing_stop", "hard_stop"];
      const isFailedLiveOrderStatus = (status) => ["rejected", "error", "skipped"].includes(String(status || "").toLowerCase());

      const dispatchScalpLiveExit = (trade, source = "tick") => {
        if (!trade || !LIVE_EXIT_REASONS.includes(trade.exitReason) || !upTokenId || !downTokenId
            || scalpRuntime._liveExitDispatchedAt === scalpRuntime.entryAt) {
          return false;
        }
        const entryOrderIdForPair = scalpRuntime._entryOrderId;
        const entryOrderStatus = scalpRuntime._entryOrderStatus;
        if (!entryOrderIdForPair) {
          if (isFailedLiveOrderStatus(entryOrderStatus)) {
            scalpRuntime._liveExitDispatchedAt = scalpRuntime.entryAt;
            scalpRuntime._pendingLiveExitTrade = null;
            return false;
          }
          scalpRuntime._pendingLiveExitTrade = trade;
          return false;
        }
        if (isFailedLiveOrderStatus(entryOrderStatus)) {
          scalpRuntime._liveExitDispatchedAt = scalpRuntime.entryAt;
          scalpRuntime._pendingLiveExitTrade = null;
          return false;
        }
        const exitTokenId = trade.side === "UP" ? upTokenId : downTokenId;
        const sellShares = Number(trade.shares) || 0;
        const exitPrice = Number(trade.exitPrice) || 0;
        const sellSizeUsd = sellShares * exitPrice;
        if (!exitTokenId || sellSizeUsd <= 0 || exitPrice <= 0) return false;

        scalpRuntime._liveExitDispatchedAt = scalpRuntime.entryAt;
        scalpRuntime._pendingLiveExitTrade = null;
        polyTrader.placeTrade({
          side: "SELL", price: exitPrice, sizeUsd: sellSizeUsd,
          tokenId: exitTokenId,
          forceLive: isScalpLive(scalpIndicatorName),
          metadata: {
            indicator: scalpIndicatorName, timeframe: tfLabel,
            marketSlug: trade.marketSlug || marketSlug,
            direction: trade.side, exitReason: trade.exitReason, scalpExitMode: "live_sell"
          }
        }).then(result => {
          polyTrader.resolveScalpPair(entryOrderIdForPair, {
            exitPrice: trade.exitPrice, exitReason: trade.exitReason,
            pnlUsd: trade.pnlUsd, holdSeconds: trade.holdSeconds,
            sellOrderId: result?.orderId || null, sellStatus: result?.status || null, sellError: result?.error || null
          });
          if (result && !result.dryRun) console.log(`⚡ [${tfLabel}] ${scalpIndicatorName} exit (${trade.exitReason}): ${result.status}`);
        }).catch(err => {
          polyTrader.resolveScalpPair(entryOrderIdForPair, {
            exitPrice: trade.exitPrice, exitReason: trade.exitReason,
            pnlUsd: trade.pnlUsd, holdSeconds: trade.holdSeconds,
            sellStatus: "error", sellError: err.message
          });
          console.error(`❌ [${tfLabel}] ${scalpIndicatorName} exit error:`, err.message);
        });
        return true;
      };

      const enteredPosition =
        scalpStatusBefore !== "in_position" &&
        scalpRuntime.status === "in_position" &&
        scalpRuntime.entryAt &&
        scalpRuntime._liveDispatchedAt !== scalpRuntime.entryAt;
      if (enteredPosition && marketSlug && upTokenId && downTokenId) {
        const tokenId = scalpRuntime.direction === "UP" ? upTokenId : downTokenId;
        const stake = Number(scalpRuntime.effectiveStakeUsd) || Number(scalpRuntime.stakeUsd) || scalpConfig.stakeUsd;
        if (tokenId && Number.isFinite(stake) && stake > 0) {
          scalpRuntime._liveDispatchedAt = scalpRuntime.entryAt;
          scalpRuntime._entryTokenId = tokenId;
          scalpRuntime._entryOrderId = null;
          scalpRuntime._entryOrderStatus = null;
          scalpRuntime._entryOrderError = null;
          polyTrader.placeTrade({
            side: "BUY", price: scalpRuntime.entryPrice, sizeUsd: stake, tokenId,
            forceLive: isScalpLive(scalpIndicatorName),
            metadata: {
              indicator: scalpIndicatorName, timeframe: tfLabel, marketSlug,
              direction: scalpRuntime.direction, scalpExitMode: "live_sell"
            }
          }).then(result => {
            if (result) scalpRuntime._entryOrderId = result.orderId;
            if (result) scalpRuntime._entryOrderStatus = result.status;
            if (result) scalpRuntime._entryOrderError = result.error || null;
            if (scalpRuntime._pendingLiveExitTrade) {
              dispatchScalpLiveExit(scalpRuntime._pendingLiveExitTrade, "entry_ack");
            }
            if (result && !result.dryRun) console.log(`⚡ [${tfLabel}] ${scalpIndicatorName} entry: ${result.status}`);
          }).catch(err => {
            scalpRuntime._entryOrderStatus = "error";
            scalpRuntime._entryOrderError = err.message;
            scalpRuntime._pendingLiveExitTrade = null;
            console.error(`❌ [${tfLabel}] ${scalpIndicatorName} entry error:`, err.message);
          });
        }
      }

      // ── Persist closed trade ──
      if (scalpAdvance.closedTrade) {
        const trade = scalpAdvance.closedTrade;
        trade.tokenId = trade.tokenId || scalpRuntime._entryTokenId
          || (trade.side === "UP" ? upTokenId : downTokenId) || "";
        trade.orderId = trade.orderId || scalpRuntime._entryOrderId || "";

        applyScalpTradeToWallet(scalpWallet, trade);
        scalpCumulative[trade.indicator] = scalpWallet.balance;
        try {
          const scalpRow = closedTradeToCsvRow(trade);
          persistRuntimeRow({
            eventType: "scalp_trade", timeframe: tfLabel,
            marketSlug: trade.marketSlug || marketSlug,
            timestamp: trade.exitTime || trade.entryTime || new Date().toISOString(),
            header: SCALP_CSV_HEADER, values: scalpRow,
            filePath: scalpCsvPath
          });
          console.log(`📡 [${tfLabel}] ${scalpIndicatorName} closed: ${trade.side} ${trade.exitReason} pnl=$${trade.pnlUsd?.toFixed(2)}`);
        } catch (err) {
          console.error(`❌ [${tfLabel}] scalp persist failed:`, err?.message);
        }
        dispatchScalpLiveExit(trade);
        scalpRuntime._entryTokenId = null;
      }

      previousChainlinkPrice = chainlinkPrice ?? previousChainlinkPrice;

      const tickDurationMs = Date.now() - tickStartedAt;
      if (tickDurationMs >= CONFIG.slowTickMs) {
        logEngineDiagnostic("slow_tick", { timeframe: tfLabel, durationMs: tickDurationMs, marketSlug }, "warn");
      }

      // Build payload (compatível com frontend dashboard)
      const payload = {
        type: "tick",
        timeframe: tfLabel,
        data: {
          market: { title: marketTitle, slug: marketSlug, timeLeft: minutesLeft, timeLeftFormatted: formatTimeLeft(minutesLeft), windowMinutes },
          indicators: {
            taPredict: { longPct: timeAdjustedProb?.adjustedUp, shortPct: timeAdjustedProb?.adjustedDown },
            heikenAshi: { color: heikenAshiStreak?.color, streak: heikenAshiStreak?.count },
            rsi: { value: currentRsi, slope: rsiSlope },
            macd: { label: macdLabel, hist: macdResult?.hist },
            delta: { d1m: delta1m, d3m: delta3m, latestClose },
            vwap: { price: currentVwap, distance: vwapDistance, slopeLabel: vwapSlopeLabel },
            bollinger: { pctB: bollingerResult?.percentB, bandwidth: bollingerResult?.bandwidth, isSqueeze: bollingerResult?.isSqueeze },
            stochRsi: { k: stochRsiResult?.k, d: stochRsiResult?.d, crossLabel: stochRsiCrossLabel, overbought: stochRsiResult?.overbought, oversold: stochRsiResult?.oversold },
            emaCross: { label: emaCrossLabel, spread: emaCrossResult?.spread },
            obv: { slope: obvResult?.slope, divergence: obvResult?.divergence },
            atr: { value: atrResult?.atr, level: atrResult?.volatilityLevel }
          },
          polymarket: {
            upPrice: marketPriceUp, downPrice: marketPriceDown,
            priceFresh: polymarketPricesFresh,
            priceSource: polymarketData.ok ? polymarketData.priceSource : "unavailable",
            priceFetchedAt: polymarketData.ok ? polymarketData.priceFetchedAt : null,
            liquidity: liquidityAmount,
            priceToBeat: priceToBeatForScalp,
            ptbSource: ptbChosenSource,
            ptbCandidates,
            ptbCompareFootnote,
            ptbWarmupActive: ptbWarmupActive,
            ptbWarmupMsRemaining: ptbWarmupActive && marketSlug
              ? Math.max(0, SCALP_PTB_WARMUP_MS - (ptbNow - scalpPtbWarmup.startedAtMs))
              : 0,
            currentPrice: polymarketCurrentPrice,
            priceDelta: priceToBeatDelta,
            currentPriceFresh: polymarketCurrentFresh,
            currentPriceAgeMs: polymarketLiveAgeMs,
            /** Epoch ms no servidor: último WS Polymarket live recebido (para “há Xs” no cliente). */
            currentPriceReceivedAt: polymarketLiveReceivedAt,
            currentPriceSource: polymarketCurrentFresh ? "polymarket_ws" : "stale_or_unavailable"
          },
          exchanges: {
            binance: { price: exchanges.binance.price, volume: exchanges.binance.volume },
            coinbase: { price: exchanges.coinbase.price, volume: exchanges.coinbase.volume },
            kraken: { price: exchanges.kraken.price, volume: exchanges.kraken.volume },
            bybit: { price: exchanges.bybit.price, volume: exchanges.bybit.volume },
            okx: { price: exchanges.okx.price, volume: exchanges.okx.volume }
          },
          oracle: {
            lagMs: oracleLagMs,
            binanceVsOracle,
            taVsOracle,
            spreadPct: oracleSpreadPct,
            indicatorCandleSource: indicatorSourceEffective,
            exchangeMedianSources,
            exchangeMedianSourcesWithPrice
          },
          feedSources: buildFeedSourcesSnapshot({
            now: Date.now(),
            chainlinkData,
            polymarketCurrentFresh,
            polymarketPriceAgeMs: polymarketLiveAgeMs
          }),
          session: { time: formatEasternTime(), name: getBtcSession() },
          signal: signalLabel,
          regime: regimeInfo.regime,
          simulation: {
            positions: [],
            totalIndicators: SCALP_INDICATORS.length,
            activated: 0,
            lastResolved: null,
            ceStatus: null,
            scalp: {
              cards: { [scalpIndicatorName]: buildScalpCardPayload(scalpRuntime, scalpConfig) },
              strip: {
                ...buildScalpStripPayload([scalpRuntime], scalpCumulative),
                wallets: [scalpWallet]
              }
            }
          },
          trading: polyTrader.getStatus(),
          /** Momento em que este pacote de indicadores foi emitido (ms desde epoch). */
          indicatorTickAt: Date.now(),
          /** Duração do tick no servidor (útil se “há Xs” cresce: tick lento ou skip). */
          indicatorTickDurationMs: tickDurationMs
        }
      };
      lastTickPayload = payload;
      return payload;
    })();

    try {
      return await tickInFlightPromise;
    } finally {
      tickInFlightPromise = null;
    }
  }

  return { tick, scalpRuntime, scalpWallet, scalpIndicatorName, scalpCumulative };
}

// ────────────────────────────────────────────────────────
// Engine runner (watchdog + tick interval)
// ────────────────────────────────────────────────────────

function startEngineRunner(timeframe, engine) {
  const loopWatch = { id: 0, running: false, startedAt: 0, lastLoggedAt: 0 };

  setInterval(() => {
    if (!loopWatch.running) return;
    const ageMs = Date.now() - loopWatch.startedAt;
    if (ageMs < CONFIG.watchdogMs) return;
    if (Date.now() - loopWatch.lastLoggedAt < CONFIG.watchdogMs) return;
    loopWatch.lastLoggedAt = Date.now();
    const message = `Loop ${timeframe} sem finalizar ha ${Math.round(ageMs / 1000)}s`;
    logEngineDiagnostic("loop_stalled", {
      loopId: loopWatch.id, timeframe, ageMs, tickTimeoutMs: CONFIG.tickTimeoutMs
    }, "error");
    broadcast({ type: "engine_status", timeframe, status: "stalled", message, ageMs, loopId: loopWatch.id });
  }, 1_000).unref?.();

  setInterval(async () => {
    if (loopWatch.running) return;
    loopWatch.id++;
    loopWatch.running = true;
    loopWatch.startedAt = Date.now();
    try {
      const payload = await withTimeout(engine.tick(), CONFIG.tickTimeoutMs, `engine ${timeframe} tick`)
        .catch(err => ({ type: "error", timeframe, error: err?.message || String(err) }));
      const loopDurationMs = Date.now() - loopWatch.startedAt;
      if (loopDurationMs >= CONFIG.slowTickMs) {
        logEngineDiagnostic("loop_slow", { loopId: loopWatch.id, timeframe, durationMs: loopDurationMs }, "warn");
      }
      broadcast(payload);
    } catch (err) {
      console.error(`Loop ${timeframe} error:`, err?.message);
      logEngineDiagnostic("loop_error", { loopId: loopWatch.id, timeframe, error: err?.message || String(err) }, "error");
    } finally {
      loopWatch.running = false;
    }
  }, 1_000);
}

// ────────────────────────────────────────────────────────
// WebSocket message handler (config updates)
// ────────────────────────────────────────────────────────

function setupWebSocketHandlers() {
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "config", data: buildConfigPayload() }));

    ws.on("message", (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.action === "getConfig") {
          ws.send(JSON.stringify({ type: "config", data: buildConfigPayload() }));
          return;
        }

        if (data.action === "setConfig") {
          // Toggle enabled por timeframe (5m / 15m)
          if (Array.isArray(data.enabledIndicators5m)) {
            tradingConfig.indicatorConfigs[SCALP_5M].enabled = data.enabledIndicators5m.includes(SCALP_5M);
          }
          if (Array.isArray(data.enabledIndicators15m)) {
            tradingConfig.indicatorConfigs[SCALP_15M].enabled = data.enabledIndicators15m.includes(SCALP_15M);
          }

          if (data.indicatorConfigs && typeof data.indicatorConfigs === "object") {
            for (const [name, patch] of Object.entries(data.indicatorConfigs)) {
              if (!SCALP_INDICATORS.includes(name)) continue;
              tradingConfig.indicatorConfigs[name] = mergeScalpConfigPatch(
                tradingConfig.indicatorConfigs[name], patch
              );
            }
          }

          // Stake base no cabeçalho Scalp usa class config-stake-input → stakesPerIndicator (igual server.js).
          if (data.stakesPerIndicator && typeof data.stakesPerIndicator === "object") {
            for (const [name, val] of Object.entries(data.stakesPerIndicator)) {
              if (!SCALP_INDICATORS.includes(name)) continue;
              const parsed = parseFloat(val);
              if (!Number.isFinite(parsed) || parsed < 0.1) continue;
              const rounded = Math.round(parsed * 100) / 100;
              tradingConfig.indicatorConfigs[name] = mergeScalpConfigPatch(
                tradingConfig.indicatorConfigs[name],
                { stakeUsd: rounded }
              );
            }
          }

          if (data.scalpStrategyBindings && typeof data.scalpStrategyBindings === "object") {
            for (const name of SCALP_INDICATORS) {
              const b = data.scalpStrategyBindings[name];
              if (!b || typeof b !== "object") continue;
              tradingConfig.scalpStrategyBindings[name] = tradingConfig.scalpStrategyBindings[name] || {};
              tradingConfig.scalpStrategyBindings[name].allowedSlugFamilies = coerceScalpBindingFamilies(name);
              if (b.graph && typeof b.graph === "object" && Array.isArray(b.graph.nodes) && b.graph.nodes.length) {
                const patch = compileScalpStrategyGraphToPatch(b.graph);
                if (Object.keys(patch).length) {
                  tradingConfig.indicatorConfigs[name] = mergeScalpConfigPatch(
                    tradingConfig.indicatorConfigs[name],
                    patch
                  );
                }
                tradingConfig.scalpStrategyBindings[name].graph = b.graph;
              }
            }
          }

          if (typeof data.dryRun === "boolean") {
            const oldMode = polyTrader.dryRun;
            polyTrader.dryRun = data.dryRun;
            if (oldMode !== data.dryRun) {
              const label = data.dryRun ? "📡 SCALP MONITOR (SIM)" : "💰 LIVE TRADING";
              console.log(`⚡ [Config] Modo alterado para: ${label}`);
            }
          }

          savePersistedTradingConfig();
          broadcast({ type: "config", data: buildConfigPayload() });
        }

        if (data.action === "analyze") {
          // Fase 2: análise de carteira pausada. Devolve estrutura vazia compatível.
          const tf = data.timeframe === "15m" ? "15m" : "5m";
          ws.send(JSON.stringify({
            type: "analysis", timeframe: tf, mode: data.mode || null,
            data: {
              totalSnapshots: 0, upCount: 0, downCount: 0,
              indicators: [], candles: [], wallets: [],
              source: "phase_1_scalp_only"
            }
          }));
        }
      } catch { /* ignore malformed */ }
    });
  });
}

// ────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 Starting BTC Polymarket — Scalp-Only (Fase 1)\n");

  if (isPostgresEnabled()) {
    await ensureTradeHistorySchema();
    await ensureRuntimeEventSchema();
    console.log("✅ Postgres schemas prontos (trade_history + runtime_events)");
  }

  applyWindowPreset(5);
  loadPersistedTradingConfig();

  // Streams compartilhados
  // Streams toggleables via env. Binance WS é DESABILITADO POR DEFAULT pelo
  // Bug #21 (cascade RSS por buffer pool nativo + reconnect loop). Usa HTTP
  // fetchLastPrice no tick — comprovado estável a 144MB indefinidamente.
  // Para reabilitar: SCALP_BINANCE_WS=1 (opt-in com risco de cascade).
  //   SCALP_BINANCE_WS=1           — opt-in para usar Binance WS (NÃO recomendado)
  //   SCALP_DISABLE_POLY_WS=1      — sem polymarket live price
  //   SCALP_DISABLE_CHAINLINK_WS=1 — usa fetchChainlinkBtcUsd HTTP no tick
  const noopStream = { getLast() { return null; }, close() {} };

  const binanceStream = process.env.SCALP_BINANCE_WS === "1"
    ? (console.log("⚠️  Binance WS HABILITADO (opt-in via SCALP_BINANCE_WS=1) — risco cascade RSS"), startBinanceTradeStream({ symbol: CONFIG.symbol }))
    : (console.log("ℹ️  Binance WS desabilitado (default Bug #21) — usando fetchLastPrice HTTP no tick"), noopStream);

  const polymarketLiveStream = process.env.SCALP_DISABLE_POLY_WS === "1"
    ? (console.log("⚠️  Polymarket live WS DESABILITADO (debug)"), noopStream)
    : startPolymarketChainlinkPriceStream({});

  const chainlinkStream = process.env.SCALP_DISABLE_CHAINLINK_WS === "1"
    ? (console.log("⚠️  Chainlink WS DESABILITADO (debug)"), noopStream)
    : startChainlinkPriceStream({});

  const sharedStreams = { binanceStream, polymarketLiveStream, chainlinkStream };

  // Heap snapshot trigger: quando RSS > HEAP_SNAPSHOT_RSS_MB, escreve snapshot
  // pra análise offline. Só dispara UMA vez por sessão pra não inflar disco.
  if (process.env.HEAP_SNAPSHOT_ON_RSS === "1") {
    const triggerMb = Number(process.env.HEAP_SNAPSHOT_RSS_MB || 220);
    let dumped = false;
    const snapshotTimer = setInterval(() => {
      if (dumped) return;
      const rssMb = process.memoryUsage().rss / 1024 / 1024;
      if (rssMb < triggerMb) return;
      dumped = true;
      const fname = `./logs/heap-${Date.now()}-rss${Math.round(rssMb)}MB.heapsnapshot`;
      try {
        const written = v8.writeHeapSnapshot(fname);
        console.log(`📸 Heap snapshot at rss=${Math.round(rssMb)}MB → ${written}`);
      } catch (err) {
        console.warn(`⚠️  heap snapshot failed: ${err?.message}`);
      }
    }, 1000);
    snapshotTimer.unref?.();
  }

  const engine5m = createScalpEngine(5, sharedStreams);
  const engine15m = createScalpEngine(15, sharedStreams);

  if (isPostgresEnabled()) {
    const n5 = await mergeRuntimeScalpTradesIntoWallet(
      engine5m.scalpWallet, engine5m.scalpIndicatorName, applyScalpTradeToWallet
    );
    const n15 = await mergeRuntimeScalpTradesIntoWallet(
      engine15m.scalpWallet, engine15m.scalpIndicatorName, applyScalpTradeToWallet
    );
    engine5m.scalpCumulative[engine5m.scalpIndicatorName] = engine5m.scalpWallet.balance;
    engine15m.scalpCumulative[engine15m.scalpIndicatorName] = engine15m.scalpWallet.balance;
    if (n5 + n15 > 0) {
      console.log(`✅ Carteira Scalp: ${n5} trade(s) 5m + ${n15} trade(s) 15m mesclados do Postgres (runtime_events).`);
    }
  }

  // GET /api/scalp/wallet — estado in-memory dos dois Scalps (sem hit Postgres)
  app.get("/api/scalp/wallet", (req, res) => {
    res.json({
      operationalMode: "scalp_only_phase_1",
      wallets: {
        [engine5m.scalpIndicatorName]: engine5m.scalpWallet,
        [engine15m.scalpIndicatorName]: engine15m.scalpWallet
      }
    });
  });

  setupWebSocketHandlers();

  // Safety net global
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logEngineDiagnostic("unhandled_rejection", { message: msg });
    console.error("[unhandledRejection] swallowed:", msg);
  });

  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, () => {
    console.log(`✅ Dashboard: http://localhost:${PORT}`);
    console.log(`   Modo: Scalp-Only (5m + 15m) — DRY/LIVE configurável\n`);
    primeBinanceFeedHosts().catch((e) => {
      console.warn(`⚠️  Binance feed prime (ignorado): ${e?.message || e}`);
    });
  });

  // Log rotation
  const logMaxAgeDays = parseInt(process.env.LOG_MAX_AGE_DAYS || "7", 10);
  const prunedOnStart = pruneOldLogs("./logs", logMaxAgeDays);
  if (prunedOnStart > 0) console.log(`🗑  Removed ${prunedOnStart} log file(s) older than ${logMaxAgeDays} days.`);
  setInterval(() => pruneOldLogs("./logs", logMaxAgeDays), 86_400_000).unref?.();

  // Engines: 5m primeiro, 15m staggered 500ms
  startEngineRunner("5m", engine5m);
  setTimeout(() => startEngineRunner("15m", engine15m), 500);
}

main().catch(err => {
  console.error("❌ Fatal startup error:", err);
  process.exit(1);
});
