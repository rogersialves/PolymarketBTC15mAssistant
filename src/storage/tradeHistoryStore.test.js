import test from "node:test";
import assert from "node:assert/strict";

import { buildTradeHistoryDbRow } from "./tradeHistoryStore.js";

test("maps trade history records to database rows with token and stable dedupe key", () => {
  const row = buildTradeHistoryDbRow({
    timestamp: 1777079640453,
    side: "BUY",
    price: 0.74,
    sizeUsd: 1,
    shares: 1.35,
    tokenId: "token-123",
    orderId: "DRY_1777079640453",
    status: "dry_run",
    executionStatus: "resolved",
    dryRun: true,
    resolved: true,
    marketClosed: true,
    marketResolved: true,
    won: true,
    pnl: 0.35,
    metadata: {
      indicator: "Delta 3m",
      timeframe: "5m",
      marketSlug: "btc-updown-5m-1777079400",
      direction: "UP"
    }
  });

  assert.equal(row.dedupe_key, "order:DRY_1777079640453");
  assert.equal(row.timestamp_ms, 1777079640453);
  assert.equal(row.token_id, "token-123");
  assert.equal(row.order_id, "DRY_1777079640453");
  assert.equal(row.metadata.indicator, "Delta 3m");
  assert.equal(row.raw.tokenId, "token-123");
});

test("uses fallback dedupe key when order id is missing", () => {
  const row = buildTradeHistoryDbRow({
    timestamp: 1776934140826,
    tokenId: "token-fallback",
    price: 0.96,
    sizeUsd: 1,
    metadata: {
      indicator: "Heiken+OBV",
      marketSlug: "btc-updown-5m-1776933900",
      direction: "UP"
    }
  });

  assert.equal(
    row.dedupe_key,
    "fallback|1776934140826|token-fallback|Heiken+OBV|btc-updown-5m-1776933900|UP|0.96|1"
  );
});
