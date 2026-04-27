import { clamp } from "../utils.js";
import { computeRsiSeries } from "./rsi.js";

/**
 * Stochastic RSI — applies Stochastic oscillator to RSI values.
 * More responsive than standard RSI for short timeframe overbought/oversold detection.
 * Uses Wilder's RSI (same as TradingView/Binance).
 *
 * Returns { k, d, overbought, oversold, crossUp, crossDown }
 * - k: fast %K line (0-100)
 * - d: slow %D line (smoothed %K)
 * - overbought: k > 80
 * - oversold: k < 20
 * - crossUp: %K crosses above %D (bullish signal)
 * - crossDown: %K crosses below %D (bearish signal)
 */

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

function smaArray(values, period) {
  const result = [];
  for (let i = 0; i < values.length; i += 1) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }
    const slice = values.slice(i - period + 1, i + 1);
    result.push(slice.reduce((sum, v) => sum + v, 0) / period);
  }
  return result;
}

export function computeStochasticRsi(closePrices, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  if (!Array.isArray(closePrices) || closePrices.length < rsiPeriod + stochPeriod + kSmooth + dSmooth) return null;

  const rsiSeries = computeRsiSeries(closePrices, rsiPeriod).filter(v => v !== null);
  if (rsiSeries.length < stochPeriod) return null;

  // Compute raw Stochastic of RSI
  const rawK = [];
  for (let i = stochPeriod - 1; i < rsiSeries.length; i += 1) {
    const window = rsiSeries.slice(i - stochPeriod + 1, i + 1);
    const minRsi = Math.min(...window);
    const maxRsi = Math.max(...window);
    const range = maxRsi - minRsi;
    rawK.push(range === 0 ? 50 : ((rsiSeries[i] - minRsi) / range) * 100);
  }

  // Smooth %K
  const kSeries = smaArray(rawK, kSmooth);
  const validK = kSeries.filter((v) => v !== null);
  if (validK.length < dSmooth) return null;

  // Smooth %D
  const dSeries = smaArray(validK, dSmooth);
  const validD = dSeries.filter((v) => v !== null);
  if (validD.length < 2) return null;

  const k = validK[validK.length - 1];
  const d = validD[validD.length - 1];
  const prevK = validK.length >= 2 ? validK[validK.length - 2] : null;
  const prevD = validD.length >= 2 ? validD[validD.length - 2] : null;

  const crossUp = prevK !== null && prevD !== null && prevK <= prevD && k > d;
  const crossDown = prevK !== null && prevD !== null && prevK >= prevD && k < d;

  return {
    k: clamp(k, 0, 100),
    d: clamp(d, 0, 100),
    overbought: k > 80,
    oversold: k < 20,
    crossUp,
    crossDown
  };
}
