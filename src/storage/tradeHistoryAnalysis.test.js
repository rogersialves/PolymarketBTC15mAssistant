import test from "node:test";
import assert from "node:assert/strict";

import { buildTradeHistoryAnalysis } from "./tradeHistoryAnalysis.js";

test("builds wallet summaries from resolved trade history records with token ids", () => {
  const records = [
    {
      timestamp: Date.parse("2026-04-27T00:01:00Z"),
      side: "BUY",
      price: 0.5,
      sizeUsd: 1,
      shares: 2,
      tokenId: "token-up",
      orderId: "DRY_1",
      dryRun: true,
      resolved: true,
      marketResolved: true,
      won: true,
      pnl: 1,
      metadata: {
        indicator: "Delta 3m",
        timeframe: "5m",
        marketSlug: "btc-updown-5m-1777244400",
        direction: "UP",
        explanation: "test win"
      }
    },
    {
      timestamp: Date.parse("2026-04-27T00:02:00Z"),
      side: "BUY",
      price: 0.25,
      sizeUsd: 1,
      shares: 4,
      tokenId: "token-down",
      orderId: "DRY_2",
      dryRun: true,
      resolved: true,
      marketResolved: true,
      won: false,
      pnl: -1,
      metadata: {
        indicator: "Delta 3m",
        timeframe: "5m",
        marketSlug: "btc-updown-5m-1777244700",
        direction: "DOWN"
      }
    },
    {
      timestamp: Date.parse("2026-04-27T00:03:00Z"),
      side: "BUY",
      price: 0.4,
      sizeUsd: 1,
      dryRun: false,
      resolved: true,
      marketResolved: true,
      won: true,
      pnl: 1.5,
      metadata: {
        indicator: "Delta 3m",
        timeframe: "5m",
        marketSlug: "btc-updown-5m-1777245000",
        direction: "UP"
      }
    },
    {
      timestamp: Date.parse("2026-04-27T00:04:00Z"),
      side: "BUY",
      price: 0.4,
      sizeUsd: 1,
      dryRun: true,
      resolved: false,
      marketResolved: false,
      won: null,
      pnl: null,
      metadata: {
        indicator: "Delta 3m",
        timeframe: "5m",
        marketSlug: "btc-updown-5m-1777245300",
        direction: "UP"
      }
    }
  ];

  const analysis = buildTradeHistoryAnalysis(records, {
    timeframeLabel: "5m",
    filterMode: "DRY_RUN",
    allIndicators: ["Delta 3m"]
  });

  assert.equal(analysis.source, "trade_history");
  assert.equal(analysis.totalSnapshots, 2);
  assert.equal(analysis.upCount, 2);
  assert.equal(analysis.downCount, 0);
  assert.equal(analysis.indicators[0].name, "Delta 3m");
  assert.equal(analysis.indicators[0].total, 2);
  assert.equal(analysis.indicators[0].correct, 1);
  assert.equal(analysis.indicators[0].wrong, 1);
  assert.equal(analysis.wallets.length, 1);

  const wallet = analysis.wallets[0];
  assert.equal(wallet.name, "Delta 3m");
  assert.equal(wallet.balance, 0);
  assert.equal(wallet.trades, 2);
  assert.equal(wallet.wins, 1);
  assert.equal(wallet.losses, 1);
  assert.equal(wallet.invested, 2);
  assert.equal(wallet.returned, 2);
  assert.equal(wallet.history[0].tokenId, "token-up");
  assert.equal(wallet.history[0].orderId, "DRY_1");
  assert.equal(wallet.history[0].outcome, "UP");
  assert.equal(wallet.history[1].outcome, "UP");
});

test("excludes scalp indicators from standard wallet analysis", () => {
  const analysis = buildTradeHistoryAnalysis([
    {
      timestamp: Date.now(),
      side: "BUY",
      price: 0.5,
      sizeUsd: 1,
      tokenId: "scalp-token",
      dryRun: true,
      resolved: true,
      marketResolved: true,
      won: true,
      pnl: 1,
      metadata: {
        indicator: "Scalp Force 5m",
        timeframe: "5m",
        marketSlug: "btc-updown-5m-1777244400",
        direction: "UP"
      }
    }
  ], {
    timeframeLabel: "5m",
    filterMode: "DRY_RUN",
    allIndicators: ["Scalp Force 5m"],
    scalpIndicators: new Set(["Scalp Force 5m"])
  });

  assert.equal(analysis.totalSnapshots, 0);
  assert.deepEqual(analysis.wallets, []);
});
