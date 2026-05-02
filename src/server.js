/**
 * server.js — Dashboard web com dados em tempo real via WebSocket.
 * Coleta dados para 5m e 15m simultaneamente.
 * Uso: npm run web  →  http://localhost:3000
 */
// Force IPv4-first DNS resolution. Some networks expose AAAA records but have
// broken IPv6 routing; Node's fetch defaults to "verbatim" order and stalls on
// the IPv6 attempt. curl uses the system resolver and is unaffected.
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import "dotenv/config";

// Diagnostics — must subscribe before any HTTP traffic begins so we capture
// the very first requests. Both modules are no-ops if disabled via env.
import { startEventLoopMonitor } from "./diagnostics/eventLoopMonitor.js";
import { startHttpDebug } from "./diagnostics/httpDebug.js";
import { startMemoryMonitor } from "./diagnostics/memoryMonitor.js";
import { diagLog } from "./diagnostics/diagSink.js";
startEventLoopMonitor();
startHttpDebug();
startMemoryMonitor();

import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG, WINDOW_PRESETS, applyWindowPreset } from "./config.js";
import { applyLiveCloseToLatestCandle, primeBinanceFeedHosts } from "./data/binance.js";
import { fetchIndicatorMarketBundle } from "./data/indicatorMarketFetch.js";
import { buildFeedSourcesSnapshot } from "./data/feedSources.js";
import { fetchChainlinkBtcUsd, getCachedPtbForSlug, ensurePtbForSlug } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook,
  getCachedEventPagePtb,
  ensureEventPagePtb,
  resolveMarketOutcome
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
import {
  buildScalpStrategyGraphFromConfig,
  embedConfigIntoScalpGraph,
  compileScalpStrategyGraphToPatch,
  SCALP_DIRECTION_EXCHANGE_KEYS,
  getScalpDirectionSourceKeys,
  exchangePricesForMedianFromKeys
} from "./scalp/strategyGraph.js";
import { buildSimSignalDirectionStrings } from "./engines/simSignalStrings.js";
import { getExchangeTickers } from "./data/exchanges.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";
import { runAnalysis } from "./engines/analysis.js";
import { appendCsvRow, countVwapCrosses, formatNumber, getCandleWindowTiming, pruneOldLogs, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { PolyTrader } from "./polyTrader.js";
import { reconcileSimCsvs } from "./reconcileSimCsvs.js";
import { mergeTradeHistoryRecords, readTradeHistoryFile, writeTradeHistoryFileAtomic } from "./tradeHistoryMerge.js";
import { backfillSimTradesFromHistory, enrichSimRowsWithTradeHistory, persistSimCsvTokenColumns, SIM_TRADES_HEADER } from "./simTradeHistoryBackfill.js";
import { isPostgresEnabled } from "./storage/db.js";
import { buildTradeHistoryAnalysis } from "./storage/tradeHistoryAnalysis.js";
import { ensureTradeHistorySchema, listTradeHistoryRecords, listTradeHistoryForAnalysis, upsertTradeHistoryRecords } from "./storage/tradeHistoryStore.js";
import { ensureRuntimeEventSchema, insertRuntimeEvent } from "./storage/runtimeEventStore.js";
import { mergeRuntimeScalpTradesIntoWallet } from "./scalp/mergeRuntimeScalpTradesIntoWallet.js";

applyGlobalProxyFromEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ────────────────────────────────────────────────────────
// Express + WebSocket setup
// ────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

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

// ── Polymarket Trading Client ──
const polyTrader = new PolyTrader();
polyTrader.init().catch(err => console.error("PolyTrader init failed:", err));

// ── Trading Configuration (runtime-configurable) ──
const ALL_INDICATORS = [
  "Full Consensus", "Heiken+OBV", "5+ Agree",
  "TA Predict", "Heiken Ashi", "OBV", "MACD", "Delta 3m", "Bollinger",
  "Consensus Edge", "Top3 15m", "Top3 5m",
  "Delta 3m Fade 5m", "Delta 3m Fade 15m",
  "Scalp Force 5m", "Scalp Force 15m"
];
const SCALP_INDICATORS = new Set(["Scalp Force 5m", "Scalp Force 15m"]);
const ONLY_15M_INDICATORS = new Set(["Top3 15m", "Delta 3m Fade 15m"]);
const ONLY_5M_INDICATORS  = new Set(["Top3 5m",  "Delta 3m Fade 5m"]);
// Fade indicators enter BOTH UP and DOWN simultaneously when triggered.
// Internally they store two positions per market under compound keys
// (`<name>::UP` and `<name>::DOWN`) but expose a single indicatorName for
// CSV/UI/LIVE dispatch — see tryOpenStandardPosition `indicatorName` field.
const FADE_INDICATORS = new Set(["Delta 3m Fade 5m", "Delta 3m Fade 15m"]);
const DEFAULT_STAKE = 1; // $1 default per indicator
const POLYMARKET_MIN_ORDER_SHARES = 5;
const SIM_ANALYSIS_TIMEOUT_MS = Number(process.env.SIM_ANALYSIS_TIMEOUT_MS || 1_200);
const ANALYSIS_REFRESH_MS = Number(process.env.ANALYSIS_REFRESH_MS || 15_000);
const CHAINLINK_STEP_TIMEOUT_MS = Number(process.env.CHAINLINK_STEP_TIMEOUT_MS || 3_500);
const POLYMARKET_SNAPSHOT_TIMEOUT_MS = Number(process.env.POLYMARKET_SNAPSHOT_TIMEOUT_MS || 5_000);
const RUNTIME_CONFIG_PATH = path.join(__dirname, "..", "logs", "trading_config.runtime.json");
const LEGACY_RUNTIME_CONFIG_PATH = path.join(process.cwd(), "logs", "trading_config.runtime.json");

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
    enabled: false
  };
}

function buildDefaultIndicatorConfigs() {
  const cfg = {};
  for (const name of ALL_INDICATORS) {
    if (name === "Scalp Force 5m") cfg[name] = makeDefaultScalpConfig(5);
    else if (name === "Scalp Force 15m") cfg[name] = makeDefaultScalpConfig(15);
    else cfg[name] = { stakeUsd: DEFAULT_STAKE };
  }
  return cfg;
}

const tradingConfig = {
  enabledIndicators5m:  new Set(), // all disabled by default
  enabledIndicators15m: new Set(), // all disabled by default
  stakesPerIndicator: Object.fromEntries(ALL_INDICATORS.map(n => [n, DEFAULT_STAKE])),
  indicatorConfigs: buildDefaultIndicatorConfigs(),
  /** Persisted strategy canvas per scalp indicator (Direção checkboxes, etc.). */
  scalpStrategyBindings: {
    "Scalp Force 5m": { graph: null },
    "Scalp Force 15m": { graph: null }
  }
};

function buildScalpStrategyBindingsPayload() {
  const out = {};
  for (const name of SCALP_INDICATORS) {
    const cfg = getIndicatorConfig(name);
    const entry = tradingConfig.scalpStrategyBindings[name] || { graph: null };
    let graph = entry.graph;
    if (!graph || typeof graph !== "object") {
      graph = embedConfigIntoScalpGraph(buildScalpStrategyGraphFromConfig(cfg, name), cfg);
    } else {
      graph = embedConfigIntoScalpGraph(graph, cfg);
    }
    out[name] = { graph };
  }
  return out;
}

function isScalpIndicator(name) {
  return SCALP_INDICATORS.has(name);
}

function getScalpTimeframe(name) {
  if (name === "Scalp Force 5m") return 5;
  if (name === "Scalp Force 15m") return 15;
  return null;
}

function isIndicatorEnabled(name) {
  const tf = getScalpTimeframe(name);
  if (tf === 5) return tradingConfig.enabledIndicators5m.has(name);
  if (tf === 15) return tradingConfig.enabledIndicators15m.has(name);
  return tradingConfig.enabledIndicators5m.has(name) || tradingConfig.enabledIndicators15m.has(name);
}

function setScalpIndicatorEnabled(name, enabled) {
  const tf = getScalpTimeframe(name);
  if (tf === 5) {
    if (enabled) tradingConfig.enabledIndicators5m.add(name);
    else tradingConfig.enabledIndicators5m.delete(name);
  } else if (tf === 15) {
    if (enabled) tradingConfig.enabledIndicators15m.add(name);
    else tradingConfig.enabledIndicators15m.delete(name);
  }
  const cfg = tradingConfig.indicatorConfigs[name];
  if (cfg) cfg.enabled = Boolean(enabled);
}

function syncScalpConfigEnabledFlags() {
  for (const name of SCALP_INDICATORS) {
    const cfg = tradingConfig.indicatorConfigs[name];
    if (cfg) cfg.enabled = isIndicatorEnabled(name);
  }
}

function getIndicatorConfig(name) {
  return tradingConfig.indicatorConfigs[name] || { stakeUsd: DEFAULT_STAKE };
}

function getIndicatorStake(name) {
  const cfg = tradingConfig.indicatorConfigs[name];
  if (cfg && Number.isFinite(cfg.stakeUsd)) return cfg.stakeUsd;
  const legacy = tradingConfig.stakesPerIndicator[name];
  return Number.isFinite(legacy) ? legacy : DEFAULT_STAKE;
}

function isIndicatorLive(name) {
  return Boolean(tradingConfig.indicatorConfigs[name]?.liveMode);
}

function computeSharesForStake(stakeUsd, contractPrice) {
  const stake = Number(stakeUsd);
  const price = Number(contractPrice);
  if (!Number.isFinite(stake) || stake <= 0 || !Number.isFinite(price) || price <= 0) return null;
  return stake / price;
}

function clampNumber(val, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

// Sanitize an incoming per-indicator config patch. Returns a fresh object
// with only known fields applied to the current config. Unknown / invalid
// fields are dropped.
function mergeIndicatorConfigPatch(name, current, patch) {
  if (!patch || typeof patch !== "object") return current;
  const next = { ...current };

  if (patch.stakeUsd !== undefined) {
    const v = clampNumber(patch.stakeUsd, 0.1, 10_000);
    if (v !== null) next.stakeUsd = Math.round(v * 100) / 100;
  }

  if (typeof patch.liveMode === "boolean") {
    next.liveMode = patch.liveMode;
  }

  if (isScalpIndicator(name)) {
    if (patch.entryMinPct !== undefined) {
      const v = clampNumber(patch.entryMinPct, 0, 100);
      if (v !== null) next.entryMinPct = v;
    }
    if (patch.entryMaxPct !== undefined) {
      const v = clampNumber(patch.entryMaxPct, 0, 100);
      if (v !== null) next.entryMaxPct = v;
    }
    if (patch.takeProfitPct !== undefined) {
      const v = clampNumber(patch.takeProfitPct, 0, 100);
      if (v !== null) next.takeProfitPct = v;
    }
    if (patch.minExitPct !== undefined) {
      const v = clampNumber(patch.minExitPct, 0, 100);
      if (v !== null) next.minExitPct = v;
    }
    if (patch.tpExitMode !== undefined) {
      next.tpExitMode = patch.tpExitMode === "trail" ? "trail" : "exit";
    }
    if (patch.tpTrailCents !== undefined) {
      const v = clampNumber(patch.tpTrailCents, 0, 100);
      if (v !== null) next.tpTrailCents = v;
    }
    if (patch.tpForceExitEnabled !== undefined) {
      next.tpForceExitEnabled = Boolean(patch.tpForceExitEnabled);
    }
    if (patch.tpForceFailTicks !== undefined) {
      const v = clampNumber(patch.tpForceFailTicks, 1, 20);
      if (v !== null) next.tpForceFailTicks = Math.round(v);
    }
    if (patch.trailingArmingCents !== undefined) {
      const v = clampNumber(patch.trailingArmingCents, 0, 100);
      if (v !== null) next.trailingArmingCents = v;
    }
    if (patch.trailingCushionCents !== undefined) {
      const v = clampNumber(patch.trailingCushionCents, 0, 100);
      if (v !== null) next.trailingCushionCents = v;
    }
    if (patch.maxEntriesPerCandle !== undefined) {
      const v = clampNumber(patch.maxEntriesPerCandle, 1, 20);
      if (v !== null) next.maxEntriesPerCandle = Math.round(v);
    }
    if (patch.entryOpenWindowSec !== undefined) {
      const v = clampNumber(patch.entryOpenWindowSec, 1, 3600);
      if (v !== null) next.entryOpenWindowSec = Math.round(v);
    }
    if (patch.maxHoldSec !== undefined) {
      const v = clampNumber(patch.maxHoldSec, 1, 86_400);
      if (v !== null) next.maxHoldSec = Math.round(v);
    }
    if (patch.minSharesFloor !== undefined) {
      const v = clampNumber(patch.minSharesFloor, 0, 10_000);
      if (v !== null) next.minSharesFloor = Math.round(v);
    }
    if (patch.maxEffectiveStakeUsd !== undefined) {
      const v = clampNumber(patch.maxEffectiveStakeUsd, 0.1, 10_000);
      if (v !== null) next.maxEffectiveStakeUsd = Math.round(v * 100) / 100;
    }
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;

    // Keep band ordering coherent
    if (Number.isFinite(next.entryMinPct) && Number.isFinite(next.entryMaxPct)
        && next.entryMinPct > next.entryMaxPct) {
      const mid = (next.entryMinPct + next.entryMaxPct) / 2;
      next.entryMinPct = mid;
      next.entryMaxPct = mid;
    }
  }

  return next;
}

function buildConfigPayload() {
  // Derive legacy stakesPerIndicator from indicatorConfigs.stakeUsd so both
  // stay in sync while old clients still receive the familiar field.
  const stakesPerIndicator = {};
  for (const name of ALL_INDICATORS) {
    stakesPerIndicator[name] = getIndicatorStake(name);
  }
  const indicatorConfigs = {};
  for (const name of ALL_INDICATORS) {
    const cfg = { ...getIndicatorConfig(name) };
    if (isScalpIndicator(name)) cfg.enabled = isIndicatorEnabled(name);
    indicatorConfigs[name] = cfg;
  }
  return {
    allIndicators: ALL_INDICATORS,
    scalpIndicators: [...SCALP_INDICATORS],
    only15mIndicators: [...ONLY_15M_INDICATORS],
    only5mIndicators:  [...ONLY_5M_INDICATORS],
    enabledIndicators5m: [...tradingConfig.enabledIndicators5m],
    enabledIndicators15m: [...tradingConfig.enabledIndicators15m],
    stakesPerIndicator,
    indicatorConfigs,
    scalpStrategyBindings: buildScalpStrategyBindingsPayload(),
    dryRun: polyTrader.dryRun,
    maxStake: polyTrader.maxStake,
    initialized: polyTrader.initialized,
    walletAddress: polyTrader.wallet?.address || null
  };
}

function buildPersistedTradingConfigPayload() {
  syncScalpConfigEnabledFlags();
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    enabledIndicators5m: [...tradingConfig.enabledIndicators5m],
    enabledIndicators15m: [...tradingConfig.enabledIndicators15m],
    stakesPerIndicator: Object.fromEntries(
      ALL_INDICATORS.map(name => [name, getIndicatorStake(name)])
    ),
    indicatorConfigs: Object.fromEntries(
      ALL_INDICATORS.map(name => [name, { ...getIndicatorConfig(name) }])
    ),
    scalpStrategyBindings: buildScalpStrategyBindingsPayload()
  };
}

