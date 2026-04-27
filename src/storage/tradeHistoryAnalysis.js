function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round4(value) {
  return Math.round(toNum(value, 0) * 10000) / 10000;
}

function opposite(side) {
  if (side === "UP") return "DOWN";
  if (side === "DOWN") return "UP";
  return "";
}

function slugStartSeconds(slug) {
  const m = String(slug || "").match(/-(\d+)$/);
  return m ? Number(m[1]) : null;
}

function inferTimeframe(trade) {
  const tf = String(trade?.metadata?.timeframe || "").toLowerCase();
  if (tf === "5m" || tf === "15m") return tf;
  const slug = String(trade?.metadata?.marketSlug || "");
  if (slug.includes("-5m-")) return "5m";
  if (slug.includes("-15m-")) return "15m";
  return "";
}

function entryTimeLeftMinutes(trade, timeframeLabel) {
  const startSec = slugStartSeconds(trade?.metadata?.marketSlug);
  const tsMs = toNum(trade?.timestamp, null);
  const windowMinutes = timeframeLabel === "15m" ? 15 : timeframeLabel === "5m" ? 5 : null;
  if (!startSec || !tsMs || !windowMinutes) return 0;
  const endSec = startSec + windowMinutes * 60;
  return Math.max(0, (endSec - tsMs / 1000) / 60);
}

function modeMatches(trade, filterMode) {
  if (!filterMode) return true;
  if (filterMode === "SIMULATION") return true;
  if (filterMode === "DRY_RUN") return trade?.dryRun === true;
  if (filterMode === "LIVE") return trade?.dryRun !== true;
  return true;
}

function isAnalyzableTrade(trade, { timeframeLabel, filterMode, allIndicators, scalpIndicators }) {
  const md = trade?.metadata || {};
  const indicator = md.indicator;
  if (!indicator) return false;
  if (scalpIndicators?.has?.(indicator)) return false;
  if (Array.isArray(allIndicators) && allIndicators.length > 0 && !allIndicators.includes(indicator)) return false;
  if (trade?.side !== "BUY") return false;
  if (trade?.resolved !== true || trade?.marketResolved !== true) return false;
  if (typeof trade?.won !== "boolean") return false;
  if (!modeMatches(trade, filterMode)) return false;

  const tf = inferTimeframe(trade);
  if (timeframeLabel && tf !== timeframeLabel) return false;
  const direction = md.direction;
  if (direction !== "UP" && direction !== "DOWN") return false;
  if (!md.marketSlug) return false;
  return true;
}

function toAnalysisRow(trade, timeframeLabel) {
  const md = trade.metadata || {};
  const side = md.direction || "";
  const outcome = trade.won ? side : opposite(side);
  const stake = toNum(trade.sizeUsd, 1);
  const pnl = toNum(trade.pnl, 0);
  const entryPrice = toNum(trade.price, 0);
  const shares = Number.isFinite(Number(trade.shares))
    ? toNum(trade.shares, 0)
    : (entryPrice > 0 ? stake / entryPrice : null);
  return {
    timestamp: trade.timestamp ? new Date(trade.timestamp).toISOString() : new Date().toISOString(),
    market_slug: md.marketSlug || "",
    timeframe: inferTimeframe(trade) || timeframeLabel || "",
    indicator: md.indicator || "",
    side,
    entry_price: entryPrice,
    entry_time_left: entryTimeLeftMinutes(trade, timeframeLabel),
    outcome,
    won: Boolean(trade.won),
    pnl_usd: pnl,
    stake,
    shares: Number.isFinite(shares) ? round4(shares) : null,
    token_id: trade.tokenId || "",
    order_id: trade.orderId || "",
    explanation: md.explanation || trade.explanation || trade.error || ""
  };
}

