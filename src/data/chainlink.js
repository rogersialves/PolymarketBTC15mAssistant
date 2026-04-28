import { ethers } from "ethers";
import { CONFIG } from "../config.js";
import { fetchWithTimeout } from "../net/http.js";

const AGGREGATOR_ABI = [
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function getRoundData(uint80 _roundId) view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)"
];

const iface = new ethers.Interface(AGGREGATOR_ABI);

let preferredRpcUrl = null;

let cachedDecimals = null;
let cachedResult = { price: null, updatedAt: null, source: "chainlink" };
let cachedFetchedAtMs = 0;
let latestFetchInFlight = null;
const MIN_FETCH_INTERVAL_MS = 2_000;
const RPC_TIMEOUT_MS = 1_500;
const NETWORK_BUDGET_MS = Math.max(1_000, Number(process.env.CHAINLINK_NETWORK_BUDGET_MS || 3_000));

function timeoutReject(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
}

function getRpcCandidates() {
  const fromList = Array.isArray(CONFIG.chainlink.polygonRpcUrls) ? CONFIG.chainlink.polygonRpcUrls : [];
  const single = CONFIG.chainlink.polygonRpcUrl ? [CONFIG.chainlink.polygonRpcUrl] : [];
  // Defaults sem API key validados em 2026-04: polygon-rpc.com e rpc.ankr.com
  // passaram a exigir autenticação; polygon.llamarpc.com está inalcançável.
  const defaults = [
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.drpc.org"
  ];

  const all = [...fromList, ...single, ...defaults].map((s) => String(s).trim()).filter(Boolean);
  return Array.from(new Set(all));
}

function getOrderedRpcs() {
  const rpcs = getRpcCandidates();
  const pref = preferredRpcUrl;
  if (pref && rpcs.includes(pref)) {
    return [pref, ...rpcs.filter((x) => x !== pref)];
  }
  return rpcs;
}

