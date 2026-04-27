/**
 * analysis.js — Módulo de análise de acurácia dos indicadores.
 * Reutilizável tanto pelo script CLI quanto pelo servidor web.
 */
import fs from "node:fs";

// ── Parse CSV ──
function parseCsv(raw) {
  const lines = raw.trim().split("\n").map(l => l.replace(/\r$/, ""));
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map(line => {
    const values = line.split(",");
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] ?? ""; });
    return obj;
  });
}

function determineOutcome(row) {
  const chainlink = parseFloat(row.chainlink_price);
  const priceToBeat = parseFloat(row.price_to_beat);
  if (isNaN(chainlink) || isNaN(priceToBeat)) return null;
  return chainlink >= priceToBeat ? "UP" : "DOWN";
}

// ── Indicator signal extractors ──
const indicators = {
  "Delta 3m": (row) => {
    const d = parseFloat(row.delta_3m_usd);
    return isNaN(d) ? null : d > 0 ? "UP" : "DOWN";
  },
  "Heiken Ashi": (row) => {
    const c = (row.heiken_color || "").toLowerCase();
    return c === "green" ? "UP" : c === "red" ? "DOWN" : null;
  },
  "OBV Slope": (row) => {
    const s = parseFloat(row.obv_slope);
    return isNaN(s) ? null : s > 0 ? "UP" : "DOWN";
  },
  "TA Predict": (row) => {
    const l = parseFloat(row.ta_predict_long_pct);
    const s = parseFloat(row.ta_predict_short_pct);
    return (isNaN(l) || isNaN(s)) ? null : l > s ? "UP" : "DOWN";
  },
  "RSI Direction": (row) => {
    const r = parseFloat(row.rsi);
    return isNaN(r) ? null : r > 50 ? "UP" : "DOWN";
  },
  "RSI Slope": (row) => {
    const s = parseFloat(row.rsi_slope);
    return isNaN(s) ? null : s > 0 ? "UP" : "DOWN";
  },
  "MACD": (row) => {
    const l = (row.macd_label || "").toLowerCase();
    return l.includes("bullish") ? "UP" : l.includes("bearish") ? "DOWN" : null;
  },
  "MACD Histogram": (row) => {
    const h = parseFloat(row.macd_hist);
    return isNaN(h) ? null : h > 0 ? "UP" : "DOWN";
  },
  "Delta 1m": (row) => {
    const d = parseFloat(row.delta_1m_usd);
    return isNaN(d) ? null : d > 0 ? "UP" : "DOWN";
  },
  "VWAP Position": (row) => {
    const d = parseFloat(row.vwap_distance_pct);
    return isNaN(d) ? null : d > 0 ? "UP" : "DOWN";
  },
  "VWAP Slope": (row) => {
    const s = (row.vwap_slope_label || "").toUpperCase();
    return s === "UP" ? "UP" : s === "DOWN" ? "DOWN" : null;
  },
  "Bollinger %B": (row) => {
    const p = parseFloat(row.bollinger_pctB);
    return isNaN(p) ? null : p > 0.5 ? "UP" : "DOWN";
  },
  "Stoch RSI": (row) => {
    const k = parseFloat(row.stoch_rsi_k);
    return isNaN(k) ? null : k > 50 ? "UP" : "DOWN";
  },
  "EMA 9/21": (row) => {
    const l = (row.ema_cross_label || "").toLowerCase();
    if (l.includes("bullish") || l.includes("cross ↑")) return "UP";
    if (l.includes("bearish") || l.includes("cross ↓")) return "DOWN";
    return null;
  },
  "Binance vs Oracle": (row) => {
    const d = parseFloat(row.binance_vs_oracle_usd);
    return isNaN(d) ? null : d > 0 ? "UP" : "DOWN";
  },
  // ── Combos ──
  "COMBO: Full Consensus": (row) => {
    const r = parseFloat(row.rsi);
    const macd = (row.macd_label || "").toLowerCase();
    const c = (row.heiken_color || "").toLowerCase();
    const obv = parseFloat(row.obv_slope);
    if (isNaN(r) || isNaN(obv)) return null;
    if (r < 45 && macd.includes("bearish") && c === "red" && obv < 0) return "DOWN";
    if (r > 55 && macd.includes("bullish") && c === "green" && obv > 0) return "UP";
    return null;
  },
  "COMBO: Heiken + OBV": (row) => {
    const c = (row.heiken_color || "").toLowerCase();
    const obv = parseFloat(row.obv_slope);
    if (isNaN(obv)) return null;
    if (c === "green" && obv > 0) return "UP";
    if (c === "red" && obv < 0) return "DOWN";
    return null;
  },
  "COMBO: 5+ Agree": (row) => {
    let up = 0, down = 0;
    const sigs = ["Heiken Ashi", "RSI Direction", "MACD", "EMA 9/21", "OBV Slope", "VWAP Position", "Delta 1m"];
    for (const key of sigs) {
      const s = indicators[key]?.(row);
      if (s === "UP") up++;
      if (s === "DOWN") down++;
    }
    if (up >= 5) return "UP";
    if (down >= 5) return "DOWN";
    return null;
  }
};

