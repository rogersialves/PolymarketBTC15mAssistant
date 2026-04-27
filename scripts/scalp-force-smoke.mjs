/**
 * scalp-force-smoke.mjs — Deterministic smoke harness for the scalp engine.
 *
 * Drives src/engines/scalpForce.js with synthetic tick fixtures so behavior
 * regressions are caught before any live-data smoke is needed.
 *
 * Usage: node scripts/scalp-force-smoke.mjs
 */

import {
  advanceScalp,
  buildScalpCardPayload,
  buildScalpStripPayload,
  computeEffectiveStake,
  computeExchangeMedian,
  createScalpRuntime,
  resolveDirection,
  SCALP_STATUS,
  closedTradeToCsvRow,
  SCALP_CSV_HEADER
} from "../src/engines/scalpForce.js";

let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

function section(title) {
  console.log(`\n— ${title} —`);
}

function baseConfig(overrides = {}) {
  return {
    stakeUsd: 1,
    entryMinPct: 50,
    entryMaxPct: 55,
    takeProfitPct: 75,
    tpExitMode: "exit",
    tpTrailCents: 3,
    tpForceExitEnabled: true,
    tpForceFailTicks: 2,
    minExitPct: 58,
    trailingArmingCents: 2,
    trailingCushionCents: 3,
    maxEntriesPerCandle: 2,
    entryOpenWindowSec: 20,
    maxHoldSec: 150,
    minSharesFloor: 5,
    maxEffectiveStakeUsd: 10,
    enabled: true,
    ...overrides
  };
}

function bullSignals() {
  return { "Heiken+OBV": "UP", "5+ Agree": "UP", "Delta 3m": "UP", "MACD": "UP" };
}

function bearSignals() {
  return { "Heiken+OBV": "DOWN", "5+ Agree": "DOWN", "Delta 3m": "DOWN" };
}

function baseCtx(overrides = {}) {
  return {
    nowMs: 1_000_000,
    marketSlug: "btc-updown-5m-x",
    candleElapsedMs: 5_000, // 5s into candle — inside 20s entry window
    priceToBeat: 100_000,
    currentPrice: 100_050,
    exchangeMedian: 100_060,
    marketPriceUp: 0.52,
    marketPriceDown: 0.48,
    signals: bullSignals(),
    config: baseConfig(),
    enabled: true,
    ...overrides
  };
}

// ────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────

section("resolveDirection");
assert(resolveDirection({ priceToBeat: 100, currentPrice: 101, exchangeMedian: 102 }) === "UP", "both agree UP");
assert(resolveDirection({ priceToBeat: 100, currentPrice: 99, exchangeMedian: 98 }) === "DOWN", "both agree DOWN");
assert(resolveDirection({ priceToBeat: 100, currentPrice: 101, exchangeMedian: 99 }) === "DOWN", "exchange below PTB returns DOWN");
assert(resolveDirection({ priceToBeat: NaN, currentPrice: 1, exchangeMedian: 1 }) === null, "NaN priceToBeat returns null");

section("computeExchangeMedian");
assert(computeExchangeMedian([100, 102, 101]) === 101, "odd-count median = middle");
assert(computeExchangeMedian([100, 102]) === 101, "even-count median = mean of two middle");
assert(computeExchangeMedian([]) === null, "empty returns null");
assert(computeExchangeMedian([null, 100, NaN]) === 100, "filters invalid values");

section("computeEffectiveStake");
{
  const r = computeEffectiveStake({ baseStakeUsd: 1, contractPrice: 0.52, minSharesFloor: 5, maxEffectiveStakeUsd: 10 });
  assert(r.ok === true, "5 shares floor forces effective = 0.52 * 5 = 2.60");
  assert(Math.abs(r.effectiveStakeUsd - 2.6) < 1e-6, "effective stake equals 2.60");
  assert(Math.abs(r.shares - 5) < 1e-6, "shares equal floor");
}
{
  const r = computeEffectiveStake({ baseStakeUsd: 3, contractPrice: 0.52, minSharesFloor: 5, maxEffectiveStakeUsd: 10 });
  assert(r.ok === true, "base stake above floor is respected");
  assert(Math.abs(r.effectiveStakeUsd - 3) < 1e-6, "effective stake equals base 3.00");
}
{
  const r = computeEffectiveStake({ baseStakeUsd: 1, contractPrice: 0.52, minSharesFloor: 50, maxEffectiveStakeUsd: 10 });
  assert(r.ok === false, "50 shares floor > cap rejects entry");
}

