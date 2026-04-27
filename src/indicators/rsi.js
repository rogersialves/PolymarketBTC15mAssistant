import { clamp } from "../utils.js";

/**
 * Computes the full RSI series using Wilder's smoothing (EMA) method.
 * Matches the RSI shown on TradingView and Binance charts.
 * The first `period` values in the result are null (insufficient data).
 */
export function computeRsiSeries(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 1) return [];

  const result = new Array(period).fill(null);

  // Build all price changes
  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);

  // Seed: simple average of the first `period` changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const d = changes[i];
    if (d > 0) avgGain += d;
    else avgLoss += -d;
  }
  avgGain /= period;
  avgLoss /= period;
  result.push(avgLoss === 0 ? 100 : clamp(100 - 100 / (1 + avgGain / avgLoss), 0, 100));

  // Wilder's EMA smoothing for subsequent changes
  for (let i = period; i < changes.length; i++) {
    const d = changes[i];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    result.push(avgLoss === 0 ? 100 : clamp(100 - 100 / (1 + avgGain / avgLoss), 0, 100));
  }

  return result;
}

/**
 * Returns the latest RSI value using Wilder's smoothing method.
 */
export function computeRsi(closes, period) {
  const series = computeRsiSeries(closes, period);
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return series[i];
  }
  return null;
}

export function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(values.length - period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

export function slopeLast(values, points) {
  if (!Array.isArray(values) || values.length < points) return null;
  const slice = values.slice(values.length - points);
  const first = slice[0];
  const last = slice[slice.length - 1];
  return (last - first) / (points - 1);
}
