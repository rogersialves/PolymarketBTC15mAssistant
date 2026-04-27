import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { countTradeHistoryRecords, ensureTradeHistorySchema, upsertTradeHistoryRecords } from "../src/storage/tradeHistoryStore.js";
import { closePool } from "../src/storage/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const historyPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, "..", "logs", "trade_history.json");

function loadHistory(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath} does not contain a JSON array`);
  }
  return parsed;
}

try {
  await ensureTradeHistorySchema();
  const before = await countTradeHistoryRecords();
  const records = loadHistory(historyPath);
  const withToken = records.filter(r => r?.tokenId).length;
  const withOrder = records.filter(r => r?.orderId).length;
  const { upserted } = await upsertTradeHistoryRecords(records);
  const after = await countTradeHistoryRecords();

  console.log(JSON.stringify({
    file: historyPath,
    read: records.length,
    withToken,
    withOrder,
    upserted,
    before,
    after,
    insertedOrDedupedDelta: after - before
  }, null, 2));
} finally {
  await closePool();
}
