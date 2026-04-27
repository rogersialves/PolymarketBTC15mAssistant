/**
 * analyze_snapshots.js
 * 
 * Analisa os snapshots de fechamento para determinar quais indicadores
 * preveem com maior acurácia se o candle vai fechar UP ou DOWN.
 * 
 * Uso: node scripts/analyze_snapshots.js
 * 
 * Precisa de dados acumulados em ./logs/snapshots.csv
 */

import fs from "node:fs";
import path from "node:path";

// ── Parse CSV ──
function parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  const lines = raw.split("\n").map(l => l.replace(/\r$/, ""));
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map(line => {
    const values = line.split(",");
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] ?? ""; });
    return obj;
  });
}

// ── Determine outcome: UP or DOWN ──
function determineOutcome(row) {
  const chainlink = parseFloat(row.chainlink_price);
  const priceToBeat = parseFloat(row.price_to_beat);
  if (isNaN(chainlink) || isNaN(priceToBeat)) return null;
  return chainlink >= priceToBeat ? "UP" : "DOWN";
}

// ── Indicator signal extractors ──
const indicators = {
  "TA Predict": (row) => {
    const long = parseFloat(row.ta_predict_long_pct);
    const short = parseFloat(row.ta_predict_short_pct);
    if (isNaN(long) || isNaN(short)) return null;
    return long > short ? "UP" : "DOWN";
  },
  "Heiken Ashi": (row) => {
    const color = (row.heiken_color || "").toLowerCase();
    if (color === "green") return "UP";
    if (color === "red") return "DOWN";
    return null;
  },
  "RSI Direction": (row) => {
    const rsi = parseFloat(row.rsi);
    if (isNaN(rsi)) return null;
    // RSI > 50 = bullish, < 50 = bearish
    return rsi > 50 ? "UP" : "DOWN";
  },
  "RSI Slope": (row) => {
    const slope = parseFloat(row.rsi_slope);
    if (isNaN(slope)) return null;
    return slope > 0 ? "UP" : "DOWN";
  },
  "MACD": (row) => {
    const label = (row.macd_label || "").toLowerCase();
    if (label.includes("bullish")) return "UP";
    if (label.includes("bearish")) return "DOWN";
    return null;
  },
  "MACD Histogram": (row) => {
    const hist = parseFloat(row.macd_hist);
    if (isNaN(hist)) return null;
    return hist > 0 ? "UP" : "DOWN";
  },
  "Delta 1m": (row) => {
    const d = parseFloat(row.delta_1m_usd);
    if (isNaN(d)) return null;
    return d > 0 ? "UP" : "DOWN";
  },
  "Delta 3m": (row) => {
    const d = parseFloat(row.delta_3m_usd);
    if (isNaN(d)) return null;
    return d > 0 ? "UP" : "DOWN";
  },
  "VWAP Position": (row) => {
    const dist = parseFloat(row.vwap_distance_pct);
    if (isNaN(dist)) return null;
    return dist > 0 ? "UP" : "DOWN";
  },
  "VWAP Slope": (row) => {
    const slope = (row.vwap_slope_label || "").toUpperCase();
    if (slope === "UP") return "UP";
    if (slope === "DOWN") return "DOWN";
    return null;
  },
  "Bollinger %B": (row) => {
    const pctB = parseFloat(row.bollinger_pctB);
    if (isNaN(pctB)) return null;
    // %B > 0.5 = upper half = bullish momentum, < 0.5 = bearish
    return pctB > 0.5 ? "UP" : "DOWN";
  },
  "Stoch RSI": (row) => {
    const k = parseFloat(row.stoch_rsi_k);
    if (isNaN(k)) return null;
    // K > 50 = bullish momentum, < 50 = bearish
    return k > 50 ? "UP" : "DOWN";
  },
  "EMA 9/21": (row) => {
    const label = (row.ema_cross_label || "").toLowerCase();
    if (label.includes("bullish") || label.includes("cross")) {
      // For cross, check spread direction
      if (label.includes("cross")) {
        return label.includes("↑") ? "UP" : "DOWN";
      }
      return "UP";
    }
    if (label.includes("bearish")) return "DOWN";
    return null;
  },
  "OBV Slope": (row) => {
    const slope = parseFloat(row.obv_slope);
    if (isNaN(slope)) return null;
    return slope > 0 ? "UP" : "DOWN";
  },
  "OBV Divergence": (row) => {
    const div = (row.obv_divergence || "").toLowerCase();
    if (div === "confirming") return null; // neutral - follows price
    if (div === "bullish_div") return "UP";
    if (div === "bearish_div") return "DOWN";
    return null;
  },
  "Binance vs Oracle": (row) => {
    const diff = parseFloat(row.binance_vs_oracle_usd);
    if (isNaN(diff)) return null;
    // Binance leads: if Binance > Oracle, price likely going up
    return diff > 0 ? "UP" : "DOWN";
  },
  // ── Composite signals ──
  "COMBO: RSI<40 + MACD bear + EMA bear": (row) => {
    const rsi = parseFloat(row.rsi);
    const macd = (row.macd_label || "").toLowerCase();
    const ema = (row.ema_cross_label || "").toLowerCase();
    if (isNaN(rsi)) return null;
    if (rsi < 40 && macd.includes("bearish") && ema.includes("bearish")) return "DOWN";
    if (rsi > 60 && macd.includes("bullish") && ema.includes("bullish")) return "UP";
    return null;
  },
  "COMBO: Heiken + OBV confirm": (row) => {
    const color = (row.heiken_color || "").toLowerCase();
    const obvSlope = parseFloat(row.obv_slope);
    if (isNaN(obvSlope)) return null;
    if (color === "green" && obvSlope > 0) return "UP";
    if (color === "red" && obvSlope < 0) return "DOWN";
    return null;
  },
  "COMBO: Full Bear (RSI<45 + MACD bear + Heiken red + OBV↓)": (row) => {
    const rsi = parseFloat(row.rsi);
    const macd = (row.macd_label || "").toLowerCase();
    const color = (row.heiken_color || "").toLowerCase();
    const obvSlope = parseFloat(row.obv_slope);
    if (isNaN(rsi) || isNaN(obvSlope)) return null;
    if (rsi < 45 && macd.includes("bearish") && color === "red" && obvSlope < 0) return "DOWN";
    if (rsi > 55 && macd.includes("bullish") && color === "green" && obvSlope > 0) return "UP";
    return null;
  },
  "COMBO: Momentum Consensus (5+ indicators agree)": (row) => {
    let up = 0, down = 0;
    const signals = [
      indicators["Heiken Ashi"](row),
      indicators["RSI Direction"](row),
      indicators["MACD"](row),
      indicators["EMA 9/21"](row),
      indicators["OBV Slope"](row),
      indicators["VWAP Position"](row),
      indicators["Delta 1m"](row)
    ];
    for (const s of signals) {
      if (s === "UP") up++;
      if (s === "DOWN") down++;
    }
    if (up >= 5) return "UP";
    if (down >= 5) return "DOWN";
    return null;
  }
};

