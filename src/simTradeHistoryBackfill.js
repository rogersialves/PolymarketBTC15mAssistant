import fs from "node:fs";
import path from "node:path";
import { appendCsvRow } from "./utils.js";
import { readTradeHistoryFile } from "./tradeHistoryMerge.js";

export const SIM_TRADES_HEADER = [
  "timestamp", "market_slug", "window_min", "indicator", "side",
  "entry_price", "entry_time_left", "outcome", "won", "pnl_usd", "stake", "mode", "explanation",
  "token_id", "order_id", "order_ts"
];

function toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}


function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function writeCsv(filePath, headers, rows) {
  const lines = [
    headers.join(","),
    ...rows.map(row => headers.map(h => csvEscape(row[h] ?? "")).join(","))
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

const csvCountsCache = new Map();

function buildCsvCounts(csvPath) {
  const counts = new Map();
  const raw = fs.readFileSync(csvPath, "utf8").trim();
  if (!raw) return counts;

  const lines = raw.split(/\r?\n/);
  const headers = splitCsvLine(lines[0]);
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = splitCsvLine(line);
    const key = rowKey({
      marketSlug: cols[idx.market_slug],
      indicator: cols[idx.indicator],
      side: cols[idx.side],
      entryPrice: cols[idx.entry_price],
      stake: cols[idx.stake]
    });
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return counts;
}

function csvExistingCounts(csvPath) {
  let stat;
  try {
    stat = fs.statSync(csvPath);
  } catch {
    csvCountsCache.delete(csvPath);
    return new Map();
  }
  const cached = csvCountsCache.get(csvPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // Return a fresh copy: callers mutate the counts (decrement during scan).
    return new Map(cached.counts);
  }
  const counts = buildCsvCounts(csvPath);
  csvCountsCache.set(csvPath, { mtimeMs: stat.mtimeMs, size: stat.size, counts: new Map(counts) });
  return counts;
}

function opposite(direction) {
  if (direction === "UP") return "DOWN";
  if (direction === "DOWN") return "UP";
  return "";
}

function slugStartSeconds(slug) {
  const m = String(slug || "").match(/-(\d+)$/);
  return m ? Number(m[1]) : null;
}

function inferWindowMinutes(trade) {
  const tf = String(trade?.metadata?.timeframe || "").toLowerCase();
  if (tf === "15m") return 15;
  if (tf === "5m") return 5;
  const slug = String(trade?.metadata?.marketSlug || "");
  if (slug.includes("-15m-")) return 15;
  if (slug.includes("-5m-")) return 5;
  return null;
}

function entryTimeLeftMinutes(trade, windowMinutes) {
  const startSec = slugStartSeconds(trade?.metadata?.marketSlug);
  const tsMs = toNum(trade?.timestamp);
  if (!startSec || !tsMs || !windowMinutes) return 0;
  const endSec = startSec + windowMinutes * 60;
  return Math.max(0, (endSec - tsMs / 1000) / 60);
}

function rowKey({ marketSlug, indicator, side, entryPrice, stake }) {
  const priceNum = toNum(entryPrice, 0);
  const normalizedPrice = Math.round(priceNum * 1_000_000) / 1_000_000;
  const stakeNum = toNum(stake, 1);
  const normalizedStake = stakeNum > 0 ? Math.round(stakeNum * 10_000) / 10_000 : 1;
  return [
    marketSlug || "",
    indicator || "",
    side || "",
    normalizedPrice,
    normalizedStake
  ].join("|");
}

export function isBackfillableTrade(trade, { timeframeLabel, allIndicators, scalpIndicators } = {}) {
  const indicator = trade?.metadata?.indicator;
  if (!indicator) return false;
  if (scalpIndicators?.has?.(indicator)) return false;
  if (Array.isArray(allIndicators) && !allIndicators.includes(indicator)) return false;
  if (trade?.side !== "BUY") return false;
  if (!trade?.tokenId) return false;
  if (trade?.resolved !== true || trade?.marketResolved !== true) return false;
  if (typeof trade?.won !== "boolean") return false;

  const windowMinutes = inferWindowMinutes(trade);
  if (!windowMinutes) return false;
  if (timeframeLabel && `${windowMinutes}m` !== timeframeLabel) return false;

  const direction = trade?.metadata?.direction;
  if (direction !== "UP" && direction !== "DOWN") return false;
  if (!trade?.metadata?.marketSlug) return false;

  const price = toNum(trade?.price);
  const stake = toNum(trade?.sizeUsd);
  return price !== null && price > 0 && stake !== null && stake > 0;
}

export function tradeToSimCsvRow(trade) {
  const windowMinutes = inferWindowMinutes(trade);
  const direction = trade.metadata.direction;
  const outcome = trade.won ? direction : opposite(direction);
  const stake = toNum(trade.sizeUsd, 0);
  const price = toNum(trade.price, 0);
  const pnl = toNum(trade.pnl, 0);
  const timeLeft = entryTimeLeftMinutes(trade, windowMinutes);
  const mode = trade.dryRun ? "DRY_RUN" : "LIVE";

  return [
    new Date(trade.timestamp || Date.now()).toISOString(),
    trade.metadata.marketSlug,
    windowMinutes,
    trade.metadata.indicator,
    direction,
    price,
    timeLeft.toFixed(3),
    outcome,
    String(Boolean(trade.won)),
    Math.round(pnl * 10000) / 10000,
    Math.round(stake * 10000) / 10000,
    mode,
    trade.metadata?.explanation || trade.explanation || "backfilled from trade_history",
    trade.tokenId || "",
    trade.orderId || "",
    trade.timestamp || ""
  ];
}

// WeakMap keyed by the (immutable) cached history array — when the underlying
// file changes, readTradeHistoryFile returns a new array and old caches GC.
const candidatesCache = new WeakMap();
const lookupCache = new WeakMap();

function getBackfillCandidates(history, options) {
  const trades = Array.isArray(history) ? history : [];
  const tfKey = options?.timeframeLabel || "*";
  let byTf = candidatesCache.get(trades);
  if (byTf?.has(tfKey)) return byTf.get(tfKey);
  if (!byTf) {
    byTf = new Map();
    candidatesCache.set(trades, byTf);
  }
  const candidates = trades
    .filter(trade => isBackfillableTrade(trade, options))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  byTf.set(tfKey, candidates);
  return candidates;
}

function buildLookupFromCandidates(candidates) {
  const lookup = new Map();
  for (const trade of candidates) {
    const key = rowKey({
      marketSlug: trade.metadata.marketSlug,
      indicator: trade.metadata.indicator,
      side: trade.metadata.direction,
      entryPrice: trade.price,
      stake: trade.sizeUsd
    });
    if (!lookup.has(key)) lookup.set(key, []);
    lookup.get(key).push(trade);
  }
  // Candidates are already sorted by timestamp from getBackfillCandidates.
  return lookup;
}

export function buildTradeHistoryLookup(history, { timeframeLabel, allIndicators, scalpIndicators } = {}) {
  const trades = Array.isArray(history) ? history : [];
  const tfKey = timeframeLabel || "*";
  let byTf = lookupCache.get(trades);
  if (byTf?.has(tfKey)) {
    // Return a deep-cloned bucket structure — callers (.shift()) mutate it.
    const cached = byTf.get(tfKey);
    const fresh = new Map();
    for (const [k, bucket] of cached) fresh.set(k, bucket.slice());
    return fresh;
  }
  if (!byTf) {
    byTf = new Map();
    lookupCache.set(trades, byTf);
  }
  const candidates = getBackfillCandidates(trades, { timeframeLabel, allIndicators, scalpIndicators });
  const lookup = buildLookupFromCandidates(candidates);
  byTf.set(tfKey, lookup);
  // Return a clone so consumer-side .shift() doesn't drain the cached buckets.
  const fresh = new Map();
  for (const [k, bucket] of lookup) fresh.set(k, bucket.slice());
  return fresh;
}

export function enrichSimRowsWithTradeHistory(rows, history, options = {}) {
  const lookup = buildTradeHistoryLookup(history, options);

  return rows.map(row => {
    const key = rowKey({
      marketSlug: row.market_slug,
      indicator: row.indicator,
      side: row.side,
      entryPrice: row.entry_price,
      stake: row.stake
    });
    const bucket = lookup.get(key);
    const match = bucket?.shift();
    if (!match) return row;
    return {
      ...row,
      token_id: match.tokenId || row.token_id || "",
      order_id: match.orderId || row.order_id || "",
      order_ts: match.timestamp || row.order_ts || ""
    };
  });
}

// Track inputs of last call that returned a no-op result (no rows missing
// token_id, no new columns). The function is called every engine tick, so
// short-circuiting the read+parse when nothing has changed since the last
// no-op is a major hot-path saving on a 750 KB CSV + 2.3 MB history.
const noopFingerprintCache = new Map();

export function persistSimCsvTokenColumns({
  historyPath,
  csvPath,
  timeframeLabel,
  allIndicators = [],
  scalpIndicators = new Set(),
  dryRun = false,
  logger = null
} = {}) {
  if (!fs.existsSync(csvPath)) {
    return { updated: 0, addedColumns: false, file: path.basename(csvPath), timeframeLabel };
  }

  let csvStat = null, historyStat = null;
  try { csvStat = fs.statSync(csvPath); } catch {}
  try { historyStat = fs.statSync(historyPath); } catch {}
  const fingerprint = noopFingerprintCache.get(csvPath);
  if (
    fingerprint && csvStat && historyStat
    && fingerprint.csvMtimeMs === csvStat.mtimeMs && fingerprint.csvSize === csvStat.size
    && fingerprint.historyMtimeMs === historyStat.mtimeMs && fingerprint.historySize === historyStat.size
  ) {
    return { updated: 0, addedColumns: false, file: path.basename(csvPath), timeframeLabel };
  }

  const raw = fs.readFileSync(csvPath, "utf8");
  if (!raw.trim()) {
    return { updated: 0, addedColumns: false, file: path.basename(csvPath), timeframeLabel };
  }

  const lines = raw.trimEnd().split(/\r?\n/);
  const originalHeaders = splitCsvLine(lines[0]);
  const headers = [
    ...SIM_TRADES_HEADER,
    ...originalHeaders.filter(h => h && !SIM_TRADES_HEADER.includes(h))
  ];
  const addedColumns = headers.length !== originalHeaders.length;

  const rows = lines.slice(1).filter(Boolean).map(line => {
    const cols = splitCsvLine(line);
    const row = {};
    originalHeaders.forEach((h, i) => { row[h] = cols[i] ?? ""; });
    for (const h of headers) if (!(h in row)) row[h] = "";
    return row;
  });

  const history = readTradeHistoryFile(historyPath);
  const lookup = buildTradeHistoryLookup(history, { timeframeLabel, allIndicators, scalpIndicators });

  let updated = 0;
  for (const row of rows) {
    if (row.token_id) continue;

    const key = rowKey({
      marketSlug: row.market_slug,
      indicator: row.indicator,
      side: row.side,
      entryPrice: row.entry_price,
      stake: row.stake
    });
    const bucket = lookup.get(key);
    if (!bucket?.length) continue;

    const rowTs = Date.parse(row.timestamp);
    let idx = 0;
    if (Number.isFinite(rowTs)) {
      let bestDelta = Infinity;
      for (let i = 0; i < bucket.length; i++) {
        const delta = Math.abs((bucket[i].timestamp || 0) - rowTs);
        if (delta < bestDelta) {
          bestDelta = delta;
          idx = i;
        }
      }
    }
    const match = bucket.splice(idx, 1)[0];
    if (!match?.tokenId) continue;

    row.token_id = match.tokenId;
    row.order_id = match.orderId || "";
    row.order_ts = match.timestamp || "";
    updated++;
  }

  if (!addedColumns && updated === 0) {
    if (csvStat && historyStat) {
      noopFingerprintCache.set(csvPath, {
        csvMtimeMs: csvStat.mtimeMs,
        csvSize: csvStat.size,
        historyMtimeMs: historyStat.mtimeMs,
        historySize: historyStat.size
      });
    }
    return { updated: 0, addedColumns: false, file: path.basename(csvPath), timeframeLabel };
  }
  // Inputs changed and the function did real work — invalidate fingerprint
  // so the next call doesn't short-circuit on stale state.
  noopFingerprintCache.delete(csvPath);

  if (dryRun) {
    logger?.(`[DRY_RUN] ${path.basename(csvPath)}: token columns ${addedColumns ? "seriam criadas" : "ok"}; ${updated} token(s) seria(m) preenchido(s)`);
    return { updated, addedColumns, file: path.basename(csvPath), timeframeLabel };
  }

  const backupPath = csvPath.replace(".csv", `.backup-token-${Date.now()}.csv`);
  fs.copyFileSync(csvPath, backupPath);
  writeCsv(csvPath, headers, rows);
  logger?.(`[CSV] ${path.basename(csvPath)}: token columns ${addedColumns ? "criadas" : "ok"}; ${updated} token(s) preenchido(s) | backup: ${path.basename(backupPath)}`);
  return { updated, addedColumns, file: path.basename(csvPath), timeframeLabel };
}

export function backfillSimTradesFromHistory({
  historyPath,
  csvPath,
  timeframeLabel,
  allIndicators = [],
  scalpIndicators = new Set(),
  dryRun = false,
  logger = null
} = {}) {
  const history = readTradeHistoryFile(historyPath);
  const existing = csvExistingCounts(csvPath);
  const candidates = getBackfillCandidates(history, { timeframeLabel, allIndicators, scalpIndicators });

  const missing = [];
  for (const trade of candidates) {
    const key = rowKey({
      marketSlug: trade.metadata.marketSlug,
      indicator: trade.metadata.indicator,
      side: trade.metadata.direction,
      entryPrice: trade.price,
      stake: trade.sizeUsd
    });
    const remainingExisting = existing.get(key) || 0;
    if (remainingExisting > 0) {
      existing.set(key, remainingExisting - 1);
      continue;
    }
    missing.push(trade);
  }

  if (missing.length === 0) {
    return { added: 0, file: path.basename(csvPath), timeframeLabel };
  }

  if (dryRun) {
    logger?.(`[DRY_RUN] ${path.basename(csvPath)}: ${missing.length} linha(s) faltante(s) seria(m) adicionada(s) do trade_history`);
    return { added: missing.length, file: path.basename(csvPath), timeframeLabel };
  }

  if (fs.existsSync(csvPath)) {
    const backupPath = csvPath.replace(".csv", `.backup-${Date.now()}.csv`);
    fs.copyFileSync(csvPath, backupPath);
    logger?.(`[CSV] backup ${path.basename(backupPath)}`);
  }

  for (const trade of missing) {
    appendCsvRow(csvPath, SIM_TRADES_HEADER, tradeToSimCsvRow(trade));
  }

  logger?.(`[CSV] ${path.basename(csvPath)}: ${missing.length} linha(s) adicionada(s) do trade_history`);
  return { added: missing.length, file: path.basename(csvPath), timeframeLabel };
}
