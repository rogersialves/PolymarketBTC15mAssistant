import fs from "node:fs";

const readCache = new Map();

export function readTradeHistoryFile(filePath) {
  try {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      readCache.delete(filePath);
      return [];
    }
    const cached = readCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.data;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const data = Array.isArray(parsed) ? parsed : [];
    readCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, data });
    return data;
  } catch {
    return [];
  }
}

export function invalidateTradeHistoryCache(filePath) {
  if (filePath) readCache.delete(filePath);
  else readCache.clear();
}

export function tradeHistoryKey(record) {
  if (record?.orderId) return `order:${record.orderId}`;
  return [
    "fallback",
    record?.timestamp ?? "",
    record?.tokenId ?? "",
    record?.metadata?.indicator ?? "",
    record?.metadata?.marketSlug ?? "",
    record?.metadata?.direction ?? "",
    record?.price ?? "",
    record?.sizeUsd ?? ""
  ].join("|");
}

export function mergeTradeRecord(existing, incoming) {
  if (!existing) return incoming;

  const merged = { ...existing, ...incoming };
  const existingResolved = existing.resolved === true && existing.marketResolved === true;
  const incomingResolved = incoming?.resolved === true && incoming?.marketResolved === true;

  if (existingResolved && !incomingResolved) {
    for (const key of ["marketClosed", "marketResolved", "resolved", "won", "pnl", "unfilled"]) {
      if (key in existing) merged[key] = existing[key];
    }
    if (existing.executionStatus === "resolved") {
      merged.executionStatus = existing.executionStatus;
    }
  }

  return merged;
}

export function mergeTradeHistoryRecords(...groups) {
  const order = [];
  const byKey = new Map();

  for (const group of groups) {
    for (const record of Array.isArray(group) ? group : []) {
      const key = tradeHistoryKey(record);
      if (!byKey.has(key)) order.push(key);
      byKey.set(key, mergeTradeRecord(byKey.get(key), record));
    }
  }

  return order.map(key => byKey.get(key));
}

export function writeTradeHistoryFileAtomic(filePath, history) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(history, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
  readCache.delete(filePath);
}

export async function writeTradeHistoryFileAtomicAsync(filePath, history) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(history, null, 2), "utf8");
  await fs.promises.rename(tmpPath, filePath);
  readCache.delete(filePath);
}
