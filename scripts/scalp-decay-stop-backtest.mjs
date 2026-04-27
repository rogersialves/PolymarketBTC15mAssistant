/**
 * scalp-decay-stop-backtest.mjs — Stop loss baseado em priceToBeatDelta.
 *
 * Hipótese: o modo de falha real do Scalp Force NÃO é "BTC anda muito contra"
 * (esse é o regime que stops em BTC spot pegariam) — é "contrato Polymarket
 * decai porque o BTC fica grudado em volta do priceToBeat até o vencimento".
 *
 * Como já temos `price_to_beat` no CSV (constante durante a vela) e podemos
 * reconstruir o BTC spot intra-hold via Binance 1s, dá pra calcular um proxy
 * direto da saúde do contrato:
 *
 *   signedDelta(t) = side === "UP"
 *     ? btcSpot(t) - priceToBeat
 *     : priceToBeat - btcSpot(t)
 *
 *   signedDelta > 0  →  lado favorável ganhando agora
 *   signedDelta = 0  →  cruzou linha (contract ≈ 50¢, decay rápido se perto do vencimento)
 *   signedDelta < 0  →  lado contrário ganhando (contract decaindo rumo a 0)
 *
 * Políticas testadas:
 *   - cross_stop:        sai se signedDelta cruza 0 (BTC passou pra outro lado)
 *   - cushion_stop_X$:   sai se signedDelta cai pra (entrySignedDelta - X)
 *   - late_decay_stop:   sai se signedDelta < 0 E tempo restante < 50% da vela
 *
 * Uso: node scripts/scalp-decay-stop-backtest.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_DIR = path.join(__dirname, "..", "logs");
const BINANCE_HOST = "https://api.binance.com";

const CUSHION_LEVELS_USD = [5, 10, 20, 30];

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
  const res = await fetch(url, { headers: { "user-agent": "scalp-decay-stop-backtest/1.0" } });
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json();
  return data.map(k => ({
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4])
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

function fmtUsd(n) { return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`; }
function fmtSigned(n) { return n >= 0 ? `+$${n.toFixed(0)}` : `-$${Math.abs(n).toFixed(0)}`; }

async function analyzeTrade(t) {
  const entryMs = new Date(t.entry_time).getTime();
  const exitMs = new Date(t.exit_time).getTime();
  const entryBtc = Number(t.current_price_entry);
  const priceToBeat = Number(t.price_to_beat);
  const side = t.side;
  const pnlActual = Number(t.pnl_usd);
  const windowMin = Number(t.window_min) || 5;
  const windowMs = windowMin * 60 * 1000;
  const candleEndMs = Math.ceil(entryMs / windowMs) * windowMs;

  const klines1s = await fetchKlinesRange({
    interval: "1s",
    startMs: entryMs - 2000,
    endMs: exitMs + 2000,
    limit: 1000
  });
  const ticks = buildIntraHoldSeries(klines1s).filter(x => x.ms >= entryMs && x.ms <= exitMs);

  const signedDeltaAt = (btcPrice) => side === "UP" ? btcPrice - priceToBeat : priceToBeat - btcPrice;

  const entrySignedDelta = signedDeltaAt(entryBtc);
  let minSignedDelta = entrySignedDelta;
  let crossedAt = null;
  let crossedTimeFrac = null;
  for (const tk of ticks) {
    const sd = signedDeltaAt(tk.price);
    if (sd < minSignedDelta) minSignedDelta = sd;
    if (entrySignedDelta > 0 && sd <= 0 && crossedAt === null) {
      crossedAt = tk.ms;
      const remainingMs = candleEndMs - tk.ms;
      crossedTimeFrac = remainingMs / windowMs;
    }
  }

  // Simulate stop policies
  const stops = {};

  // cross_stop: trigger se signedDelta cruza 0
  stops.cross = { triggered: false, atMs: null };
  for (const tk of ticks) {
    const sd = signedDeltaAt(tk.price);
    if (sd <= 0) {
      stops.cross = { triggered: true, atMs: tk.ms, atBtc: tk.price };
      break;
    }
  }

  // cushion_stop_X: trigger se signedDelta < (entrySignedDelta - X)
  for (const X of CUSHION_LEVELS_USD) {
    const threshold = entrySignedDelta - X;
    stops[`cushion_${X}`] = { triggered: false, atMs: null };
    for (const tk of ticks) {
      const sd = signedDeltaAt(tk.price);
      if (sd <= threshold) {
        stops[`cushion_${X}`] = { triggered: true, atMs: tk.ms, atBtc: tk.price };
        break;
      }
    }
  }

  // late_decay_stop: signedDelta < 0 E remainingFraction < 0.5
  stops.late_decay = { triggered: false, atMs: null };
  for (const tk of ticks) {
    const sd = signedDeltaAt(tk.price);
    const remainingFrac = (candleEndMs - tk.ms) / windowMs;
    if (sd < 0 && remainingFrac < 0.5) {
      stops.late_decay = { triggered: true, atMs: tk.ms, atBtc: tk.price };
      break;
    }
  }

  return {
    indicator: t.indicator,
    side,
    holdSec: Number(t.hold_seconds),
    exitReason: t.exit_reason,
    pnlActual,
    entryBtc,
    priceToBeat,
    entrySignedDelta,
    minSignedDelta,
    crossedAt,
    crossedTimeFrac,
    stops
  };
}

async function main() {
  const trades5 = parseCsv(path.join(LOGS_DIR, "scalp_trades_5m.csv"));
  const trades15 = parseCsv(path.join(LOGS_DIR, "scalp_trades_15m.csv"));
  const trades = [...trades5, ...trades15].filter(t => t.exit_reason !== "slug_rollover");

  console.log("\n" + "═".repeat(120));
  console.log("  ⚡ SCALP DECAY-STOP BACKTEST — priceToBeatDelta (proxy do contrato)");
  console.log("═".repeat(120));
  console.log(`\n  Closed trades: ${trades.length} (5m: ${trades5.length} | 15m: ${trades15.length})`);
  const wins = trades.filter(t => Number(t.pnl_usd) > 0).length;
  const losses = trades.filter(t => Number(t.pnl_usd) <= 0).length;
  console.log(`  Wins: ${wins}  |  Losses: ${losses}\n`);

  console.log("─".repeat(130));
  console.log("  #  Side  Hold     Exit              PnL      EntrySD     MinSD      Crossed?    cross  c5$  c10$  c20$  c30$  late");
  console.log("─".repeat(130));

  const policies = ["cross", "cushion_5", "cushion_10", "cushion_20", "cushion_30", "late_decay"];
  const aggregate = Object.fromEntries(policies.map(p => [p, { triggeredOnWin: 0, triggeredOnLoss: 0 }]));
  const rows = [];

  for (let i = 0; i < trades.length; i++) {
    let row;
    try {
      row = await analyzeTrade(trades[i]);
      rows.push(row);
    } catch (err) {
      console.log(`  ${String(i + 1).padStart(2)}.  ❌ falha: ${err.message}`);
      continue;
    }

    const sideStr = row.side === "UP" ? "↑UP " : "↓DOWN";
    const crossed = row.crossedAt
      ? `sim @${(row.crossedTimeFrac * 100).toFixed(0)}%rem`
      : "não";
    const flags = (key) => row.stops[key]?.triggered ? "  ✓  " : "  -  ";

    console.log(
      `  ${String(i + 1).padStart(2)}.  ${sideStr.padEnd(5)} ${String(row.holdSec).padStart(5)}s   ` +
      `${row.exitReason.padEnd(18)}${fmtUsd(row.pnlActual).padStart(7)}  ` +
      `${fmtSigned(row.entrySignedDelta).padStart(7)}  ${fmtSigned(row.minSignedDelta).padStart(7)}  ` +
      `${crossed.padEnd(11)}` +
      `${flags("cross")}${flags("cushion_5")}${flags("cushion_10")}${flags("cushion_20")}${flags("cushion_30")}${flags("late_decay")}`
    );

    for (const p of policies) {
      if (row.stops[p]?.triggered) {
        if (row.pnlActual > 0) aggregate[p].triggeredOnWin++;
        else aggregate[p].triggeredOnLoss++;
      }
    }
    await new Promise(r => setTimeout(r, 120));
  }

  console.log("─".repeat(130));
  console.log("\n  📊 AGREGADO POR POLÍTICA DE STOP");
  console.log("  ─────────────────────────────────");
  console.log("  Política           Stoppou losers   Matou winners    Avaliação");
  for (const p of policies) {
    const a = aggregate[p];
    const verdict = a.triggeredOnLoss > 0 && a.triggeredOnWin === 0
      ? "✅ pega losers sem matar winners"
      : a.triggeredOnLoss > 0
        ? `⚠️  pega ${a.triggeredOnLoss} loser(s) mas mata ${a.triggeredOnWin} winner(s)`
        : a.triggeredOnWin > 0
          ? `❌ só mata ${a.triggeredOnWin} winner(s)`
          : "— nunca acionado";
    console.log(`  ${p.padEnd(18)} ${String(a.triggeredOnLoss).padStart(2)}/${losses}             ${String(a.triggeredOnWin).padStart(2)}/${wins}             ${verdict}`);
  }

  console.log("\n  📐 ESTATÍSTICAS DOS DELTAS");
  console.log("  ─────────────────────────");
  const winRows = rows.filter(r => r.pnlActual > 0);
  const lossRows = rows.filter(r => r.pnlActual <= 0);
  if (winRows.length) {
    const minSDs = winRows.map(r => r.minSignedDelta);
    console.log(`  Winners (${winRows.length}): minSD médio ${fmtSigned(minSDs.reduce((a, b) => a + b, 0) / minSDs.length)}, ` +
      `pior caso ${fmtSigned(Math.min(...minSDs))}, melhor caso ${fmtSigned(Math.max(...minSDs))}`);
  }
  if (lossRows.length) {
    const minSDs = lossRows.map(r => r.minSignedDelta);
    console.log(`  Losers   (${lossRows.length}): minSD médio ${fmtSigned(minSDs.reduce((a, b) => a + b, 0) / minSDs.length)}, ` +
      `pior caso ${fmtSigned(Math.min(...minSDs))}, melhor caso ${fmtSigned(Math.max(...minSDs))}`);
  }

  console.log("\n  💡 Interpretação:");
  console.log("     • signedDelta < 0 = BTC do lado contrário ao priceToBeat (contrato decaindo).");
  console.log("     • Se 'cross' acionou em loser e NÃO em winners, é forte candidato a stop.");
  console.log("     • cushion_X é mais cauteloso (preserva uma reserva); late_decay só age perto do vencimento.\n");
}

main().catch(err => {
  console.error("❌ Backtest failed:", err);
  process.exit(1);
});
