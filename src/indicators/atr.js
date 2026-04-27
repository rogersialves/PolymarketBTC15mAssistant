/**
 * ATR (Average True Range)
 *
 * Measures market volatility over a period.
 * High ATR = volatile market with larger moves.
 * Low ATR = calm market, potential squeeze before breakout.
 *
 * Returns { atr, atrPercent, volatilityLevel }
 * - atr: absolute ATR value in USD
 * - atrPercent: ATR as percentage of current price
 * - volatilityLevel: "high" | "normal" | "low"
 */

export function computeAtr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;

  // Compute True Range for each candle
  const trueRanges = [];
  for (let i = 1; i < candles.length; i += 1) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return null;

  // Simple average of last `period` true ranges
  const recentTR = trueRanges.slice(trueRanges.length - period);
  const atr = recentTR.reduce((sum, v) => sum + v, 0) / period;

  const currentPrice = candles[candles.length - 1].close;
  const atrPercent = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;

  // Classify volatility relative to BTC typical ranges
  // For 1-minute candles: <0.02% = low, >0.05% = high
  let volatilityLevel = "normal";
  if (atrPercent < 0.02) volatilityLevel = "low";
  else if (atrPercent > 0.05) volatilityLevel = "high";

  return {
    atr,
    atrPercent,
    volatilityLevel
  };
}
