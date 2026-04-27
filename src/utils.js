import fs from "node:fs";
import path from "node:path";

export function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatNumber(x, digits = 0) {
  if (x === null || x === undefined || Number.isNaN(x)) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(x);
}

export function formatPct(x, digits = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return "-";
  return `${(x * 100).toFixed(digits)}%`;
}

export function getCandleWindowTiming(windowMinutes) {
  const nowMs = Date.now();
  const windowMs = windowMinutes * 60_000;
  const startMs = Math.floor(nowMs / windowMs) * windowMs;
  const endMs = startMs + windowMs;
  const elapsedMs = nowMs - startMs;
  const remainingMs = endMs - nowMs;
  return {
    startMs,
    endMs,
    elapsedMs,
    remainingMs,
    elapsedMinutes: elapsedMs / 60_000,
    remainingMinutes: remainingMs / 60_000
  };
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function appendCsvRow(filePath, header, row) {
  ensureDir(path.dirname(filePath));
  const exists = fs.existsSync(filePath);
  const line = row
    .map((v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      if (s.includes(",") || s.includes("\n") || s.includes('"')) {
        return `"${s.replaceAll('"', '""')}"`;
      }
      return s;
    })
    .join(",");

  if (!exists) {
    fs.writeFileSync(filePath, `${header.join(",")}\n${line}\n`, "utf8");
    return;
  }

  fs.appendFileSync(filePath, `${line}\n`, "utf8");
}

/**
 * Counts how many times the close price crossed the VWAP line within the
 * most recent `lookback` candles. Returns null if there is not enough data.
 */
export function countVwapCrosses(closePrices, vwapSeries, lookback) {
  if (closePrices.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closePrices.length - lookback + 1; i < closePrices.length; i += 1) {
    const prevDiff = closePrices[i - 1] - vwapSeries[i - 1];
    const currDiff = closePrices[i] - vwapSeries[i];
    if (prevDiff === 0) continue;
    if ((prevDiff > 0 && currDiff < 0) || (prevDiff < 0 && currDiff > 0)) crosses += 1;
  }
  return crosses;
}

/**
 * Deletes JSON files in `logsDir` that are older than `maxAgeDays` days.
 * Returns the number of files removed. Safe to call at startup.
 */
export function pruneOldLogs(logsDir, maxAgeDays = 7) {
  if (!fs.existsSync(logsDir)) return 0;
  const cutoffMs = Date.now() - maxAgeDays * 86_400_000;
  let pruned = 0;
  for (const f of fs.readdirSync(logsDir)) {
    if (!f.endsWith(".json") && !f.endsWith(".jsonl") && !f.endsWith(".csv")) continue;
    const full = path.join(logsDir, f);
    try {
      if (fs.statSync(full).mtimeMs < cutoffMs) {
        fs.unlinkSync(full);
        pruned += 1;
      }
    } catch {
      // ignore — file may have been removed by a concurrent process
    }
  }
  return pruned;
}
