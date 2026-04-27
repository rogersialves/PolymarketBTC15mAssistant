import fs from "node:fs";

export function readTradeHistoryFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
}