// ── Main analysis ──
const csvPath = path.resolve("./logs/snapshots.csv");
if (!fs.existsSync(csvPath)) {
  console.log("❌ Arquivo ./logs/snapshots.csv não encontrado.");
  console.log("   Deixe o bot rodando para acumular dados de fechamento.");
  process.exit(1);
}

const rows = parseCsv(csvPath);
console.log(`\n📊 Análise de Previsão de Fechamento de Candle`);
console.log(`${"═".repeat(70)}`);
console.log(`   Snapshots analisados: ${rows.length}`);

// Enrich with outcome
const enriched = rows.map(r => ({ ...r, outcome: determineOutcome(r) })).filter(r => r.outcome !== null);
const upCount = enriched.filter(r => r.outcome === "UP").length;
const downCount = enriched.filter(r => r.outcome === "DOWN").length;

console.log(`   Candles UP:   ${upCount} (${((upCount / enriched.length) * 100).toFixed(1)}%)`);
console.log(`   Candles DOWN: ${downCount} (${((downCount / enriched.length) * 100).toFixed(1)}%)`);
console.log(`${"═".repeat(70)}\n`);

if (enriched.length < 3) {
  console.log("⚠️  Poucos dados para análise estatística confiável.");
  console.log("   Continue rodando o bot para acumular pelo menos 50+ snapshots.\n");
}

