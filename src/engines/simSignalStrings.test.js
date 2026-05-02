import test from "node:test";
import assert from "node:assert/strict";

import { buildSimSignalDirectionStrings } from "./simSignalStrings.js";

test("Heiken+OBV UP when HA green and OBV slope positive", () => {
  const s = buildSimSignalDirectionStrings({
    timeAdjustedProb: { adjustedUp: 0.6, adjustedDown: 0.4 },
    heikenAshiStreak: { color: "green" },
    macdLabel: "bullish",
    delta3m: 1,
    bollingerResult: { percentB: 0.6 },
    obvResult: { slope: 0.1 },
    currentRsi: 60,
    emaCrossLabel: "bullish",
    vwapDistance: 0.001
  });
  assert.equal(s["Heiken+OBV"], "UP");
  assert.equal(s["Heiken Ashi"], "UP");
  assert.equal(s["OBV"], "UP");
});

test("Heiken+OBV DOWN when HA red and OBV slope negative", () => {
  const s = buildSimSignalDirectionStrings({
    timeAdjustedProb: { adjustedUp: 0.4, adjustedDown: 0.6 },
    heikenAshiStreak: { color: "red" },
    macdLabel: "bearish",
    delta3m: -2,
    bollingerResult: { percentB: 0.4 },
    obvResult: { slope: -0.05 },
    currentRsi: 40,
    emaCrossLabel: "bearish",
    vwapDistance: -0.002
  });
  assert.equal(s["Heiken+OBV"], "DOWN");
});

test("5+ Agree when seven components align UP", () => {
  const s = buildSimSignalDirectionStrings({
    timeAdjustedProb: { adjustedUp: 0.55, adjustedDown: 0.45 },
    heikenAshiStreak: { color: "green" },
    macdLabel: "bullish",
    delta3m: 5,
    bollingerResult: { percentB: 0.55 },
    obvResult: { slope: 1 },
    currentRsi: 55,
    emaCrossLabel: "CROSS ↑",
    vwapDistance: 0.01
  });
  assert.equal(s["5+ Agree"], "UP");
});

test("no Heiken+OBV when OBV slope is zero", () => {
  const s = buildSimSignalDirectionStrings({
    timeAdjustedProb: { adjustedUp: 0.5, adjustedDown: 0.5 },
    heikenAshiStreak: { color: "green" },
    macdLabel: "bullish",
    delta3m: 1,
    bollingerResult: { percentB: 0.6 },
    obvResult: { slope: 0 },
    currentRsi: 52,
    emaCrossLabel: "bullish",
    vwapDistance: 0.001
  });
  assert.equal(s["Heiken+OBV"], undefined);
});