// ────────────────────────────────────────────────────────
// State machine scenarios
// ────────────────────────────────────────────────────────

section("Scenario 1 — valid 5m entry in band 50-55%");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  advanceScalp(rt, baseCtx());
  assert(rt.status === SCALP_STATUS.IN_POSITION, "enters on first valid tick");
  assert(rt.direction === "UP", "direction is UP");
  assert(rt.shares >= 5, "shares >= minSharesFloor");
  assert(rt.deadlineAt > 1_000_000, "deadline is set into the future");
}

section("Scenario 2 — valid 15m entry requires Delta 3m confirm");
{
  const rt = createScalpRuntime("Scalp Force 15m", 15);
  const ctx15 = baseCtx({ signals: { ...bullSignals(), "Delta 3m": null } });
  advanceScalp(rt, ctx15);
  assert(rt.status === SCALP_STATUS.IDLE, "15m without Delta 3m does NOT enter");
}
{
  const rt = createScalpRuntime("Scalp Force 15m", 15);
  advanceScalp(rt, baseCtx({ signals: bullSignals() }));
  assert(rt.status === SCALP_STATUS.IN_POSITION, "15m with Delta 3m enters");
}

section("Scenario 3 — reject on oracle vs exchange disagreement");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  advanceScalp(rt, baseCtx({ exchangeMedian: 99_000 }));
  assert(rt.status === SCALP_STATUS.IDLE, "no entry when oracle/exchange disagree");
}

section("Scenario 4 — reject on contract price outside band");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  advanceScalp(rt, baseCtx({ marketPriceUp: 0.70, marketPriceDown: 0.30 }));
  assert(rt.status === SCALP_STATUS.ARMED, "70¢ UP is outside 50-55% band — armed, not entered");
  assert(!!rt.latestReason, "has a reason for refusing entry");
}

section("Scenario 5 — effective stake above cap blocks entry");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  const cfg = baseConfig({ minSharesFloor: 50, maxEffectiveStakeUsd: 10 });
  advanceScalp(rt, baseCtx({ config: cfg }));
  assert(rt.status === SCALP_STATUS.ARMED, "cap exceeded — stays armed");
  assert(rt.status !== SCALP_STATUS.IN_POSITION, "no position opened");
}

section("Scenario 6 — TP exit");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  advanceScalp(rt, baseCtx());
  const result = advanceScalp(rt, baseCtx({
    nowMs: 1_030_000,
    candleElapsedMs: 35_000,
    marketPriceUp: 0.80,
    marketPriceDown: 0.20
  }));
  assert(rt.status === SCALP_STATUS.CLOSED_TP, "closes on TP when contract reaches 80¢");
  assert(result.closedTrade?.exitReason === "tp_hit", "closed trade exitReason is tp_hit");
  assert(result.closedTrade.pnlUsd > 0, "TP hit produces positive PnL");
}

section("Scenario 7 - trailing does not arm on initial spread drop");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  const cfg = baseConfig({ entryMaxPct: 60 });
  advanceScalp(rt, baseCtx({ marketPriceUp: 0.57, config: cfg }));
  const result = advanceScalp(rt, baseCtx({
    nowMs: 1_010_000,
    candleElapsedMs: 15_000,
    marketPriceUp: 0.50,
    marketPriceDown: 0.50,
    config: cfg
  }));
  assert(rt.status === SCALP_STATUS.IN_POSITION, "spread drop before arming keeps position open");
  assert(result.closedTrade === null, "no trailing close before arming threshold");
  assert(rt.trailingArmed === false, "trailing remains unarmed");
}

