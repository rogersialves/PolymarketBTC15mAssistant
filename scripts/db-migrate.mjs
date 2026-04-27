import "dotenv/config";
import { ensureTradeHistorySchema } from "../src/storage/tradeHistoryStore.js";
import { closePool } from "../src/storage/db.js";

try {
  await ensureTradeHistorySchema();
  console.log("OK trade_history schema ready");
} finally {
  await closePool();
}
