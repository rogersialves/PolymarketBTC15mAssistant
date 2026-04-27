import test from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../config.js";
import { fetchKlines } from "./binance.js";

test("fetchKlines returns stale cached candles immediately while refreshing in background", async () => {
  const originalFetch = globalThis.fetch;
  const originalCacheMs = CONFIG.binanceKlinesCacheMs;
  const originalBases = CONFIG.binanceBaseUrls;

  try {
    CONFIG.binanceKlinesCacheMs = 0;
    CONFIG.binanceBaseUrls = ["https://unit.test"];

    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: true,
          json: async () => [[1, "1", "2", "0.5", "1.5", "10", 2]]
        };
      }
      return new Promise((_, reject) => {
        setTimeout(() => reject(new Error("should not block stale return")), 200);
      });
    };

    const first = await fetchKlines({ interval: "1m", limit: 1 });
    assert.equal(first[0].close, 1.5);

    const startedAt = Date.now();
    const second = await fetchKlines({ interval: "1m", limit: 1 });
    assert.equal(second[0].close, 1.5);
    assert.ok(Date.now() - startedAt < 50);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    CONFIG.binanceKlinesCacheMs = originalCacheMs;
    CONFIG.binanceBaseUrls = originalBases;
  }
});

test("fetchKlines backs off stale refresh attempts after a failed refresh", async () => {
  const originalFetch = globalThis.fetch;
  const originalCacheMs = CONFIG.binanceKlinesCacheMs;
  const originalRetryMs = CONFIG.binanceRefreshRetryMs;
  const originalBases = CONFIG.binanceBaseUrls;

  try {
    CONFIG.binanceKlinesCacheMs = 0;
    CONFIG.binanceRefreshRetryMs = 10_000;
    CONFIG.binanceBaseUrls = ["https://unit-retry.test"];

    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: true,
          json: async () => [[1, "1", "2", "0.5", "1.5", "10", 2]]
        };
      }
      throw new Error("network down");
    };

    const first = await fetchKlines({ interval: "retry", limit: 2 });
    assert.equal(first[0].close, 1.5);

    const second = await fetchKlines({ interval: "retry", limit: 2 });
    assert.equal(second[0].close, 1.5);
    await new Promise(resolve => setTimeout(resolve, 0));

    const third = await fetchKlines({ interval: "retry", limit: 2 });
    assert.equal(third[0].close, 1.5);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    CONFIG.binanceKlinesCacheMs = originalCacheMs;
    CONFIG.binanceRefreshRetryMs = originalRetryMs;
    CONFIG.binanceBaseUrls = originalBases;
  }
});