function applyPersistedTradingConfigPayload(payload) {
  if (!payload || typeof payload !== "object") return false;

  if (Array.isArray(payload.enabledIndicators5m)) {
    tradingConfig.enabledIndicators5m.clear();
    for (const name of payload.enabledIndicators5m) {
      if (ALL_INDICATORS.includes(name)) tradingConfig.enabledIndicators5m.add(name);
    }
  }
  if (Array.isArray(payload.enabledIndicators15m)) {
    tradingConfig.enabledIndicators15m.clear();
    for (const name of payload.enabledIndicators15m) {
      if (ALL_INDICATORS.includes(name)) tradingConfig.enabledIndicators15m.add(name);
    }
  }

  if (payload.stakesPerIndicator && typeof payload.stakesPerIndicator === "object") {
    for (const [name, val] of Object.entries(payload.stakesPerIndicator)) {
      if (!ALL_INDICATORS.includes(name)) continue;
      const parsed = parseFloat(val);
      if (!Number.isFinite(parsed) || parsed < 0.1) continue;
      const rounded = Math.round(parsed * 100) / 100;
      tradingConfig.stakesPerIndicator[name] = rounded;
      const cfg = tradingConfig.indicatorConfigs[name];
      if (cfg) cfg.stakeUsd = rounded;
    }
  }

  if (payload.indicatorConfigs && typeof payload.indicatorConfigs === "object") {
    for (const [name, patch] of Object.entries(payload.indicatorConfigs)) {
      if (!ALL_INDICATORS.includes(name)) continue;
      const current = tradingConfig.indicatorConfigs[name] || { stakeUsd: DEFAULT_STAKE };
      const merged = mergeIndicatorConfigPatch(name, current, patch);
      tradingConfig.indicatorConfigs[name] = merged;
      if (isScalpIndicator(name) && typeof patch?.enabled === "boolean") {
        setScalpIndicatorEnabled(name, patch.enabled);
      }
      if (Number.isFinite(merged.stakeUsd)) {
        tradingConfig.stakesPerIndicator[name] = merged.stakeUsd;
      }
    }
  }

  if (payload.scalpStrategyBindings && typeof payload.scalpStrategyBindings === "object") {
    for (const name of SCALP_INDICATORS) {
      const b = payload.scalpStrategyBindings[name];
      if (!b || typeof b !== "object") continue;
      tradingConfig.scalpStrategyBindings[name] = tradingConfig.scalpStrategyBindings[name] || { graph: null };
      if (b.graph && typeof b.graph === "object" && Array.isArray(b.graph.nodes) && b.graph.nodes.length) {
        const patch = compileScalpStrategyGraphToPatch(b.graph);
        if (Object.keys(patch).length) {
          tradingConfig.indicatorConfigs[name] = mergeIndicatorConfigPatch(
            name,
            tradingConfig.indicatorConfigs[name] || { stakeUsd: DEFAULT_STAKE },
            patch
          );
        }
        tradingConfig.scalpStrategyBindings[name].graph = b.graph;
      }
    }
  }

  syncScalpConfigEnabledFlags();
  return true;
}

function loadPersistedTradingConfig() {
  const candidatePaths = [RUNTIME_CONFIG_PATH];
  if (LEGACY_RUNTIME_CONFIG_PATH !== RUNTIME_CONFIG_PATH) {
    candidatePaths.push(LEGACY_RUNTIME_CONFIG_PATH);
  }
  const configPath = candidatePaths.find(p => fs.existsSync(p));
  if (!configPath) {
    console.log(`⚙️  [Config] runtime não encontrado; usando defaults (${RUNTIME_CONFIG_PATH})`);
    return;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (applyPersistedTradingConfigPayload(payload)) {
      console.log(`⚙️  [Config] runtime carregado de ${configPath}`);
      if (configPath !== RUNTIME_CONFIG_PATH) {
        savePersistedTradingConfig();
      }
    }
  } catch (err) {
    console.warn(`⚠️  [Config] falha ao carregar runtime config: ${err?.message || err}`);
  }
}

