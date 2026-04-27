import test from "node:test";
import assert from "node:assert/strict";

import { buildRuntimeEventRow } from "./runtimeEventStore.js";

test("maps header and row values into a runtime event row", () => {
  const row = buildRuntimeEventRow({
    eventType: "signal",
    timeframe: "5m",
    marketSlug: "btc-updown-5m-1777269000",
    timestamp: "2026-04-27T05:52:00.000Z",
    header: ["timestamp", "window_min", "signal", "recommendation"],
    values: ["2026-04-27T05:52:00.000Z", 5, "UP", "ENTER:UP:mid"]
  });

  assert.equal(row.event_type, "signal");
  assert.equal(row.timeframe, "5m");
  assert.equal(row.market_slug, "btc-updown-5m-1777269000");
  assert.equal(row.timestamp.toISOString(), "2026-04-27T05:52:00.000Z");
  assert.deepEqual(row.raw, {
    timestamp: "2026-04-27T05:52:00.000Z",
    window_min: 5,
    signal: "UP",
    recommendation: "ENTER:UP:mid"
  });
});
