/**
 * backtest_consensus_edge.js
 * Analisa os logs históricos para determinar quantas vezes o Consensus Edge teria sido ativado.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_DIR = path.join(__dirname, "..", "logs");

function parseCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map(line => {
    const vals = line.split(",");
    const row = {};
    headers.forEach((h, i) => row[h.trim()] = vals[i]?.trim());
    return row;
  });
}

const trades5m = parseCsv(path.join(LOGS_DIR, "sim_trades_5m.csv"));
const trades15m = parseCsv(path.join(LOGS_DIR, "sim_trades_15m.csv"));
const allTrades = [...trades5m, ...trades15m];

console.log(`\n${"═".repeat(80)}`);
console.log(`  ⚡ BACKTEST — CONSENSUS EDGE — Análise Histórica de Ativação`);
console.log(`${"═".repeat(80)}\n`);
console.log(`  Total de trades nos logs: ${allTrades.length} (5m: ${trades5m.length} | 15m: ${trades15m.length})\n`);

// The 9 core indicators used by Consensus Edge
const CORE_INDICATORS = [
  "TA Predict", "Heiken Ashi", "MACD", "Delta 3m", "Bollinger",
  "OBV", "Heiken+OBV", "Full Consensus", "5+ Agree"
];

// Group trades by candle (market_slug)
const candleMap = {};
for (const t of allTrades) {
  const key = t.market_slug;
  if (!candleMap[key]) candleMap[key] = [];
  candleMap[key].push(t);
}

const totalCandles = Object.keys(candleMap).length;
let ceActivated = 0;      // Would have activated (all criteria met)
let ceWouldWin = 0;
let ceWouldLose = 0;
let cePnl = 0;
let failReasons = { concordance: 0, price: 0, noSignal: 0 };
let concordanceDistribution = {};
let priceWhenConcordanceMet = { inZone: 0, tooHigh: 0, tooLow: 0 };
let activationDetails = [];

for (const [slug, trades] of Object.entries(candleMap)) {
  const outcome = trades[0].outcome;
  
  // Count core indicator votes
  let upVotes = 0, downVotes = 0;
  let corePresent = 0;
  const coreSignals = {};
  
  for (const t of trades) {
    if (CORE_INDICATORS.includes(t.indicator)) {
      corePresent++;
      coreSignals[t.indicator] = t.side;
      if (t.side === "UP") upVotes++;
      else if (t.side === "DOWN") downVotes++;
    }
  }
  
  const totalVotes = upVotes + downVotes;
  const majority = Math.max(upVotes, downVotes);
  const majoritySide = upVotes > downVotes ? "UP" : "DOWN";
  
  // Track concordance distribution
  const concordanceKey = `${majority}/${totalVotes}`;
  if (!concordanceDistribution[majority]) concordanceDistribution[majority] = { total: 0, wins: 0 };
  concordanceDistribution[majority].total++;
  if (majoritySide === outcome) concordanceDistribution[majority].wins++;
  
  // Check CE criteria
  if (totalVotes < 7) {
    failReasons.concordance++;
    continue;
  }
  
  if (majority < 7) {
    failReasons.concordance++;
    continue;
  }
  
  // Concordance >= 7: Now check price
  // Get the entry price for the majority side
  const sidePrice = trades.find(t => t.side === majoritySide)?.entry_price;
  const price = parseFloat(sidePrice) || 0;
  
  if (price < 0.60) {
    failReasons.price++;
    priceWhenConcordanceMet.tooLow++;
    continue;
  }
  if (price > 0.85) {
    failReasons.price++;
    priceWhenConcordanceMet.tooHigh++;
    continue;
  }
  
  priceWhenConcordanceMet.inZone++;
  
  // CE would have activated!
  ceActivated++;
  const won = majoritySide === outcome;
  if (won) ceWouldWin++; else ceWouldLose++;
  
  // Simulate P&L with $1 base stake
  const pnl = won ? (1 / price - 1) : -1;
  cePnl += pnl;
  
  activationDetails.push({
    slug: slug.replace(/.*-(\d+)$/, "#$1"),
    side: majoritySide,
    price: price.toFixed(2),
    outcome,
    won,
    pnl: pnl.toFixed(4),
    concordance: `${majority}/${totalVotes}`,
    window: trades[0].window_min
  });
}

// Results
console.log(`  📊 RESUMO DE ATIVAÇÃO:`);
console.log(`  ${"─".repeat(60)}`);
console.log(`  Total de candles analisados: ${totalCandles}`);
console.log(`  CE teria ativado:            ${ceActivated} vezes (${(ceActivated/totalCandles*100).toFixed(1)}% dos candles)`);
console.log(`  Wins esperados:              ${ceWouldWin}`);
console.log(`  Losses esperados:            ${ceWouldLose}`);
console.log(`  WinRate:                     ${ceActivated > 0 ? (ceWouldWin/ceActivated*100).toFixed(1) : "N/A"}%`);
console.log(`  P&L estimado ($1/trade):     $${cePnl.toFixed(2)}`);
console.log();

console.log(`  ❌ RAZÕES DE NÃO-ATIVAÇÃO:`);
console.log(`  ${"─".repeat(60)}`);
console.log(`  Concordância < 7 indicadores: ${failReasons.concordance} candles (${(failReasons.concordance/totalCandles*100).toFixed(1)}%)`);
console.log(`  Preço fora da zona 0.60-0.85: ${failReasons.price} candles (${(failReasons.price/totalCandles*100).toFixed(1)}%)`);
console.log(`    ↳ Preço muito baixo (< 0.60): ${priceWhenConcordanceMet.tooLow}`);
console.log(`    ↳ Preço muito alto (> 0.85):   ${priceWhenConcordanceMet.tooHigh}`);
console.log(`    ↳ Na zona ideal (ativou):       ${priceWhenConcordanceMet.inZone}`);
console.log();

console.log(`  📈 DISTRIBUIÇÃO DE CONCORDÂNCIA:`);
console.log(`  ${"─".repeat(60)}`);
console.log(`  ${"Concordância".padEnd(16)} ${"Candles".padStart(8)} ${"WR".padStart(8)}`);
for (const count of Object.keys(concordanceDistribution).sort((a, b) => Number(a) - Number(b))) {
  const d = concordanceDistribution[count];
  const wr = d.total > 0 ? (d.wins / d.total * 100).toFixed(1) : "N/A";
  const emoji = parseFloat(wr) >= 70 ? "🟢" : parseFloat(wr) >= 50 ? "🟡" : "🔴";
  console.log(`  ${emoji} ${(count + " concordam").padEnd(16)} ${String(d.total).padStart(8)} ${(wr + "%").padStart(8)}`);
}

console.log();
console.log(`  📋 ÚLTIMAS 20 ATIVAÇÕES DO CONSENSUS EDGE:`);
console.log(`  ${"─".repeat(70)}`);
console.log(`  ${"Candle".padEnd(12)} ${"Window".padStart(6)} ${"Side".padStart(5)} ${"Preço".padStart(6)} ${"Concord".padStart(8)} ${"Result".padStart(7)} ${"P&L".padStart(8)}`);
const recent = activationDetails.slice(-20);
for (const a of recent) {
  const emoji = a.won ? "✅" : "❌";
  console.log(`  ${emoji} ${a.slug.padEnd(10)} ${(a.window + "m").padStart(6)} ${a.side.padStart(5)} ${a.price.padStart(6)} ${a.concordance.padStart(8)} ${a.outcome.padStart(7)} ${("$" + a.pnl).padStart(8)}`);
}

// Dynamic stake simulation
console.log(`\n\n${"═".repeat(80)}`);
console.log(`  💰 SIMULAÇÃO COM STAKE DINÂMICO ($1 + 20% do lucro)`);
console.log(`${"═".repeat(80)}\n`);

let dynamicBalance = 0;
let dynamicInvested = 0;
let maxStake = 1;
for (const a of activationDetails) {
  const stake = 1 + Math.max(0, dynamicBalance * 0.20);
  if (stake > maxStake) maxStake = stake;
  dynamicInvested += stake;
  const price = parseFloat(a.price);
  const pnl = a.won ? (stake / price - stake) : -stake;
  dynamicBalance += pnl;
}

console.log(`  Total invested:    $${dynamicInvested.toFixed(2)}`);
console.log(`  Final balance:     $${dynamicBalance.toFixed(2)}`);
console.log(`  Max stake atingido: $${maxStake.toFixed(2)}`);
console.log(`  ROI:               ${dynamicInvested > 0 ? (dynamicBalance/dynamicInvested*100).toFixed(1) : 0}%`);
console.log(`\n${"═".repeat(80)}\n`);