function savePersistedTradingConfig() {
  try {
    fs.mkdirSync(path.dirname(RUNTIME_CONFIG_PATH), { recursive: true });
    const tmpPath = `${RUNTIME_CONFIG_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(buildPersistedTradingConfigPayload(), null, 2), "utf8");
    fs.renameSync(tmpPath, RUNTIME_CONFIG_PATH);
  } catch (err) {
    console.warn(`⚠️  [Config] falha ao salvar runtime config: ${err?.message || err}`);
  }
}

loadPersistedTradingConfig();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function formatEngineError(err) {
  const message = err?.message || String(err || "Erro desconhecido");
  const details = [];
  const code = err?.code || err?.cause?.code;
  const causeMessage = err?.cause?.message;
  if (code) details.push(`code ${code}`);
  if (causeMessage && causeMessage !== message) details.push(causeMessage);
  return details.length ? `${message} | ${details.join(" | ")}` : message;
}

const engineDiagnosticsPath = "./logs/engine_watchdog.jsonl";

function logEngineDiagnostic(event, data = {}, level = "warn") {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...data
  };
  try {
    fs.mkdirSync(path.dirname(engineDiagnosticsPath), { recursive: true });
    fs.appendFile(engineDiagnosticsPath, `${JSON.stringify(entry)}\n`, () => {});
  } catch {
    // Do not let diagnostics logging affect trading/dashboard flow.
  }

  const msg = `[watchdog] ${event} ${JSON.stringify(data)}`;
  if (level === "error") console.error(msg);
  else if (level === "info") console.log(msg);
  else console.warn(msg);
}

function persistRuntimeRow({ eventType, timeframe, marketSlug, timestamp, header, values, filePath }) {
  if (isPostgresEnabled()) {
    insertRuntimeEvent({ eventType, timeframe, marketSlug, timestamp, header, values }).catch(err => {
      logEngineDiagnostic("runtime_event_insert_error", {
        eventType,
        timeframe,
        marketSlug,
        error: err?.message || String(err)
      }, "error");
    });
    return;
  }
  appendCsvRow(filePath, header, values);
}

function persistRuntimeRaw({ eventType, timeframe, marketSlug, timestamp, raw, filePath = null }) {
  if (isPostgresEnabled()) {
    insertRuntimeEvent({ eventType, timeframe, marketSlug, timestamp, raw }).catch(err => {
      logEngineDiagnostic("runtime_event_insert_error", {
        eventType,
        timeframe,
        marketSlug,
        error: err?.message || String(err)
      }, "error");
    });
    return;
  }
  if (filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), "utf8");
  }
}

function timeoutAfter(ms, label) {
  return new Promise((_, reject) => {
    // .unref() so pending timeout timers don't keep the event loop alive
    // and don't inflate libuv's timer heap when many CLOBs are inflight.
    setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms).unref();
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([promise, timeoutAfter(ms, label)]);
}

function makeScalpWallet(name) {
  return {
    name,
    balance: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    invested: 0,
    returned: 0,
    history: []
  };
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

function buildScalpHistoryLookup(indicatorName, tradeHistoryPath) {
  const lookup = new Map();
  let history = [];
  try {
    history = readTradeHistoryFile(tradeHistoryPath);
  } catch {
    history = [];
  }

  for (const t of history) {
    const md = t?.metadata || {};
    if (md.indicator !== indicatorName) continue;
    if (!t?.tokenId) continue;
    const slug = md.marketSlug || "";
    const side = md.direction || "";
    const tf = md.timeframe || "";
    if (!slug || !side) continue;
    const key = `${slug}|${side}|${tf}`;
    if (!lookup.has(key)) lookup.set(key, []);
    lookup.get(key).push(t);
  }

  for (const bucket of lookup.values()) {
    bucket.sort((a, b) => (Number(a?.timestamp) || 0) - (Number(b?.timestamp) || 0));
  }

  return lookup;
}

function pickScalpTokenMatch(lookup, { marketSlug, side, windowMin, entryTime, exitTime }) {
  const tf = Number(windowMin) === 15 ? "15m" : "5m";
  const key = `${marketSlug || ""}|${side || ""}|${tf}`;
  const bucket = lookup.get(key);
  if (!bucket || bucket.length === 0) return null;

  const refTs = Number.isFinite(Date.parse(entryTime || ""))
    ? Date.parse(entryTime)
    : Number.isFinite(Date.parse(exitTime || ""))
      ? Date.parse(exitTime)
      : null;

  if (!Number.isFinite(refTs)) {
    return bucket.shift() || null;
  }

  let bestIdx = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < bucket.length; i++) {
    const ts = Number(bucket[i]?.timestamp) || 0;
    const delta = Math.abs(ts - refTs);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIdx = i;
    }
  }

  return bucket.splice(bestIdx, 1)[0] || null;
}

function readScalpWalletFromCsv(csvPath, indicatorName, tradeHistoryPath = path.join(__dirname, "..", "logs", "trade_history.json")) {
  const wallet = makeScalpWallet(indicatorName);
  if (!fs.existsSync(csvPath)) return wallet;
  try {
    const historyLookup = buildScalpHistoryLookup(indicatorName, tradeHistoryPath);
    const raw = fs.readFileSync(csvPath, "utf8").trim();
    if (!raw) return wallet;
    const lines = raw.split("\n").map(l => l.replace(/\r$/, ""));
    const header = lines[0]?.split(",") || [];
    const idx = (name) => header.indexOf(name);
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const indicator = cols[idx("indicator")] || indicatorName;
      if (indicator !== indicatorName) continue;
      const marketSlug = cols[idx("market_slug")];
      const windowMin = Number(cols[idx("window_min")]);
      const side = cols[idx("side")];
      const entryTime = cols[idx("entry_time")];
      const exitTime = cols[idx("exit_time")];

      const csvTokenId = idx("token_id") >= 0 ? (cols[idx("token_id")] || "") : "";
      const csvOrderId = idx("order_id") >= 0 ? (cols[idx("order_id")] || "") : "";
      const historyMatch = (!csvTokenId || !csvOrderId)
        ? pickScalpTokenMatch(historyLookup, { marketSlug, side, windowMin, entryTime, exitTime })
        : null;

      applyScalpTradeToWallet(wallet, {
        indicator,
        marketSlug,
        windowMin,
        side,
        entryPrice: Number(cols[idx("entry_price")]),
        exitPrice: Number(cols[idx("exit_price")]),
        entryTime,
        exitTime,
        holdSeconds: Number(cols[idx("hold_seconds")]),
        exitReason: cols[idx("exit_reason")],
        stakeUsd: Number(cols[idx("stake_usd")]),
        effectiveStakeUsd: Number(cols[idx("effective_stake_usd")]),
        shares: Number(cols[idx("shares")]),
        pnlUsd: Number(cols[idx("pnl_usd")]),
        tokenId: csvTokenId || historyMatch?.tokenId || "",
        orderId: csvOrderId || historyMatch?.orderId || ""
      });
    }
  } catch (err) {
    console.warn(`⚠️  Falha ao ler histórico scalp ${csvPath}: ${err?.message || err}`);
  }
  return wallet;
}

// ────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────

function formatEasternTime(now = new Date()) {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now); } catch { return "-"; }
}

function getBtcSession(now = new Date()) {
  const hour = now.getUTCHours();
  if (hour >= 13 && hour < 16) return "Europe/US overlap";
  if (hour === 7)              return "Asia/Europe overlap";
  if (hour < 7)               return "Asia";
  if (hour < 13)              return "Europe";
  if (hour < 22)              return "US";
  return "Off-hours";
}

// ────────────────────────────────────────────────────────
// Polymarket resolver (per-timeframe)
// ────────────────────────────────────────────────────────

// FIX BC: Shared Gamma backoff across ALL resolver instances (5m + 15m engines).
// Run 19: each engine had its own lastGammaTimeoutMs. When the 20s backoff expired
// simultaneously for both, both tried Gamma at once → inflight[gamma=2] while
// Binance + Polygon were also in-flight → 4 concurrent slow TLS connections →
// loopLag p50=2785ms → zombie sockets → RSS 454MB crash.
// Shared backoff means: when ONE engine's Gamma times out, BOTH engines enter
// backoff. Only one engine will attempt Gamma per backoff window.
//
// FIX BE: Exponential backoff. Gamma has NEVER succeeded in any run so far
// (consistent timeout pattern). Each failed retry creates a zombie TLS socket
// that lives 3-9s after the AbortSignal, consuming HTTP global slots and
// triggering GC cascades. Exponential backoff caps at 300s (5 min) after
// 4+ consecutive failures, reducing zombie creation rate by ~15x.
let _sharedGammaLastTimeoutMs = 0;
let _sharedGammaConsecFailures = 0;  // FIX BE: consecutive failure counter

function _gammaBackoffMs() {
  // 20s → 40s → 80s → 160s → 300s (cap) after 0,1,2,3,4+ failures
  return Math.min(20_000 * Math.pow(2, _sharedGammaConsecFailures), 300_000);
}

function createPolymarketResolver(preset, tfLabel) {
  const cache = { market: null, fetchedAtMs: 0 };
  let resolveInFlight = null;
  let currentSnapshotAbort = null;
  // FIX BC: Use shared module-level backoff (see _sharedGammaLastTimeoutMs above).
  // Per-instance lastGammaTimeoutMs removed — both engines now share one backoff.

  function getCachedMarket() {
    return cache.market;
  }

  async function resolve() {
    const now = Date.now();
    if (cache.market && now - cache.fetchedAtMs < CONFIG.polymarketResolveCacheMs) return cache.market;

    // FIX AN: Backoff must apply even when cache is empty (was: cache.market &&
    // which always skipped the guard when cache=null, causing continuous 4s
    // Gamma retries on every tick and RSS accumulation leading to OOM).
    // When in backoff with a cached market, return it. Without a cached market
    // and in backoff, throw so the snapshot step is skipped gracefully.
    if (now - _sharedGammaLastTimeoutMs < _gammaBackoffMs()) {
      if (cache.market) return cache.market;
      throw Object.assign(new Error("Gamma API in backoff — no cached market yet"), { name: "GammaBackoff" });
    }

    // Dedup: if a fetch is already in-flight, piggyback on it instead of
    // launching a second concurrent request to gamma-api.
    if (resolveInFlight) return resolveInFlight;

    resolveInFlight = (async () => {
      try {
        const events = await fetchLiveEventsBySeriesId({ seriesId: preset.seriesId, limit: 25 });
        const allMarkets = flattenEventMarkets(events);
        const selected = pickLatestLiveMarket(allMarkets);
        cache.market = selected;
        cache.fetchedAtMs = Date.now();
        _sharedGammaConsecFailures = 0;  // FIX BE: reset on success
        return selected;
      } catch (err) {
        // FIX AQ: Set backoff timer on ANY timeout, regardless of cache state.
        // Previously only set when cache.market existed — meaning the 15m engine
        // with no cache entry would retry Gamma every tick (every ~15s) without
        // ever triggering the 60s backoff, blocking the per-host semaphore for
        // all other Gamma consumers.
        const msg = err?.message || String(err);
        if (/timeout/i.test(msg)) {
          _sharedGammaLastTimeoutMs = Date.now();
          // FIX BE: exponential backoff — increment failure counter.
          // Next backoff = min(20s * 2^failures, 300s). Caps at 5 min after 4+ failures.
          _sharedGammaConsecFailures = Math.min(_sharedGammaConsecFailures + 1, 10);
        }
        if (cache.market) {
          console.warn(`⚠️  Polymarket fetch falhou; usando mercado em cache: ${msg}`);
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
    // FIX F: Create the AbortController BEFORE await resolve() and register it
    // immediately. When an outer withTimeout abandons this fetchSnapshot() as a
    // zombie, the next tick's Fix-D will abort this controller before the zombie
    // ever fires CLOBs. The zombie then checks signal.aborted after resolve()
    // returns and exits without opening any CLOB sockets — preventing the
    // cascade of 32+ simultaneous connections that caused the OOM freeze.
    const snapshotAbort = new AbortController();
    if (currentSnapshotAbort) {
      currentSnapshotAbort.abort();
    }
    currentSnapshotAbort = snapshotAbort;

    const market = await resolve();
    if (!market) return { ok: false };
    // If we were aborted while waiting in resolve() (this snapshot is a zombie
    // abandoned by an outer withTimeout and the next tick already ran Fix-D),
    // exit immediately without firing any CLOB requests.
    if (snapshotAbort.signal.aborted) return { ok: false };

    const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
    const outcomePrices = Array.isArray(market.outcomePrices) ? market.outcomePrices : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);
    const clobTokenIds = Array.isArray(market.clobTokenIds) ? market.clobTokenIds : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

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

    let upClobPrice = null, downClobPrice = null;
    let priceFresh = false;
    // snapshotAbort was already created above (before await resolve()).
    // It covers all CLOB price requests. Aborted in finally{} so sockets are
    // released as soon as the budget expires or prices are obtained.
    // FIX G: clobBooks removed — fetchOrderBook calls were fire-and-forget
    // dead code (the .then() after return never updated the returned object
    // because upOb/downOb are local vars captured by value). They also
    // always failed with err=20 at ~85ms, adding 4 useless connections per
    // tick (50% of all CLOB traffic) that contributed to the RSS cascade.
    // FIX AH: Fetch CLOB prices sequentially (not Promise.all) to avoid 2
    // simultaneous TLS connections per engine. With 2 engines staggered by
    // 500ms, max concurrent CLOB connections is now 1 (down from 4).
    //
    // FIX BK: Per-price AbortController timeouts so each price fetch is aborted
    // at exactly 1500ms, releasing the host semaphore immediately.
    // FIX BN: When RSS > 190MB, process._httpPaused=true and fetchClobPrice()
    // throws AbortError immediately \u2014 upClobPrice/downClobPrice stay null,
    // engine falls back to cached Gamma prices. No circuit breaker needed here.
    try {
      let upP = null, downP = null;
      const upPriceAbort = new AbortController();
      const upPriceTimer = setTimeout(
        () => upPriceAbort.abort(new Error(`CLOB price up timeout after ${CONFIG.polymarketSnapshotClobBudgetMs}ms`)),
        CONFIG.polymarketSnapshotClobBudgetMs
      );
      try {
        upP = await fetchClobPrice({
          tokenId: upTokenId,
          side: "buy",
          signal: AbortSignal.any([upPriceAbort.signal, snapshotAbort.signal])
        });
      } catch { /* upClobPrice stays null */ }
      clearTimeout(upPriceTimer);

      if (!snapshotAbort.signal.aborted) {
        const downPriceAbort = new AbortController();
        const downPriceTimer = setTimeout(
          () => downPriceAbort.abort(new Error(`CLOB price down timeout after ${CONFIG.polymarketSnapshotClobBudgetMs}ms`)),
          CONFIG.polymarketSnapshotClobBudgetMs
        );
        try {
          downP = await fetchClobPrice({
            tokenId: downTokenId,
            side: "buy",
            signal: AbortSignal.any([downPriceAbort.signal, snapshotAbort.signal])
          });
        } catch { /* downClobPrice stays null */ }
        clearTimeout(downPriceTimer);
      }
      upClobPrice = upP;
      downClobPrice = downP;
      priceFresh = Number.isFinite(upClobPrice) && Number.isFinite(downClobPrice);
    } catch {
      // Do not fall back to Gamma for tradable prices.
    } finally {
      snapshotAbort.abort();
      if (currentSnapshotAbort === snapshotAbort) {
        currentSnapshotAbort = null;
      }
    }

    return {
      ok: true,
      market,
      prices: { up: priceFresh ? upClobPrice : null, down: priceFresh ? downClobPrice : null },
      gammaPrices: { up: gammaUp, down: gammaDown },
      priceFresh,
      priceSource: priceFresh ? "clob" : "unavailable",
      priceFetchedAt: Date.now(),
      orderbook: { up: {}, down: {} },
      tokenIds: { up: upTokenId, down: downTokenId }
    };
  }

  return { resolve, fetchSnapshot, getCachedMarket };
}

// ────────────────────────────────────────────────────────
// Snapshot CSV header
// ────────────────────────────────────────────────────────

const snapshotCsvHeader = [
  "timestamp","market_slug","window_min","time_left_min",
  "ta_predict_long_pct","ta_predict_short_pct",
  "heiken_color","heiken_streak","rsi","rsi_slope","macd_hist","macd_label",
  "delta_1m_usd","delta_1m_pct","delta_3m_usd","delta_3m_pct",
  "vwap_price","vwap_distance_pct","vwap_slope_label",
  "bollinger_pctB","bollinger_bw_pct","bollinger_squeeze",
  "stoch_rsi_k","stoch_rsi_d","stoch_rsi_cross",
  "ema_cross_label","ema_cross_spread","obv_slope","obv_divergence",
  "atr_value","atr_level",
  "poly_up_price","poly_down_price","poly_liquidity","price_to_beat",
  "chainlink_price","binance_price","binance_vol_24h",
  "coinbase_price","coinbase_vol_24h","kraken_price","kraken_vol_24h",
  "bybit_price","bybit_vol_24h","okx_price","okx_vol_24h",
  "oracle_lag_ms","binance_vs_oracle_usd","oracle_spread_pct",
  "regime","signal","edge_up","edge_down","recommendation"
];

// ────────────────────────────────────────────────────────
// Main engine loop (one per timeframe)
// ────────────────────────────────────────────────────────

function createTimeframeEngine(windowMinutes, sharedStreams) {
  const preset = WINDOW_PRESETS[windowMinutes];
  const tfLabel = `${windowMinutes}m`;
  const csvPath = `./logs/snapshots_${tfLabel}.csv`;
  const polyResolver = createPolymarketResolver(preset, tfLabel);

  // Per-timeframe state
  let previousChainlinkPrice = null;
  // Fallback latch de PTB por slug: usado APENAS enquanto o fetch histórico
  // do Chainlink ainda não populou o cache. Substituído pelo officialPtb assim
  // que disponível. Nunca usado para resolução de outcome — só referência de exibição.
  let scalpPtbFallbackState = { slug: null, value: null };
  let snapshotSavedForSlug = null;
  let dumpedMarketSlugs = new Set();
  let lastAnalysis = null;
  let lastBroadcastedAnalysis = null;
  const analysisByMode = new Map();
  const analysisInFlightByMode = new Map();

  // ── Simulated trade tracking ──
  // { [slug]: { [indicatorName]: { side, entryPrice, timeLeft, ts, stake, shares } } }
  let simPositions = {};
  let resolvedTrades = [];  // last N resolved trade summaries for display

  // ── Deferred sim resolution queue ──
  // At snapshot time we enqueue closed-candle positions instead of writing the
  // CSV immediately. The resolver below polls Polymarket for each pending slug
  // and uses `outcomePrices` as canonical truth, falling back to the local
  // chainlink-vs-PTB calculation only after a timeout window.
  const pendingSimResolutions = {};
  const SIM_RESOLUTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min before falling back to local
  const SIM_RESOLUTION_POLL_MS    = 30 * 1000;     // poll Polymarket every 30s

  // ── LIVE trade deduplication guard ──
  // Prevents double-entry when Polymarket returns multiple slugs for the same
  // 5-minute (or 15-minute) candle window.
  // Maps indicatorName → candleWindowEndMs of the last LIVE trade.
  const lastLiveWindowEnd = {};
  const minShareRejectedEntryKeys = new Set();
  const tradesCsvPath = `./logs/sim_trades_${tfLabel}.csv`;
  const tradeHistoryPath = path.join(__dirname, "..", "logs", "trade_history.json");
  const tradesCsvHeader = SIM_TRADES_HEADER;

  // mtime-based cache for the parsed sim trades CSV. Re-parsing the file on
  // every tick (~1s) was the dominant source of event-loop blocking and GC
  // pressure for trade_history-heavy installs. The file only changes when
  // appendCsvRow writes a new row, so a stat() check per tick is enough.
  let tradesCsvCache = { mtimeMs: 0, size: 0, headers: null, rows: null };
  function readTradesCsvCached() {
    let stat;
    try {
      stat = fs.statSync(tradesCsvPath);
    } catch {
      tradesCsvCache = { mtimeMs: 0, size: 0, headers: null, rows: null };
      return null;
    }
    if (
      tradesCsvCache.rows &&
      tradesCsvCache.mtimeMs === stat.mtimeMs &&
      tradesCsvCache.size === stat.size
    ) {
      return { headers: tradesCsvCache.headers, rows: tradesCsvCache.rows };
    }
    let raw;
    try { raw = fs.readFileSync(tradesCsvPath, "utf8"); } catch { return null; }
    const lines = raw.trim().split("\n").map(l => l.replace(/\r$/, ""));
    if (lines.length < 2) {
      tradesCsvCache = { mtimeMs: stat.mtimeMs, size: stat.size, headers: null, rows: [] };
      return { headers: [], rows: [] };
    }
    const headers = lines[0].split(",");
    const rows = lines.slice(1).map(line => {
      const values = line.split(",");
      const obj = {};
      headers.forEach((h, i) => { obj[h] = values[i] ?? ""; });
      return obj;
    });
    tradesCsvCache = { mtimeMs: stat.mtimeMs, size: stat.size, headers, rows };
    return { headers, rows };
  }

  // ── Consensus Edge dynamic stake tracker ──
  // Running balance for Consensus Edge to compute $1 + 20% of profit
  let ceWalletBalance = 0;
  // Bootstrap from existing CSV if available
  try {
    if (fs.existsSync(tradesCsvPath)) {
      const raw = fs.readFileSync(tradesCsvPath, "utf8");
      const lines = raw.trim().split("\n");
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        if (cols[3] === "Consensus Edge") {
          ceWalletBalance += parseFloat(cols[9]) || 0; // pnl_usd column
        }
      }
    }
  } catch { /* ignore */ }

  // ── Pending sim resolution finalizer ──
  // Writes a single resolved trade row per indicator using the chosen outcome
  // (canonical Polymarket truth, or local fallback after timeout).
  function finalizeSimResolution(pending, outcome, source) {
    const summary = { slug: pending.slug, outcome, source, trades: [], invested: 0, returned: 0 };
    for (const [posKey, pos] of Object.entries(pending.positions)) {
      // Use indicatorName stored in the position (user-facing name); fall back
      // to posKey for legacy/standard positions where they're the same value.
      const name = pos.indicatorName || posKey;
      const stake = pos.stake ?? DEFAULT_STAKE;
      const shares = Number.isFinite(Number(pos.shares))
        ? Number(pos.shares)
        : computeSharesForStake(stake, pos.entryPrice);
      const won = pos.side === outcome;
      const returned = won && Number.isFinite(shares) ? shares : 0;
      const pnl = returned - stake;
      const trade = { name, ...pos, shares, outcome, won, stake, returned: Math.round(returned * 10000) / 10000, pnl: Math.round(pnl * 10000) / 10000 };
      summary.trades.push(trade);
      summary.invested += stake;
      summary.returned += returned;
      if (name === "Consensus Edge") ceWalletBalance += trade.pnl;

      const tradeMode = polyTrader.dryRun ? "DRY_RUN" : "LIVE";
      const simTradeRow = [
        new Date().toISOString(), pending.slug, pending.windowMinutes, name,
        pos.side, pos.entryPrice, pos.timeLeft.toFixed(3),
        outcome, won, trade.pnl, stake, tradeMode, pos.explanation || "",
        pos._tradeResult?.tokenId || "",
        pos._tradeResult?.orderId || "",
        pos._tradeResult?.timestamp || ""
      ];
      persistRuntimeRow({
        eventType: "sim_trade",
        timeframe: tfLabel,
        marketSlug: pending.slug,
        timestamp: simTradeRow[0],
        header: tradesCsvHeader,
        values: simTradeRow,
        filePath: tradesCsvPath
      });
    }
    summary.pnl = Math.round((summary.returned - summary.invested) * 10000) / 10000;
    resolvedTrades.unshift(summary);
    if (resolvedTrades.length > 20) resolvedTrades.pop();
    console.log(`✅ [${tfLabel}] sim resolved ${pending.slug} → ${outcome} (source=${source}, trades=${summary.trades.length}, pnl=$${summary.pnl})`);

    // Push updated wallet data to all connected clients immediately
    try {
      refreshAnalysisCache("SIMULATION")
        .then(updatedAnalysis => {
          if (updatedAnalysis) {
            broadcast({ type: "analysis", timeframe: tfLabel, data: updatedAnalysis, mode: "SIMULATION" });
          }
        })
        .catch(broadcastErr => {
          console.warn(`⚠️  [${tfLabel}] broadcast analysis after resolution failed: ${broadcastErr?.message}`);
        });
    } catch (broadcastErr) {
      console.warn(`⚠️  [${tfLabel}] broadcast analysis after resolution failed: ${broadcastErr?.message}`);
    }
  }

  // ── Pending sim resolution worker ──
  // For each pending slug, ask Polymarket for the canonical outcome. If the
  // market hasn't settled yet, retry next cycle. After the timeout window, fall
  // back to the local chainlink-vs-PTB calculation captured at snapshot time.
  let resolverInFlight = false;
  async function processPendingSimResolutions() {
    if (resolverInFlight) return;
    resolverInFlight = true;
    try {
      const slugs = Object.keys(pendingSimResolutions);
      for (const slug of slugs) {
        const pending = pendingSimResolutions[slug];
        if (!pending) continue;
        const ageMs = Date.now() - pending.snapshotTime;

        let outcome = null;
        let source  = null;

        try {
          const market = await fetchMarketBySlug(slug);
          const polyOutcome = market ? resolveMarketOutcome(market) : null;
          if (polyOutcome) {
            outcome = polyOutcome;
            source  = "polymarket";
          }
        } catch (err) {
          // Will retry on next poll. Log only once per slug to avoid spam.
          if (!pending._loggedFetchErr) {
            console.warn(`⚠️  [${tfLabel}] resolver fetch ${slug}: ${err?.message}`);
            pending._loggedFetchErr = true;
          }
        }

        if (!outcome && ageMs > SIM_RESOLUTION_TIMEOUT_MS) {
          if (pending.fallbackOutcome) {
            outcome = pending.fallbackOutcome;
            source  = "local_timeout";
          } else {
            // No local fallback either — drop the entry rather than write garbage.
            console.warn(`⚠️  [${tfLabel}] dropping unresolved sim ${slug} (no Polymarket truth and no local fallback)`);
            delete pendingSimResolutions[slug];
            continue;
          }
        }

        if (outcome) {
          finalizeSimResolution(pending, outcome, source);
          delete pendingSimResolutions[slug];
        }
      }
    } finally {
      resolverInFlight = false;
    }
  }

  setInterval(() => {
    processPendingSimResolutions().catch(err => {
      console.warn(`⚠️  [${tfLabel}] sim resolver tick failed: ${err?.message}`);
    });
  }, SIM_RESOLUTION_POLL_MS);

  // ── Scalp Force runtime (per-timeframe) ──
  // Scalp positions live in their own state and never enter simPositions or
  // the hold-to-expiry CSV files.
  const scalpIndicatorName = windowMinutes === 15 ? "Scalp Force 15m" : "Scalp Force 5m";
  const scalpRuntime = createScalpRuntime(scalpIndicatorName, windowMinutes);
  const scalpCsvPath = `./logs/scalp_trades_${tfLabel}.csv`;
  migrateScalpTradesCsvIfNeeded(scalpCsvPath);
  const scalpWallet = readScalpWalletFromCsv(scalpCsvPath, scalpIndicatorName);
  const scalpCumulative = { [scalpIndicatorName]: scalpWallet.balance };

  // Config clone for this timeframe
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
        timeframe: tfLabel,
        step: name,
        durationMs,
        error: formatEngineError(err)
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
            watchdog: {
              ...(lastTickPayload.data?.watchdog || {}),
              staleTick: true,
              tickReentryBlocked: true
            }
          }
        };
      }
      throw new Error(`${tfLabel} tick anterior ainda em execução`);
    }

    tickInFlightPromise = (async () => {
      const tickStartedAt = Date.now();
      const candleTiming = getCandleWindowTiming(windowMinutes);
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

    // Fetch data — priority: polymarket WS > chainlink WS > HTTP
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
          console.warn(`⚠️  [${tfLabel}] chainlink timeout; usando preço em cache/stream: ${err?.message || err}`);
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
        return await withTimeout(
          polyResolver.fetchSnapshot(),
          POLYMARKET_SNAPSHOT_TIMEOUT_MS,
          `polymarket snapshot ${tfLabel}`
        );
      } catch (err) {
        const cachedMarket = polyResolver.getCachedMarket();
        if (cachedMarket) {
          console.warn(`⚠️  [${tfLabel}] polymarket snapshot timeout; usando cache sem preços: ${err?.message || err}`);
          return {
            ok: true,
            market: cachedMarket,
            prices: { up: null, down: null },
            gammaPrices: { up: null, down: null },
            priceFresh: false,
            priceSource: "timeout_cache",
            priceFetchedAt: Date.now(),
            orderbook: { up: {}, down: {} },
            tokenIds: { up: null, down: null }
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

    // Settlement timing
    const settlementMs = polymarketData.ok && polymarketData.market?.endDate ? new Date(polymarketData.market.endDate).getTime() : null;
    const settlementMinutesLeft = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
    const minutesLeft = settlementMinutesLeft ?? candleTiming.remainingMinutes;

    // Indicators (último 1m alinhado ao last price — evita série “congelada” entre polls de klines)
    const closePrices = candles1mLive.map(c => c.close);
    const sessionVwap = computeSessionVwap(candles1mLive);
    const vwapSeries = computeVwapSeries(candles1mLive);
    const currentVwap = vwapSeries[vwapSeries.length - 1];
    const slopeLookback = tfConfig.vwapSlopeLookbackMinutes;
    const vwapSlope = vwapSeries.length >= slopeLookback ? (currentVwap - vwapSeries[vwapSeries.length - slopeLookback]) / slopeLookback : null;
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

    // Polymarket
    const marketPriceUp = polymarketData.ok ? polymarketData.prices.up : null;
    const marketPriceDown = polymarketData.ok ? polymarketData.prices.down : null;
    const polymarketPricesFresh = Boolean(polymarketData.ok && polymarketData.priceFresh);
    const upTokenId = polymarketData.ok ? polymarketData.tokenIds?.up : null;
    const downTokenId = polymarketData.ok ? polymarketData.tokenIds?.down : null;
    const edgeResult = computeEdge({ modelUp: timeAdjustedProb.adjustedUp, modelDown: timeAdjustedProb.adjustedDown, marketYes: marketPriceUp, marketNo: marketPriceDown });
    const decision = decide({ remainingMinutes: minutesLeft, edgeUp: edgeResult.edgeUp, edgeDown: edgeResult.edgeDown, modelUp: timeAdjustedProb.adjustedUp, modelDown: timeAdjustedProb.adjustedDown, phases: tfConfig.phases });

    // Derived labels
    const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";
    const macdLabel = macdResult === null ? "-" : macdResult.hist < 0 ? (macdResult.histDelta !== null && macdResult.histDelta < 0 ? "bearish (expanding)" : "bearish") : (macdResult.histDelta !== null && macdResult.histDelta > 0 ? "bullish (expanding)" : "bullish");
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

    // ── Price-to-beat (PTB) latch ──
    // Sources:
    //   "title" — parsed from market question text (canonical, deterministic)
    // ── Price To Beat: fonte canônica da própria página do evento ────────────
    // A página da Polymarket já expõe o PTB renderizado para o slug do candle.
    // Ela tem prioridade por bater exatamente com o valor mostrado ao usuário.
    // Mantemos o fallback histórico/local apenas se a página não responder.
    if (marketSlug) {
      ensureEventPagePtb(marketSlug).catch(() => {});
      ensurePtbForSlug(marketSlug).catch(() => {});
    }
    const pagePtb = marketSlug ? getCachedEventPagePtb(marketSlug) : null;
    const historicalPtb = marketSlug ? getCachedPtbForSlug(marketSlug) : null;
    const officialPtb = pagePtb ?? historicalPtb;

    // Enquanto o cache não popula: fallback latcheado no primeiro tick (legacy)
    if (marketSlug && scalpPtbFallbackState.slug !== marketSlug) {
      scalpPtbFallbackState = { slug: marketSlug, value: null };
    }
    if (scalpPtbFallbackState.slug && scalpPtbFallbackState.value === null && chainlinkPrice !== null) {
      scalpPtbFallbackState.value = chainlinkPrice;
    }
    const priceToBeat = officialPtb ?? (
      scalpPtbFallbackState.slug === marketSlug ? scalpPtbFallbackState.value : null
    );
    const priceToBeatForScalp = priceToBeat;

    // Exchanges & Oracle
    const exchanges = getExchangeTickers();
    const oracleLagMs = (binanceTickTs !== null && chainlinkTickTs !== null) ? Math.abs(binanceTickTs - chainlinkTickTs) : null;
    const binanceVsOracle = (spotPrice !== null && chainlinkPrice !== null && Number.isFinite(spotPrice) && Number.isFinite(chainlinkPrice)) ? spotPrice - chainlinkPrice : null;
    const taVsOracle = (taLastPrice !== null && chainlinkPrice !== null && Number.isFinite(taLastPrice) && Number.isFinite(chainlinkPrice))
      ? taLastPrice - chainlinkPrice : null;
    const allOracleExchangePrices = SCALP_DIRECTION_EXCHANGE_KEYS.map(k => exchanges[k]?.price)
      .filter(p => p !== null && Number.isFinite(p));
    const oracleSpreadPct = (allOracleExchangePrices.length >= 2 && chainlinkPrice !== null && Number.isFinite(chainlinkPrice) && chainlinkPrice > 0)
      ? ((Math.max(...allOracleExchangePrices) - Math.min(...allOracleExchangePrices)) / chainlinkPrice) * 100 : null;

    const liquidityAmount = polymarketData.ok ? (Number(polymarketData.market?.liquidityNum) || Number(polymarketData.market?.liquidity) || null) : null;
    const currentPriceForPolymarket = polymarketCurrentPrice;
    const priceToBeatDelta = (currentPriceForPolymarket !== null && priceToBeatForScalp !== null) ? currentPriceForPolymarket - priceToBeatForScalp : null;

    // EMA / Stoch / OBV display labels
    const stochRsiCrossLabel = stochRsiResult === null ? "" : stochRsiResult.crossUp ? " ✕UP" : stochRsiResult.crossDown ? " ✕DN" : "";
    const emaCrossLabel = emaCrossResult === null ? "-" : emaCrossResult.crossUp ? "CROSS ↑" : emaCrossResult.crossDown ? "CROSS ↓" : emaCrossResult.bullish ? "bullish" : "bearish";

    // ── Simulated trades — Top Indicadores apenas ──
    // Lista fixa dos indicadores — filtrada pelo config de runtime
    // Scalp indicators run on a dedicated runtime (see scalp engine block
    // below) and must NOT enter the hold-to-expiry simPositions loop.
    const SIM_INDICATORS = ALL_INDICATORS.filter(n => {
      if (isScalpIndicator(n)) return false;
      if (ONLY_15M_INDICATORS.has(n) && windowMinutes !== 15) return false;
      if (ONLY_5M_INDICATORS.has(n)  && windowMinutes !== 5)  return false;
      return windowMinutes === 5
        ? tradingConfig.enabledIndicators5m.has(n)
        : tradingConfig.enabledIndicators15m.has(n);
    });

    const simSignals = buildSimSignalDirectionStrings({
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

    // Top3 15m — entrada apenas quando Delta 3m + Heiken Ashi + OBV concordam
    if (simSignals["Delta 3m"] && simSignals["Heiken Ashi"] && simSignals["OBV"] &&
        simSignals["Delta 3m"] === simSignals["Heiken Ashi"] && simSignals["Heiken Ashi"] === simSignals["OBV"]) {
      simSignals["Top3 15m"] = simSignals["Delta 3m"];
    }

    // Top3 5m — entrada apenas quando Delta 3m + TA Predict + Bollinger concordam (Delta 3m + TA Predict + Bollinger)
    if (simSignals["Delta 3m"] && simSignals["TA Predict"] && simSignals["Bollinger"] &&
        simSignals["Delta 3m"] === simSignals["TA Predict"] && simSignals["TA Predict"] === simSignals["Bollinger"]) {
      simSignals["Top3 5m"] = simSignals["Delta 3m"];
    }

    // ── Consensus Edge — weighted technical concordance with price filter ──
    // Uses 9 core technical indicators.
    const coreIndicators = ["TA Predict", "Heiken Ashi", "MACD", "Delta 3m", "Bollinger", "OBV", "Heiken+OBV",
      "Full Consensus", "5+ Agree"];
    let ceUp = 0, ceDown = 0;
    const ceVotes = {}; // track which indicator voted which way
    for (const ind of coreIndicators) {
      if (simSignals[ind] === "UP") { ceUp++; ceVotes[ind] = "UP"; }
      else if (simSignals[ind] === "DOWN") { ceDown++; ceVotes[ind] = "DOWN"; }
      else { ceVotes[ind] = null; } // neutral
    }
    const ceTotal = ceUp + ceDown;
    const ceMajority = Math.max(ceUp, ceDown);
    const ceMajoritySide = ceUp > ceDown ? "UP" : ceDown > ceUp ? "DOWN" : null;
    const cePriceCheck = ceMajoritySide ? (ceMajoritySide === "UP" ? marketPriceUp : marketPriceDown) : null;
    const ceBaseStake = getIndicatorStake("Consensus Edge");
    const ceStakePreview = ceBaseStake + Math.max(0, ceWalletBalance * 0.20);

    // Build CE status diagnostic
    const ceStatus = {
      upVotes: ceUp,
      downVotes: ceDown,
      totalVotes: ceTotal,
      majority: ceMajority,
      majoritySide: ceMajoritySide,
      price: cePriceCheck,
      votes: ceVotes,
      active: false,
      failReasons: [],
      walletBalance: Math.round(ceWalletBalance * 100) / 100,
      nextStake: Math.round(ceStakePreview * 100) / 100,
      timeLeft: minutesLeft,
      timeLeftFormatted: formatTimeLeft(minutesLeft),
      timeOk: minutesLeft <= 1.0
    };

    if (ceTotal < 7 || ceMajority < 7) {
      ceStatus.failReasons.push(`Concordância: ${ceMajority}/${ceTotal} (precisa ≥7)`);
    } else if (cePriceCheck !== null && (cePriceCheck < 0.60 || cePriceCheck > 0.85)) {
      ceStatus.failReasons.push(`Preço: ${(cePriceCheck * 100).toFixed(1)}¢ (zona: 60-85¢)`);
      if (cePriceCheck < 0.60) ceStatus.failReasons.push("Preço muito baixo — sinal fraco");
      else ceStatus.failReasons.push("Preço muito alto — R/R desfavorável");
    }

    // Apply signal if all criteria met (concordance + price + time)
    if (ceTotal >= 7 && ceMajority >= 7 && cePriceCheck !== null && cePriceCheck >= 0.60 && cePriceCheck <= 0.85) {
      if (minutesLeft <= 1.0) {
        simSignals["Consensus Edge"] = ceMajoritySide;
        ceStatus.active = true;
        ceStatus.failReasons = [];
      } else {
        // Concordance + price OK, but waiting for time
        ceStatus.failReasons.push(`Aguardando entrada — faltam ${formatTimeLeft(minutesLeft)}`);
      }
    }

    if (minutesLeft > 1.0) {
      ceStatus.failReasons.push(`Tempo: ${formatTimeLeft(minutesLeft)} restante (precisa ≤01:00)`);
    }

    // Build explanations for each indicator signal
    const simExplanations = {};
    if (simSignals["TA Predict"]) simExplanations["TA Predict"] = `TA ↑${(timeAdjustedProb.adjustedUp*100).toFixed(1)}% ↓${(timeAdjustedProb.adjustedDown*100).toFixed(1)}%`;
    if (simSignals["Heiken Ashi"]) simExplanations["Heiken Ashi"] = `HA ${heikenAshiStreak.color} streak ${heikenAshiStreak.count}v`;
    if (simSignals["MACD"]) simExplanations["MACD"] = macdLabel;
    if (simSignals["Delta 3m"]) simExplanations["Delta 3m"] = `Δ3m ${delta3m > 0 ? "+" : ""}${delta3m.toFixed(2)}`;
    if (simSignals["Bollinger"]) simExplanations["Bollinger"] = `%B=${bollingerResult.percentB.toFixed(2)} bw=${(bollingerResult.bandwidth*100).toFixed(1)}%`;
    if (simSignals["OBV"]) simExplanations["OBV"] = `OBV slope ${obvResult.slope > 0 ? "↑" : "↓"} ${obvResult.slope.toFixed(4)}`;
    if (simSignals["Full Consensus"]) simExplanations["Full Consensus"] = `RSI ${currentRsi.toFixed(1)} + MACD + HA + OBV → ${simSignals["Full Consensus"]}`;
    if (simSignals["Heiken+OBV"]) simExplanations["Heiken+OBV"] = `HA ${heikenAshiStreak.color} + OBV ${obvResult.slope > 0 ? "↑" : "↓"}`;
    if (simSignals["5+ Agree"]) {
      const baseForExpl = { HA: simSignals["Heiken Ashi"], RSI: currentRsi > 50 ? "UP" : "DOWN", MACD: simSignals["MACD"], OBV: simSignals["OBV"], Delta: simSignals["Delta 3m"] };
      const aligned = Object.entries(baseForExpl).filter(([,v]) => v === simSignals["5+ Agree"]).map(([k]) => k);
      simExplanations["5+ Agree"] = `5+ acordo: ${aligned.join("+")}`;
    }
    if (simSignals["Consensus Edge"]) simExplanations["Consensus Edge"] = `CE ${ceUp}↑ ${ceDown}↓ / preço ${cePriceCheck !== null ? (cePriceCheck*100).toFixed(1)+"¢" : "?"}` ;
    if (simSignals["Top3 15m"]) simExplanations["Top3 15m"] = `Δ3m ${delta3m > 0 ? "+" : ""}${delta3m.toFixed(2)} + HA ${heikenAshiStreak.color} + OBV ${obvResult.slope > 0 ? "↑" : "↓"} → ${simSignals["Top3 15m"]}`;
    if (simSignals["Top3 5m"]) simExplanations["Top3 5m"] = `Δ3m ${delta3m > 0 ? "+" : ""}${delta3m.toFixed(2)} + TA ${simSignals["TA Predict"]} + BB %B=${bollingerResult.percentB.toFixed(2)} → ${simSignals["Top3 5m"]} (Delta 3m + TA Predict + Bollinger)`;
    if (simSignals["Delta 3m"]) {
      const fadeSideExpl = simSignals["Delta 3m"] === "UP" ? "DOWN" : "UP";
      simExplanations["Delta 3m Fade 5m"]  = `Δ3m Fade: Delta=${simSignals["Delta 3m"]} → entra ${fadeSideExpl}`;
      simExplanations["Delta 3m Fade 15m"] = simExplanations["Delta 3m Fade 5m"];
    }

    // Track first executable activation per indicator per slug.
    if (marketSlug) {
      if (!simPositions[marketSlug]) simPositions[marketSlug] = {};
      const pos = simPositions[marketSlug];
      const tryOpenStandardPosition = ({ name, side, price, stake, explanation, posKey, indicatorName }) => {
        if (!polymarketPricesFresh) return false;
        // posKey defaults to indicator name
        const key = posKey || name;
        const displayName = indicatorName || name;
        if (pos[key]) return false;
        const effectiveStake = Number.isFinite(Number(stake)) ? Number(stake) : getIndicatorStake(displayName);
        const shares = computeSharesForStake(effectiveStake, price);
        if (!Number.isFinite(shares) || shares < POLYMARKET_MIN_ORDER_SHARES) {
          const rejKey = `${marketSlug}:${key}:${side}`;
          if (!minShareRejectedEntryKeys.has(rejKey)) {
            minShareRejectedEntryKeys.add(rejKey);
            logEngineDiagnostic("entry_rejected_min_shares", {
              timeframe: tfLabel,
              marketSlug,
              indicator: displayName,
              side,
              stakeUsd: Math.round(effectiveStake * 100) / 100,
              price,
              shares: Number.isFinite(shares) ? Math.round(shares * 10000) / 10000 : null,
              minShares: POLYMARKET_MIN_ORDER_SHARES
            }, "info");
          }
          return false;
        }
        pos[key] = {
          side,
          entryPrice: price,
          timeLeft: minutesLeft,
          ts: new Date().toISOString(),
          stake: Math.round(effectiveStake * 100) / 100,
          shares: Math.round(shares * 10000) / 10000,
          explanation: explanation || "",
          indicatorName: displayName  // user-facing name (CSV / LIVE / UI)
        };
        return true;
      };

      for (const name of SIM_INDICATORS) {
        if (name === "Consensus Edge") {
          // Consensus Edge: dynamic stake = base + 20% of accumulated profit
          const signal = simSignals[name];
          if (signal && !pos[name] && minutesLeft <= 1.0) {
            const price = signal === "UP" ? marketPriceUp : marketPriceDown;
            const baseStake = getIndicatorStake(name);
            const ceStake = baseStake + Math.max(0, ceWalletBalance * 0.20);
            if (price != null && price > 0) {
              tryOpenStandardPosition({ name, side: signal, price, stake: Math.round(ceStake * 100) / 100, explanation: simExplanations[name] || "" });
            }
          }
        } else if (FADE_INDICATORS.has(name)) {
          // Delta 3m Fade — inverts Delta 3m signal: Delta=UP → entra DOWN, Delta=DOWN → entra UP.
          const trigger = simSignals["Delta 3m"];
          if (trigger && !pos[name] && minutesLeft <= 1.0) {
            const fadeSide = trigger === "UP" ? "DOWN" : "UP";
            const price = fadeSide === "UP" ? marketPriceUp : marketPriceDown;
            if (price != null && price > 0) {
              const stake = getIndicatorStake(name);
              tryOpenStandardPosition({ name, side: fadeSide, price, stake, explanation: simExplanations[name] || `Δ3m Fade: Delta=${trigger} → entra ${fadeSide}` });
            }
          }
        } else {
          // Standard technical indicators — stake from config
          const signal = simSignals[name];
          // Enters only when minutes left is 1.0 or less
          if (signal && !pos[name] && minutesLeft <= 1.0) {
            const price = signal === "UP" ? marketPriceUp : marketPriceDown;
            if (price != null && price > 0) {
              const stake = getIndicatorStake(name);
              tryOpenStandardPosition({ name, side: signal, price, stake, explanation: simExplanations[name] || "" });
            }
          }
        }
      }
    }

    // ── Dispatch NEW positions to PolyTrader ──
    if (marketSlug && simPositions[marketSlug]) {
      // Use the local clock candle-window end as the dedup key.
      // This stays constant for all Polymarket slugs within the same 5m/15m window.
      const tradeWindowKey = candleTiming.endMs;

      for (const [posKey, p] of Object.entries(simPositions[marketSlug])) {
        if (p._traded) continue; // already dispatched
        const indicatorName = p.indicatorName || posKey;

        // LIVE-mode dedup: one trade per indicator per candle window
        // (prevents double-entry when two Polymarket slugs are active simultaneously).
        const indLive = isIndicatorLive(indicatorName);
        const dedupKey = indicatorName;
        if ((!polyTrader.dryRun || indLive) && lastLiveWindowEnd[dedupKey] === tradeWindowKey) {
          console.warn(`⚠️  [${tfLabel}] ${indicatorName} (${p.side}): já enviado nesta janela (${new Date(tradeWindowKey).toISOString()}) — ignorando duplicata`);
          p._traded = true;
          continue;
        }

        const tokenId = p.side === "UP" ? upTokenId : downTokenId;
        if (tokenId && polyTrader) {
          // Hard guardrail: scalp indicators are simulation-only in MVP.
          if (isScalpIndicator(indicatorName)) {
            p._traded = true;
            continue;
          }
          const stake = p.stake || getIndicatorStake(indicatorName);
          const shares = Number.isFinite(Number(p.shares))
            ? Number(p.shares)
            : computeSharesForStake(stake, p.entryPrice);
          if (!Number.isFinite(shares) || shares < POLYMARKET_MIN_ORDER_SHARES) {
            console.warn(`⚠️  [${tfLabel}] ${indicatorName} (${p.side}): ordem bloqueada localmente — ${Number.isFinite(shares) ? shares.toFixed(2) : "?"} shares < ${POLYMARKET_MIN_ORDER_SHARES}`);
            p._traded = true;
            continue;
          }
          polyTrader.placeTrade({
            side: "BUY",
            price: p.entryPrice,
            sizeUsd: stake,
            tokenId,
            forceLive: indLive,
            metadata: { indicator: indicatorName, timeframe: tfLabel, marketSlug, direction: p.side }
          }).then(result => {
            p._tradeResult = result;
            if (!result.dryRun) console.log(`📊 [${tfLabel}] ${indicatorName} (${p.side}): ${result.status}`);
          }).catch(err => {
            console.error(`❌ [${tfLabel}] ${indicatorName} (${p.side}) trade error:`, err.message);
          });
          // Mark window as used BEFORE the promise resolves (synchronously)
          if (!polyTrader.dryRun || indLive) lastLiveWindowEnd[dedupKey] = tradeWindowKey;
          p._traded = true;
        }
      }
    }

    // ── Scalp Force advance (isolated runtime — never touches simPositions) ──
    const scalpConfig = getIndicatorConfig(scalpIndicatorName);
    const scalpEnabled = windowMinutes === 5
      ? tradingConfig.enabledIndicators5m.has(scalpIndicatorName)
      : tradingConfig.enabledIndicators15m.has(scalpIndicatorName);
    const dirGraphFull = tradingConfig.scalpStrategyBindings[scalpIndicatorName]?.graph ?? null;
    const exchangeMedianSources = getScalpDirectionSourceKeys(dirGraphFull, scalpConfig, scalpIndicatorName);
    const { prices: directionExchangePrices, keysWithPrice: exchangeMedianSourcesWithPrice }
      = exchangePricesForMedianFromKeys(exchanges, exchangeMedianSources);
    const scalpExchangeMedian = computeExchangeMedian(directionExchangePrices);
    const scalpStatusBefore = scalpRuntime.status;
    const scalpAdvance = advanceScalp(scalpRuntime, {
      nowMs: Date.now(),
      marketSlug,
      candleElapsedMs: candleTiming.elapsedMs,
      priceToBeat: priceToBeatForScalp,
      currentPrice: currentPriceForPolymarket,
      exchangeMedian: scalpExchangeMedian,
      marketPriceUp,
      marketPriceDown,
      signals: simSignals,
      config: scalpConfig,
      enabled: scalpEnabled && polymarketCurrentFresh && polymarketPricesFresh
    });

    // ── Scalp Force LIVE dispatch ──
    // Entrada envia BUY real. Saída pode enviar SELL rápido assim que existir
    // orderId do BUY; P&L LIVE só é carimbado se o SELL também for aceito.
    const LIVE_EXIT_REASONS = ["tp_hit", "tp_trailing_stop", "tp_force_fail", "timeout_min_exit", "timeout_force_exit", "decay_stop_min_exit", "decay_stop_force_exit", "trailing_stop", "hard_stop"];
    const isFailedLiveOrderStatus = (status) => ["rejected", "error", "skipped"].includes(String(status || "").toLowerCase());
    const dispatchScalpLiveExit = (trade, source = "tick") => {
      if (
        !trade ||
        !LIVE_EXIT_REASONS.includes(trade.exitReason) ||
        !upTokenId || !downTokenId ||
        scalpRuntime._liveExitDispatchedAt === scalpRuntime.entryAt
      ) {
        return false;
      }

      const entryOrderIdForPair = scalpRuntime._entryOrderId;
      const entryOrderStatus = scalpRuntime._entryOrderStatus;
      if (!entryOrderIdForPair) {
        if (isFailedLiveOrderStatus(entryOrderStatus)) {
          console.warn(`⚠️  [${tfLabel}] ${scalpIndicatorName} exit bloqueado (${trade.exitReason}): entrada LIVE falhou (${entryOrderStatus})`);
          scalpRuntime._liveExitDispatchedAt = scalpRuntime.entryAt;
          scalpRuntime._pendingLiveExitTrade = null;
          return false;
        }
        scalpRuntime._pendingLiveExitTrade = trade;
        console.warn(`⏳ [${tfLabel}] ${scalpIndicatorName} exit aguardando orderId do BUY (${trade.exitReason}, ${source})`);
        return false;
      }
      if (isFailedLiveOrderStatus(entryOrderStatus)) {
        console.warn(`⚠️  [${tfLabel}] ${scalpIndicatorName} exit bloqueado (${trade.exitReason}): entrada LIVE ${entryOrderStatus}`);
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
        side: "SELL",
        price: exitPrice,
        sizeUsd: sellSizeUsd,
        tokenId: exitTokenId,
        forceLive: isIndicatorLive(scalpIndicatorName),
        metadata: {
          indicator: scalpIndicatorName,
          timeframe: tfLabel,
          marketSlug: trade.marketSlug || marketSlug,
          direction: trade.side,
          exitReason: trade.exitReason,
          scalpExitMode: "live_sell"
        }
      }).then(result => {
        polyTrader.resolveScalpPair(entryOrderIdForPair, {
          exitPrice: trade.exitPrice,
          exitReason: trade.exitReason,
          pnlUsd: trade.pnlUsd,
          holdSeconds: trade.holdSeconds,
          sellOrderId: result?.orderId || null,
          sellStatus: result?.status || null,
          sellError: result?.error || null
        });
        if (result && !result.dryRun) console.log(`⚡ [${tfLabel}] ${scalpIndicatorName} exit (${trade.exitReason}): ${result.status}`);
      }).catch(err => {
        polyTrader.resolveScalpPair(entryOrderIdForPair, {
          exitPrice: trade.exitPrice,
          exitReason: trade.exitReason,
          pnlUsd: trade.pnlUsd,
          holdSeconds: trade.holdSeconds,
          sellStatus: "error",
          sellError: err.message
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
          side: "BUY",
          price: scalpRuntime.entryPrice,
          sizeUsd: stake,
          tokenId,
          forceLive: isIndicatorLive(scalpIndicatorName),
          metadata: {
            indicator: scalpIndicatorName,
            timeframe: tfLabel,
            marketSlug,
            direction: scalpRuntime.direction,
            scalpExitMode: "live_sell"
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

    if (scalpAdvance.closedTrade) {
      const trade = scalpAdvance.closedTrade;
      // Keep token/order IDs on Scalp wallet rows for validation in the modal.
      // Use the entry token captured at open; fallback to side token for same-slug closes.
      trade.tokenId = trade.tokenId || scalpRuntime._entryTokenId || (trade.side === "UP" ? upTokenId : downTokenId) || "";
      trade.orderId = trade.orderId || scalpRuntime._entryOrderId || "";

      // Registra TODOS os fechamentos no histórico e CSV.
      // Em rollover de candle, o scalp resolve a posição pelo PTB salvo quando
      // houver preço oracle disponível; se faltar dado, registra fallback neutro.
      applyScalpTradeToWallet(scalpWallet, trade);
      scalpCumulative[trade.indicator] = scalpWallet.balance;
      try {
        const scalpRow = closedTradeToCsvRow(trade);
        persistRuntimeRow({
          eventType: "scalp_trade",
          timeframe: tfLabel,
          marketSlug: trade.marketSlug || marketSlug,
          timestamp: trade.exitTime || trade.entryTime || new Date().toISOString(),
          header: SCALP_CSV_HEADER,
          values: scalpRow,
          filePath: scalpCsvPath
        });
      } catch (err) {
        console.error(`❌ [${tfLabel}] scalp persist failed:`, err?.message);
      }

      // Expiração/rollover é excluída: mercado já encerrado, Polymarket resolve sozinho.
      dispatchScalpLiveExit(trade);
      scalpRuntime._entryTokenId = null;
    }

    // Build positions array for payload
    const activePositions = marketSlug && simPositions[marketSlug]
      ? Object.entries(simPositions[marketSlug]).map(([name, p]) => ({
          name, side: p.side, entryPrice: p.entryPrice,
          timeLeft: p.timeLeft, ts: p.ts, stake: p.stake ?? getIndicatorStake(name), shares: p.shares
        }))
      : [];

    // ── Dump market JSON (once per slug) ──
    if (polymarketData.ok && polymarketData.market) {
      const slug = marketSlug || String(polymarketData.market?.id ?? "");
      if (slug && !dumpedMarketSlugs.has(slug)) {
        dumpedMarketSlugs.add(slug);
        try {
          persistRuntimeRaw({
            eventType: "polymarket_market",
            timeframe: tfLabel,
            marketSlug: slug,
            timestamp: new Date().toISOString(),
            raw: polymarketData.market,
            filePath: path.join("./logs", `polymarket_market_${slug}.json`)
          });
        } catch { /* ignore */ }
      }
    }

    // ── Snapshot on close ──
    const shouldSnapshot = marketSlug && minutesLeft <= 0.15 && snapshotSavedForSlug !== marketSlug;
    if (marketSlug && snapshotSavedForSlug !== null && snapshotSavedForSlug !== marketSlug) snapshotSavedForSlug = null;

    if (shouldSnapshot) {
      snapshotSavedForSlug = marketSlug;
      const snapshotRow = [
        new Date().toISOString(), marketSlug, windowMinutes, minutesLeft.toFixed(3),
        timeAdjustedProb?.adjustedUp, timeAdjustedProb?.adjustedDown,
        heikenAshiStreak?.color, heikenAshiStreak?.count,
        currentRsi, rsiSlope, macdResult?.hist, macdLabel,
        delta1m, delta1m !== null && latestClose !== null ? (delta1m / latestClose) * 100 : null,
        delta3m, delta3m !== null && latestClose !== null ? (delta3m / latestClose) * 100 : null,
        currentVwap, vwapDistance !== null ? vwapDistance * 100 : null, vwapSlopeLabel,
        bollingerResult?.percentB, bollingerResult !== null ? bollingerResult.bandwidth * 100 : null, bollingerResult?.isSqueeze,
        stochRsiResult?.k, stochRsiResult?.d, stochRsiCrossLabel,
        emaCrossLabel, emaCrossResult?.spread, obvResult?.slope, obvResult?.divergence,
        atrResult?.atr, atrResult?.volatilityLevel,
        marketPriceUp, marketPriceDown, liquidityAmount, priceToBeat,
        chainlinkPrice, exchanges.binance.price, exchanges.binance.volume,
        exchanges.coinbase.price, exchanges.coinbase.volume, exchanges.kraken.price, exchanges.kraken.volume,
        exchanges.bybit.price, exchanges.bybit.volume, exchanges.okx.price, exchanges.okx.volume,
        oracleLagMs, binanceVsOracle, oracleSpreadPct,
        regimeInfo.regime, signalLabel, edgeResult.edgeUp, edgeResult.edgeDown,
        decision.action === "ENTER" ? `${decision.side}:${decision.phase}:${decision.strength}` : "NO_TRADE"
      ];
      persistRuntimeRow({
        eventType: "snapshot",
        timeframe: tfLabel,
        marketSlug,
        timestamp: snapshotRow[0],
        header: snapshotCsvHeader,
        values: snapshotRow,
        filePath: csvPath
      });

      // ── Defer simulated trade resolution to async resolver ──
      // The resolver consults Polymarket's `outcomePrices` as canonical truth
      // (see resolveMarketOutcome). Local chainlink-vs-PTB is kept only as a
      // fallback if Polymarket doesn't settle within SIM_RESOLUTION_TIMEOUT_MS.
      // Use previousChainlinkPrice when chainlinkPrice is null (stream lag) to
      // avoid dropping pending positions due to a missing single tick reading.
      const effectiveChainlinkForFallback = chainlinkPrice ?? previousChainlinkPrice;
      const fallbackOutcome = (effectiveChainlinkForFallback !== null && priceToBeat !== null)
        ? (effectiveChainlinkForFallback >= priceToBeat ? "UP" : "DOWN") : null;
      if (simPositions[marketSlug] && Object.keys(simPositions[marketSlug]).length > 0) {
        pendingSimResolutions[marketSlug] = {
          slug: marketSlug,
          windowMinutes,
          positions: simPositions[marketSlug],
          snapshotTime: Date.now(),
          fallbackOutcome
        };
        delete simPositions[marketSlug];
        // Best-effort kick of the resolver — if Polymarket already settled,
        // the CSV row appears in the same tick. Otherwise the periodic timer
        // picks it up later.
        processPendingSimResolutions().catch(() => {});
      }

      // Analysis moved out of tick path. It is refreshed asynchronously and
      // served from cache to avoid blocking the event loop under degradation.
    }

    previousChainlinkPrice = chainlinkPrice ?? previousChainlinkPrice;

    // Build the payload
    const tickDurationMs = Date.now() - tickStartedAt;
    if (tickDurationMs >= CONFIG.slowTickMs) {
      logEngineDiagnostic("slow_tick", { timeframe: tfLabel, durationMs: tickDurationMs, marketSlug }, "warn");
    }

      const cachedAnalysis = analysisByMode.get("*") || null;
      const analysisChanged = cachedAnalysis !== lastBroadcastedAnalysis;
      if (analysisChanged) lastBroadcastedAnalysis = cachedAnalysis;

      const payload = {
      type: "tick",
      timeframe: tfLabel,
      data: {
        market: {
          title: marketTitle,
          slug: marketSlug,
          timeLeft: minutesLeft,
          timeLeftFormatted: formatTimeLeft(minutesLeft),
          windowMinutes
        },
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
          liquidity: liquidityAmount, priceToBeat: priceToBeatForScalp,
          currentPrice: currentPriceForPolymarket, priceDelta: priceToBeatDelta,
          currentPriceFresh: polymarketCurrentFresh,
          currentPriceAgeMs: polymarketLiveAgeMs,
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
          positions: activePositions,
          totalIndicators: ALL_INDICATORS.length,
          activated: activePositions.length,
          lastResolved: resolvedTrades.length > 0 ? resolvedTrades[0] : null,
          ceStatus,
          scalp: {
            cards: {
              [scalpIndicatorName]: buildScalpCardPayload(scalpRuntime, scalpConfig)
            },
            strip: {
              ...buildScalpStripPayload([scalpRuntime], scalpCumulative),
              wallets: [scalpWallet]
            }
          }
        },
        trading: polyTrader.getStatus(),
        indicatorTickAt: Date.now(),
        indicatorTickDurationMs: tickDurationMs
      }
      };
      if (analysisChanged) payload.analysis = cachedAnalysis;
      lastTickPayload = payload;
      return payload;
    })();

    try {
      return await tickInFlightPromise;
    } finally {
      tickInFlightPromise = null;
    }
  }

  // ── Compute accuracy from sim trades (entry-based, not close-based) ──
  // Cache the heavy analysis aggregation across ticks. The result depends only
  // on (csvRowsRef, tradeHistoryRef, filterMode) — all three come from
  // mtime-keyed caches, so the references are stable until a write happens.
  // This avoids re-iterating ~5k CSV rows + rebuilding ~10 wallet histories
  // every second per engine.
  const analysisCache = new Map(); // filterMode → { rowsRef, historyRef, result }

  async function computeSimAnalysis(filterMode) {
    // FIX BR: skip heavy Postgres analysis when HTTP is paused (high RSS).
    // Each analysis query allocates ~28MB RSS per engine (1915 JS objects +
    // buildTradeHistoryAnalysis intermediate allocations). During a GC cascade
    // this allocation is the primary trigger — Run 26 showed RSS jumping from
    // 174MB → 231MB (+57MB) from two analysis calls while HTTP was paused.
    // The analysis result is used only for trading decisions; when HTTP is
    // paused, market data is already stale so skipping analysis is safe.
    if (process._httpPaused) {
      return null;
    }
    if (isPostgresEnabled()) {
      try {
        const tQuery0 = Date.now();
        // Use the lightweight shared query (no `raw` column, cached 14s between
        // both engines) instead of the full SELECT * that fetched 3-8MB per call.
        const tradeHistory = await withTimeout(
          listTradeHistoryForAnalysis(),
          SIM_ANALYSIS_TIMEOUT_MS,
          `${tfLabel} trade_history analysis`
        );
        const queryMs = Date.now() - tQuery0;
        const tBuild0 = Date.now();
        const result = buildTradeHistoryAnalysis(tradeHistory, {
          timeframeLabel: tfLabel,
          filterMode,
          allIndicators: ALL_INDICATORS,
          scalpIndicators: SCALP_INDICATORS
        });
        const buildMs = Date.now() - tBuild0;
        if (queryMs >= 200 || buildMs >= 100) {
          diagLog(`[analysisDebug] tf=${tfLabel} mode=${filterMode || "*"} rows=${tradeHistory.length} query=${queryMs}ms build=${buildMs}ms`);
        }
        return result.totalSnapshots >= 1 ? result : null;
      } catch (err) {
        console.warn(`⚠️  [${tfLabel}] análise trade_history/Postgres falhou: ${err?.message || err}`);
        return null;
      }
    }

    let tradeHistory = [];
    try {
      tradeHistory = readTradeHistoryFile(tradeHistoryPath);
      const backfill = backfillSimTradesFromHistory({
        historyPath: tradeHistoryPath,
        csvPath: tradesCsvPath,
        timeframeLabel: tfLabel,
        allIndicators: ALL_INDICATORS,
        scalpIndicators: SCALP_INDICATORS,
        logger: msg => console.log(`[${tfLabel}] ${msg}`)
      });
      if (backfill.added > 0) {
        console.log(`✅ [${tfLabel}] carteiras backfilled: ${backfill.added} linha(s) recuperada(s) do trade_history`);
      }
      persistSimCsvTokenColumns({
        historyPath: tradeHistoryPath,
        csvPath: tradesCsvPath,
        timeframeLabel: tfLabel,
        allIndicators: ALL_INDICATORS,
        scalpIndicators: SCALP_INDICATORS,
        logger: msg => console.log(`[${tfLabel}] ${msg}`)
      });
    } catch (err) {
      console.warn(`⚠️  [${tfLabel}] backfill de carteiras falhou: ${err?.message || err}`);
    }

    const csvData = readTradesCsvCached();
    if (!csvData || !csvData.rows || csvData.rows.length === 0) return null;

    const cacheKey = filterMode || "*";
    const cachedAnalysis = analysisCache.get(cacheKey);
    if (
      cachedAnalysis
      && cachedAnalysis.rowsRef === csvData.rows
      && cachedAnalysis.historyRef === tradeHistory
    ) {
      return cachedAnalysis.result;
    }

    let rows = csvData.rows.filter(r => {
      if (!r.market_slug || !r.indicator) return false;
      if (!ALL_INDICATORS.includes(r.indicator)) return false;
      if (!filterMode) return true; // no filter — return all (Dashboard)
      const rowMode = r.mode || 'SIM'; // legacy rows without mode = SIM
      // "SIMULATION" view should include both dry-run and live entries.
      if (filterMode === "SIMULATION") {
        return rowMode === "SIM" || rowMode === "DRY_RUN" || rowMode === "LIVE";
      }
      return rowMode === filterMode;
    });

    rows = enrichSimRowsWithTradeHistory(rows, tradeHistory, {
      timeframeLabel: tfLabel,
      allIndicators: ALL_INDICATORS,
      scalpIndicators: SCALP_INDICATORS
    });

    if (rows.length === 0) return null;

    // Count unique candles (slugs)
    const seenSlugs = new Set();
    let totalUp = 0, totalDown = 0;
    for (const row of rows) {
      if (!seenSlugs.has(row.market_slug)) {
        seenSlugs.add(row.market_slug);
        if (row.outcome === "UP") totalUp++;
        else if (row.outcome === "DOWN") totalDown++;
      }
    }

    // Group trades by slug for candle cards
    const bySlug = new Map();
    for (const row of rows) {
      if (!bySlug.has(row.market_slug)) bySlug.set(row.market_slug, []);
      bySlug.get(row.market_slug).push(row);
    }

    // Build candle cards (most recent 36)
    const slugEntries = [...bySlug.entries()];
    const recentEntries = slugEntries.slice(-36);
    const candles = recentEntries.map(([slug, trades]) => {
      const outcome = trades[0]?.outcome || "";
      const models = {};
      let upSignals = 0, downSignals = 0;
      for (const t of trades) {
        const won = t.won === "true";
        const side = t.side;
        if (side === "UP") upSignals++;
        else downSignals++;
        const name = t.indicator;
        const modelData = { pred: side, hit: won };
        if (name === "Full Consensus") models.fullConsensus = modelData;
        else if (name === "TA Predict") models.taPredict = modelData;
        else if (name === "Heiken+OBV") models.heikenObv = modelData;
        else if (name === "5+ Agree") models.fivePlus = modelData;
        else if (name === "Consensus Edge") models.consensusEdge = modelData;
      }
      return { slug, outcome, upSignals, downSignals, models };
    });

    // Per-indicator accuracy (from ALL resolved trades, not just last 36)
    const stats = {};
    for (const row of rows) {
      const name = row.indicator;
      if (!stats[name]) stats[name] = { name, correct: 0, wrong: 0, total: 0 };
      stats[name].total++;
      if (row.won === "true") stats[name].correct++;
      else stats[name].wrong++;
    }
    const indicators = Object.values(stats)
      .map(s => ({
        name: s.name,
        accuracy: s.total > 0 ? (s.correct / s.total) * 100 : 0,
        total: s.total, correct: s.correct, wrong: s.wrong,
        change: null
      }))
      .sort((a, b) => b.accuracy - a.accuracy);

    // Cumulative wallet per indicator
    const wallets = {};
    for (const row of rows) {
      const name = row.indicator;
      if (!wallets[name]) wallets[name] = { name, balance: 0, trades: 0, wins: 0, losses: 0, invested: 0, returned: 0, history: [] };
      const w = wallets[name];
      w.trades++;
      const stake = parseFloat(row.stake) || 1; // Default $1 for legacy rows without stake column
      w.invested += stake;
      const pnl = parseFloat(row.pnl_usd) || 0;
      const entryPrice = parseFloat(row.entry_price) || 0;
      const shares = computeSharesForStake(stake, entryPrice);
      const timeLeft = parseFloat(row.entry_time_left) || 0;
      const won = row.won === "true";
      if (won) {
        w.wins++;
        w.returned += (stake + pnl);
      } else {
        w.losses++;
      }
      w.balance += pnl;
      w.history.push({
        ts: row.timestamp,
        slug: row.market_slug,
        side: row.side,
        entryPrice,
        timeLeft,
        outcome: row.outcome,
        won,
        pnl,
        stake,
        shares: Number.isFinite(shares) ? Math.round(shares * 10000) / 10000 : null,
        tokenId: row.token_id || "",
        orderId: row.order_id || "",
        explanation: row.explanation || ""
      });
    }
    const walletList = Object.values(wallets).sort((a, b) => b.balance - a.balance);

    const result = {
      totalSnapshots: seenSlugs.size,
      upCount: totalUp,
      downCount: totalDown,
      indicators,
      candles,
      wallets: walletList,
      source: "sim_trades"
    };
    analysisCache.set(cacheKey, {
      rowsRef: csvData.rows,
      historyRef: tradeHistory,
      result
    });
    return result;
  }

  function emptyAnalysis() {
    return { totalSnapshots: 0, upCount: 0, downCount: 0, indicators: [], candles: [], wallets: [], source: "empty" };
  }

  async function recomputeAnalysis(filterMode) {
    const modeKey = filterMode || "*";
    const simResult = await computeSimAnalysis(filterMode);
    let result = null;
    if (simResult && simResult.totalSnapshots >= 1) {
      result = simResult;
    } else if (!filterMode) {
      result = runAnalysis(csvPath, lastAnalysis, windowMinutes) || emptyAnalysis();
      lastAnalysis = result;
    } else {
      result = emptyAnalysis();
    }
    analysisByMode.set(modeKey, result);
    return result;
  }

  async function refreshAnalysisCache(filterMode) {
    const modeKey = filterMode || "*";
    if (analysisInFlightByMode.has(modeKey)) {
      return analysisInFlightByMode.get(modeKey);
    }
    const p = recomputeAnalysis(filterMode)
      .catch((err) => {
        console.warn(`⚠️  [${tfLabel}] refresh analysis cache falhou (${modeKey}): ${err?.message || err}`);
        return analysisByMode.get(modeKey) || emptyAnalysis();
      })
      .finally(() => analysisInFlightByMode.delete(modeKey));
    analysisInFlightByMode.set(modeKey, p);
    return p;
  }

  setInterval(() => {
    refreshAnalysisCache().catch(() => {});
  }, ANALYSIS_REFRESH_MS).unref?.();

  // Prime cache shortly after startup and then keep periodic refreshes.
  setTimeout(() => {
    refreshAnalysisCache().catch(() => {});
  }, 2_000).unref?.();

  return {
    tick,
    getAnalysis: async () => {
      if (analysisByMode.has("*")) return analysisByMode.get("*");
      return await refreshAnalysisCache();
    },
    getAnalysisForMode: async (filterMode) => {
      const modeKey = filterMode || "*";
      if (analysisByMode.has(modeKey)) return analysisByMode.get(modeKey);
      return await refreshAnalysisCache(filterMode);
    },
    scalpWallet,
    scalpIndicatorName,
    scalpCumulative
  };
}

function formatTimeLeft(totalMinutes) {
  const totalSeconds = Math.max(0, Math.floor(totalMinutes * 60));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// ────────────────────────────────────────────────────────
// Startup
// ────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 Starting BTC Polymarket Web Dashboard...\n");

  if (isPostgresEnabled()) {
    await ensureTradeHistorySchema();
    await ensureRuntimeEventSchema();
    console.log("✅ Postgres trade_history pronto");
  }

  // Apply default preset to initialize CONFIG
  applyWindowPreset(5);

  // Shared streams
  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream = startChainlinkPriceStream({});
  const sharedStreams = { binanceStream, polymarketLiveStream, chainlinkStream };

  // Create engines for both timeframes
  const engine5m = createTimeframeEngine(5, sharedStreams);
  const engine15m = createTimeframeEngine(15, sharedStreams);

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

  // API endpoint for manual analysis
  app.get("/api/analysis/:tf", async (req, res) => {
    const tf = req.params.tf === "15m" ? "15m" : "5m";
    const engine = tf === "15m" ? engine15m : engine5m;
    res.json(await engine.getAnalysis());
  });

  // ── GET /api/trade-history — retorna trade_history.json filtrado ──
  app.get("/api/trade-history", async (req, res) => {
    try {
      const sinceRaw = parseInt(req.query.since, 10);
      const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;
      if (isPostgresEnabled()) {
        res.json(await listTradeHistoryRecords({ since }));
        return;
      }
      const historyPath = path.join(__dirname, "..", "logs", "trade_history.json");
      if (!fs.existsSync(historyPath)) return res.json([]);
      const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
      res.json(since > 0 ? history.filter(t => (t.timestamp || 0) >= since) : history);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/resolve-trades — roda resolução com streaming SSE ──
  // Guarda flag para evitar execuções paralelas
  let resolveJobRunning = false;

  app.post("/api/resolve-trades", async (req, res) => {
    if (resolveJobRunning) {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ type: "error", msg: "⚠️ Já existe uma execução em andamento. Aguarde." })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "done", updated: 0, skipped: 0, failed: 0 })}\n\n`);
      return res.end();
    }

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (obj) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    const since       = typeof req.body?.since === "number" && Number.isFinite(req.body.since) ? req.body.since : 0;
    const dryRun      = req.body?.dryRun === true;
    const reprocessAll = req.body?.reprocessAll === true;
    const GAMMA_BASE = "https://gamma-api.polymarket.com";
    const CLOB_BASE  = "https://clob.polymarket.com";
    const DELAY_MS   = 300;
    const simCsvPaths = ["5m", "15m"].map(tf => path.join(__dirname, "..", "logs", `sim_trades_${tf}.csv`));

    const toNum = (v, fb = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : fb; };
    const safeArr = (v) => {
      if (Array.isArray(v)) return v;
      if (typeof v === "string") { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
      return [];
    };

    const sendCsvReconciliation = (correctedTrades, dryRunFlag) => {
      if (isPostgresEnabled()) {
        send({ type: "info", msg: "ℹ️ Reconciliação CSV ignorada: trade_history/Postgres é a fonte da verdade." });
        return { totalReconciled: 0, perFile: {}, samples: [] };
      }
      send({ type: "info", msg: "🔍 Reconciliando todas as linhas em sim_trades_*.csv..." });
      const recon = reconcileSimCsvs({
        correctedTrades,
        simCsvPaths,
        dryRun: dryRunFlag,
        logger: msg => send({ type: "info", msg })
      });

      if (recon.totalReconciled === 0) {
        send({ type: "info", msg: "✅ Nenhuma divergência encontrada nas CSVs de simulação." });
        return recon;
      }

      send({ type: "info", msg: `📋 Reconciliação total: ${recon.totalReconciled} linha(s) em ${Object.keys(recon.perFile).length} arquivo(s).` });
      for (const [file, info] of Object.entries(recon.perFile)) {
        const modes = Object.entries(info.modes).map(([mode, count]) => `${mode}:${count}`).join(", ");
        send({ type: "info", msg: `   - ${file}: ${info.modified} linha(s)${modes ? ` (${modes})` : ""}` });
      }

      if (dryRunFlag && recon.samples.length > 0) {
        for (const sample of recon.samples.slice(0, 5)) {
          send({ type: "info", msg: `   DRY ${sample.file}:${sample.line} ${sample.indicator} ${sample.oldOutcome}->${sample.newOutcome} pnl ${sample.oldPnl}->${sample.newPnl}` });
        }
      }

      return recon;
    };

    const sendHistoryBackfill = (historyPath, dryRunFlag) => {
      if (isPostgresEnabled()) {
        send({ type: "info", msg: "ℹ️ Backfill CSV ignorado: carteiras agora usam trade_history/Postgres." });
        return 0;
      }
      send({ type: "info", msg: "🔁 Recuperando linhas faltantes das carteiras a partir do trade_history..." });
      let total = 0;
      let tokens = 0;
      for (const tf of ["5m", "15m"]) {
        const csvPath = path.join(__dirname, "..", "logs", `sim_trades_${tf}.csv`);
        const result = backfillSimTradesFromHistory({
          historyPath,
          csvPath,
          timeframeLabel: tf,
          allIndicators: ALL_INDICATORS,
          scalpIndicators: SCALP_INDICATORS,
          dryRun: dryRunFlag,
          logger: msg => send({ type: "info", msg })
        });
        total += result.added;

        const tokenResult = persistSimCsvTokenColumns({
          historyPath,
          csvPath,
          timeframeLabel: tf,
          allIndicators: ALL_INDICATORS,
          scalpIndicators: SCALP_INDICATORS,
          dryRun: dryRunFlag,
          logger: msg => send({ type: "info", msg })
        });
        tokens += tokenResult.updated;
      }
      send({
        type: "info",
        msg: total === 0
          ? "✅ Nenhuma linha faltante encontrada para as carteiras."
          : `📋 Backfill de carteiras: ${total} linha(s) ${dryRunFlag ? "seria(m) adicionada(s)" : "adicionada(s)"} em sim_trades_*.csv.`
      });
      if (tokens > 0) {
        send({ type: "info", msg: `🔑 Tokens nas carteiras: ${tokens} linha(s) ${dryRunFlag ? "seria(m) preenchida(s)" : "preenchida(s)"}.` });
      }
      return total;
    };

    const isExitResolvedTrade = (trade) => {
      return trade?.resolved === true
        && trade?.executionStatus === "resolved"
        && Boolean(trade.exitReason || trade.exitOrderId || trade.metadata?.scalpExitMode);
    };

    const needsMarketResolution = (trade) => {
      if (!trade?.tokenId) return false;
      if (isExitResolvedTrade(trade)) return false;
      if (reprocessAll) return true;
      return !trade.marketResolved || trade.resolved !== true;
    };

    const slugCache = new Map();

    async function resolveViaSlug(slug) {
      if (slugCache.has(slug)) return slugCache.get(slug);
      try {
        const r = await fetch(`${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`, { headers: { Accept: "application/json" } });
        if (!r.ok) { slugCache.set(slug, null); return null; }
        const events = await r.json();
        const market = (Array.isArray(events) ? events[0] : null)?.markets?.[0] ?? null;
        slugCache.set(slug, market);
        return market;
      } catch { slugCache.set(slug, null); return null; }
    }

    async function resolveViaTokenMidpoint(tokenId) {
      try {
        const r = await fetch(`${CLOB_BASE}/midpoint?token_id=${encodeURIComponent(tokenId)}`, { headers: { Accept: "application/json" } });
        if (!r.ok) return null;
        const data = await r.json();
        const mid = toNum(data?.mid, -1);
        if (mid === 1) return true;
        if (mid === 0) return false;
        return null;
      } catch { return null; }
    }

    resolveJobRunning = true;
    let updated = 0, skipped = 0, failed = 0;

    try {
      const historyPath = path.join(__dirname, "..", "logs", "trade_history.json");
      if (!isPostgresEnabled() && !fs.existsSync(historyPath)) {
        send({ type: "error", msg: "❌ trade_history.json não encontrado." });
        send({ type: "done", updated: 0, skipped: 0, failed: 0 });
        return;
      }

      const history = isPostgresEnabled()
        ? await listTradeHistoryRecords()
        : JSON.parse(fs.readFileSync(historyPath, "utf8"));

      const pending = history.filter(t => {
        if (since > 0 && (t.timestamp || 0) < since) return false;
        return needsMarketResolution(t);
      });

      send({ type: "info", msg: `📂 ${history.length} registros | ${pending.length} para processar` });

      if (pending.length === 0) {
        send({ type: "info", msg: "✅ Nenhum trade pendente no período selecionado." });
        sendCsvReconciliation(dryRun ? history : (isPostgresEnabled() ? await listTradeHistoryRecords() : readTradeHistoryFile(historyPath)), dryRun);
        sendHistoryBackfill(historyPath, dryRun);
        if (dryRun) {
          send({ type: "info", msg: "🧪 [DRY_RUN] Alterações NÃO salvas." });
        }
        send({ type: "done", updated: 0, skipped: 0, failed: 0 });
        return;
      }

      for (const trade of pending) {
        const label = `[${trade.metadata?.indicator ?? "?"}] ${trade.metadata?.marketSlug ?? String(trade.tokenId).substring(0, 16) + "..."}`;
        send({ type: "processing", msg: `⏳ ${label}`, label });

        try {
          const slug     = trade.metadata?.marketSlug;
          const tokenId  = trade.tokenId;
          const notPlaced = !trade.orderId || ["skipped", "rejected", "error"].includes(trade.status);
          const sizeMatched = toNum(trade.sizeMatched ?? trade.filledSize, 0);
          const filledShares = notPlaced ? sizeMatched : toNum(trade.shares, 0);
          const filledUsd    = notPlaced ? sizeMatched * toNum(trade.price, 0) : toNum(trade.sizeUsd, 0);

          let result = null;

          // Abordagem 1: Gamma via slug
          if (slug) {
            const market = await resolveViaSlug(slug);
            if (market) {
              const closed        = Boolean(market.closed);
              const clobTokenIds  = safeArr(market.clobTokenIds);
              const outcomePrices = safeArr(market.outcomePrices);
              const numericPrices = outcomePrices.map(p => parseFloat(p));
              const isResolved    = closed && numericPrices.length === 2
                && numericPrices.every(p => p === 0 || p === 1)
                && numericPrices.some(p => p === 1);

              if (isResolved && tokenId) {
                const idx = clobTokenIds.findIndex(id => String(id) === String(tokenId));
                if (idx >= 0) {
                  const won = numericPrices[idx] >= 0.5;
                  const pnl = won
                    ? parseFloat((filledShares - filledUsd).toFixed(2))
                    : parseFloat((-filledUsd).toFixed(2));
                  result = { source: "gamma", won, pnl, marketClosed: closed, marketResolved: true };
                }
              } else if (!closed) {
                result = { source: "gamma", marketClosed: false, marketResolved: false };
              }
            }
          }

          // Abordagem 2: CLOB midpoint
          if (!result?.marketResolved && tokenId) {
            const wonViaToken = await resolveViaTokenMidpoint(tokenId);
            if (wonViaToken !== null) {
              const pnl = wonViaToken
                ? parseFloat((filledShares - filledUsd).toFixed(2))
                : parseFloat((-filledUsd).toFixed(2));
              result = { source: "clob", won: wonViaToken, pnl, marketClosed: true, marketResolved: true };
            }
          }

          if (!result || !result.marketResolved) {
            send({ type: "skip", msg: `⏩ ${label} — mercado ainda ativo`, label });
            skipped++;
          } else {
            trade.marketClosed   = result.marketClosed;
            trade.marketResolved = result.marketResolved;
            trade.resolved       = true;
            trade.won            = result.won;
            trade.pnl            = result.pnl;
            trade.executionStatus = "resolved";
            const pnlStr = result.pnl >= 0 ? `+$${result.pnl}` : `-$${Math.abs(result.pnl)}`;
            send({ type: "resolved", msg: `${result.won ? "✅" : "❌"} ${label} — ${result.won ? "GANHOU" : "PERDEU"} ${pnlStr} [${result.source}]${dryRun ? " [DRY]" : ""}`, won: result.won, pnl: result.pnl, label });
            updated++;
          }
        } catch (err) {
          send({ type: "error", msg: `💥 ${label} — ${err.message}`, label });
          failed++;
        }

        await new Promise(r => setTimeout(r, DELAY_MS));
      }

      if (dryRun) {
        sendCsvReconciliation(history, true);
        sendHistoryBackfill(historyPath, true);
        send({ type: "info", msg: "🧪 [DRY_RUN] Alterações NÃO salvas." });
      } else {
        if (updated > 0) {
          if (isPostgresEnabled()) {
            await upsertTradeHistoryRecords(history);
            send({ type: "info", msg: `💾 Salvo no Postgres | ${history.length} registro(s)` });
            sendCsvReconciliation(history, false);
          } else {
            const backupPath = historyPath.replace(".json", `.backup-${Date.now()}.json`);
            fs.copyFileSync(historyPath, backupPath);
            const latestHistory = readTradeHistoryFile(historyPath);
            const mergedHistory = mergeTradeHistoryRecords(latestHistory, history);
            writeTradeHistoryFileAtomic(historyPath, mergedHistory);
            send({ type: "info", msg: `💾 Salvo — backup em ${path.basename(backupPath)} | ${mergedHistory.length} registro(s)` });
            sendCsvReconciliation(mergedHistory, false);
          }
          sendHistoryBackfill(historyPath, false);
        } else {
          send({ type: "info", msg: isPostgresEnabled() ? "ℹ️ Nenhuma alteração nova em trade_history/Postgres." : "ℹ️ Nenhuma alteração nova em trade_history.json." });
          sendCsvReconciliation(isPostgresEnabled() ? await listTradeHistoryRecords() : readTradeHistoryFile(historyPath), false);
          sendHistoryBackfill(historyPath, false);
        }
      }

      send({ type: "done", updated, skipped, failed });
    } catch (err) {
      send({ type: "error", msg: `❌ Erro fatal: ${err.message}` });
      send({ type: "done", updated, skipped, failed });
    } finally {
      resolveJobRunning = false;
      res.end();
    }
  });

  // Handle WebSocket messages from client
  wss.on("connection", (ws) => {
    ws.on("message", async (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.action === "analyze") {
          const tf = data.timeframe === "15m" ? "15m" : "5m";
          const engine = tf === "15m" ? engine15m : engine5m;
          const filterMode = data.mode || null;
          const result = filterMode
            ? await engine.getAnalysisForMode(filterMode)
            : await engine.getAnalysis();
          ws.send(JSON.stringify({ type: "analysis", timeframe: tf, data: result, mode: filterMode }));
        }
        // ── Get current config ──
        if (data.action === "getConfig") {
          ws.send(JSON.stringify({ type: "config", data: buildConfigPayload() }));
        }
        // ── Update config at runtime ──
        if (data.action === "setConfig") {
          // Update enabled indicators per timeframe
          if (Array.isArray(data.enabledIndicators5m)) {
            tradingConfig.enabledIndicators5m.clear();
            for (const name of data.enabledIndicators5m) {
              if (ALL_INDICATORS.includes(name)) tradingConfig.enabledIndicators5m.add(name);
            }
          }
          if (Array.isArray(data.enabledIndicators15m)) {
            tradingConfig.enabledIndicators15m.clear();
            for (const name of data.enabledIndicators15m) {
              if (ALL_INDICATORS.includes(name)) tradingConfig.enabledIndicators15m.add(name);
            }
          }
          if (data.enabledIndicators5m || data.enabledIndicators15m) {
            syncScalpConfigEnabledFlags();
            console.log(`⚙️  [Config] 5m: ${tradingConfig.enabledIndicators5m.size} indicadores | 15m: ${tradingConfig.enabledIndicators15m.size} indicadores`);
          }
          // Update per-indicator stakes (legacy field)
          if (data.stakesPerIndicator && typeof data.stakesPerIndicator === "object") {
            for (const [name, val] of Object.entries(data.stakesPerIndicator)) {
              if (!ALL_INDICATORS.includes(name)) continue;
              const parsed = parseFloat(val);
              if (Number.isFinite(parsed) && parsed >= 0.1) {
                const rounded = Math.round(parsed * 100) / 100;
                tradingConfig.stakesPerIndicator[name] = rounded;
                const cfg = tradingConfig.indicatorConfigs[name];
                if (cfg) cfg.stakeUsd = rounded;
              }
            }
          }
          // Update per-indicator full configs (new extensible field)
          if (data.indicatorConfigs && typeof data.indicatorConfigs === "object") {
            for (const [name, patch] of Object.entries(data.indicatorConfigs)) {
              if (!ALL_INDICATORS.includes(name)) continue;
              const current = tradingConfig.indicatorConfigs[name] || { stakeUsd: DEFAULT_STAKE };
              const merged = mergeIndicatorConfigPatch(name, current, patch);
              tradingConfig.indicatorConfigs[name] = merged;
              if (isScalpIndicator(name) && typeof patch?.enabled === "boolean") {
                setScalpIndicatorEnabled(name, patch.enabled);
              }
              // Mirror stakeUsd into legacy map
              if (Number.isFinite(merged.stakeUsd)) {
                tradingConfig.stakesPerIndicator[name] = merged.stakeUsd;
              }
            }
            const scalpChanges = Object.keys(data.indicatorConfigs).filter(n => SCALP_INDICATORS.has(n));
            if (scalpChanges.length) {
              console.log(`⚙️  [Config] scalp params atualizados: ${scalpChanges.join(", ")}`);
            }
          }
          if (data.scalpStrategyBindings && typeof data.scalpStrategyBindings === "object") {
            for (const name of SCALP_INDICATORS) {
              const b = data.scalpStrategyBindings[name];
              if (!b || typeof b !== "object") continue;
              tradingConfig.scalpStrategyBindings[name] = tradingConfig.scalpStrategyBindings[name] || { graph: null };
              if (b.graph && typeof b.graph === "object" && Array.isArray(b.graph.nodes) && b.graph.nodes.length) {
                const patch = compileScalpStrategyGraphToPatch(b.graph);
                if (Object.keys(patch).length) {
                  tradingConfig.indicatorConfigs[name] = mergeIndicatorConfigPatch(
                    name,
                    tradingConfig.indicatorConfigs[name] || { stakeUsd: DEFAULT_STAKE },
                    patch
                  );
                }
                tradingConfig.scalpStrategyBindings[name].graph = b.graph;
              }
            }
          }
          // Update DRY_RUN mode
          if (typeof data.dryRun === "boolean") {
            const oldMode = polyTrader.dryRun;
            polyTrader.dryRun = data.dryRun;
            if (oldMode !== data.dryRun) {
              const label = data.dryRun ? "📡 SCALP MONITOR (SIM)" : "💰 LIVE TRADING";
              console.log(`⚡ [Config] Modo alterado para: ${label}`);
            }
          }
          savePersistedTradingConfig();
          // Broadcast updated config to all clients
          broadcast({ type: "config", data: buildConfigPayload() });
        }
      } catch { /* ignore */ }
    });
  });

  // Global safety net — log and swallow unhandled rejections so the process
  // does not crash from dangling async timeouts (e.g. CLOB fetchWithTimeout
  // timers that fire after a Promise.race budget already settled).
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logEngineDiagnostic("unhandled_rejection", { message: msg });
    console.error("[unhandledRejection] swallowed:", msg);
  });

  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, () => {
    console.log(`✅ Dashboard: http://localhost:${PORT}`);
    console.log(`   Collecting data for 5m and 15m simultaneously\n`);
    primeBinanceFeedHosts().catch((e) => {
      console.warn(`⚠️  Binance feed prime (ignorado): ${e?.message || e}`);
    });
  });

  // Rotate old log files on startup and every 24 hours
  const logMaxAgeDays = parseInt(process.env.LOG_MAX_AGE_DAYS || "7", 10);
  const prunedOnStart = pruneOldLogs("./logs", logMaxAgeDays);
  if (prunedOnStart > 0) console.log(`🗑  Removed ${prunedOnStart} log file(s) older than ${logMaxAgeDays} days.`);
  setInterval(() => pruneOldLogs("./logs", logMaxAgeDays), 86_400_000);

  // Signal CSV — written every 15s, for the active (5m) engine for now
  const signalsCsvPath = "./logs/signals.csv";
  const signalsCsvHeader = [
    "timestamp", "window_min", "entry_minute", "time_left_min",
    "regime", "signal", "model_up", "model_down",
    "mkt_up", "mkt_down", "edge_up", "edge_down", "recommendation"
  ];
  const lastSignalWriteByTf = new Map();
  let lastTradeRefreshMs = 0;

  function persistSignalRowFromPayload(payload) {
    if (!payload || payload.type !== "tick" || !payload.data) return;
    const tf = payload.timeframe === "15m" ? "15m" : "5m";
    const now = Date.now();
    const lastWrite = lastSignalWriteByTf.get(tf) || 0;
    if (now - lastWrite < 15_000) return;
    lastSignalWriteByTf.set(tf, now);

    const d = payload.data;
    const wm = d.market?.windowMinutes ?? (tf === "15m" ? 15 : 5);
    const entryMin = wm - (d.market?.timeLeft ?? 0);
    const signalRow = [
      new Date().toISOString(),
      wm,
      entryMin.toFixed(3),
      (d.market?.timeLeft ?? 0).toFixed(3),
      d.regime ?? "-",
      d.signal ?? "NO TRADE",
      d.indicators?.taPredict?.longPct ?? null,
      d.indicators?.taPredict?.shortPct ?? null,
      d.polymarket?.upPrice ?? null,
      d.polymarket?.downPrice ?? null,
      null,
      null,
      d.signal ?? "NO_TRADE"
    ];
    persistRuntimeRow({
      eventType: "signal",
      timeframe: tf,
      marketSlug: d.market?.slug || null,
      timestamp: signalRow[0],
      header: signalsCsvHeader,
      values: signalRow,
      filePath: signalsCsvPath
    });
  }

  function startEngineRunner(timeframe, engine) {
    const loopWatch = {
      id: 0,
      running: false,
      startedAt: 0,
      lastLoggedAt: 0
    };

    setInterval(() => {
      if (!loopWatch.running) return;
      const ageMs = Date.now() - loopWatch.startedAt;
      if (ageMs < CONFIG.watchdogMs) return;
      if (Date.now() - loopWatch.lastLoggedAt < CONFIG.watchdogMs) return;
      loopWatch.lastLoggedAt = Date.now();
      const message = `Loop ${timeframe} sem finalizar ha ${Math.round(ageMs / 1000)}s`;
      logEngineDiagnostic("loop_stalled", {
        loopId: loopWatch.id,
        timeframe,
        ageMs,
        tickTimeoutMs: CONFIG.tickTimeoutMs
      }, "error");
      broadcast({
        type: "engine_status",
        timeframe,
        status: "stalled",
        message,
        ageMs,
        loopId: loopWatch.id
      });
    }, 1_000).unref?.();

    setInterval(async () => {
      if (loopWatch.running) return;
      loopWatch.id++;
      loopWatch.running = true;
      loopWatch.startedAt = Date.now();
      try {
        const payload = await withTimeout(engine.tick(), CONFIG.tickTimeoutMs, `engine ${timeframe} tick`)
          .catch(err => ({ type: "error", timeframe, error: formatEngineError(err) }));
        const loopDurationMs = Date.now() - loopWatch.startedAt;
        if (loopDurationMs >= CONFIG.slowTickMs) {
          logEngineDiagnostic("loop_slow", { loopId: loopWatch.id, timeframe, durationMs: loopDurationMs }, "warn");
        }
        broadcast(payload);
        persistSignalRowFromPayload(payload);

        const nowMs = Date.now();
        if (nowMs - lastTradeRefreshMs >= 60_000) {
          lastTradeRefreshMs = nowMs;
          polyTrader.refreshTradeResults().catch(() => {});
        }
      } catch (err) {
        console.error(`Loop ${timeframe} error:`, err?.message);
        logEngineDiagnostic("loop_error", { loopId: loopWatch.id, timeframe, error: formatEngineError(err) }, "error");
      } finally {
        loopWatch.running = false;
      }
    }, 1_000);
  }

  startEngineRunner("5m", engine5m);
  // FIX AH: Stagger 15m engine by 500ms so its 2 CLOB price fetches never
  // fire simultaneously with the 5m engine's 2 CLOB fetches. With both at the
  // same interval start, all 4 TLS connections open at once, saturating libuv's
  // 4 crypto thread pool workers and causing 1000+ ms event loop freezes.
  setTimeout(() => startEngineRunner("15m", engine15m), 500);
}

main();
