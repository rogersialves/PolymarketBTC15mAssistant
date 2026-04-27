/**
 * Bollinger Bands (default: 20-period SMA, 2 standard deviations)
 *
 * Returns { upper, middle, lower, bandwidth, percentB }
 * - bandwidth: (upper - lower) / middle — measures volatility
 * - percentB: (price - lower) / (upper - lower) — 0 = at lower band, 1 = at upper band
 */

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(values.length - period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

function stdDev(values, period, mean) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(values.length - period);
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

export function computeBollingerBands(closePrices, period = 20, multiplier = 2) {
  if (!Array.isArray(closePrices) || closePrices.length < period) return null;

  const middle = sma(closePrices, period);
  if (middle === null) return null;

  const sd = stdDev(closePrices, period, middle);
  if (sd === null || sd === 0) return null;

  const upper = middle + multiplier * sd;
  const lower = middle - multiplier * sd;
  const bandwidth = (upper - lower) / middle;
  const currentPrice = closePrices[closePrices.length - 1];
  const percentB = (currentPrice - lower) / (upper - lower);

  return {
    upper,
    middle,
    lower,
    bandwidth,
    percentB,
    isSqueeze: bandwidth < 0.02
  };
}
