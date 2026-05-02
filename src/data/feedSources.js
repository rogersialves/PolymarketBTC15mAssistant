import { CONFIG } from "../config.js";
import { getBinanceFeedHostsSnapshot } from "./binance.js";

const CHAINLINK_FRESH_MS = 45_000;

function binanceFreshWindowMs() {
  const k = Number(CONFIG.binanceKlinesCacheMs) || 2_000;
  const p = Number(CONFIG.binanceLastPriceCacheMs) || 2_000;
  return Math.max(60_000, 3 * Math.max(k, p));
}

function isChainlinkMisconfigured() {
  if (!CONFIG.chainlink?.btcUsdAggregator) return true;
  const hasRpc =
    Boolean(String(CONFIG.chainlink.polygonRpcUrl || "").trim()) ||
    (Array.isArray(CONFIG.chainlink.polygonRpcUrls) &&
      CONFIG.chainlink.polygonRpcUrls.some((s) => String(s).trim()));
  if (!hasRpc) return true;
  return false;
}

/**
 * @param {object} raw
 * @param {boolean} raw.configured
 * @param {number|null} raw.lastOkAt
 * @param {number|null} raw.lastLatencyMs
 * @param {string|null} raw.lastError
 * @param {number} raw.cooldownUntil
 * @param {number} now
 * @param {number} freshMs
 */
export function buildBinanceHostFeedStatus(raw, now, freshMs) {
  if (!raw || !raw.configured) {
    return {
      status: "unknown",
      detail: "não configurado em BINANCE_BASE_URLS",
      ageMs: null,
      latencyMs: null,
      preferred: Boolean(raw?.preferred)
    };
  }
  if (raw.cooldownUntil > now) {
    const sec = Math.ceil((raw.cooldownUntil - now) / 1000);
    return {
      status: "down",
      detail: `cooldown ${sec}s${raw.lastError ? ` · ${raw.lastError}` : ""}`,
      ageMs: raw.lastOkAt ? now - raw.lastOkAt : null,
      latencyMs: raw.lastLatencyMs ?? null,
      preferred: Boolean(raw.preferred)
    };
  }
  if (raw.lastOkAt !== null && raw.lastOkAt !== undefined && now - raw.lastOkAt <= freshMs) {
    return {
      status: "ok",
      detail: raw.preferred ? "ativo (preferido)" : "OK",
      ageMs: now - raw.lastOkAt,
      latencyMs: raw.lastLatencyMs ?? null,
      preferred: Boolean(raw.preferred)
    };
  }
  if (raw.lastOkAt !== null && raw.lastOkAt !== undefined) {
    return {
      status: "stale",
      detail: raw.lastError ? `último erro: ${raw.lastError}` : "sem sucesso recente",
      ageMs: now - raw.lastOkAt,
      latencyMs: raw.lastLatencyMs ?? null,
      preferred: Boolean(raw.preferred)
    };
  }
  return {
    status: "unknown",
    detail: raw.lastError ? `sem OK ainda · ${raw.lastError}` : "sem tentativa ainda",
    ageMs: null,
    latencyMs: null,
    preferred: Boolean(raw.preferred)
  };
}

/**
 * @param {object} params
 * @param {number} params.now
 * @param {object|null} params.chainlinkData — { price, updatedAt, source }
 * @param {boolean} [params.polymarketCurrentFresh]
 * @param {number|null} [params.polymarketPriceAgeMs]
 */
export function buildChainlinkFeedStatus({
  now,
  chainlinkData,
  polymarketCurrentFresh = false,
  polymarketPriceAgeMs = null
}) {
  if (isChainlinkMisconfigured()) {
    return {
      status: "misconfigured",
      detail: "RPC Polygon ou CHAINLINK_BTC_USD_AGGREGATOR ausente",
      source: "missing_config",
      ageMs: null
    };
  }
  const data = chainlinkData && typeof chainlinkData === "object" ? chainlinkData : {};
  const source = String(data.source || "");
  if (source === "missing_config") {
    return {
      status: "misconfigured",
      detail: "Chainlink não configurado",
      source: "missing_config",
      ageMs: null
    };
  }
  const price = data.price;
  const updatedAt = data.updatedAt != null ? Number(data.updatedAt) : null;
  const finite = price !== null && price !== undefined && Number.isFinite(Number(price));
  const ageMs =
    updatedAt !== null && Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : null;

  if (polymarketCurrentFresh) {
    const polyAge =
      polymarketPriceAgeMs != null && Number.isFinite(Number(polymarketPriceAgeMs))
        ? Math.max(0, Number(polymarketPriceAgeMs))
        : 0;
    if (polyAge <= CHAINLINK_FRESH_MS) {
      return {
        status: "ok",
        detail: "stream Polymarket (referência Chainlink)",
        source: "polymarket_ws",
        ageMs: polyAge
      };
    }
    return {
      status: "degraded",
      detail: "Polymarket com latência alta",
      source: "polymarket_ws",
      ageMs: polyAge
    };
  }

  if (!finite) {
    return {
      status: "down",
      detail: "sem preço oracle",
      source: source || "—",
      ageMs
    };
  }

  if (source.includes("cache") || source === "chainlink_cache") {
    return {
      status: "degraded",
      detail: "fallback em cache / timeout",
      source,
      ageMs
    };
  }

  if (ageMs !== null && ageMs <= CHAINLINK_FRESH_MS) {
    return {
      status: "ok",
      detail: ageMs < 5000 ? "fresco" : `atualizado há ${(ageMs / 1000).toFixed(0)}s`,
      source: source || "chainlink",
      ageMs
    };
  }

  return {
    status: "degraded",
    detail: ageMs !== null ? `dados com ${(ageMs / 1000).toFixed(0)}s` : "idade desconhecida",
    source: source || "chainlink",
    ageMs
  };
}

/**
 * Snapshot for WebSocket tick `data.feedSources`.
 * @param {object} opts
 * @param {number} opts.now
 * @param {object|null} [opts.chainlinkData]
 * @param {boolean} [opts.polymarketCurrentFresh]
 * @param {object} [opts.binanceSnapshot] — override for tests (default: live getBinanceFeedHostsSnapshot())
 */
export function buildFeedSourcesSnapshot({
  now = Date.now(),
  chainlinkData = null,
  polymarketCurrentFresh = false,
  polymarketPriceAgeMs = null,
  binanceSnapshot = null
} = {}) {
  const freshMs = binanceFreshWindowMs();
  const rawBinance = binanceSnapshot || getBinanceFeedHostsSnapshot();
  const binanceCom = buildBinanceHostFeedStatus(rawBinance.binanceCom, now, freshMs);
  const binanceUs = buildBinanceHostFeedStatus(rawBinance.binanceUs, now, freshMs);
  const chainlink = buildChainlinkFeedStatus({
    now,
    chainlinkData,
    polymarketCurrentFresh,
    polymarketPriceAgeMs
  });
  return { binanceCom, binanceUs, chainlink };
}