/**
 * Runs the analysis on a CSV file path or raw CSV string.
 * @param {string} source — file path or raw CSV content
 * @param {object} [previousResults] — previous analysis result for change tracking
 * @param {number|null} [windowMinutes] — filter by window_min column (5 or 15). If null, accepts all.
 * @returns {object} analysis result
 */
export function runAnalysis(source, previousResults = null, windowMinutes = null) {
  let raw;
  if (source.includes(",") && source.includes("\n")) {
    raw = source;
  } else {
    if (!fs.existsSync(source)) return { error: "no_data", totalSnapshots: 0, indicators: [], candles: [] };
    raw = fs.readFileSync(source, "utf8");
  }

  const rows = parseCsv(raw);

  // Filter by windowMinutes if specified
  const filtered = windowMinutes !== null
    ? rows.filter(r => String(r.window_min).trim() === String(windowMinutes))
    : rows;

  const enriched = filtered.map(r => ({ ...r, outcome: determineOutcome(r) })).filter(r => r.outcome !== null);

  if (enriched.length === 0) return { error: "no_data", totalSnapshots: 0, indicators: [], candles: [] };

  const upCount = enriched.filter(r => r.outcome === "UP").length;
  const downCount = enriched.filter(r => r.outcome === "DOWN").length;

  // Score each indicator
  const results = [];
  const prevMap = {};
  if (previousResults?.indicators) {
    for (const ind of previousResults.indicators) prevMap[ind.name] = ind.accuracy;
  }

  for (const [name, fn] of Object.entries(indicators)) {
    let correct = 0, wrong = 0;
    for (const row of enriched) {
      const pred = fn(row);
      if (pred === null) continue;
      if (pred === row.outcome) correct++;
      else wrong++;
    }
    const total = correct + wrong;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;
    const coverage = enriched.length > 0 ? (total / enriched.length) * 100 : 0;
    const prevAccuracy = prevMap[name] ?? null;
    const change = prevAccuracy !== null ? accuracy - prevAccuracy : null;

    results.push({ name, correct, wrong, total, accuracy, coverage, prevAccuracy, change });
  }

  results.sort((a, b) => b.accuracy !== a.accuracy ? b.accuracy - a.accuracy : b.coverage - a.coverage);

  // Last N candles with consensus + model predictions
  const candles = enriched.slice(-36).map(row => {
    let up = 0, down = 0;
    for (const [name, fn] of Object.entries(indicators)) {
      if (name.startsWith("COMBO")) continue;
      const s = fn(row);
      if (s === "UP") up++;
      if (s === "DOWN") down++;
    }
    const consensus = up > down ? "UP" : "DOWN";

    // Individual model predictions for card display
    const fullConsensus = indicators["COMBO: Full Consensus"]?.(row) ?? null;
    const heikenObv = indicators["COMBO: Heiken + OBV"]?.(row) ?? null;
    const fivePlus = indicators["COMBO: 5+ Agree"]?.(row) ?? null;
    const taPredict = indicators["TA Predict"]?.(row) ?? null;

    return {
      slug: row.market_slug || "?",
      outcome: row.outcome,
      consensus,
      hit: consensus === row.outcome,
      upSignals: up,
      downSignals: down,
      models: {
        fullConsensus: { pred: fullConsensus, hit: fullConsensus !== null ? fullConsensus === row.outcome : null },
        heikenObv:     { pred: heikenObv,     hit: heikenObv !== null ? heikenObv === row.outcome : null },
        fivePlus:      { pred: fivePlus,       hit: fivePlus !== null ? fivePlus === row.outcome : null },
        taPredict:     { pred: taPredict,      hit: taPredict !== null ? taPredict === row.outcome : null }
      }
    };
  });

  // Changes since last analysis
  const changes = results
    .filter(r => r.change !== null && Math.abs(r.change) >= 1)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, 8)
    .map(r => ({ name: r.name, from: r.prevAccuracy, to: r.accuracy, direction: r.change > 0 ? "up" : "down" }));

  return {
    totalSnapshots: enriched.length,
    upCount,
    downCount,
    indicators: results,
    candles,
    changes
  };
}
