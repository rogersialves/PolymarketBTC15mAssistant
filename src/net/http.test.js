import test from "node:test";
import assert from "node:assert/strict";

import { fetchWithTimeout } from "./http.js";

test("fetchWithTimeout keeps slot until the active fetch observes timeout abort", async () => {
  const originalFetch = globalThis.fetch;

  try {
    let sawAbort = false;
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
      calls++;
      return new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => {
          sawAbort = true;
          setTimeout(() => {
            reject(Object.assign(new Error("aborted by signal"), { name: "AbortError" }));
          }, 30);
        }, { once: true });
      });
    };

    const startedAt = Date.now();
    await assert.rejects(
      fetchWithTimeout("https://unit-timeout.test/a", {}, { timeoutMs: 20, label: "unit timeout" }),
      /unit timeout timeout after 20ms/
    );

    assert.equal(calls, 1);
    assert.equal(sawAbort, true);
    assert.ok(Date.now() - startedAt >= 45);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithTimeout aborts active fetches when global HTTP pause turns on", async () => {
  const originalFetch = globalThis.fetch;
  const originalPaused = process._httpPaused;

  try {
    let fetchStarted;
    const fetchStartedPromise = new Promise((resolve) => { fetchStarted = resolve; });
    globalThis.fetch = async (_url, options) => {
      fetchStarted();
      return new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted by pause"), { name: "AbortError" }));
        }, { once: true });
      });
    };

    const pending = fetchWithTimeout("https://unit-pause.test/a", {}, { timeoutMs: 10_000, label: "unit pause" });
    await fetchStartedPromise;

    process._httpPaused = true;
    process.emit("httpPauseChanged", true);

    await assert.rejects(pending, /unit pause aborted \(HTTP paused\)/);
  } finally {
    process._httpPaused = false;
    process.emit("httpPauseChanged", false);
    process._httpPaused = originalPaused;
    globalThis.fetch = originalFetch;
  }
});
