/**
 * Monta as chaves string de direção (UP/DOWN) usadas pelo Scalp Force e pela
 * simulação legada — mesma regra que `src/server.js` aplicava ao `simSignals`.
 *
 * @param {object} p
 * @param {{ adjustedUp?: number|null, adjustedDown?: number|null }} [p.timeAdjustedProb]
 * @param {{ color?: string }} [p.heikenAshiStreak]
 * @param {string} p.macdLabel
 * @param {number|null} p.delta3m
 * @param {{ percentB?: number|null }} [p.bollingerResult]
 * @param {{ slope?: number|null }} [p.obvResult]
 * @param {number|null} p.currentRsi
 * @param {string} p.emaCrossLabel
 * @param {number|null} p.vwapDistance
 * @returns {Record<string, "UP"|"DOWN">}
 */
export function buildSimSignalDirectionStrings({
  timeAdjustedProb,
  heikenAshiStreak,
  macdLabel,
  delta3m,
  bollingerResult,
  obvResult,
  currentRsi,
  emaCrossLabel,
  vwapDistance
}) {
  const out = {};
  const macd = String(macdLabel || "");
  const ema = String(emaCrossLabel || "");

  if (timeAdjustedProb?.adjustedUp != null && timeAdjustedProb?.adjustedDown != null) {
    out["TA Predict"] = timeAdjustedProb.adjustedUp > timeAdjustedProb.adjustedDown ? "UP" : "DOWN";
  }
  if (heikenAshiStreak?.color === "green") out["Heiken Ashi"] = "UP";
  else if (heikenAshiStreak?.color === "red") out["Heiken Ashi"] = "DOWN";

  if (macd.includes("bullish")) out["MACD"] = "UP";
  else if (macd.includes("bearish")) out["MACD"] = "DOWN";

  if (delta3m !== null && delta3m !== undefined && delta3m !== 0) {
    out["Delta 3m"] = delta3m > 0 ? "UP" : "DOWN";
  }

  if (bollingerResult?.percentB != null && Number.isFinite(Number(bollingerResult.percentB))) {
    out["Bollinger"] = bollingerResult.percentB > 0.5 ? "UP" : "DOWN";
  }

  if (obvResult?.slope != null && obvResult.slope !== 0) {
    out["OBV"] = obvResult.slope > 0 ? "UP" : "DOWN";
  }

  if (
    currentRsi != null && Number.isFinite(currentRsi) &&
    macd.includes("bullish") && heikenAshiStreak?.color === "green" && obvResult?.slope > 0
  ) {
    out["Full Consensus"] = "UP";
  } else if (
    currentRsi != null && Number.isFinite(currentRsi) &&
    macd.includes("bearish") && heikenAshiStreak?.color === "red" && obvResult?.slope < 0
  ) {
    out["Full Consensus"] = "DOWN";
  }

  if (heikenAshiStreak?.color === "green" && obvResult?.slope > 0) {
    out["Heiken+OBV"] = "UP";
  } else if (heikenAshiStreak?.color === "red" && obvResult?.slope < 0) {
    out["Heiken+OBV"] = "DOWN";
  }

  const baseForCount = {
    "Heiken Ashi": out["Heiken Ashi"],
    "RSI": currentRsi != null && Number.isFinite(currentRsi)
      ? (currentRsi > 50 ? "UP" : currentRsi < 50 ? "DOWN" : null)
      : null,
    "MACD": out["MACD"],
    "EMA": ema.includes("bullish") || ema.includes("CROSS ↑")
      ? "UP"
      : ema.includes("bearish") || ema.includes("CROSS ↓")
        ? "DOWN"
        : null,
    "OBV": out["OBV"],
    "VWAP": vwapDistance != null && Number.isFinite(vwapDistance)
      ? (vwapDistance > 0 ? "UP" : vwapDistance < 0 ? "DOWN" : null)
      : null,
    "Delta": out["Delta 3m"]
  };
  let sUp = 0;
  let sDn = 0;
  for (const v of Object.values(baseForCount)) {
    if (v === "UP") sUp++;
    if (v === "DOWN") sDn++;
  }
  if (sUp >= 5) out["5+ Agree"] = "UP";
  else if (sDn >= 5) out["5+ Agree"] = "DOWN";

  return out;
}
