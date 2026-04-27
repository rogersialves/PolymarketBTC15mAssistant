/**
 * EMA Crossover (default: 9 fast / 21 slow)
 *
 * Returns { emaFast, emaSlow, bullish, bearish, crossUp, crossDown, spread }
 * - bullish: EMA fast > EMA slow (momentum is upward)
 * - bearish: EMA fast < EMA slow (momentum is downward)
 * - crossUp: EMA fast just crossed above EMA slow
 * - crossDown: EMA fast just crossed below EMA slow
 * - spread: absolute distance between the two EMAs
 */

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 1; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

export function computeEmaCross(closePrices, fastPeriod = 9, slowPeriod = 21) {
  if (!Array.isArray(closePrices) || closePrices.length < slowPeriod + 2) return null;

  const emaFast = ema(closePrices, fastPeriod);
  const emaSlow = ema(closePrices, slowPeriod);
  if (emaFast === null || emaSlow === null) return null;

  // Previous values (one bar back) to detect crossovers
  const prevPrices = closePrices.slice(0, -1);
  const prevEmaFast = ema(prevPrices, fastPeriod);
  const prevEmaSlow = ema(prevPrices, slowPeriod);

  const bullish = emaFast > emaSlow;
  const bearish = emaFast < emaSlow;

  const crossUp = prevEmaFast !== null && prevEmaSlow !== null
    ? prevEmaFast <= prevEmaSlow && emaFast > emaSlow
    : false;

  const crossDown = prevEmaFast !== null && prevEmaSlow !== null
    ? prevEmaFast >= prevEmaSlow && emaFast < emaSlow
    : false;

  const spread = emaFast - emaSlow;

  return {
    emaFast,
    emaSlow,
    bullish,
    bearish,
    crossUp,
    crossDown,
    spread
  };
}
