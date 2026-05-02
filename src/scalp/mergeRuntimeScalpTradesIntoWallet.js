/**
 * When TRADE_HISTORY_SOURCE=postgres, closed scalp rows go to runtime_events only
 * (CSV is not appended). Wallet state is still bootstrapped from CSV — this merge
 * replays missing scalp_trade rows from Postgres so restarts keep full history.
 */

import { isPostgresEnabled } from "../storage/db.js";
import { listScalpTradeRuntimeEventsForIndicator } from "../storage/runtimeEventStore.js";

function normTs(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(ts);
}

function scalpRuntimeRawToTrade(raw) {
  if (!raw || typeof raw !== "object") return null;
  const ind = raw.indicator;
  if (!ind) return null;
  return {
    indicator: ind,
    marketSlug: raw.market_slug || raw.marketSlug || "",
    windowMin: Number(raw.window_min),
    side: raw.side || "",
    entryPrice: Number(raw.entry_price),
    exitPrice: Number(raw.exit_price),
    entryTime: raw.entry_time || null,
    exitTime: raw.exit_time || raw.timestamp || null,
    holdSeconds: Number(raw.hold_seconds) || 0,
    exitReason: raw.exit_reason || "",
    stakeUsd: Number(raw.stake_usd),
    effectiveStakeUsd: Number.isFinite(Number(raw.effective_stake_usd))
      ? Number(raw.effective_stake_usd)
      : Number(raw.stake_usd),
    shares: Number(raw.shares),
    pnlUsd: Number(raw.pnl_usd),
    tokenId: raw.token_id || "",
    orderId: raw.order_id || ""
  };
}

function looseHistoryKey({ slug, ts, side }) {
  return `${String(slug || "")}|${normTs(ts)}|${String(side || "")}`;
}

export async function mergeRuntimeScalpTradesIntoWallet(wallet, indicatorName, applyScalpTradeToWallet) {
  if (!isPostgresEnabled() || !wallet || typeof applyScalpTradeToWallet !== "function") return 0;
  const hist = Array.isArray(wallet.history) ? wallet.history : [];
  const seen = new Set(hist.map((n) => looseHistoryKey({ slug: n.slug, ts: n.ts, side: n.side })));
  let added = 0;
  try {
    const rows = await listScalpTradeRuntimeEventsForIndicator(indicatorName);
    for (const row of rows) {
      const trade = scalpRuntimeRawToTrade(row.raw);
      if (!trade || trade.indicator !== indicatorName) continue;
      const ts = trade.exitTime || trade.entryTime || null;
      const k = looseHistoryKey({ slug: trade.marketSlug, ts, side: trade.side });
      if (seen.has(k)) continue;
      applyScalpTradeToWallet(wallet, trade);
      seen.add(k);
      added++;
    }
  } catch (err) {
    console.warn(`⚠️  mergeRuntimeScalpTradesIntoWallet(${indicatorName}): ${err?.message || err}`);
  }
  return added;
}
