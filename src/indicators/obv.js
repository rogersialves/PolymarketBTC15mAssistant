/**
 * OBV (On-Balance Volume)
 *
 * Accumulates volume: adds on up-closes, subtracts on down-closes.
 * OBV rising with price = trend confirmation.
 * OBV diverging from price = early reversal warning.
 *
 * Returns { obv, slope, divergence }
 * - slope: direction of OBV over lookback period (positive = buying pressure)
 * - divergence: "bullish_div" | "bearish_div" | "confirming" | null
 */

export function computeObv(candles, slopeLookback = 5) {
  if (!Array.isArray(candles) || candles.length < slopeLookback + 1) return null;

  // Build OBV series
  const obvSeries = [0];
  for (let i = 1; i < candles.length; i += 1) {
    const prevClose = candles[i - 1].close;
    const currClose = candles[i].close;
    const volume = candles[i].volume ?? 0;

    if (currClose > prevClose) {
      obvSeries.push(obvSeries[obvSeries.length - 1] + volume);
    } else if (currClose < prevClose) {
      obvSeries.push(obvSeries[obvSeries.length - 1] - volume);
    } else {
      obvSeries.push(obvSeries[obvSeries.length - 1]);
    }
  }

  const currentObv = obvSeries[obvSeries.length - 1];

  // OBV slope over lookback
  const obvStart = obvSeries[obvSeries.length - slopeLookback];
  const obvEnd = currentObv;
  const obvSlope = (obvEnd - obvStart) / slopeLookback;

  // Price slope over same lookback
  const priceStart = candles[candles.length - slopeLookback].close;
  const priceEnd = candles[candles.length - 1].close;
  const priceSlope = priceEnd - priceStart;

  // Detect divergence
  let divergence = "confirming";
  if (priceSlope > 0 && obvSlope < 0) {
    divergence = "bearish_div"; // Price up, volume down — weak rally
  } else if (priceSlope < 0 && obvSlope > 0) {
    divergence = "bullish_div"; // Price down, volume up — accumulation
  }

  return {
    obv: currentObv,
    slope: obvSlope,
    divergence
  };
}