async function jsonRpcRequest(rpcUrl, method, params) {
  const res = await fetchWithTimeout(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  }, {
    timeoutMs: RPC_TIMEOUT_MS,
    label: `Chainlink RPC ${method}`
  });

  if (!res.ok) {
    throw new Error(`rpc_http_${res.status}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`rpc_error_${data.error.code}`);
  }
  return data.result;
}

async function ethCall(rpcUrl, to, data) {
  return await jsonRpcRequest(rpcUrl, "eth_call", [{ to, data }, "latest"]);
}

async function fetchDecimals(rpcUrl, aggregator) {
  const data = iface.encodeFunctionData("decimals", []);
  const result = await ethCall(rpcUrl, aggregator, data);
  const [dec] = iface.decodeFunctionResult("decimals", result);
  return Number(dec);
}

async function fetchLatestRoundData(rpcUrl, aggregator) {
  const data = iface.encodeFunctionData("latestRoundData", []);
  const result = await ethCall(rpcUrl, aggregator, data);
  const decoded = iface.decodeFunctionResult("latestRoundData", result);
  return {
    roundId: decoded[0],   // BigInt (uint80)
    answer: decoded[1],
    updatedAt: decoded[3]
  };
}

async function fetchRoundDataAt(rpcUrl, aggregator, roundId) {
  const data = iface.encodeFunctionData("getRoundData", [roundId]);
  const result = await ethCall(rpcUrl, aggregator, data);
  const decoded = iface.decodeFunctionResult("getRoundData", result);
  return {
    answer: decoded[1],
    updatedAt: Number(decoded[3])  // Unix seconds
  };
}

// ─── Historical PTB lookup (per market slug) ─────────────────────────────────
// Cache: slug → { price, fetchedAt }
const ptbHistoricalCache = new Map();
let ptbFetchInFlight = new Set(); // slugs currently being fetched

/**
 * Fetches the official Chainlink BTC/USD price at the exact Unix second
 * encoded in the market slug (e.g. btc-updown-5m-1777249200 → 1777249200).
 *
 * Uses binary search over the current aggregator phase rounds to locate the
 * round whose updatedAt ≤ targetUnixSec and the next round's updatedAt >
 * targetUnixSec. This matches exactly how Polymarket resolves these markets.
 *
 * Returns the price (number) or null on failure.
 */
export async function fetchChainlinkPriceAtTimestamp(targetUnixSec) {
  if (!CONFIG.chainlink.btcUsdAggregator) return null;
  if ((!CONFIG.chainlink.polygonRpcUrl && (!CONFIG.chainlink.polygonRpcUrls || CONFIG.chainlink.polygonRpcUrls.length === 0))) return null;

  const aggregator = CONFIG.chainlink.btcUsdAggregator;
  const rpcs = getOrderedRpcs();

  for (const rpc of rpcs) {
    try {
      if (cachedDecimals === null) {
        cachedDecimals = await fetchDecimals(rpc, aggregator);
      }

      // Get latest round to determine phase and current position
      const latest = await fetchLatestRoundData(rpc, aggregator);
      const latestRoundId = BigInt(latest.roundId);
      const latestTs = Number(latest.updatedAt);

      // EACAggregatorProxy round format: upper 16 bits = phase, lower 64 = agg round
      const phaseId = latestRoundId >> 64n;
      const latestAggRound = latestRoundId & 0xFFFFFFFFFFFFFFFFn;

      // If target is in the future or current round is already it, return now
      if (targetUnixSec >= latestTs) {
        const scale = 10 ** cachedDecimals;
        return Number(latest.answer) / scale;
      }

      // Estimate how many rounds to look back.
      // Chainlink BTC/USD heartbeat is ~27s; be conservative with 5s floor.
      const secBack = latestTs - targetUnixSec;
      const estRoundsBack = BigInt(Math.ceil(secBack / 5));

      // Search bounds: don't go below round 1, cap upper at latest
      const searchLow = latestAggRound > estRoundsBack * 3n
        ? latestAggRound - estRoundsBack * 3n
        : 1n;
      const searchHigh = latestAggRound;

      // Binary search: find greatest aggRound where updatedAt ≤ targetUnixSec
      let low = searchLow;
      let high = searchHigh;

      while (low < high) {
        const mid = (low + high + 1n) / 2n;
        const midRound = await fetchRoundDataAt(rpc, aggregator, (phaseId << 64n) | mid);
        if (midRound.updatedAt <= targetUnixSec) {
          low = mid;
        } else {
          high = mid - 1n;
        }
      }

      // Fallback: if low's timestamp is still after target, expand search window
      const finalRoundId = (phaseId << 64n) | low;
      const finalRound = await fetchRoundDataAt(rpc, aggregator, finalRoundId);

      if (finalRound.updatedAt > targetUnixSec) {
        // Target is before our search window — widen and retry with lower bound 1
        if (low > 1n) {
          low = 1n;
          high = searchLow;
          while (low < high) {
            const mid = (low + high + 1n) / 2n;
            const midRound = await fetchRoundDataAt(rpc, aggregator, (phaseId << 64n) | mid);
            if (midRound.updatedAt <= targetUnixSec) {
              low = mid;
            } else {
              high = mid - 1n;
            }
          }
          const retryRound = await fetchRoundDataAt(rpc, aggregator, (phaseId << 64n) | low);
          const scale = 10 ** cachedDecimals;
          return Number(retryRound.answer) / scale;
        }
        return null;
      }

      const scale = 10 ** cachedDecimals;
      preferredRpcUrl = rpc;
      return Number(finalRound.answer) / scale;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Returns cached PTB for a slug, or kicks off an async fetch and returns null
 * until resolved (fire-and-forget pattern for use in the tick loop).
 */
export function getCachedPtbForSlug(slug) {
  return ptbHistoricalCache.get(slug)?.price ?? null;
}

export async function ensurePtbForSlug(slug) {
  if (ptbHistoricalCache.has(slug)) return ptbHistoricalCache.get(slug).price;
  if (ptbFetchInFlight.has(slug)) return null;

  // Extract Unix timestamp from slug (last segment)
  const parts = slug.split("-");
  const lastPart = parts[parts.length - 1];
  const targetUnixSec = Number(lastPart);
  if (!Number.isFinite(targetUnixSec) || targetUnixSec < 1_000_000_000) return null;

  ptbFetchInFlight.add(slug);
  try {
    const price = await fetchChainlinkPriceAtTimestamp(targetUnixSec);
    if (price !== null && Number.isFinite(price)) {
      ptbHistoricalCache.set(slug, { price, fetchedAt: Date.now() });
    }
    return price;
  } finally {
    ptbFetchInFlight.delete(slug);
  }
}

export async function fetchChainlinkBtcUsd() {
  if ((!CONFIG.chainlink.polygonRpcUrl && (!CONFIG.chainlink.polygonRpcUrls || CONFIG.chainlink.polygonRpcUrls.length === 0)) || !CONFIG.chainlink.btcUsdAggregator) {
    return { price: null, updatedAt: null, source: "missing_config" };
  }

  const now = Date.now();
  if (cachedFetchedAtMs && now - cachedFetchedAtMs < MIN_FETCH_INTERVAL_MS) {
    return cachedResult;
  }
  if (cachedResult.price !== null) {
    if (!latestFetchInFlight) {
      latestFetchInFlight = fetchChainlinkBtcUsdFromNetwork(now)
        .catch(() => cachedResult)
        .finally(() => { latestFetchInFlight = null; });
    }
    return cachedResult;
  }
  if (latestFetchInFlight) return latestFetchInFlight;

  latestFetchInFlight = fetchChainlinkBtcUsdFromNetwork(now);
  try {
    return await latestFetchInFlight;
  } finally {
    latestFetchInFlight = null;
  }
}

async function fetchChainlinkBtcUsdFromNetwork(now = Date.now()) {
  const rpcs = getOrderedRpcs();
  if (rpcs.length === 0) return { price: null, updatedAt: null, source: "missing_config" };

  const aggregator = CONFIG.chainlink.btcUsdAggregator;
  const startedAt = Date.now();

  for (const rpc of rpcs) {
    const elapsedMs = Date.now() - startedAt;
    const remainingBudgetMs = NETWORK_BUDGET_MS - elapsedMs;
    if (remainingBudgetMs <= 0) {
      break;
    }

    preferredRpcUrl = rpc;
    try {
      const attempt = (async () => {
        if (cachedDecimals === null) {
          cachedDecimals = await fetchDecimals(rpc, aggregator);
        }
        return await fetchLatestRoundData(rpc, aggregator);
      })();

      const round = await Promise.race([
        attempt,
        timeoutReject(remainingBudgetMs, "Chainlink network budget")
      ]);
      const answer = Number(round.answer);
      const scale = 10 ** Number(cachedDecimals);
      const price = answer / scale;

      cachedResult = {
        price,
        updatedAt: Number(round.updatedAt) * 1000,
        source: "chainlink"
      };
      cachedFetchedAtMs = now;
      preferredRpcUrl = rpc;
      return cachedResult;
    } catch {
      cachedDecimals = null;
      continue;
    }
  }

  return cachedResult;
}