export function buildTradeHistoryAnalysis(records, {
  timeframeLabel = null,
  filterMode = null,
  allIndicators = [],
  scalpIndicators = new Set()
} = {}) {
  const rows = (Array.isArray(records) ? records : [])
    .filter(trade => isAnalyzableTrade(trade, { timeframeLabel, filterMode, allIndicators, scalpIndicators }))
    .sort((a, b) => (toNum(a.timestamp, 0) - toNum(b.timestamp, 0)))
    .map(trade => toAnalysisRow(trade, timeframeLabel));

  const seenSlugs = new Set();
  let totalUp = 0;
  let totalDown = 0;
  for (const row of rows) {
    if (seenSlugs.has(row.market_slug)) continue;
    seenSlugs.add(row.market_slug);
    if (row.outcome === "UP") totalUp++;
    else if (row.outcome === "DOWN") totalDown++;
  }

  const bySlug = new Map();
  for (const row of rows) {
    if (!bySlug.has(row.market_slug)) bySlug.set(row.market_slug, []);
    bySlug.get(row.market_slug).push(row);
  }
  const candles = [...bySlug.entries()].slice(-36).map(([slug, trades]) => {
    const outcome = trades[0]?.outcome || "";
    const models = {};
    let upSignals = 0;
    let downSignals = 0;
    for (const t of trades) {
      if (t.side === "UP") upSignals++;
      else if (t.side === "DOWN") downSignals++;
      const modelData = { pred: t.side, hit: t.won };
      if (t.indicator === "Full Consensus") models.fullConsensus = modelData;
      else if (t.indicator === "TA Predict") models.taPredict = modelData;
      else if (t.indicator === "Heiken+OBV") models.heikenObv = modelData;
      else if (t.indicator === "5+ Agree") models.fivePlus = modelData;
      else if (t.indicator === "Consensus Edge") models.consensusEdge = modelData;
    }
    return { slug, outcome, upSignals, downSignals, models };
  });

  const stats = {};
  const wallets = {};
  for (const row of rows) {
    if (!stats[row.indicator]) stats[row.indicator] = { name: row.indicator, correct: 0, wrong: 0, total: 0 };
    stats[row.indicator].total++;
    if (row.won) stats[row.indicator].correct++;
    else stats[row.indicator].wrong++;

    if (!wallets[row.indicator]) {
      wallets[row.indicator] = {
        name: row.indicator,
        balance: 0,
        trades: 0,
        wins: 0,
        losses: 0,
        invested: 0,
        returned: 0,
        history: []
      };
    }
    const w = wallets[row.indicator];
    w.trades++;
    w.invested += row.stake;
    if (row.won) {
      w.wins++;
      w.returned += row.stake + row.pnl_usd;
    } else {
      w.losses++;
    }
    w.balance += row.pnl_usd;
    w.history.push({
      ts: row.timestamp,
      slug: row.market_slug,
      side: row.side,
      entryPrice: row.entry_price,
      timeLeft: row.entry_time_left,
      outcome: row.outcome,
      won: row.won,
      pnl: row.pnl_usd,
      stake: row.stake,
      shares: row.shares,
      tokenId: row.token_id,
      orderId: row.order_id,
      explanation: row.explanation
    });
  }

  const indicators = Object.values(stats)
    .map(s => ({
      name: s.name,
      accuracy: s.total > 0 ? (s.correct / s.total) * 100 : 0,
      total: s.total,
      correct: s.correct,
      wrong: s.wrong,
      change: null
    }))
    .sort((a, b) => b.accuracy - a.accuracy);

  const walletList = Object.values(wallets)
    .map(w => ({
      ...w,
      balance: round4(w.balance),
      invested: round4(w.invested),
      returned: round4(w.returned)
    }))
    .sort((a, b) => b.balance - a.balance);

  return {
    totalSnapshots: seenSlugs.size,
    upCount: totalUp,
    downCount: totalDown,
    indicators,
    candles,
    wallets: walletList,
    source: "trade_history"
  };
}