section("Scenario 8 - TP trail mode does not exit immediately at target");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  const cfg = baseConfig({ tpExitMode: "trail", tpTrailCents: 3 });
  advanceScalp(rt, baseCtx({ config: cfg }));
  const result = advanceScalp(rt, baseCtx({
    nowMs: 1_010_000,
    candleElapsedMs: 15_000,
    marketPriceUp: 0.80,
    marketPriceDown: 0.20,
    config: cfg
  }));
  assert(rt.status === SCALP_STATUS.IN_POSITION, "TP trail keeps position open at target");
  assert(result.closedTrade === null, "no immediate TP close in trail mode");
  assert(rt.tpArmed === true, "TP trail is armed");
}

section("Scenario 9 - TP trail exits on target trailing stop");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  const cfg = baseConfig({ tpExitMode: "trail", tpTrailCents: 3 });
  advanceScalp(rt, baseCtx({ config: cfg }));
  advanceScalp(rt, baseCtx({ nowMs: 1_010_000, candleElapsedMs: 15_000, marketPriceUp: 0.80, marketPriceDown: 0.20, config: cfg }));
  const result = advanceScalp(rt, baseCtx({ nowMs: 1_020_000, candleElapsedMs: 25_000, marketPriceUp: 0.77, marketPriceDown: 0.23, config: cfg }));
  assert(rt.status === SCALP_STATUS.CLOSED_TP_TRAILING_STOP, "TP trail closes when price falls to TP trail stop");
  assert(result.closedTrade?.exitReason === "tp_trailing_stop", "reason is tp_trailing_stop");
  assert(result.closedTrade.pnlUsd > 0, "TP trail keeps positive PnL");
}

section("Scenario 10 - TP trail exits when strength fails");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  const cfg = baseConfig({ tpExitMode: "trail", tpTrailCents: 3, tpForceFailTicks: 2 });
  advanceScalp(rt, baseCtx({ config: cfg }));
  advanceScalp(rt, baseCtx({ nowMs: 1_010_000, candleElapsedMs: 15_000, marketPriceUp: 0.80, marketPriceDown: 0.20, config: cfg }));
  advanceScalp(rt, baseCtx({ nowMs: 1_020_000, candleElapsedMs: 25_000, marketPriceUp: 0.82, marketPriceDown: 0.18, signals: bearSignals(), config: cfg }));
  const result = advanceScalp(rt, baseCtx({ nowMs: 1_030_000, candleElapsedMs: 35_000, marketPriceUp: 0.81, marketPriceDown: 0.19, signals: bearSignals(), config: cfg }));
  assert(rt.status === SCALP_STATUS.CLOSED_TP_FORCE_FAIL, "TP trail closes after configured force-fail ticks");
  assert(result.closedTrade?.exitReason === "tp_force_fail", "reason is tp_force_fail");
}

section("Scenario 11 - trailing stop exits after armed top reverses");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  const cfg = baseConfig({ entryMaxPct: 60, takeProfitPct: 80, trailingArmingCents: 2, trailingCushionCents: 3 });
  advanceScalp(rt, baseCtx({ marketPriceUp: 0.55, config: cfg }));
  advanceScalp(rt, baseCtx({
    nowMs: 1_010_000,
    candleElapsedMs: 15_000,
    marketPriceUp: 0.70,
    marketPriceDown: 0.30,
    config: cfg
  }));
  const result = advanceScalp(rt, baseCtx({
    nowMs: 1_020_000,
    candleElapsedMs: 25_000,
    marketPriceUp: 0.67,
    marketPriceDown: 0.33,
    config: cfg
  }));
  assert(rt.status === SCALP_STATUS.CLOSED_TRAILING_STOP, "closes on trailing stop after reversal");
  assert(result.closedTrade?.exitReason === "trailing_stop", "reason is trailing_stop");
  assert(result.closedTrade.pnlUsd > 0, "trailing stop locks positive PnL");
}

