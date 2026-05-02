import test from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../config.js";
import {
  buildBinanceHostFeedStatus,
  buildChainlinkFeedStatus,
  buildFeedSourcesSnapshot
} from "./feedSources.js";

test("buildBinanceHostFeedStatus: down when in cooldown", () => {
  const now = 1_000_000;
  const s = buildBinanceHostFeedStatus(
    {
      configured: true,
      lastOkAt: now - 120_000,
      lastLatencyMs: 40,
      lastError: "HTTP 503",
      cooldownUntil: now + 5000,
      preferred: false
    },
    now,
    60_000
  );
  assert.equal(s.status, "down");
  assert.ok(s.detail.includes("cooldown"));
});

test("buildBinanceHostFeedStatus: ok when recent success", () => {
  const now = 2_000_000;
  const s = buildBinanceHostFeedStatus(
    {
      configured: true,
      lastOkAt: now - 10_000,
      lastLatencyMs: 55,
      lastError: null,
      cooldownUntil: 0,
      preferred: true
    },
    now,
    60_000
  );
  assert.equal(s.status, "ok");
  assert.equal(s.latencyMs, 55);
});

test("buildBinanceHostFeedStatus: unknown when not configured", () => {
  const now = 3_000_000;
  const s = buildBinanceHostFeedStatus(
    { configured: false, lastOkAt: null, lastLatencyMs: null, lastError: null, cooldownUntil: 0, preferred: false },
    now,
    60_000
  );
  assert.equal(s.status, "unknown");
});

test("buildBinanceHostFeedStatus: stale when success too old", () => {
  const now = 10_000_000;
  const s = buildBinanceHostFeedStatus(
    {
      configured: true,
      lastOkAt: now - 300_000,
      lastLatencyMs: 20,
      lastError: null,
      cooldownUntil: 0,
      preferred: false
    },
    now,
    60_000
  );
  assert.equal(s.status, "stale");
});

test("buildFeedSourcesSnapshot merges binance override", () => {
  const now = 5_000_000;
  const snap = buildFeedSourcesSnapshot({
    now,
    binanceSnapshot: {
      binanceCom: {
        baseUrl: "https://api.binance.com",
        configured: true,
        preferred: true,
        lastOkAt: now - 1000,
        lastLatencyMs: 12,
        lastError: null,
        cooldownUntil: 0
      },
      binanceUs: {
        baseUrl: "https://api.binance.us",
        configured: true,
        preferred: false,
        lastOkAt: null,
        lastLatencyMs: null,
        lastError: "ECONNRESET",
        cooldownUntil: 0
      }
    },
    chainlinkData: { price: 70000, updatedAt: now - 2000, source: "chainlink_ws" },
    polymarketCurrentFresh: false
  });
  assert.equal(snap.binanceCom.status, "ok");
  assert.equal(snap.binanceUs.status, "unknown");
  assert.ok(snap.coinbaseTicker && typeof snap.coinbaseTicker.status === "string");
  assert.ok(snap.krakenTicker && typeof snap.krakenTicker.status === "string");
  assert.ok(snap.bybitTicker && typeof snap.bybitTicker.status === "string");
  assert.ok(snap.okxTicker && typeof snap.okxTicker.status === "string");
});

test("buildChainlinkFeedStatus ok with RPC stub in CONFIG", () => {
  const origUrl = CONFIG.chainlink.polygonRpcUrl;
  const origUrls = CONFIG.chainlink.polygonRpcUrls;
  CONFIG.chainlink.polygonRpcUrl = "https://polygon.unit.test";
  CONFIG.chainlink.polygonRpcUrls = [];
  try {
    const now = 8_000_000_000;
    const s = buildChainlinkFeedStatus({
      now,
      chainlinkData: { price: 71_234.5, updatedAt: now - 3000, source: "chainlink_ws" },
      polymarketCurrentFresh: false
    });
    assert.equal(s.status, "ok");
    assert.equal(s.source, "chainlink_ws");
  } finally {
    CONFIG.chainlink.polygonRpcUrl = origUrl;
    CONFIG.chainlink.polygonRpcUrls = origUrls;
  }
});

test("buildChainlinkFeedStatus polymarket fresh path", () => {
  const origUrl = CONFIG.chainlink.polygonRpcUrl;
  CONFIG.chainlink.polygonRpcUrl = "https://polygon.unit.test";
  try {
    const now = 9_000_000_000;
    const s = buildChainlinkFeedStatus({
      now,
      chainlinkData: { price: 70_000, updatedAt: now - 120_000, source: "chainlink_ws" },
      polymarketCurrentFresh: true,
      polymarketPriceAgeMs: 400
    });
    assert.equal(s.status, "ok");
    assert.equal(s.source, "polymarket_ws");
    assert.equal(s.ageMs, 400);
  } finally {
    CONFIG.chainlink.polygonRpcUrl = origUrl;
  }
});
