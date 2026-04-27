import "dotenv/config";
import { countTradeHistoryRecords, listTradeHistoryRecords } from "../src/storage/tradeHistoryStore.js";
import { closePool } from "../src/storage/db.js";

try {
  const count = await countTradeHistoryRecords();
  const recent = await listTradeHistoryRecords({ limit: 5 });
  console.log(`trade_history rows: ${count}`);
  console.log("first rows:");
  for (const row of recent) {
    console.log(JSON.stringify({
      timestamp: row.timestamp,
      indicator: row.metadata?.indicator || null,
      timeframe: row.metadata?.timeframe || null,
      marketSlug: row.metadata?.marketSlug || null,
      tokenId: row.tokenId || null,
      orderId: row.orderId || null,
      resolved: row.resolved,
      won: row.won,
      pnl: row.pnl
    }));
  }
} finally {
  await closePool();
}