section("Scenario 12 - re-enters after defensive stop when still eligible");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  const cfg = baseConfig({ entryMaxPct: 70, takeProfitPct: 80, maxEntriesPerCandle: 2, entryOpenWindowSec: 30 });
  advanceScalp(rt, baseCtx({ marketPriceUp: 0.55, config: cfg }));
  advanceScalp(rt, baseCtx({ nowMs: 1_010_000, candleElapsedMs: 10_000, marketPriceUp: 0.62, config: cfg }));
  advanceScalp(rt, baseCtx({ nowMs: 1_020_000, candleElapsedMs: 20_000, marketPriceUp: 0.59, config: cfg }));
  assert(rt.status === SCALP_STATUS.CLOSED_TRAILING_STOP, "first entry closed by trailing stop");
  advanceScalp(rt, baseCtx({ nowMs: 1_021_000, candleElapsedMs: 21_000, marketPriceUp: 0.55, config: cfg }));
  assert(rt.status === SCALP_STATUS.IN_POSITION, "second entry opens in same candle");
  assert(rt.entriesThisCandle === 2, "entry counter reaches max 2");
}

section("Scenario 13 - max entries blocks another re-entry");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  const cfg = baseConfig({ entryMaxPct: 70, takeProfitPct: 80, maxEntriesPerCandle: 1 });
  advanceScalp(rt, baseCtx({ marketPriceUp: 0.55, config: cfg }));
  advanceScalp(rt, baseCtx({ nowMs: 1_010_000, candleElapsedMs: 10_000, marketPriceUp: 0.62, config: cfg }));
  advanceScalp(rt, baseCtx({ nowMs: 1_020_000, candleElapsedMs: 20_000, marketPriceUp: 0.59, config: cfg }));
  advanceScalp(rt, baseCtx({ nowMs: 1_021_000, candleElapsedMs: 21_000, marketPriceUp: 0.55, config: cfg }));
  assert(rt.status === SCALP_STATUS.CLOSED_TRAILING_STOP, "stays closed after max entries");
  assert(rt.latestReason.includes("Limite de entradas"), "reason explains max entries limit");
}

section("Scenario 14 - TP does not re-enter in the same candle");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  const cfg = baseConfig({ entryMaxPct: 70, takeProfitPct: 75, maxEntriesPerCandle: 2 });
  advanceScalp(rt, baseCtx({ marketPriceUp: 0.55, config: cfg }));
  advanceScalp(rt, baseCtx({ nowMs: 1_010_000, candleElapsedMs: 10_000, marketPriceUp: 0.76, config: cfg }));
  advanceScalp(rt, baseCtx({ nowMs: 1_011_000, candleElapsedMs: 11_000, marketPriceUp: 0.55, config: cfg }));
  assert(rt.status === SCALP_STATUS.CLOSED_TP, "TP remains terminal for this candle");
  assert(rt.entriesThisCandle === 1, "no second entry after TP");
}

section("Scenario 15 — timeout exit above min exit %");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  advanceScalp(rt, baseCtx());
  const result = advanceScalp(rt, baseCtx({
    nowMs: 1_000_000 + 160_000, // past maxHoldSec=150
    marketPriceUp: 0.60, // >= minExitPct 58
    marketPriceDown: 0.40
  }));
  assert(rt.status === SCALP_STATUS.CLOSED_TIMEOUT_MIN_EXIT, "timeout above min exit closes as min_exit");
  assert(result.closedTrade?.exitReason === "timeout_min_exit", "reason is timeout_min_exit");
}

section("Scenario 16 — timeout forced exit below min exit %");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  advanceScalp(rt, baseCtx());
  const result = advanceScalp(rt, baseCtx({
    nowMs: 1_000_000 + 160_000,
    marketPriceUp: 0.45, // < minExitPct 58
    marketPriceDown: 0.55
  }));
  assert(rt.status === SCALP_STATUS.CLOSED_TIMEOUT_FORCE_EXIT, "below min exit forces close");
  assert(result.closedTrade?.exitReason === "timeout_force_exit", "reason is timeout_force_exit");
}

section("Scenario 17 — missing contract price while in position holds state");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  advanceScalp(rt, baseCtx());
  const before = rt.status;
  advanceScalp(rt, baseCtx({ nowMs: 1_010_000, marketPriceUp: null, marketPriceDown: null }));
  assert(rt.status === before, "stale tick preserves IN_POSITION");
  assert(rt.latestReason.includes("indisponível") || rt.latestReason.includes("contrato"), "reason reflects stale price");
}

