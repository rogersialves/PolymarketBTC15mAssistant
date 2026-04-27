import "dotenv/config";
import { ensureTradeHistorySchema } from "../src/storage/tradeHistoryStore.js";
import { ensureRuntimeEventSchema } from "../src/storage/runtimeEventStore.js";
import { closePool } from "../src/storage/db.js";

try {
  await ensureTradeHistorySchema();
  await ensureRuntimeEventSchema();
  console.log("OK database schema ready");
} finally {
  await closePool();
}
