/**
 * scalpForce.js — Isolated scalp-force strategy runtime.
 *
 * Owns its own per-timeframe state machine (arm → in_position → close) and
 * stays completely separate from the hold-to-expiry simPositions flow.
 * Exposes pure helpers so the same logic can be driven from the server tick
 * loop AND from the smoke-test harness with deterministic fixtures.
 */

export const SCALP_STATUS = Object.freeze({
  IDLE: "idle",
  ARMED: "armed",
  IN_POSITION: "in_position",
  CLOSED_TP: "closed_tp",
  CLOSED_TIMEOUT_MIN_EXIT: "closed_timeout_min_exit",
  CLOSED_TIMEOUT_FORCE_EXIT: "closed_timeout_force_exit",
  CLOSED_DECAY_STOP_MIN: "closed_decay_stop_min",
  CLOSED_DECAY_STOP_FORCE: "closed_decay_stop_force",
  CLOSED_TRAILING_STOP: "closed_trailing_stop",
  CLOSED_TP_TRAILING_STOP: "closed_tp_trailing_stop",
  CLOSED_TP_FORCE_FAIL: "closed_tp_force_fail",
  CLOSED_HARD_STOP: "closed_hard_stop",
  CANCELLED: "cancelled"
});

export const SCALP_CSV_HEADER = [
  "timestamp",
  "indicator",
  "market_slug",
  "window_min",
  "side",
  "entry_price",
  "exit_price",
  "entry_time",
  "exit_time",
  "hold_seconds",
  "exit_reason",
  "stake_usd",
  "effective_stake_usd",
  "shares",
  "pnl_usd",
  "price_to_beat",
  "current_price_entry",
  "exchange_median_entry",
  "take_profit_pct",
  "min_exit_pct",
  "entry_open_window_sec",
  "max_hold_sec"
];

export function createScalpRuntime(indicatorName, timeframeMinutes) {
  return {
    indicatorName,
    timeframeMinutes,
    slug: null,
    status: SCALP_STATUS.IDLE,
    latestReason: "Aguardando candle",
    direction: null,
    // Pre-entry context
    armedAt: null,
    // Entry context
    entryAt: null,
    entryPrice: null,
    effectiveStakeUsd: null,
    stakeUsd: null,
    shares: null,
    priceToBeat: null,
    currentPriceAtEntry: null,
    exchangeMedianAtEntry: null,
    targetPrice: null,
    minExitThreshold: null,
    deadlineAt: null,
    // Exit context
    exitAt: null,
    exitPrice: null,
    exitReason: null,
    pnlUsd: null,
    diagnostics: null,
    // Last closed trade (for UI strip)
    lastClosedTrade: null,
    // Re-entry guard for the current candle/slug.
    entriesThisCandle: 0,
    // Entry signed delta — BTC spot minus priceToBeat at the moment of entry (signed by direction)
    entrySignedDelta: null,
    // Live decay stop diagnostic — updated every IN_POSITION tick for UI display
    decayStopDiag: null,
    // Contract trailing stop state. Values are contract cents (0..100), not percent of BTC.
    maxContractPctSinceEntry: null,
    trailingArmed: false,
    trailingStopPct: null,
    trailingStopDiag: null,
    hardStopDiag: null,
    tpArmed: false,
    tpTrailStopPct: null,
    tpForceFailCount: 0,
    tpTrailDiag: null,
    // LIVE dedup guards (server.js populates these — not used by pure engine logic)
    _liveDispatchedAt: null,
    _liveExitDispatchedAt: null,
    _entryOrderId: null,
    _inFavorableHold: false
  };
}

