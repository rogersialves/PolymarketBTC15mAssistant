// ─── Window Presets ───────────────────────────────────────────────
// Each preset contains all parameters that vary depending on the
// candle window (5 min or 15 min). The active window is selected
// interactively at startup or via the CANDLE_WINDOW_MINUTES env variable.

export const WINDOW_PRESETS = {
  5: {
    seriesId: "10684",
    seriesSlug: "btc-updown-5m",
    vwapSlopeLookbackMinutes: 3,
    phases: { earlyAbove: 3.3, midAbove: 1.5 },
    timerColors: { greenAbove: 3.3, yellowAbove: 1.5 }
  },
  15: {
    seriesId: "10192",
    seriesSlug: "btc-up-or-down-15m",
    vwapSlopeLookbackMinutes: 5,
    phases: { earlyAbove: 10, midAbove: 5 },
    timerColors: { greenAbove: 10, yellowAbove: 5 }
  }
};

// ─── Exported Configuration ───────────────────────────────────────

export const CONFIG = {
  // Binance
  symbol: "BTCUSDT",
  binanceBaseUrl: process.env.BINANCE_BASE_URL || "https://api.binance.com",
  binanceBaseUrls: (process.env.BINANCE_BASE_URLS || `${process.env.BINANCE_BASE_URL || "https://api.binance.com"},https://api.binance.us`)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  binanceWsBaseUrl: process.env.BINANCE_WS_BASE_URL || "wss://stream.binance.com:9443",

  // Polymarket APIs
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",

  // Timing
  pollIntervalMs: 1_000,
  httpTimeoutMs: Number(process.env.HTTP_TIMEOUT_MS || 4_000),
  tickTimeoutMs: Number(process.env.ENGINE_TICK_TIMEOUT_MS || 8_000),
  slowTickMs: Number(process.env.ENGINE_SLOW_TICK_MS || 3_000),
  watchdogMs: Number(process.env.ENGINE_WATCHDOG_MS || 6_000),
  binanceFailoverBudgetMs: Number(process.env.BINANCE_FAILOVER_BUDGET_MS || 5_000),
  polymarketSnapshotClobBudgetMs: Number(process.env.POLYMARKET_SNAPSHOT_CLOB_BUDGET_MS || 1_500),
  polymarketResolveCacheMs: Number(process.env.POLYMARKET_RESOLVE_CACHE_MS || 15_000),
  binanceKlinesCacheMs: Number(process.env.BINANCE_KLINES_CACHE_MS || 10_000),
  binanceLastPriceCacheMs: Number(process.env.BINANCE_LAST_PRICE_CACHE_MS || 2_000),
  exchangeTickerCacheMs: Number(process.env.EXCHANGE_TICKER_CACHE_MS || 10_000),
  candleWindowMinutes: 5,

  // Indicators
  vwapSlopeLookbackMinutes: 3,
  rsiPeriod: 14,
  rsiMaPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  // Bollinger Bands
  bollingerPeriod: 20,
  bollingerStdDev: 2,

  // Stochastic RSI
  stochRsiPeriod: 14,
  stochRsiSmooth: 3,

  // EMA Cross
  emaFast: 9,
  emaSlow: 21,

  // On-Balance Volume
  obvSlopeLookback: 5,

  // Average True Range
  atrPeriod: 14,

  // Decision phases (set by applyWindowPreset)
  phases: { earlyAbove: 3.3, midAbove: 1.5 },

  // Timer color thresholds (set by applyWindowPreset)
  timerColors: { greenAbove: 3.3, yellowAbove: 1.5 },

  // Polymarket market selection
  polymarket: {
    marketSlug: process.env.POLYMARKET_SLUG || "",
    seriesId: "",
    seriesSlug: "",
    autoSelectLatest: (process.env.POLYMARKET_AUTO_SELECT_LATEST || "true").toLowerCase() === "true",
    liveDataWsUrl: process.env.POLYMARKET_LIVE_WS_URL || "wss://ws-live-data.polymarket.com",
    upOutcomeLabel: process.env.POLYMARKET_UP_LABEL || "Up",
    downOutcomeLabel: process.env.POLYMARKET_DOWN_LABEL || "Down"
  },

  // Chainlink oracle (Polygon)
  chainlink: {
    polygonRpcUrls: (process.env.POLYGON_RPC_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonRpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    polygonWssUrls: (process.env.POLYGON_WSS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonWssUrl: process.env.POLYGON_WSS_URL || "",
    btcUsdAggregator: process.env.CHAINLINK_BTC_USD_AGGREGATOR || "0xc907E116054Ad103354f2D350FD2514433D57F6f"
  }
};

/**
 * Applies a window preset (5 or 15 min) to CONFIG at runtime.
 * Called once at startup after user selects the window.
 */
export function applyWindowPreset(windowMinutes) {
  const preset = WINDOW_PRESETS[windowMinutes] ?? WINDOW_PRESETS[5];

  CONFIG.candleWindowMinutes = windowMinutes;
  CONFIG.vwapSlopeLookbackMinutes = preset.vwapSlopeLookbackMinutes;
  CONFIG.phases = preset.phases;
  CONFIG.timerColors = preset.timerColors;
  CONFIG.polymarket.seriesId = process.env.POLYMARKET_SERIES_ID || preset.seriesId;
  CONFIG.polymarket.seriesSlug = process.env.POLYMARKET_SERIES_SLUG || preset.seriesSlug;
}