// ── Score each indicator ──
const results = [];

for (const [name, extractFn] of Object.entries(indicators)) {
  let correct = 0;
  let wrong = 0;
  let skipped = 0;
  const details = [];

  for (const row of enriched) {
    const prediction = extractFn(row);
    if (prediction === null) {
      skipped++;
      continue;
    }
    const hit = prediction === row.outcome;
    if (hit) correct++;
    else wrong++;
    details.push({
      slug: row.market_slug,
      prediction,
      outcome: row.outcome,
      hit
    });
  }

  const total = correct + wrong;
  const accuracy = total > 0 ? (correct / total) * 100 : 0;
  const coverage = enriched.length > 0 ? ((total) / enriched.length) * 100 : 0;

  results.push({ name, correct, wrong, skipped, total, accuracy, coverage, details });
}

// Sort by accuracy (descending), then by coverage
results.sort((a, b) => {
  if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
  return b.coverage - a.coverage;
});

// ── Print results table ──
console.log("┌─────────────────────────────────────────────────────┬────────┬─────────┬──────────┐");
console.log("│ Indicador                                           │ Acerto │ Cobert. │ Amostras │");
console.log("├─────────────────────────────────────────────────────┼────────┼─────────┼──────────┤");

for (const r of results) {
  const nameCol = r.name.padEnd(51);
  const accCol = `${r.accuracy.toFixed(1)}%`.padStart(6);
  const covCol = `${r.coverage.toFixed(0)}%`.padStart(7);
  const sampCol = `${r.total}`.padStart(8);
  
  const emoji = r.accuracy >= 70 ? "🟢" : r.accuracy >= 55 ? "🟡" : r.accuracy >= 45 ? "⚪" : "🔴";
  console.log(`│ ${emoji} ${nameCol}│ ${accCol} │ ${covCol} │ ${sampCol} │`);
}

console.log("└─────────────────────────────────────────────────────┴────────┴─────────┴──────────┘");

// ── Print detailed breakdown for top indicators ──
console.log(`\n${"═".repeat(70)}`);
console.log("📋 Detalhamento dos Top 5 Indicadores\n");

for (const r of results.slice(0, 5)) {
  console.log(`  ${r.name} (${r.accuracy.toFixed(1)}% accuracy, ${r.total} trades)`);
  for (const d of r.details) {
    const icon = d.hit ? "✅" : "❌";
    console.log(`    ${icon} ${d.slug.slice(-15)} → Predicted: ${d.prediction} | Actual: ${d.outcome}`);
  }
  console.log("");
}

// ── Correlation matrix (simplified) ──
console.log(`${"═".repeat(70)}`);
console.log("📈 Sinal Combinado por Candle\n");

for (const row of enriched) {
  const slug = row.market_slug || "?";
  const shortSlug = slug.slice(-18);
  const outcome = row.outcome;
  const signals = [];
  
  for (const [name, fn] of Object.entries(indicators)) {
    if (name.startsWith("COMBO")) continue;
    const sig = fn(row);
    if (sig !== null) signals.push({ name: name.slice(0, 12), sig });
  }
  
  const upSignals = signals.filter(s => s.sig === "UP").length;
  const downSignals = signals.filter(s => s.sig === "DOWN").length;
  const consensus = upSignals > downSignals ? "UP" : "DOWN";
  const consensusHit = consensus === outcome ? "✅" : "❌";
  
  console.log(`  ${shortSlug} | Result: ${outcome} | Consensus: ${consensus} ${consensusHit} | UP:${upSignals} DOWN:${downSignals}`);
  
  const wrongIndicators = signals.filter(s => s.sig !== outcome).map(s => s.name);
  if (wrongIndicators.length > 0 && wrongIndicators.length <= signals.length / 2) {
    console.log(`    ↳ Errados: ${wrongIndicators.join(", ")}`);
  }
}

console.log(`\n${"═".repeat(70)}`);
console.log("💡 Recomendação: Acumule 50+ snapshots para resultados estatisticamente confiáveis.");
console.log("   Execute este script periodicamente: node scripts/analyze_snapshots.js\n");