export function computeExchangeMedian(prices) {
  const valid = (prices || []).filter(p => Number.isFinite(p) && p > 0);
  if (!valid.length) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function resolveDirection({ priceToBeat, exchangeMedian }) {
  if (!Number.isFinite(priceToBeat) || !Number.isFinite(exchangeMedian)) {
    return null;
  }
  return exchangeMedian >= priceToBeat ? "UP" : "DOWN";
}

export function strengthAgrees(direction, signals, timeframeMinutes) {
  if (!direction) return false;
  if (signals["Heiken+OBV"] !== direction) return false;
  if (signals["5+ Agree"] !== direction) return false;
  if (timeframeMinutes === 15 && signals["Delta 3m"] !== direction) return false;
  return true;
}

function contractPriceForDirection(direction, ctx) {
  if (direction === "UP") return ctx.marketPriceUp;
  if (direction === "DOWN") return ctx.marketPriceDown;
  return null;
}

function requiredStrengthIndicators(timeframeMinutes) {
  return timeframeMinutes === 15
    ? ["Heiken+OBV", "5+ Agree", "Delta 3m"]
    : ["Heiken+OBV", "5+ Agree"];
}

function statusLabel(ok) {
  return ok ? "ok" : "fail";
}

function formatUsdValue(value) {
  return Number.isFinite(value) ? `$${Math.round(value).toLocaleString("en-US")}` : "-";
}

function sideVsPriceToBeat(value, priceToBeat) {
  if (!Number.isFinite(value) || !Number.isFinite(priceToBeat)) return null;
  return value >= priceToBeat ? "UP" : "DOWN";
}

function directionActualText({ priceToBeat, currentPrice, exchangeMedian, direction }) {
  const oracleSide = sideVsPriceToBeat(currentPrice, priceToBeat);
  const exchangeSide = sideVsPriceToBeat(exchangeMedian, priceToBeat);
  const ptbText = formatUsdValue(priceToBeat);
  const oracleText = `${formatUsdValue(currentPrice)} ${oracleSide || "sem lado"}`;
  const exchangeText = `${formatUsdValue(exchangeMedian)} ${exchangeSide || "sem lado"}`;
  if (direction) {
    return `${direction} confirmado | PTB ${ptbText} | bolsas ${exchangeText} | oracle ${oracleText}`;
  }
  return `sem direção | PTB ${ptbText} | bolsas ${exchangeText} | oracle ${oracleText}`;
}

function directionBlockReason(ctx) {
  const exchangeSide = sideVsPriceToBeat(ctx.exchangeMedian, ctx.priceToBeat);
  return `Aguardando mediana das bolsas | PTB ${formatUsdValue(ctx.priceToBeat)} | bolsas ${formatUsdValue(ctx.exchangeMedian)} ${exchangeSide || "sem lado"}`;
}

export function buildScalpDiagnostics(ctx, timeframeMinutes) {
  const direction = resolveDirection({
    priceToBeat: ctx.priceToBeat,
    exchangeMedian: ctx.exchangeMedian
  });
  const contractPrice = contractPriceForDirection(direction, ctx);
  const contractPct = Number.isFinite(contractPrice) ? contractPrice * 100 : null;
  const entryMin = ctx.config?.entryMinPct ?? 0;
  const entryMax = ctx.config?.entryMaxPct ?? 100;
  const withinWindow = Number.isFinite(ctx.candleElapsedMs) && ctx.candleElapsedMs <= (ctx.config?.entryOpenWindowSec || 0) * 1000;
  const inBand = contractPct !== null && contractPct >= entryMin && contractPct <= entryMax;
  const stakeInfo = Number.isFinite(contractPrice) && contractPrice > 0
    ? computeEffectiveStake({
        baseStakeUsd: ctx.config?.stakeUsd,
        contractPrice,
        minSharesFloor: ctx.config?.minSharesFloor,
        maxEffectiveStakeUsd: ctx.config?.maxEffectiveStakeUsd
      })
    : { ok: false, reason: "preço contrato inválido", effectiveStakeUsd: null, shares: null };
  const directionReady = direction !== null;
  const requirements = [];

  requirements.push({
    key: "direction",
    label: "Mediana bolsas vs PTB",
    status: statusLabel(directionReady),
    expected: "UP ou DOWN vs Price to Beat",
    actual: directionActualText({
      priceToBeat: ctx.priceToBeat,
      currentPrice: ctx.currentPrice,
      exchangeMedian: ctx.exchangeMedian,
      direction
    }),
    details: {
      priceToBeat: ctx.priceToBeat,
      currentPrice: ctx.currentPrice,
      exchangeMedian: ctx.exchangeMedian
    }
  });

  for (const name of requiredStrengthIndicators(timeframeMinutes)) {
    const actual = ctx.signals?.[name] || null;
    requirements.push({
      key: `signal:${name}`,
      label: name,
      status: statusLabel(directionReady && actual === direction),
      expected: direction || "UP/DOWN definido",
      actual: actual || "neutro"
    });
  }

  requirements.push({
    key: "entry_band",
    label: "Preço contrato na banda",
    status: statusLabel(inBand),
    expected: `${entryMin}-${entryMax}¢`,
    actual: contractPct === null ? "sem preço" : `${contractPct.toFixed(1)}¢`
  });

  requirements.push({
    key: "entry_window",
    label: "Janela de entrada",
    status: statusLabel(withinWindow),
    expected: `<= ${ctx.config?.entryOpenWindowSec ?? 0}s`,
    actual: Number.isFinite(ctx.candleElapsedMs) ? `${Math.floor(ctx.candleElapsedMs / 1000)}s` : "sem tempo"
  });

  requirements.push({
    key: "stake_floor",
    label: "Stake base / min shares",
    status: statusLabel(stakeInfo.ok),
    expected: `maior entre $${ctx.config?.stakeUsd ?? 1} e ${ctx.config?.minSharesFloor ?? 0} shares, cap $${ctx.config?.maxEffectiveStakeUsd ?? "-"}`,
    actual: stakeInfo.ok
      ? `$${stakeInfo.effectiveStakeUsd.toFixed(2)} / ${stakeInfo.shares.toFixed(2)} sh`
      : stakeInfo.reason
  });

  return {
    direction,
    contractPrice,
    contractPct,
    requirements,
    ready: requirements.every((r) => r.status === "ok")
  };
}

export function computeEffectiveStake({ baseStakeUsd, contractPrice, minSharesFloor, maxEffectiveStakeUsd }) {
  if (!Number.isFinite(contractPrice) || contractPrice <= 0) {
    return { ok: false, reason: "preço contrato inválido", effectiveStakeUsd: null, shares: null };
  }
  const baseValid = Number.isFinite(baseStakeUsd) && baseStakeUsd > 0 ? baseStakeUsd : 1;
  const floor = Math.max(0, Number(minSharesFloor) || 0) * contractPrice;
  const effective = Math.max(baseValid, floor);
  const cap = Number.isFinite(maxEffectiveStakeUsd) ? maxEffectiveStakeUsd : Infinity;
  if (effective > cap) {
    return { ok: false, reason: `stake efetiva $${effective.toFixed(2)} > cap $${cap}`, effectiveStakeUsd: effective, shares: null };
  }
  const shares = effective / contractPrice;
  return { ok: true, reason: null, effectiveStakeUsd: Math.round(effective * 10000) / 10000, shares: Math.round(shares * 10000) / 10000 };
}

function resetToIdle(runtime, reason) {
  runtime.status = SCALP_STATUS.IDLE;
  runtime.latestReason = reason || "Aguardando candle";
  runtime.direction = null;
  runtime.armedAt = null;
  runtime.entryAt = null;
  runtime.entryPrice = null;
  runtime.effectiveStakeUsd = null;
  runtime.stakeUsd = null;
  runtime.shares = null;
  runtime.priceToBeat = null;
  runtime.currentPriceAtEntry = null;
  runtime.exchangeMedianAtEntry = null;
  runtime.targetPrice = null;
  runtime.minExitThreshold = null;
  runtime.deadlineAt = null;
  runtime.exitAt = null;
  runtime.exitPrice = null;
  runtime.exitReason = null;
  runtime.pnlUsd = null;
  runtime.entrySignedDelta = null;
  runtime.decayStopDiag = null;
  runtime.maxContractPctSinceEntry = null;
  runtime.trailingArmed = false;
  runtime.trailingStopPct = null;
  runtime.trailingStopDiag = null;
  runtime.hardStopDiag = null;
  runtime.tpArmed = false;
  runtime.tpTrailStopPct = null;
  runtime.tpForceFailCount = 0;
  runtime.tpTrailDiag = null;
  runtime._inFavorableHold = false;
}

function clearPositionForReentry(runtime, reason) {
  runtime.status = SCALP_STATUS.IDLE;
  runtime.latestReason = reason || "Aguardando reentrada";
  runtime.direction = null;
  runtime.armedAt = null;
  runtime.entryAt = null;
  runtime.entryPrice = null;
  runtime.effectiveStakeUsd = null;
  runtime.stakeUsd = null;
  runtime.shares = null;
  runtime.priceToBeat = null;
  runtime.currentPriceAtEntry = null;
  runtime.exchangeMedianAtEntry = null;
  runtime.targetPrice = null;
  runtime.minExitThreshold = null;
  runtime.deadlineAt = null;
  runtime.exitAt = null;
  runtime.exitPrice = null;
  runtime.exitReason = null;
  runtime.pnlUsd = null;
  runtime.entrySignedDelta = null;
  runtime.decayStopDiag = null;
  runtime.maxContractPctSinceEntry = null;
  runtime.trailingArmed = false;
  runtime.trailingStopPct = null;
  runtime.trailingStopDiag = null;
  runtime.hardStopDiag = null;
  runtime.tpArmed = false;
  runtime.tpTrailStopPct = null;
  runtime.tpForceFailCount = 0;
  runtime.tpTrailDiag = null;
  runtime._inFavorableHold = false;
}

function maxEntriesPerCandle(config) {
  const n = Number(config?.maxEntriesPerCandle);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function expiryOutcomeForRuntime(runtime, currentPrice) {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(runtime.priceToBeat)) return null;
  return currentPrice >= runtime.priceToBeat ? "UP" : "DOWN";
}

function tpExitMode(config) {
  return config?.tpExitMode === "trail" ? "trail" : "exit";
}

function shouldForceFailTp(runtime, ctx) {
  const enabled = ctx.config?.tpForceExitEnabled !== false;
  if (!enabled) return false;
  const requiredTicks = Math.max(1, Math.round(Number(ctx.config?.tpForceFailTicks) || 2));
  const stillStrong = strengthAgrees(runtime.direction, ctx.signals || {}, runtime.timeframeMinutes);
  runtime.tpForceFailCount = stillStrong ? 0 : (runtime.tpForceFailCount || 0) + 1;
  return runtime.tpForceFailCount >= requiredTicks;
}

/**
 * Advance a scalp runtime by one tick. Returns `{ closedTrade }` when a trade
 * closes on this tick, so the caller can persist / log it. All decisions are
 * pure functions of the context — no network, no timers.
 *
 * Context (required fields):
 *   - nowMs                 server tick timestamp
 *   - marketSlug            current Polymarket slug (may be null)
 *   - candleElapsedMs       ms elapsed since candle start
 *   - priceToBeat           resolved price-to-beat (float)
 *   - currentPrice          chainlink / oracle live price (float)
 *   - exchangeMedian        median of exchange spot prices (float)
 *   - marketPriceUp         Polymarket UP contract price (0..1)
 *   - marketPriceDown       Polymarket DOWN contract price (0..1)
 *   - signals               simSignals map (Heiken+OBV, 5+ Agree, Delta 3m, ...)
 *   - config                indicator scalp config object
 *   - enabled               boolean — whether the indicator is enabled for this tf
 */
export function advanceScalp(runtime, ctx) {
  const closed = { closedTrade: null };
  runtime.diagnostics = buildScalpDiagnostics(ctx, runtime.timeframeMinutes);

  // Reset state on slug rollover so we never leak entries across candles.
  if (runtime.slug && ctx.marketSlug && runtime.slug !== ctx.marketSlug) {
    if (runtime.status === SCALP_STATUS.IN_POSITION) {
      const outcome = expiryOutcomeForRuntime(runtime, ctx.currentPrice);
      const resolved = outcome === "UP" || outcome === "DOWN";
      const won = resolved && outcome === runtime.direction;
      runtime.lastClosedTrade = buildClosedTradeSnapshot(runtime, {
        exitPrice: resolved ? (won ? 1 : 0) : runtime.entryPrice,
        exitReason: resolved ? (won ? "expiry_win" : "expiry_loss") : "slug_rollover_unresolved",
        exitAt: ctx.nowMs,
        config: ctx.config,
        marketSlug: runtime.slug,
        outcome
      });
      closed.closedTrade = runtime.lastClosedTrade;
    }
    resetToIdle(runtime, "Novo candle — estado resetado");
    runtime.entriesThisCandle = 0;
  }
  runtime.slug = ctx.marketSlug || runtime.slug;

  if (!ctx.enabled) {
    resetToIdle(runtime, "Indicador desativado");
    runtime.entriesThisCandle = 0;
    return closed;
  }

  // IN_POSITION branch — check exits first on every tick.
  if (runtime.status === SCALP_STATUS.IN_POSITION) {
    const contractPrice = runtime.direction === "UP" ? ctx.marketPriceUp : ctx.marketPriceDown;
    if (!Number.isFinite(contractPrice) || contractPrice <= 0) {
      // Keep position open — hold until next valid tick rather than force-close on stale data.
      runtime.latestReason = "Preço do contrato indisponível — mantendo posição";
      return closed;
    }
    const pct = contractPrice * 100;
    const reached = pct >= (ctx.config.takeProfitPct ?? 100);
    const expired = ctx.nowMs >= runtime.deadlineAt;
    runtime.maxContractPctSinceEntry = Number.isFinite(runtime.maxContractPctSinceEntry)
      ? Math.max(runtime.maxContractPctSinceEntry, pct)
      : pct;

    // ── 1. TP: default exits immediately; trail mode arms profit protection instead.
    if (reached && tpExitMode(ctx.config) === "exit") {
      runtime.lastClosedTrade = buildClosedTradeSnapshot(runtime, {
        exitPrice: contractPrice,
        exitReason: "tp_hit",
        exitAt: ctx.nowMs,
        config: ctx.config,
        marketSlug: ctx.marketSlug
      });
      runtime.status = SCALP_STATUS.CLOSED_TP;
      runtime.latestReason = `TP atingido em ${pct.toFixed(1)}¢`;
      closed.closedTrade = runtime.lastClosedTrade;
      return closed;
    }
    // ── 2. Decay stop: BTC spot recuou > cushionUsd do priceToBeat vs entrada ──
    // Só dispara se TP não foi atingido. Respeita Min Exit como piso de preço.
    const cushionUsd = ctx.config.decayStopCushionUsd ?? 30;
    const currentSignedDelta = runtime.direction === "UP"
      ? ctx.currentPrice - runtime.priceToBeat
      : runtime.priceToBeat - ctx.currentPrice;
    const decayThreshold = Number.isFinite(runtime.entrySignedDelta)
      ? runtime.entrySignedDelta - cushionUsd
      : null;
    const decayTriggered =
      Number.isFinite(runtime.entrySignedDelta) &&
      Number.isFinite(currentSignedDelta) &&
      Number.isFinite(ctx.currentPrice) &&
      currentSignedDelta < decayThreshold;
    // Always update live diag for UI display (even when not triggered)
    runtime.decayStopDiag = {
      entrySignedDelta: runtime.entrySignedDelta,
      currentSignedDelta: Number.isFinite(currentSignedDelta) ? currentSignedDelta : null,
      cushionUsd,
      threshold: decayThreshold,
      margin: Number.isFinite(currentSignedDelta) && decayThreshold !== null
        ? currentSignedDelta - decayThreshold
        : null,
      triggered: decayTriggered
    };

    const tpTrailCents = Number.isFinite(ctx.config.tpTrailCents)
      ? ctx.config.tpTrailCents
      : 3;
    const tpForceFailTicks = Math.max(1, Math.round(Number(ctx.config.tpForceFailTicks) || 2));
    runtime.tpTrailDiag = {
      armed: runtime.tpArmed,
      currentPct: pct,
      maxPct: runtime.maxContractPctSinceEntry,
      stopPct: runtime.tpArmed ? runtime.tpTrailStopPct : null,
      trailCents: tpTrailCents,
      forceFailCount: runtime.tpForceFailCount || 0,
      forceFailTicks: tpForceFailTicks,
      forceExitEnabled: ctx.config.tpForceExitEnabled !== false,
      forceFail: false,
      trailHit: false,
      targetPct: ctx.config.takeProfitPct ?? 100,
      reached
    };

    if (tpExitMode(ctx.config) === "trail" && (reached || runtime.tpArmed)) {
      runtime.tpArmed = true;
      runtime.tpTrailStopPct = runtime.maxContractPctSinceEntry - tpTrailCents;
      const forceFail = shouldForceFailTp(runtime, ctx);
      const trailHit = Number.isFinite(runtime.tpTrailStopPct) && pct <= runtime.tpTrailStopPct;
      runtime.tpTrailDiag = {
        armed: true,
        currentPct: pct,
        maxPct: runtime.maxContractPctSinceEntry,
        stopPct: runtime.tpTrailStopPct,
        trailCents: tpTrailCents,
        forceFailCount: runtime.tpForceFailCount || 0,
        forceFailTicks: tpForceFailTicks,
        forceExitEnabled: ctx.config.tpForceExitEnabled !== false,
        forceFail,
        trailHit,
        targetPct: ctx.config.takeProfitPct ?? 100,
        reached
      };
      if (forceFail || trailHit) {
        runtime.lastClosedTrade = buildClosedTradeSnapshot(runtime, {
          exitPrice: contractPrice,
          exitReason: forceFail ? "tp_force_fail" : "tp_trailing_stop",
          exitAt: ctx.nowMs,
          config: ctx.config,
          marketSlug: ctx.marketSlug
        });
        runtime.status = forceFail ? SCALP_STATUS.CLOSED_TP_FORCE_FAIL : SCALP_STATUS.CLOSED_TP_TRAILING_STOP;
        runtime.latestReason = forceFail
          ? `TP força falhou (${runtime.tpForceFailCount}/${runtime.tpTrailDiag.forceFailTicks}) em ${pct.toFixed(1)}¢`
          : `TP trailing stop: ${pct.toFixed(1)}c <= stop ${runtime.tpTrailStopPct.toFixed(1)}c (top ${runtime.maxContractPctSinceEntry.toFixed(1)}c)`;
        closed.closedTrade = runtime.lastClosedTrade;
        return closed;
      }
    }

    if (decayTriggered) {
      const aboveMin = pct >= (ctx.config.minExitPct ?? 0);
      runtime.lastClosedTrade = buildClosedTradeSnapshot(runtime, {
        exitPrice: contractPrice,
        exitReason: aboveMin ? "decay_stop_min_exit" : "decay_stop_force_exit",
        exitAt: ctx.nowMs,
        config: ctx.config,
        marketSlug: ctx.marketSlug
      });
      runtime.status = aboveMin ? SCALP_STATUS.CLOSED_DECAY_STOP_MIN : SCALP_STATUS.CLOSED_DECAY_STOP_FORCE;
      runtime.latestReason = `Decay stop: delta $${currentSignedDelta.toFixed(0)} (entrada $${runtime.entrySignedDelta.toFixed(0)}, cushion $${cushionUsd})`;
      closed.closedTrade = runtime.lastClosedTrade;
      return closed;
    }

    // 3. Trailing stop: arms only after the contract moves above entry, so bid/ask spread
    // right after entry does not trigger an immediate loss.
    const trailingArmingCents = Number.isFinite(ctx.config.trailingArmingCents)
      ? ctx.config.trailingArmingCents
      : 2;
    const trailingCushionCents = Number.isFinite(ctx.config.trailingCushionCents)
      ? ctx.config.trailingCushionCents
      : 3;
    const entryPct = Number.isFinite(runtime.entryPrice) ? runtime.entryPrice * 100 : null;
    const armingThreshold = Number.isFinite(entryPct) ? entryPct + trailingArmingCents : null;
    if (!runtime.trailingArmed && armingThreshold !== null && pct >= armingThreshold) {
      runtime.trailingArmed = true;
    }
    runtime.trailingStopPct = runtime.trailingArmed
      ? runtime.maxContractPctSinceEntry - trailingCushionCents
      : null;
    const trailingTriggered = runtime.trailingArmed &&
      Number.isFinite(runtime.trailingStopPct) &&
      pct <= runtime.trailingStopPct;
    runtime.trailingStopDiag = {
      armed: runtime.trailingArmed,
      currentPct: pct,
      entryPct,
      maxPct: runtime.maxContractPctSinceEntry,
      armingThreshold,
      cushionCents: trailingCushionCents,
      stopPct: runtime.trailingStopPct,
      triggered: trailingTriggered
    };
    if (trailingTriggered) {
      runtime.lastClosedTrade = buildClosedTradeSnapshot(runtime, {
        exitPrice: contractPrice,
        exitReason: "trailing_stop",
        exitAt: ctx.nowMs,
        config: ctx.config,
        marketSlug: ctx.marketSlug
      });
      runtime.status = SCALP_STATUS.CLOSED_TRAILING_STOP;
      runtime.latestReason = `Trailing stop: ${pct.toFixed(1)}c <= stop ${runtime.trailingStopPct.toFixed(1)}c (top ${runtime.maxContractPctSinceEntry.toFixed(1)}c)`;
      closed.closedTrade = runtime.lastClosedTrade;
      return closed;
    }

    // 4. Hard stop: catastrophe floor when contract collapses below entry-N¢ after grace period.
    // Grace period prevents bid/ask spread from triggering immediately after entry.
    const hardStopCushionCents = Number.isFinite(ctx.config.hardStopCushionCents)
      ? ctx.config.hardStopCushionCents
      : 15;
    const hardStopGraceSec = Number.isFinite(ctx.config.hardStopGraceSec)
      ? ctx.config.hardStopGraceSec
      : 20;
    const holdSec = runtime.entryAt ? (ctx.nowMs - runtime.entryAt) / 1000 : 0;
    const hardStopThresholdPct = entryPct !== null ? entryPct - hardStopCushionCents : null;
    const hardStopReady = holdSec >= hardStopGraceSec;
    const hardStopTriggered = hardStopReady &&
      hardStopThresholdPct !== null &&
      pct < hardStopThresholdPct;
    runtime.hardStopDiag = {
      entryPct,
      currentPct: pct,
      cushionCents: hardStopCushionCents,
      threshold: hardStopThresholdPct,
      graceSec: hardStopGraceSec,
      holdSec,
      ready: hardStopReady,
      triggered: hardStopTriggered
    };
    if (hardStopTriggered) {
      runtime.lastClosedTrade = buildClosedTradeSnapshot(runtime, {
        exitPrice: contractPrice,
        exitReason: "hard_stop",
        exitAt: ctx.nowMs,
        config: ctx.config,
        marketSlug: ctx.marketSlug
      });
      runtime.status = SCALP_STATUS.CLOSED_HARD_STOP;
      runtime.latestReason = `Hard stop: ${pct.toFixed(1)}¢ < ${hardStopThresholdPct.toFixed(1)}¢ (entrada ${entryPct.toFixed(1)}¢ − ${hardStopCushionCents}¢, hold ${holdSec.toFixed(0)}s)`;
      closed.closedTrade = runtime.lastClosedTrade;
      return closed;
    }

    // ── 5. Hold favorável: monitora condições a cada tick sem timer fixo ──
    // Se o deadline expirou E as condições são favoráveis, entra em hold favorável.
    // Enquanto em hold favorável, cada tick reavalia as condições — sai imediatamente
    // quando qualquer condição falhar, sem esperar um novo deadline.
    const btcMoreFavorable = Number.isFinite(currentSignedDelta) &&
      Number.isFinite(runtime.entrySignedDelta) &&
      currentSignedDelta > runtime.entrySignedDelta;
    const contractNotWorsen = runtime.entryPrice !== null && pct >= runtime.entryPrice * 100;

    if (runtime._inFavorableHold) {
      if (btcMoreFavorable && contractNotWorsen) {
        runtime.latestReason = `Hold favorável: SD $${currentSignedDelta.toFixed(0)} > entrada $${runtime.entrySignedDelta.toFixed(0)} | contrato ${pct.toFixed(1)}¢`;
        return closed;
      }
      // Condição falhou — sai agora
      const aboveMin = pct >= (ctx.config.minExitPct ?? 0);
      runtime.lastClosedTrade = buildClosedTradeSnapshot(runtime, {
        exitPrice: contractPrice,
        exitReason: aboveMin ? "timeout_min_exit" : "timeout_force_exit",
        exitAt: ctx.nowMs,
        config: ctx.config,
        marketSlug: ctx.marketSlug
      });
      runtime.status = aboveMin ? SCALP_STATUS.CLOSED_TIMEOUT_MIN_EXIT : SCALP_STATUS.CLOSED_TIMEOUT_FORCE_EXIT;
      runtime.latestReason = aboveMin
        ? `Hold favorável encerrado em ${pct.toFixed(1)}¢`
        : `Hold favorável encerrado (abaixo do mínimo) em ${pct.toFixed(1)}¢`;
      closed.closedTrade = runtime.lastClosedTrade;
      return closed;
    }

    if (expired) {
      if (btcMoreFavorable && contractNotWorsen) {
        runtime._inFavorableHold = true;
        runtime.latestReason = `Hold favorável: SD $${currentSignedDelta.toFixed(0)} > entrada $${runtime.entrySignedDelta.toFixed(0)} | contrato ${pct.toFixed(1)}¢`;
        return closed;
      }
      const aboveMin = pct >= (ctx.config.minExitPct ?? 0);
      runtime.lastClosedTrade = buildClosedTradeSnapshot(runtime, {
        exitPrice: contractPrice,
        exitReason: aboveMin ? "timeout_min_exit" : "timeout_force_exit",
        exitAt: ctx.nowMs,
        config: ctx.config,
        marketSlug: ctx.marketSlug
      });
      runtime.status = aboveMin ? SCALP_STATUS.CLOSED_TIMEOUT_MIN_EXIT : SCALP_STATUS.CLOSED_TIMEOUT_FORCE_EXIT;
      runtime.latestReason = aboveMin
        ? `Timeout acima do mínimo em ${pct.toFixed(1)}¢`
        : `Timeout forçado em ${pct.toFixed(1)}¢`;
      closed.closedTrade = runtime.lastClosedTrade;
      return closed;
    }

    runtime.latestReason = runtime.tpArmed
      ? `TP armado ${runtime.direction} @ ${pct.toFixed(1)}¢ — stop ${runtime.tpTrailStopPct?.toFixed?.(1) ?? "-"}¢`
      : `Em posição ${runtime.direction} @ ${pct.toFixed(1)}¢ — alvo ${ctx.config.takeProfitPct}¢`;
    return closed;
  }

  // TP closes the cycle for this candle. Defensive exits may re-enter while
  // the entry window is still open, limited by maxEntriesPerCandle.
  if (
    runtime.status === SCALP_STATUS.CLOSED_TP ||
    runtime.status === SCALP_STATUS.CLOSED_TP_TRAILING_STOP ||
    runtime.status === SCALP_STATUS.CLOSED_TP_FORCE_FAIL
  ) {
    return closed;
  }
  if (
    runtime.status === SCALP_STATUS.CLOSED_TIMEOUT_MIN_EXIT ||
    runtime.status === SCALP_STATUS.CLOSED_TIMEOUT_FORCE_EXIT ||
    runtime.status === SCALP_STATUS.CLOSED_DECAY_STOP_MIN ||
    runtime.status === SCALP_STATUS.CLOSED_DECAY_STOP_FORCE ||
    runtime.status === SCALP_STATUS.CLOSED_TRAILING_STOP ||
    runtime.status === SCALP_STATUS.CLOSED_HARD_STOP
  ) {
    const maxEntries = maxEntriesPerCandle(ctx.config);
    if ((runtime.entriesThisCandle || 0) >= maxEntries) {
      runtime.latestReason = `Limite de entradas no candle atingido (${runtime.entriesThisCandle}/${maxEntries})`;
      return closed;
    }
    clearPositionForReentry(runtime, `Reentrada liberada (${runtime.entriesThisCandle}/${maxEntries})`);
  }
  if (runtime.status === SCALP_STATUS.CANCELLED) {
    return closed;
  }

  // IDLE / ARMED — evaluate arm then entry.
  const direction = resolveDirection({
    priceToBeat: ctx.priceToBeat,
    exchangeMedian: ctx.exchangeMedian
  });
  if (!direction) {
    resetToIdle(runtime, directionBlockReason(ctx));
    return closed;
  }
  if (!strengthAgrees(direction, ctx.signals || {}, runtime.timeframeMinutes)) {
    runtime.direction = direction;
    runtime.status = SCALP_STATUS.IDLE;
    runtime.latestReason = `Indicadores não confirmam ${direction}`;
    return closed;
  }

  const contractPrice = direction === "UP" ? ctx.marketPriceUp : ctx.marketPriceDown;
  if (!Number.isFinite(contractPrice) || contractPrice <= 0) {
    runtime.direction = direction;
    runtime.status = SCALP_STATUS.IDLE;
    runtime.latestReason = "Preço do contrato indisponível";
    return closed;
  }

  const entryWindowMs = (ctx.config.entryOpenWindowSec || 0) * 1000;
  const withinWindow = ctx.candleElapsedMs <= entryWindowMs;
  const pct = contractPrice * 100;
  const inBand = pct >= (ctx.config.entryMinPct ?? 0) && pct <= (ctx.config.entryMaxPct ?? 100);

  // We're "armed" any time direction + strength agree — display to user.
  if (!withinWindow) {
    runtime.direction = direction;
    runtime.status = SCALP_STATUS.ARMED;
    runtime.armedAt = runtime.armedAt ?? ctx.nowMs;
    runtime.latestReason = `Janela de entrada encerrada (${Math.floor(ctx.candleElapsedMs / 1000)}s / ${ctx.config.entryOpenWindowSec}s)`;
    return closed;
  }
  if (!inBand) {
    runtime.direction = direction;
    runtime.status = SCALP_STATUS.ARMED;
    runtime.armedAt = runtime.armedAt ?? ctx.nowMs;
    runtime.latestReason = `Fora da banda: ${pct.toFixed(1)}¢ (zona ${ctx.config.entryMinPct}-${ctx.config.entryMaxPct}¢)`;
    return closed;
  }

  // Enter position
  const stakeInfo = computeEffectiveStake({
    baseStakeUsd: ctx.config.stakeUsd,
    contractPrice,
    minSharesFloor: ctx.config.minSharesFloor,
    maxEffectiveStakeUsd: ctx.config.maxEffectiveStakeUsd
  });
  if (!stakeInfo.ok) {
    runtime.direction = direction;
    runtime.status = SCALP_STATUS.ARMED;
    runtime.armedAt = runtime.armedAt ?? ctx.nowMs;
    runtime.latestReason = `Entrada bloqueada: ${stakeInfo.reason}`;
    return closed;
  }

  runtime.direction = direction;
  runtime.status = SCALP_STATUS.IN_POSITION;
  runtime.entriesThisCandle = (runtime.entriesThisCandle || 0) + 1;
  runtime.entryAt = ctx.nowMs;
  runtime.entryPrice = contractPrice;
  runtime.effectiveStakeUsd = stakeInfo.effectiveStakeUsd;
  runtime.stakeUsd = ctx.config.stakeUsd ?? 1;
  runtime.shares = stakeInfo.shares;
  runtime.priceToBeat = ctx.priceToBeat;
  runtime.currentPriceAtEntry = ctx.currentPrice;
  runtime.exchangeMedianAtEntry = ctx.exchangeMedian;
  runtime.targetPrice = (ctx.config.takeProfitPct ?? 100) / 100;
  runtime.minExitThreshold = (ctx.config.minExitPct ?? 0) / 100;
  runtime.deadlineAt = ctx.nowMs + (ctx.config.maxHoldSec || 0) * 1000;
  runtime.maxContractPctSinceEntry = pct;
  runtime.trailingArmed = false;
  runtime.trailingStopPct = null;
  runtime.trailingStopDiag = {
    armed: false,
    currentPct: pct,
    entryPct: pct,
    maxPct: pct,
    armingThreshold: pct + (ctx.config.trailingArmingCents ?? 2),
    cushionCents: ctx.config.trailingCushionCents ?? 3,
    stopPct: null,
    triggered: false
  };
  runtime.tpArmed = false;
  runtime.tpTrailStopPct = null;
  runtime.tpForceFailCount = 0;
  runtime.tpTrailDiag = {
    armed: false,
    currentPct: pct,
    maxPct: pct,
    stopPct: null,
    trailCents: ctx.config.tpTrailCents ?? 3,
    forceFailCount: 0,
    forceFailTicks: Math.max(1, Math.round(Number(ctx.config.tpForceFailTicks) || 2)),
    forceExitEnabled: ctx.config.tpForceExitEnabled !== false,
    forceFail: false,
    trailHit: false,
    targetPct: ctx.config.takeProfitPct ?? 100,
    reached: false
  };
  runtime.entrySignedDelta = direction === "UP"
    ? ctx.currentPrice - ctx.priceToBeat
    : ctx.priceToBeat - ctx.currentPrice;
  runtime.latestReason = `Entrou ${direction} @ ${pct.toFixed(1)}¢ — alvo ${ctx.config.takeProfitPct}¢ (${runtime.entriesThisCandle}/${maxEntriesPerCandle(ctx.config)})`;
  return closed;
}

function buildClosedTradeSnapshot(runtime, { exitPrice, exitReason, exitAt, config, marketSlug, outcome = null }) {
  const entryPrice = runtime.entryPrice ?? 0;
  const shares = runtime.shares ?? 0;
  const effective = runtime.effectiveStakeUsd ?? 0;
  const returned = Number.isFinite(exitPrice) && Number.isFinite(shares) ? shares * exitPrice : 0;
  const pnl = returned - effective;
  const holdSec = runtime.entryAt ? (exitAt - runtime.entryAt) / 1000 : 0;
  return {
    indicator: runtime.indicatorName,
    marketSlug: marketSlug || runtime.slug,
    windowMin: runtime.timeframeMinutes,
    side: runtime.direction,
    entryPrice: round4(entryPrice),
    exitPrice: round4(exitPrice),
    entryTime: runtime.entryAt ? new Date(runtime.entryAt).toISOString() : null,
    exitTime: new Date(exitAt).toISOString(),
    holdSeconds: Math.round(holdSec * 10) / 10,
    exitReason,
    stakeUsd: runtime.stakeUsd,
    effectiveStakeUsd: round4(effective),
    shares: round4(shares),
    pnlUsd: round4(pnl),
    outcome,
    priceToBeat: runtime.priceToBeat,
    currentPriceEntry: runtime.currentPriceAtEntry,
    exchangeMedianEntry: runtime.exchangeMedianAtEntry,
    takeProfitPct: config.takeProfitPct,
    minExitPct: config.minExitPct,
    tpExitMode: config.tpExitMode,
    tpTrailCents: config.tpTrailCents,
    tpForceExitEnabled: config.tpForceExitEnabled,
    tpForceFailTicks: config.tpForceFailTicks,
    trailingArmingCents: config.trailingArmingCents,
    trailingCushionCents: config.trailingCushionCents,
    entryOpenWindowSec: config.entryOpenWindowSec,
    maxHoldSec: config.maxHoldSec
  };
}

export function closedTradeToCsvRow(trade) {
  return [
    new Date().toISOString(),
    trade.indicator,
    trade.marketSlug || "",
    trade.windowMin,
    trade.side || "",
    trade.entryPrice,
    trade.exitPrice,
    trade.entryTime || "",
    trade.exitTime || "",
    trade.holdSeconds,
    trade.exitReason || "",
    trade.stakeUsd,
    trade.effectiveStakeUsd,
    trade.shares,
    trade.pnlUsd,
    trade.priceToBeat ?? "",
    trade.currentPriceEntry ?? "",
    trade.exchangeMedianEntry ?? "",
    trade.takeProfitPct,
    trade.minExitPct,
    trade.entryOpenWindowSec,
    trade.maxHoldSec
  ];
}

export function buildScalpCardPayload(runtime, config) {
  const remainingMs = runtime.deadlineAt ? Math.max(0, runtime.deadlineAt - Date.now()) : null;
  return {
    indicator: runtime.indicatorName,
    timeframeMinutes: runtime.timeframeMinutes,
    status: runtime.status,
    direction: runtime.direction,
    reason: runtime.latestReason,
    entryPrice: runtime.entryPrice,
    targetPrice: runtime.targetPrice,
    minExitThreshold: runtime.minExitThreshold,
    stakeUsd: runtime.stakeUsd,
    effectiveStakeUsd: runtime.effectiveStakeUsd,
    shares: runtime.shares,
    entriesThisCandle: runtime.entriesThisCandle || 0,
    entryAt: runtime.entryAt ? new Date(runtime.entryAt).toISOString() : null,
    deadlineAt: runtime.deadlineAt ? new Date(runtime.deadlineAt).toISOString() : null,
    remainingMs,
    lastClosedTrade: runtime.lastClosedTrade,
    diagnostics: runtime.diagnostics || null,
    decayStopDiag: runtime.decayStopDiag || null,
    trailingStopDiag: runtime.trailingStopDiag || null,
    hardStopDiag: runtime.hardStopDiag || null,
    tpTrailDiag: runtime.tpTrailDiag || null,
    inFavorableHold: runtime._inFavorableHold,
    config: {
      stakeUsd: config.stakeUsd,
      entryMinPct: config.entryMinPct,
      entryMaxPct: config.entryMaxPct,
      takeProfitPct: config.takeProfitPct,
      minExitPct: config.minExitPct,
      tpExitMode: config.tpExitMode,
      tpTrailCents: config.tpTrailCents,
      tpForceExitEnabled: config.tpForceExitEnabled,
      tpForceFailTicks: config.tpForceFailTicks,
      trailingArmingCents: config.trailingArmingCents,
      trailingCushionCents: config.trailingCushionCents,
      hardStopCushionCents: config.hardStopCushionCents,
      hardStopGraceSec: config.hardStopGraceSec,
      maxEntriesPerCandle: config.maxEntriesPerCandle,
      entryOpenWindowSec: config.entryOpenWindowSec,
      maxHoldSec: config.maxHoldSec,
      minSharesFloor: config.minSharesFloor,
      maxEffectiveStakeUsd: config.maxEffectiveStakeUsd,
      enabled: config.enabled
    }
  };
}

export function buildScalpStripPayload(runtimes, cumulative) {
  const active = [];
  let latestExit = null;
  for (const rt of runtimes) {
    if (rt.status === SCALP_STATUS.IN_POSITION) {
      active.push({
        indicator: rt.indicatorName,
        direction: rt.direction,
        entryPrice: rt.entryPrice,
        effectiveStakeUsd: rt.effectiveStakeUsd,
        shares: rt.shares,
        remainingMs: rt.deadlineAt ? Math.max(0, rt.deadlineAt - Date.now()) : null
      });
    }
    const closed = rt.lastClosedTrade;
    if (closed && (!latestExit || (closed.exitTime || "") > (latestExit.exitTime || ""))) {
      latestExit = closed;
    }
  }
  return {
    activePositions: active,
    latestExit,
    cumulativePnlByIndicator: { ...cumulative }
  };
}

function round4(v) {
  if (!Number.isFinite(v)) return v;
  return Math.round(v * 10000) / 10000;
}
