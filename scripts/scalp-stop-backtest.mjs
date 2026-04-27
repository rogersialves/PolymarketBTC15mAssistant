/**
 * scalp-stop-backtest.mjs — Hypothetical Fib-stop analysis on closed scalp trades.
 *
 * Lê logs/scalp_trades_5m.csv + logs/scalp_trades_15m.csv, busca 1s klines da
 * Binance dentro de [entry_time, exit_time] e calcula:
 *
 *   - MAE (Max Adverse Excursion): quão longe o BTC spot foi CONTRA a posição
 *     antes do desfecho.
 *   - MFE (Max Favorable Excursion): quão longe foi A FAVOR.
 *   - Níveis Fib do swing recente (15m, lookback 12 candles).
 *   - Para cada nível (38.2/50/61.8/78.6%) responde: o BTC cruzou esse nível
 *     contra a posição durante o hold? Se sim, um stop ali teria fechado a
 *     posição antes do TP/timeout.
 *
 * Saída: tabela por trade + agregado por nível de stop.
 *
 * Uso: node scripts/scalp-stop-backtest.mjs
 *
 * Limitação honesta: a coluna `pnl_se_stop` assume que stoppar no nível Fib
 * fecharia a Polymarket position com perda total do effective_stake (worst
 * case). Sem ticks intra-hold do CONTRATO Polymarket, não dá pra modelar
 * preço de saída exato — só BTC spot está disponível para reconstruir.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_DIR = path.join(__dirname, "..", "logs");

const FIB_LEVELS = [0.382, 0.5, 0.618, 0.786];
const BINANCE_HOST = "https://api.binance.com";

// Range Fib agora é INTRA-CANDLE: a vela em formação no momento da entrada
// (ou a vela anterior se a corrente ainda não acumulou range suficiente).
// Reflete a escala real dos holds de 27-300s, não swings de 3h.
const MIN_RUNNING_RANGE_USD = 10;

function parseCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(",");
    const row = {};
    headers.forEach((h, i) => row[h] = vals[i]?.trim());
    return row;
  });
}

async function fetchKlinesRange({ interval, startMs, endMs, limit = 1000 }) {
  const url = new URL(`${BINANCE_HOST}/api/v3/klines`);
  url.searchParams.set("symbol", "BTCUSDT");
  url.searchParams.set("interval", interval);
  url.searchParams.set("startTime", String(startMs));
  url.searchParams.set("endTime", String(endMs));
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url, { headers: { "user-agent": "scalp-stop-backtest/1.0" } });
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json();
  return data.map(k => ({
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    closeTime: Number(k[6])
  }));
}

function buildIntraHoldSeries(klines1s) {
  const ticks = [];
  for (const k of klines1s) {
    ticks.push({ ms: k.openTime, price: k.open });
    ticks.push({ ms: k.openTime + 250, price: k.high });
    ticks.push({ ms: k.openTime + 500, price: k.low });
    ticks.push({ ms: k.openTime + 750, price: k.close });
  }
  return ticks;
}

function computeMaeMfe(ticks, entryPriceBtc, side) {
  let mae = 0;
  let mfe = 0;
  let maeAtMs = null;
  for (const t of ticks) {
    const move = side === "UP" ? t.price - entryPriceBtc : entryPriceBtc - t.price;
    if (move > mfe) mfe = move;
    if (-move > mae) {
      mae = -move;
      maeAtMs = t.ms;
    }
  }
  return { mae, mfe, maeAtMs };
}

function computeRangeFromKlines(klines) {
  if (!klines.length) return null;
  const high = Math.max(...klines.map(k => k.high));
  const low = Math.min(...klines.map(k => k.low));
  return { high, low, range: high - low };
}

function checkStopHit(ticks, entryPriceBtc, side, stopPriceBtc) {
  for (const t of ticks) {
    if (side === "UP" && t.price <= stopPriceBtc) return { hit: true, atMs: t.ms, atPrice: t.price };
    if (side === "DOWN" && t.price >= stopPriceBtc) return { hit: true, atMs: t.ms, atPrice: t.price };
  }
  return { hit: false };
}

function fmtUsd(n) { return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`; }
function fmtBtc(n) { return Number.isFinite(n) ? `$${n.toFixed(2)}` : "—"; }

async function analyzeTrade(t) {
  const entryMs = new Date(t.entry_time).getTime();
  const exitMs = new Date(t.exit_time).getTime();
  const entryBtc = Number(t.current_price_entry);
  const side = t.side;
  const pnlActual = Number(t.pnl_usd);
  const effectiveStake = Number(t.effective_stake_usd);

  // 1s ticks dentro do hold (pad de 5s antes/depois pra capturar boundaries)
  const klines1s = await fetchKlinesRange({
    interval: "1s",
    startMs: entryMs - 5000,
    endMs: exitMs + 5000,
    limit: 1000
  });
  const ticks = buildIntraHoldSeries(klines1s).filter(x => x.ms >= entryMs && x.ms <= exitMs);

  const { mae, mfe, maeAtMs } = computeMaeMfe(ticks, entryBtc, side);

  // ── Intra-candle Fib base ──
  // Pega 1m klines da vela em formação até a entrada + a vela anterior.
  // Range usado: o maior entre running e previous (mais conservador).
  const windowMin = Number(t.window_min) || 5;
  const windowMs = windowMin * 60 * 1000;
  const candleOpenMs = Math.floor(entryMs / windowMs) * windowMs;
  const prevCandleOpenMs = candleOpenMs - windowMs;

  const klines1m = await fetchKlinesRange({
    interval: "1m",
    startMs: prevCandleOpenMs,
    endMs: entryMs,
    limit: windowMin * 2 + 2
  });
  const runningKlines = klines1m.filter(k => k.openTime >= candleOpenMs && k.openTime < entryMs);
  const previousKlines = klines1m.filter(k => k.openTime >= prevCandleOpenMs && k.openTime < candleOpenMs);
  const runningRange = computeRangeFromKlines(runningKlines);
  const previousRange = computeRangeFromKlines(previousKlines);
  let fibBase = null;
  let fibSource = "—";
  if (runningRange && runningRange.range >= MIN_RUNNING_RANGE_USD) {
    fibBase = runningRange;
    fibSource = `running ${windowMin}m`;
  } else if (previousRange) {
    fibBase = previousRange;
    fibSource = `prev ${windowMin}m`;
  }

  const stopAnalysis = {};
  if (fibBase && fibBase.range > 0) {
    for (const f of FIB_LEVELS) {
      const stopBtc = side === "UP"
        ? entryBtc - fibBase.range * f
        : entryBtc + fibBase.range * f;
      const hit = checkStopHit(ticks, entryBtc, side, stopBtc);
      stopAnalysis[f] = { stopBtc, ...hit };
    }
  }

  return {
    indicator: t.indicator,
    side,
    holdSec: Number(t.hold_seconds),
    exitReason: t.exit_reason,
    pnlActual,
    effectiveStake,
    entryBtc,
    mae,
    mfe,
    maeAtMs,
    fibRange: fibBase?.range ?? null,
    fibSource,
    stopAnalysis,
    market: t.market_slug
  };
}

function fmtTime(ms) {
  if (!ms) return "—";
  return new Date(ms).toISOString().slice(11, 19);
}

async function main() {
  const trades5 = parseCsv(path.join(LOGS_DIR, "scalp_trades_5m.csv"));
  const trades15 = parseCsv(path.join(LOGS_DIR, "scalp_trades_15m.csv"));
  const trades = [...trades5, ...trades15].filter(t => t.exit_reason !== "slug_rollover");

  console.log("\n" + "═".repeat(110));
  console.log("  ⚡ SCALP STOP BACKTEST — Fib-anchored stop loss hypothetical analysis");
  console.log("═".repeat(110));
  console.log(`\n  Closed trades: ${trades.length} (5m: ${trades5.length} | 15m: ${trades15.length})`);
  const wins = trades.filter(t => Number(t.pnl_usd) > 0).length;
  const losses = trades.filter(t => Number(t.pnl_usd) <= 0).length;
  console.log(`  Wins: ${wins}  |  Losses/breakeven: ${losses}`);
  console.log(`  Exit reasons: ${[...new Set(trades.map(t => t.exit_reason))].join(", ")}\n`);

  if (!trades.length) {
    console.log("  Sem trades fechados — nada para analisar.");
    return;
  }

  if (losses === 0) {
    console.log("  ⚠️  Aviso: TODOS os trades foram winners. O backtest mede 'quanto");
    console.log("     espaço o stop precisa pra NÃO matar os ganhadores' — não há");
    console.log("     trades perdedores pra comprovar redução de prejuízo ainda.\n");
  }

  console.log("─".repeat(120));
  console.log(
    "  #  Side  Hold    Exit            PnL       Entry$BTC    MAE        MFE      Fib base       Stops triggered"
  );
  console.log("─".repeat(120));

  const stopAggregate = Object.fromEntries(FIB_LEVELS.map(f => [f, { triggered: 0, stillWin: 0 }]));

  for (let i = 0; i < trades.length; i++) {
    let row;
    try {
      row = await analyzeTrade(trades[i]);
    } catch (err) {
      console.log(`  ${String(i + 1).padStart(2)}.  ❌ falha: ${err.message}`);
      continue;
    }
    const triggered = FIB_LEVELS
      .filter(f => row.stopAnalysis[f]?.hit)
      .map(f => `${(f * 100).toFixed(1)}%`)
      .join(" ") || "—";
    const sideStr = row.side === "UP" ? "↑UP " : "↓DOWN";
    const fibCell = `${fmtBtc(row.fibRange)} (${row.fibSource})`;
    console.log(
      `  ${String(i + 1).padStart(2)}.  ${sideStr.padEnd(5)} ${String(row.holdSec).padStart(5)}s  ` +
      `${row.exitReason.padEnd(15)} ${fmtUsd(row.pnlActual).padStart(8)}  ` +
      `${fmtBtc(row.entryBtc).padStart(10)}  ` +
      `${fmtBtc(row.mae).padStart(8)}  ` +
      `${fmtBtc(row.mfe).padStart(8)}  ` +
      `${fibCell.padEnd(15)} ${triggered}`
    );

    for (const f of FIB_LEVELS) {
      const a = row.stopAnalysis[f];
      if (a?.hit) {
        stopAggregate[f].triggered++;
        if (row.pnlActual > 0) stopAggregate[f].stillWin++; // winner que teria sido stoppado
      }
    }

    await new Promise(r => setTimeout(r, 120)); // throttle Binance
  }

  console.log("─".repeat(110));
  console.log("\n  📊 AGREGADO POR NÍVEL DE STOP");
  console.log("  ─────────────────────────────");
  console.log("  Nível Fib   Trades stoppados   Winners mortos   Tradeoff");
  for (const f of FIB_LEVELS) {
    const agg = stopAggregate[f];
    const tradeoff = agg.stillWin > 0
      ? `❌ stop mata ${agg.stillWin} winner(s)`
      : agg.triggered > 0
        ? `✅ só stoppa losers`
        : `— nunca acionado`;
    console.log(
      `  ${(f * 100).toFixed(1).padStart(5)}%       ${String(agg.triggered).padStart(4)}/${trades.length}             ` +
      `${String(agg.stillWin).padStart(3)}              ${tradeoff}`
    );
  }

  console.log("\n  💡 Como ler:");
  console.log("     • 'Winners mortos' = trades positivos que o stop teria fechado antes do TP.");
  console.log("     • Se um nível mata winners, ele é apertado demais pro regime atual.");
  console.log("     • Com mais histórico (incluindo losers), o agregado mostra qual nível");
  console.log("       Fib salva mais perdas sem destruir muitos ganhadores.\n");
}

main().catch(err => {
  console.error("❌ Backtest failed:", err);
  process.exit(1);
});
