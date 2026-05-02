import test from "node:test";
import assert from "node:assert/strict";
import { isBtcUpDownWindowSlug } from "./polymarket.js";

test("isBtcUpDownWindowSlug matches 5m and 15m btc-updown slugs", () => {
  assert.equal(isBtcUpDownWindowSlug("btc-updown-15m-1777691700"), true);
  assert.equal(isBtcUpDownWindowSlug("btc-updown-5m-1777691700"), true);
  assert.equal(isBtcUpDownWindowSlug("BTC-UPDOWN-15M-1"), true);
});

test("isBtcUpDownWindowSlug rejects other slugs", () => {
  assert.equal(isBtcUpDownWindowSlug(""), false);
  assert.equal(isBtcUpDownWindowSlug(null), false);
  assert.equal(isBtcUpDownWindowSlug("bitcoin-above-100k"), false);
  assert.equal(isBtcUpDownWindowSlug("btc-updown-1h-1777691700"), false);
});
