import { clamp } from "../utils.js";

/**
 * Scores the directional bias (UP vs DOWN) by combining multiple
 * technical indicators into a weighted score.
 *
 * Returns { bullishScore, bearishScore, rawBullishProbability }.
 */
export function scoreDirection(inputs) {
  const {
    price,
    vwap,
    vwapSlope,
    rsi,
    rsiSlope,
    macd,
    heikenColor,
    heikenCount,
    failedVwapReclaim,
    // New indicators
    bollinger,
    stochRsi,
    emaCross,
    obv,
    atr
  } = inputs;

  let bullishScore = 1;
  let bearishScore = 1;

  // ── Price relative to VWAP ──
  if (price !== null && vwap !== null) {
    if (price > vwap) bullishScore += 2;
    if (price < vwap) bearishScore += 2;
  }

  // ── VWAP slope direction ──
  if (vwapSlope !== null) {
    if (vwapSlope > 0) bullishScore += 2;
    if (vwapSlope < 0) bearishScore += 2;
  }

  // ── RSI + RSI slope alignment ──
  if (rsi !== null && rsiSlope !== null) {
    if (rsi > 55 && rsiSlope > 0) bullishScore += 2;
    if (rsi < 45 && rsiSlope < 0) bearishScore += 2;
  }

  // ── MACD histogram + expansion ──
  if (macd?.hist !== null && macd?.histDelta !== null) {
    const expandingBullish = macd.hist > 0 && macd.histDelta > 0;
    const expandingBearish = macd.hist < 0 && macd.histDelta < 0;
    if (expandingBullish) bullishScore += 2;
    if (expandingBearish) bearishScore += 2;

    if (macd.macd > 0) bullishScore += 1;
    if (macd.macd < 0) bearishScore += 1;
  }

  // ── Heiken Ashi consecutive candles ──
  if (heikenColor) {
    if (heikenColor === "green" && heikenCount >= 2) bullishScore += 1;
    if (heikenColor === "red" && heikenCount >= 2) bearishScore += 1;
  }

  // ── Failed VWAP reclaim is a strong bearish signal ──
  if (failedVwapReclaim === true) bearishScore += 3;

  // ────────────────────────────────────────────────────────────────
  // NEW INDICATORS
  // ────────────────────────────────────────────────────────────────

  // ── Bollinger Bands — mean reversion at extremes ──
  if (bollinger !== null) {
    // Price at lower band = oversold, expect bounce
    if (bollinger.percentB < 0.2) bullishScore += 2;
    // Price at upper band = overbought, expect pullback
    if (bollinger.percentB > 0.8) bearishScore += 2;
    // Squeeze + trending = stronger move expected
    if (bollinger.isSqueeze && vwapSlope !== null) {
      if (vwapSlope > 0) bullishScore += 1;
      if (vwapSlope < 0) bearishScore += 1;
    }
  }

  // ── Stochastic RSI — overbought/oversold with crossover ──
  if (stochRsi !== null) {
    // Oversold + crossing up = strong bullish reversal
    if (stochRsi.oversold && stochRsi.crossUp) bullishScore += 3;
    else if (stochRsi.oversold) bullishScore += 1;

    // Overbought + crossing down = strong bearish reversal
    if (stochRsi.overbought && stochRsi.crossDown) bearishScore += 3;
    else if (stochRsi.overbought) bearishScore += 1;

    // Regular crossovers without extreme values
    if (!stochRsi.overbought && !stochRsi.oversold) {
      if (stochRsi.crossUp) bullishScore += 1;
      if (stochRsi.crossDown) bearishScore += 1;
    }
  }

  // ── EMA Cross 9/21 — momentum direction ──
  if (emaCross !== null) {
    // Aligned with trend
    if (emaCross.bullish) bullishScore += 2;
    if (emaCross.bearish) bearishScore += 2;

    // Fresh crossover = stronger signal
    if (emaCross.crossUp) bullishScore += 1;
    if (emaCross.crossDown) bearishScore += 1;
  }

  // ── OBV — volume confirms or diverges from price ──
  if (obv !== null) {
    // Volume slope alignment
    if (obv.slope > 0) bullishScore += 1;
    if (obv.slope < 0) bearishScore += 1;

    // Divergence = strong reversal signal
    if (obv.divergence === "bullish_div") bullishScore += 2;
    if (obv.divergence === "bearish_div") bearishScore += 2;
  }

  // ── ATR — volatility context (moderates confidence) ──
  // In low volatility, moderate the signals (less conviction)
  // In high volatility, existing signals get a small boost
  if (atr !== null) {
    if (atr.volatilityLevel === "high") {
      // High volatility amplifies the dominant direction slightly
      if (bullishScore > bearishScore) bullishScore += 1;
      if (bearishScore > bullishScore) bearishScore += 1;
    }
    // Low volatility: no penalty, just less confident
  }

  const rawBullishProbability = bullishScore / (bullishScore + bearishScore);
  return { bullishScore, bearishScore, rawBullishProbability };
}

/**
 * Applies time decay to the raw probability. As time runs out,
 * the prediction converges toward 50/50 (uncertainty increases).
 */
export function applyTimeAwareness(rawBullishProbability, remainingMinutes, windowMinutes) {
  const timeDecay = clamp(remainingMinutes / windowMinutes, 0, 1);
  const adjustedUp = clamp(0.5 + (rawBullishProbability - 0.5) * timeDecay, 0, 1);
  return { timeDecay, adjustedUp, adjustedDown: 1 - adjustedUp };
}
