/**
 * resolve-pending-trades.mjs
 *
 * Atualiza o status de trades pendentes/não-resolvidos em logs/trade_history.json
 * usando o tokenId de cada registro para consultar o resultado via Polymarket API.
 *
 * Estratégia de resolução (em ordem):
 *   1. Gamma API via marketSlug  → GET /events?slug=<marketSlug>
 *   2. CLOB midpoint via tokenId → GET /midpoint?token_id=<tokenId>
 *      (retorna mid=1 ou mid=0 quando o mercado está resolvido)
 *
 * Uso:
 *   node scripts/resolve-pending-trades.mjs
 *   node scripts/resolve-pending-trades.mjs --dry-run   (não salva, apenas mostra)
 *   node scripts/resolve-pending-trades.mjs --all       (reprocessa todos, inclusive já resolvidos)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileSimCsvs } from "../src/reconcileSimCsvs.js";
import { mergeTradeHistoryRecords, readTradeHistoryFile, writeTradeHistoryFileAtomic } from "../src/tradeHistoryMerge.js";
import { backfillSimTradesFromHistory, persistSimCsvTokenColumns } from "../src/simTradeHistoryBackfill.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.join(__dirname, "..", "logs", "trade_history.json");
const SIM_CSV_PATHS = ["5m", "15m"].map(tf => path.join(__dirname, "..", "logs", `sim_trades_${tf}.csv`));
const ALL_INDICATORS = [
  "Full Consensus", "Heiken+OBV", "5+ Agree",
  "TA Predict", "Heiken Ashi", "OBV", "MACD", "Delta 3m", "Bollinger",
  "Consensus Edge", "Top3 15m", "Top3 5m",
  "Delta 3m Fade 5m", "Delta 3m Fade 15m",
  "Scalp Force 5m", "Scalp Force 15m"
];
const SCALP_INDICATORS = new Set(["Scalp Force 5m", "Scalp Force 15m"]);
const GAMMA_BASE   = "https://gamma-api.polymarket.com";
const CLOB_BASE    = "https://clob.polymarket.com";
const DELAY_MS     = 300; // throttle entre requests para não sobrecarregar a API

const isDryRun  = process.argv.includes("--dry-run");
const reprocessAll = process.argv.includes("--all");

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function toNum(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  return res.json();
}

function runCsvReconciliation(correctedTrades, dryRun) {
  console.log(`\n🔍 Reconciliando todas as linhas em sim_trades_*.csv...`);
  const recon = reconcileSimCsvs({
    correctedTrades,
    simCsvPaths: SIM_CSV_PATHS,
    dryRun,
    logger: msg => console.log(msg)
  });

  if (recon.totalReconciled === 0) {
    console.log(`✅ Nenhuma divergência encontrada nas CSVs de simulação.`);
    return recon;
  }

  console.log(`📋 Reconciliação total: ${recon.totalReconciled} linha(s) em ${Object.keys(recon.perFile).length} arquivo(s).`);
  for (const [file, info] of Object.entries(recon.perFile)) {
    const modes = Object.entries(info.modes)
      .map(([mode, count]) => `${mode}:${count}`)
      .join(", ");
    console.log(`   - ${file}: ${info.modified} linha(s)${modes ? ` (${modes})` : ""}`);
  }

  if (dryRun && recon.samples.length > 0) {
    console.log(`   Amostras DRY_RUN:`);
    for (const sample of recon.samples.slice(0, 5)) {
      console.log(`   - ${sample.file}:${sample.line} ${sample.indicator} ${sample.oldOutcome}->${sample.newOutcome} pnl ${sample.oldPnl}->${sample.newPnl}`);
    }
  }

  return recon;
}

function runHistoryBackfill(dryRun) {
  console.log(`\n🔁 Recuperando linhas faltantes das carteiras a partir do trade_history...`);
  let total = 0;
  let tokens = 0;
  for (const tf of ["5m", "15m"]) {
    const csvPath = path.join(__dirname, "..", "logs", `sim_trades_${tf}.csv`);
    const result = backfillSimTradesFromHistory({
      historyPath: HISTORY_PATH,
      csvPath,
      timeframeLabel: tf,
      allIndicators: ALL_INDICATORS,
      scalpIndicators: SCALP_INDICATORS,
      dryRun,
      logger: msg => console.log(msg)
    });
    total += result.added;

    const tokenResult = persistSimCsvTokenColumns({
      historyPath: HISTORY_PATH,
      csvPath,
      timeframeLabel: tf,
      allIndicators: ALL_INDICATORS,
      scalpIndicators: SCALP_INDICATORS,
      dryRun,
      logger: msg => console.log(msg)
    });
    tokens += tokenResult.updated;
  }

  if (total === 0) {
    console.log("✅ Nenhuma linha faltante encontrada para as carteiras.");
  } else {
    console.log(`📋 Backfill de carteiras: ${total} linha(s) ${dryRun ? "seria(m) adicionada(s)" : "adicionada(s)"} em sim_trades_*.csv.`);
  }
  if (tokens > 0) {
    console.log(`🔑 Tokens nas carteiras: ${tokens} linha(s) ${dryRun ? "seria(m) preenchida(s)" : "preenchida(s)"}.`);
  }
  return total;
}

function isExitResolvedTrade(trade) {
  return trade?.resolved === true
    && trade?.executionStatus === "resolved"
    && Boolean(trade.exitReason || trade.exitOrderId || trade.metadata?.scalpExitMode);
}

function needsMarketResolution(trade) {
  if (!trade?.tokenId) return false;
  if (isExitResolvedTrade(trade)) return false;
  if (reprocessAll) return true;
  return !trade.marketResolved || trade.resolved !== true;
}

// ── Abordagem 1: Gamma API via slug ────────────────────────────────────────

const slugCache = new Map();

async function resolveViaSlug(slug) {
  if (slugCache.has(slug)) return slugCache.get(slug);
  try {
    const data = await fetchJson(`${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`);
    const event  = Array.isArray(data) ? data[0] : null;
    const market = event && Array.isArray(event.markets) ? event.markets[0] : null;
    slugCache.set(slug, market ?? null);
    return market ?? null;
  } catch {
    slugCache.set(slug, null);
    return null;
  }
}

// ── Abordagem 2: CLOB midpoint via tokenId ─────────────────────────────────
// Retorna null (ainda ativo), true (resolveu vencedor) ou false (resolveu perdedor)

async function resolveViaTokenMidpoint(tokenId) {
  try {
    const data = await fetchJson(`${CLOB_BASE}/midpoint?token_id=${encodeURIComponent(tokenId)}`);
    if (!data || data.mid == null) return null;
    const mid = toNum(data.mid, -1);
    if (mid === 1) return true;   // ganhou (price = $1)
    if (mid === 0) return false;  // perdeu (price = $0)
    return null; // ainda ativo (fractional)
  } catch {
    return null;
  }
}

// ── Lógica de resolução de um trade ────────────────────────────────────────

async function resolveTrade(trade) {
  const slug     = trade.metadata?.marketSlug;
  const tokenId  = trade.tokenId;
  const shares   = toNum(trade.shares, 0);
  const sizeUsd  = toNum(trade.sizeUsd, 0);

  // Custo real (para ordens não executadas, usa sizeMatched * price)
  const notPlaced  = !trade.orderId || ["skipped", "rejected", "error"].includes(trade.status);
  const sizeMatched = toNum(trade.sizeMatched ?? trade.filledSize, 0);
  const filledShares = notPlaced ? sizeMatched : shares;
  const filledUsd    = notPlaced ? sizeMatched * toNum(trade.price, 0) : sizeUsd;

  // ── Tenta via slug (mais confiável — retorna dados completos do mercado) ──
  if (slug) {
    const market = await resolveViaSlug(slug);
    if (market) {
      const closed         = Boolean(market.closed);
      const clobTokenIds   = safeJsonArray(market.clobTokenIds);
      const outcomePrices  = safeJsonArray(market.outcomePrices);
      const numericPrices  = outcomePrices.map(p => parseFloat(p));

      const isResolved = closed
        && numericPrices.length === 2
        && numericPrices.every(p => p === 0 || p === 1)
        && numericPrices.some(p => p === 1);

      if (isResolved && tokenId) {
        const idx = clobTokenIds.findIndex(id => String(id) === String(tokenId));
        if (idx >= 0) {
          const won = numericPrices[idx] >= 0.5;
          const pnl = won
            ? parseFloat((filledShares - filledUsd).toFixed(2))
            : parseFloat((-filledUsd).toFixed(2));
          return { source: "gamma_slug", won, pnl, marketClosed: closed, marketResolved: true };
        }
      }
      // Mercado ainda aberto — sem resolução por enquanto
      if (!closed) return { source: "gamma_slug", marketClosed: false, marketResolved: false };
    }
  }

  // ── Fallback: CLOB midpoint via tokenId ──
  if (tokenId) {
    const wonViaToken = await resolveViaTokenMidpoint(tokenId);
    if (wonViaToken !== null) {
      const pnl = wonViaToken
        ? parseFloat((filledShares - filledUsd).toFixed(2))
        : parseFloat((-filledUsd).toFixed(2));
      return { source: "clob_midpoint", won: wonViaToken, pnl, marketClosed: true, marketResolved: true };
    }
  }

  return null; // não foi possível resolver
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(HISTORY_PATH)) {
    console.error(`❌ Arquivo não encontrado: ${HISTORY_PATH}`);
    process.exit(1);
  }

  const history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  console.log(`📂 ${history.length} registros carregados de trade_history.json`);

  // Filtra os pendentes (sem resolução de mercado)
  const pending = history.filter(t => needsMarketResolution(t));

  if (pending.length === 0) {
    console.log("✅ Nenhum trade pendente encontrado. Tudo já está resolvido.");
    runCsvReconciliation(isDryRun ? history : readTradeHistoryFile(HISTORY_PATH), isDryRun);
    runHistoryBackfill(isDryRun);
    if (isDryRun) {
      console.log("🧪 [DRY_RUN] Alterações NÃO salvas (use sem --dry-run para persistir).");
    }
    return;
  }

  console.log(`\n🔍 ${pending.length} trade(s) pendente(s) para processar...\n`);

  let updated = 0;
  let skipped = 0;
  let failed  = 0;

  for (const trade of pending) {
    const label = `[${trade.metadata?.indicator ?? "?"}] ${trade.metadata?.marketSlug ?? trade.tokenId?.substring(0, 16) + "..."}`;
    process.stdout.write(`  ⏳ ${label} ... `);

    try {
      const result = await resolveTrade(trade);

      if (!result) {
        console.log("⏩ não resolvido (mercado ainda ativo ou sem dados)");
        skipped++;
      } else if (!result.marketResolved) {
        console.log(`⏩ mercado ainda aberto (closed=${result.marketClosed})`);
        skipped++;
      } else {
        // Aplica as atualizações
        trade.marketClosed    = result.marketClosed;
        trade.marketResolved  = result.marketResolved;
        trade.resolved        = true;
        trade.won             = result.won;
        trade.pnl             = result.pnl;
        trade.executionStatus = "resolved";

        const pnlStr  = result.pnl >= 0 ? `+$${result.pnl}` : `-$${Math.abs(result.pnl)}`;
        const wonStr  = result.won ? "✅ GANHOU" : "❌ PERDEU";
        console.log(`${wonStr}  P&L: ${pnlStr}  [via ${result.source}]`);
        updated++;
      }
    } catch (err) {
      console.log(`💥 erro: ${err.message}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  // Resumo
  console.log(`\n─────────────────────────────────────`);
  console.log(`📊 Resultado: ${updated} atualizados | ${skipped} sem resolução | ${failed} erros`);

  if (isDryRun) {
    runCsvReconciliation(history, true);
    runHistoryBackfill(true);
    console.log("🧪 [DRY_RUN] Alterações NÃO salvas (use sem --dry-run para persistir).");
    return;
  }

  let finalHistory = history;

  if (updated > 0) {
    // Backup antes de salvar
    const backupPath = HISTORY_PATH.replace(".json", `.backup-${Date.now()}.json`);
    fs.copyFileSync(HISTORY_PATH, backupPath);
    console.log(`💾 Backup salvo em: ${path.basename(backupPath)}`);

    const latestHistory = readTradeHistoryFile(HISTORY_PATH);
    finalHistory = mergeTradeHistoryRecords(latestHistory, history);
    writeTradeHistoryFileAtomic(HISTORY_PATH, finalHistory);
    console.log(`✅ trade_history.json atualizado com ${updated} resolução(ões) em ${finalHistory.length} registro(s).`);
  } else {
    console.log("ℹ️  Nenhuma alteração nova em trade_history.json.");
    finalHistory = readTradeHistoryFile(HISTORY_PATH);
  }

  runCsvReconciliation(finalHistory, false);
  runHistoryBackfill(false);
}

main().catch(err => {
  console.error("❌ Erro fatal:", err.message);
  process.exit(1);
});
