import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultSlugFamiliesForIndicator,
  normalizeSlugFamilies,
  marketSlugAllowedForScalpBinding,
  coerceScalpBindingFamilies
} from "./slugBinding.js";

test("defaultSlugFamiliesForIndicator matches 5m vs 15m scalp", () => {
  assert.deepEqual(defaultSlugFamiliesForIndicator("Scalp Force 5m"), ["btc-updown-5m"]);
  assert.deepEqual(defaultSlugFamiliesForIndicator("Scalp Force 15m"), ["btc-updown-15m"]);
});

test("normalizeSlugFamilies filters unknown and falls back when empty", () => {
  assert.deepEqual(
    normalizeSlugFamilies(["btc-updown-5m", "bogus", "btc-updown-15m"], "Scalp Force 5m"),
    ["btc-updown-5m", "btc-updown-15m"]
  );
  assert.deepEqual(normalizeSlugFamilies([], "Scalp Force 5m"), ["btc-updown-5m"]);
});

test("marketSlugAllowedForScalpBinding enforces 1:1 mercado ↔ scalp", () => {
  assert.equal(marketSlugAllowedForScalpBinding("btc-updown-5m-1777691700", "Scalp Force 5m"), true);
  assert.equal(marketSlugAllowedForScalpBinding("btc-updown-15m-1777691700", "Scalp Force 5m"), false);
  assert.equal(marketSlugAllowedForScalpBinding("btc-updown-15m-1777691700", "Scalp Force 15m"), true);
  assert.equal(marketSlugAllowedForScalpBinding("btc-updown-5m-1777691700", "Scalp Force 15m"), false);
  assert.equal(marketSlugAllowedForScalpBinding("some-other-market", "Scalp Force 5m"), true);
});

test("coerceScalpBindingFamilies", () => {
  assert.deepEqual(coerceScalpBindingFamilies("Scalp Force 5m"), ["btc-updown-5m"]);
  assert.deepEqual(coerceScalpBindingFamilies("Scalp Force 15m"), ["btc-updown-15m"]);
});
