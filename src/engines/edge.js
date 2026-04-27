import { clamp } from "../utils.js";

/**
 * Computes the edge (difference) between the model's predicted
 * probabilities and the Polymarket prices for UP and DOWN.
 */
export function computeEdge({ modelUp, modelDown, marketYes, marketNo }) {
  if (marketYes === null || marketNo === null) {
    return { marketUp: null, marketDown: null, edgeUp: null, edgeDown: null };
  }

  const priceSum = marketYes + marketNo;
  const marketUp = priceSum > 0 ? marketYes / priceSum : null;
  const marketDown = priceSum > 0 ? marketNo / priceSum : null;

  const edgeUp = marketUp === null ? null : modelUp - marketUp;
  const edgeDown = marketDown === null ? null : modelDown - marketDown;

  return {
    marketUp: marketUp === null ? null : clamp(marketUp, 0, 1),
    marketDown: marketDown === null ? null : clamp(marketDown, 0, 1),
    edgeUp,
    edgeDown
  };
}

/**
 * Decides whether to enter a trade based on the current phase,
 * edge, and model probability. Phase thresholds come from CONFIG.phases.
 *
 * @param {object} params
 * @param {number} params.remainingMinutes - Minutes left in the window
 * @param {number|null} params.edgeUp - Edge for UP side
 * @param {number|null} params.edgeDown - Edge for DOWN side
 * @param {number|null} params.modelUp - Model probability for UP
 * @param {number|null} params.modelDown - Model probability for DOWN
 * @param {object} params.phases - { earlyAbove, midAbove } from CONFIG
 */
export function decide({ remainingMinutes, edgeUp, edgeDown, modelUp = null, modelDown = null, phases = { earlyAbove: 3.3, midAbove: 1.5 } }) {
  const phase = remainingMinutes > phases.earlyAbove
    ? "EARLY"
    : remainingMinutes > phases.midAbove
      ? "MID"
      : "LATE";

  const edgeThreshold = phase === "EARLY" ? 0.05 : phase === "MID" ? 0.1 : 0.2;
  const minProbability = phase === "EARLY" ? 0.55 : phase === "MID" ? 0.6 : 0.65;

  if (edgeUp === null || edgeDown === null) {
    return { action: "NO_TRADE", side: null, phase, reason: "missing_market_data" };
  }

  const strongestSide = edgeUp > edgeDown ? "UP" : "DOWN";
  const strongestEdge = strongestSide === "UP" ? edgeUp : edgeDown;
  const strongestModelProb = strongestSide === "UP" ? modelUp : modelDown;

  if (strongestEdge < edgeThreshold) {
    return { action: "NO_TRADE", side: null, phase, reason: `edge_below_${edgeThreshold}` };
  }

  if (strongestModelProb !== null && strongestModelProb < minProbability) {
    return { action: "NO_TRADE", side: null, phase, reason: `prob_below_${minProbability}` };
  }

  const strength = strongestEdge >= 0.2 ? "STRONG" : strongestEdge >= 0.1 ? "GOOD" : "OPTIONAL";
  return { action: "ENTER", side: strongestSide, phase, strength, edge: strongestEdge };
}