section("Scenario 18 — slug rollover resets runtime");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  advanceScalp(rt, baseCtx({ marketSlug: "slug-a" }));
  assert(rt.status === SCALP_STATUS.IN_POSITION, "entered on slug-a");
  const result = advanceScalp(rt, baseCtx({
    marketSlug: "slug-b",
    nowMs: 1_010_000,
    candleElapsedMs: 1_000
  }));
  assert(result.closedTrade?.exitReason === "expiry_win", "rollover resolves winning expired scalp");
  assert(result.closedTrade?.exitPrice === 1, "winning expiry exits at 100%");
  assert(result.closedTrade?.pnlUsd > 0, "winning expiry produces positive PnL");
  assert(rt.slug === "slug-b", "slug tracks latest input");
  // After rollover it can either reset to idle (if conditions not yet met)
  // or immediately re-enter on slug-b. Either is valid; what we must NOT see
  // is a stale slug-a position lingering.
  assert(rt.status !== SCALP_STATUS.CLOSED_TP, "did not carry the old CLOSED_TP across slugs");
}

section("Scenario 18b — slug rollover resolves expired loss");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  advanceScalp(rt, baseCtx({
    marketSlug: "slug-a",
    currentPrice: 99_950,
    exchangeMedian: 99_940,
    marketPriceUp: 0.48,
    marketPriceDown: 0.52,
    signals: bearSignals()
  }));
  assert(rt.status === SCALP_STATUS.IN_POSITION, "entered DOWN on slug-a");
  const result = advanceScalp(rt, baseCtx({
    marketSlug: "slug-b",
    nowMs: 1_010_000,
    candleElapsedMs: 1_000,
    currentPrice: 100_050,
    exchangeMedian: 100_060
  }));
  assert(result.closedTrade?.exitReason === "expiry_loss", "rollover resolves losing expired scalp");
  assert(result.closedTrade?.exitPrice === 0, "losing expiry exits at 0%");
  assert(result.closedTrade?.pnlUsd < 0, "losing expiry produces negative PnL");
}

section("Scenario 19 — disabled indicator forces idle");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  advanceScalp(rt, baseCtx({ enabled: false }));
  assert(rt.status === SCALP_STATUS.IDLE, "disabled never enters");
}

section("CSV row format");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  advanceScalp(rt, baseCtx());
  const result = advanceScalp(rt, baseCtx({
    nowMs: 1_030_000,
    candleElapsedMs: 35_000,
    marketPriceUp: 0.80,
    marketPriceDown: 0.20
  }));
  const row = closedTradeToCsvRow(result.closedTrade);
  assert(Array.isArray(row), "CSV row is an array");
  assert(row.length === SCALP_CSV_HEADER.length, `row length matches header (${row.length} vs ${SCALP_CSV_HEADER.length})`);
}

section("Payload builders");
{
  const rt = createScalpRuntime("Scalp Force 5m", 5);
  advanceScalp(rt, baseCtx());
  const card = buildScalpCardPayload(rt, baseConfig());
  assert(card.indicator === "Scalp Force 5m", "card carries indicator name");
  assert(card.config && typeof card.config.entryMinPct === "number", "card exposes config");
  assert(card.config && card.config.tpExitMode === "exit", "card exposes TP mode config");
  assert(card.config && typeof card.config.tpTrailCents === "number", "card exposes TP trail config");
  assert(card.tpTrailDiag && card.tpTrailDiag.armed === false, "card exposes TP trail diag");
  assert(card.config && typeof card.config.trailingArmingCents === "number", "card exposes trailing config");
  assert(card.config && typeof card.config.maxEntriesPerCandle === "number", "card exposes max entries config");
  assert(card.trailingStopDiag && card.trailingStopDiag.armed === false, "card exposes trailing stop diag");
  assert(card.diagnostics?.requirements?.length >= 5, "card exposes scalp activation checklist");
  const strip = buildScalpStripPayload([rt], { "Scalp Force 5m": 3.42 });
  assert(strip.activePositions.length === 1, "strip shows 1 active");
  assert(strip.cumulativePnlByIndicator["Scalp Force 5m"] === 3.42, "strip forwards cumulative PnL");
}

// ────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
