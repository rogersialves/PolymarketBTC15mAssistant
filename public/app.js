/**
 * app.js — Client-side WebSocket + DOM rendering for the dashboard.
 */

// ── State ──
let activeTf = "5m";
let latestData = { "5m": null, "15m": null };
let latestAnalysis = { "5m": null, "15m": null };
let ws = null;
let reconnectTimer = null;
// Acumula todas as ordens LIVE recebidas via WS (deduplicado por orderId)
const _liveOrdersMap = new Map(); // orderId/key → trade record

// ── Helpers ──
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function fmt(n, d = 0) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPct(n, d = 2) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(d) + "%";
}
function fmtPolyPrice(p) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return "STALE";
  return `${(Number(p) * 100).toFixed(0)}c`;
}
function fmtDelta(usd, close) {
  if (usd === null || !Number.isFinite(Number(usd))) return "—";
  const sign = usd > 0 ? "+" : usd < 0 ? "-" : "";
  const pct = close ? ((Math.abs(usd) / close) * 100).toFixed(2) : "?";
  return `${sign}$${Math.abs(usd).toFixed(2)}, ${sign}${pct}%`;
}
function colorClass(value) {
  if (value === null || value === undefined) return "color-dim";
  return Number(value) > 0 ? "color-up" : Number(value) < 0 ? "color-down" : "color-dim";
}

function flash(el, dir) {
  el.classList.remove("flash-up", "flash-down");
  void el.offsetWidth; // force reflow
  el.classList.add(dir > 0 ? "flash-up" : "flash-down");
}

// ── WebSocket ──
function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    document.getElementById("connectionStatus").className = "status-dot connected";
    console.log("WS connected");
  };

  ws.onclose = () => {
    document.getElementById("connectionStatus").className = "status-dot disconnected";
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch { /* ignore */ }
  };
}

function handleMessage(msg) {
  if (msg.type === "tick" && msg.data) {
    latestData[msg.timeframe] = msg.data;
    if (msg.analysis) {
      latestAnalysis[msg.timeframe] = msg.analysis;
    }
    // Acumular ordens LIVE (não dry_run)
    const recent = msg.data?.trading?.recentTrades || [];
    for (const t of recent) {
      if (t.dryRun) continue;
      const key = t.orderId || `${t.timestamp}_${t.metadata?.indicator}`;
      if (key) _liveOrdersMap.set(key, t);
    }
    if (msg.timeframe === activeTf) {
      renderRealtime(msg.data);
      if (msg.analysis) renderAnalysis(msg.analysis);
    }
  }
  if (msg.type === "analysis" && msg.data) {
    latestAnalysis[msg.timeframe] = msg.data;
    if (msg.timeframe === activeTf) renderAnalysis(msg.data);
  }
  if (msg.type === "error") {
    console.warn(`Engine error (${msg.timeframe}):`, msg.error);
  }
}

// ── Render Real-Time Panel ──
function renderRealtime(d) {
  // Market title & timing
  document.getElementById("marketTitle").textContent = d.market.title || "Connecting...";
  document.getElementById("marketSlug").textContent = d.market.slug || "—";

  const timerEl = document.getElementById("timeLeft");
  timerEl.textContent = d.market.timeLeftFormatted || "--:--";
  const tl = d.market.timeLeft;
  const wm = d.market.windowMinutes || 5;
  timerEl.className = "timer " + (tl > wm * 0.66 ? "green" : tl > wm * 0.3 ? "yellow" : "red");

  // Session info
  document.getElementById("sessionInfo").textContent = `${d.session.time} | ${d.session.name}`;

  // ── Indicators ──
  const ind = d.indicators;

  // TA Predict
  const longPct = ind.taPredict.longPct !== null ? (ind.taPredict.longPct * 100).toFixed(0) : "?";
  const shortPct = ind.taPredict.shortPct !== null ? (ind.taPredict.shortPct * 100).toFixed(0) : "?";
  const taPredEl = document.getElementById("val-taPredict");
  const taIsBull = ind.taPredict.longPct > ind.taPredict.shortPct;
  taPredEl.innerHTML = `<span class="${taIsBull ? "color-up" : "color-down"}">LONG ${longPct}%</span> / <span class="${taIsBull ? "color-down" : "color-up"}">SHORT ${shortPct}%</span>`;

  // Heiken Ashi
  const hEl = document.getElementById("val-heiken");
  const hColor = ind.heikenAshi.color || "—";
  const hClass = hColor === "green" ? "color-up" : hColor === "red" ? "color-down" : "color-dim";
  hEl.innerHTML = `<span class="${hClass}">${hColor} x${ind.heikenAshi.streak || "?"}</span>`;

  // RSI
  const rsiEl = document.getElementById("val-rsi");
  const rsiVal = ind.rsi.value !== null ? ind.rsi.value.toFixed(1) : "—";
  const rsiArrow = ind.rsi.slope > 0 ? " ↑" : ind.rsi.slope < 0 ? " ↓" : "";
  const rsiClass = ind.rsi.value > 70 ? "color-down" : ind.rsi.value < 30 ? "color-up" : "color-neutral";
  const rsiOBOS = ind.rsi.value > 70 ? " OB" : ind.rsi.value < 30 ? " OS" : "";
  rsiEl.innerHTML = `<span class="${rsiClass}">${rsiVal}${rsiArrow}${rsiOBOS}</span>`;

  // MACD
  const macdEl = document.getElementById("val-macd");
  const macdClass = ind.macd.label.includes("bullish") ? "color-up" : ind.macd.label.includes("bearish") ? "color-down" : "color-dim";
  macdEl.innerHTML = `<span class="${macdClass}">${ind.macd.label}</span>`;

  // Delta 1/3
  const deltaEl = document.getElementById("val-delta");
  const d1 = fmtDelta(ind.delta.d1m, ind.delta.latestClose);
  const d3 = fmtDelta(ind.delta.d3m, ind.delta.latestClose);
  const d1Class = colorClass(ind.delta.d1m);
  const d3Class = colorClass(ind.delta.d3m);
  deltaEl.innerHTML = `<span class="${d1Class}">${d1}</span> | <span class="${d3Class}">${d3}</span>`;

  // VWAP
  const vwapEl = document.getElementById("val-vwap");
  const vwapDistPct = ind.vwap.distance !== null ? (ind.vwap.distance * 100).toFixed(2) : "?";
  const vwapSlopeClass = ind.vwap.slopeLabel === "UP" ? "color-up" : ind.vwap.slopeLabel === "DOWN" ? "color-down" : "color-dim";
  vwapEl.innerHTML = `${fmt(ind.vwap.price, 0)} (${vwapDistPct}%) | <span class="${vwapSlopeClass}">slope ${ind.vwap.slopeLabel}</span>`;

  // Bollinger
  const bollEl = document.getElementById("val-bollinger");
  const pctBVal = ind.bollinger.pctB !== null ? ind.bollinger.pctB.toFixed(2) : "—";
  const bwVal = ind.bollinger.bandwidth !== null ? (ind.bollinger.bandwidth * 100).toFixed(2) : "—";
  const sqz = ind.bollinger.isSqueeze ? ' <span class="color-warn">SQUEEZE</span>' : "";
  bollEl.innerHTML = `${pctBVal} (%B) | BW ${bwVal}%${sqz}`;

  // Stoch RSI
  const stochEl = document.getElementById("val-stochRsi");
  const kVal = ind.stochRsi.k !== null ? Math.round(ind.stochRsi.k) : "—";
  const dVal = ind.stochRsi.d !== null ? Math.round(ind.stochRsi.d) : "—";
  const stochTag = ind.stochRsi.overbought ? ' <span class="color-down">OB</span>' : ind.stochRsi.oversold ? ' <span class="color-up">OS</span>' : "";
  stochEl.innerHTML = `K ${kVal} / D ${dVal}${stochTag}${ind.stochRsi.crossLabel || ""}`;

  // EMA
  const emaEl = document.getElementById("val-ema");
  const emaClass = ind.emaCross.label.includes("bullish") || ind.emaCross.label.includes("↑") ? "color-up" : ind.emaCross.label.includes("bearish") || ind.emaCross.label.includes("↓") ? "color-down" : "color-dim";
  const emaSpread = ind.emaCross.spread !== null ? ` ($${Math.abs(ind.emaCross.spread).toFixed(0)})` : "";
  emaEl.innerHTML = `<span class="${emaClass}">${ind.emaCross.label}${emaSpread}</span>`;

  // OBV
  const obvEl = document.getElementById("val-obv");
  const obvDir = ind.obv.slope > 0 ? "↑" : ind.obv.slope < 0 ? "↓" : "→";
  const obvLabel = ind.obv.divergence || "confirming";
  const obvClass = obvLabel.includes("DIV") ? "color-warn" : ind.obv.slope > 0 ? "color-up" : ind.obv.slope < 0 ? "color-down" : "color-dim";
  obvEl.innerHTML = `<span class="${obvClass}">${obvDir} ${obvLabel}</span>`;

  // ATR
  const atrEl = document.getElementById("val-atr");
  const atrVal = ind.atr.value !== null ? `$${ind.atr.value.toFixed(2)}` : "—";
  const atrClass = ind.atr.level === "high" ? "color-warn" : ind.atr.level === "low" ? "color-neutral" : "";
  atrEl.innerHTML = `<span class="${atrClass}">${atrVal} (${ind.atr.level || "—"})</span>`;

  // ── Polymarket ──
  const poly = d.polymarket;
  document.getElementById("polyUp").textContent = fmtPolyPrice(poly.upPrice);
  document.getElementById("polyDown").textContent = fmtPolyPrice(poly.downPrice);
  document.getElementById("polyLiquidity").textContent = fmt(poly.liquidity, 0);

  document.getElementById("priceToBeat").textContent = poly.priceToBeat !== null ? `$${fmt(poly.priceToBeat, 0)}` : "—";

  const cpEl = document.getElementById("currentPrice");
  const oldText = cpEl.textContent;
  const cpVal = poly.currentPrice !== null ? `$${fmt(poly.currentPrice, 2)}` : "—";
  const deltaStr = poly.priceDelta !== null ? ` (${poly.priceDelta > 0 ? "+" : ""}$${poly.priceDelta.toFixed(2)})` : "";
  const cpClass = poly.priceDelta > 0 ? "color-up" : poly.priceDelta < 0 ? "color-down" : "";
  cpEl.innerHTML = `<span class="${cpClass}">${cpVal}${deltaStr}</span>`;
  if (!poly.currentPriceFresh) {
    cpEl.innerHTML = `<span class="color-warn">STALE</span>`;
  }
  if (oldText !== cpEl.textContent && poly.priceDelta !== null) {
    flash(cpEl, poly.priceDelta);
  }

  // ── Exchanges ──
  const ex = d.exchanges;
  renderExchange("Binance", ex.binance);
  renderExchange("Coinbase", ex.coinbase);
  renderExchange("Kraken", ex.kraken);

  // Oracle
  const oracle = d.oracle;
  document.getElementById("oracleLag").textContent = oracle.lagMs !== null ? `${(oracle.lagMs / 1000).toFixed(1)}s` : "—";
  document.getElementById("oracleSpread").textContent = oracle.spreadPct !== null ? fmtPct(oracle.spreadPct, 3) : "—";
  const bvo = oracle.binanceVsOracle;
  const bvoEl = document.getElementById("binVsOracle");
  bvoEl.textContent = bvo !== null ? `$${bvo > 0 ? "+" : ""}${bvo.toFixed(2)}` : "—";
  bvoEl.className = `value ${colorClass(bvo)}`;

  // ── Simulation ──
  renderSimulation(d.simulation);

  // ── Trading Mode Badge ──
  renderTradingBadge(d.trading);
}

function renderSimulation(sim) {
  if (!sim) return;

  // Counter: activated / total
  document.getElementById("simCounter").textContent = `${sim.activated} / ${sim.totalIndicators}`;

  // Active positions grid
  const container = document.getElementById("simPositions");
  if (sim.positions && sim.positions.length > 0) {
    container.innerHTML = sim.positions.map(p => {
      const dirCls = p.side === "UP" ? "color-up" : "color-down";
      const arrow = p.side === "UP" ? "↑" : "↓";
      const price = (p.entryPrice * 100).toFixed(1);
      const tl = p.timeLeft.toFixed(1);
      const stake = p.stake || 1;
      const stakeInfo = stake !== 1 ? `\nStake: $${stake.toFixed(2)}` : `\nStake: $1.00`;
      const stakeTag = stake !== 1 ? `<span class="sim-stake">$${stake.toFixed(2)}</span>` : '';
      return `<div class="sim-pos" title="${esc(p.name)}\nEntrada: ${esc(p.side)} a ${price}¢${stakeInfo}\nTime Left: ${tl}min\n${esc(p.ts)}">
        <span class="sim-name">${esc(p.name)}</span>
        <span class="${dirCls}">${arrow}</span>
        <span class="sim-price">${price}¢</span>
        ${stakeTag}
        <span class="sim-tl">${tl}m</span>
      </div>`;
    }).join("");
  } else {
    container.innerHTML = '<div class="empty-state">Aguardando ativações...</div>';
  }

  // Last resolved market
  const resolvedEl = document.getElementById("simResolved");
  if (sim.lastResolved) {
    const r = sim.lastResolved;
    const won = r.trades.filter(t => t.won).length;
    const lost = r.trades.length - won;
    const invested = r.invested || r.trades.length;
    const returned = r.returned || r.trades.reduce((s, t) => s + (t.returned || 0), 0);
    const profit = returned - invested;
    const profitCls = profit >= 0 ? "color-up" : "color-down";
    const shortSlug = (r.slug || "").replace(/.*-(\d+)$/, "#$1");
    resolvedEl.innerHTML = `
      <div class="sim-result-header">
        <span>📊 <b>${shortSlug}</b> → <span class="${r.outcome === 'UP' ? 'color-up' : 'color-down'}">${r.outcome}</span></span>
        <span>💰 $${invested.toFixed(0)} → <span class="${profitCls}"><b>$${returned.toFixed(2)}</b></span> (${won}✅ ${lost}❌) &nbsp;|&nbsp; Lucro: <span class="${profitCls}"><b>$${profit >= 0 ? '+' : ''}${profit.toFixed(2)}</b></span></span>
      </div>
      <div class="sim-result-trades">${r.trades.map(t => {
        const cls = t.won ? "sim-won" : "sim-lost";
        const icon = t.won ? "✅" : "❌";
        const ret = t.returned || 0;
        const stake = t.stake || 1;
        const profit = ret - stake;
        const stakeLabel = stake !== 1 ? ` [$${stake.toFixed(2)}]` : '';
        const tipReturn = t.won ? `Stake: $${stake.toFixed(2)}\nRetorno: $${ret.toFixed(2)} (lucro +$${profit.toFixed(2)})` : `Stake: $${stake.toFixed(2)}\nPerdeu $${stake.toFixed(2)}`;
        return `<span class="sim-trade-badge ${cls}" title="${t.name}${stakeLabel}: ${t.side} @${(t.entryPrice*100).toFixed(1)}¢\n${tipReturn}">${icon} ${t.name}${stakeLabel} ${t.won ? '+$'+profit.toFixed(2) : '-$'+stake.toFixed(2)}</span>`;
      }).join("")}</div>
    `;
  }

  // Consensus Edge status panel
  renderCeStatus(sim.ceStatus);
}

function renderTradingBadge(trading) {
  const badge = document.getElementById("tradingBadge");
  if (!badge) return;
  if (!trading) {
    badge.textContent = "📡 SCALP MONITOR";
    badge.className = "trading-badge dry-run";
    return;
  }

  if (trading.dryRun) {
    const count = trading.totalTradesPlaced || 0;
    badge.textContent = `📡 SIM (${count})`;
    badge.className = "trading-badge dry-run";
    badge.title = `Modo simulação — ${count} ordens simuladas\nMax Stake: $${trading.maxStake}`;
  } else {
    const bal = trading.usdcBalance !== null ? `$${trading.usdcBalance.toFixed(2)}` : "—";
    badge.textContent = `💰 LIVE ${bal}`;
    badge.className = "trading-badge live";
    badge.title = `Trading REAL ativo\nWallet: ${trading.walletAddress || "—"}\nSaldo USDC: ${bal}\nOrdens abertas: ${trading.openOrdersCount || 0}`;
  }
}

function renderCeStatus(ce) {
  const el = document.getElementById("ceStatus");
  if (!el) return;
  if (!ce) { el.innerHTML = ''; return; }

  const voteIcons = Object.entries(ce.votes || {}).map(([ind, side]) => {
    if (side === null) return `<span class="ce-vote neutral" title="${ind}: Neutro">⚪ ${shortInd(ind)}</span>`;
    const cls = side === ce.majoritySide ? "agree" : "disagree";
    const arrow = side === "UP" ? "↑" : "↓";
    return `<span class="ce-vote ${cls}" title="${ind}: ${side}">${side === ce.majoritySide ? "✅" : "❌"} ${shortInd(ind)} ${arrow}</span>`;
  }).join("");

  const concordanceOk = ce.majority >= 7;
  const priceOk = ce.price !== null && ce.price >= 0.60 && ce.price <= 0.85;
  const pricePct = ce.price ? (ce.price * 100).toFixed(1) : "—";




  const concordIcon = concordanceOk ? "✅" : "❌";
  const priceIcon = priceOk ? "✅" : "❌";
  const timeOk = ce.timeOk || false;
  const timeIcon = timeOk ? "✅" : "⏳";
  const timeFormatted = ce.timeLeftFormatted || "—";

  const balCls = ce.walletBalance >= 0 ? "color-up" : "color-down";
  const balSign = ce.walletBalance >= 0 ? "+" : "";

  // Determine panel state: active, ready (waiting time), or inactive
  const allCriteriaExceptTime = concordanceOk && priceOk;
  const panelCls = ce.active ? "ce-active" : (allCriteriaExceptTime ? "ce-ready" : "ce-inactive");
  const statusIcon = ce.active ? "🟢" : (allCriteriaExceptTime ? "🟡" : "🔴");
  const statusText = ce.active ? "ATIVO" : (allCriteriaExceptTime ? "AGUARDANDO TEMPO" : "INATIVO");

  el.innerHTML = `
    <div class="ce-panel ${panelCls}">
      <div class="ce-header">
        <span>${statusIcon} <b>Consensus Edge</b> — ${statusText}</span>
        <span class="ce-stake-info">💰 Saldo: <span class="${balCls}">${balSign}$${ce.walletBalance.toFixed(2)}</span> | Próx. Stake: <b>$${ce.nextStake.toFixed(2)}</b></span>
      </div>
      <div class="ce-criteria">
        <span class="ce-criterion ${concordanceOk ? 'pass' : 'fail'}">${concordIcon} Concordância: <b>${ce.majority}/${ce.totalVotes}</b> (≥7) — ↑${ce.upVotes} ↓${ce.downVotes}</span>
        <span class="ce-criterion ${priceOk ? 'pass' : 'fail'}">${priceIcon} Preço: <b>${pricePct}¢</b> (zona: 60-85¢)</span>
        <span class="ce-criterion ${timeOk ? 'pass' : 'fail'}">${timeIcon} Tempo: <b>${timeFormatted}</b> (≤01:00)</span>
      </div>
      ${ce.failReasons.length > 0 ? `<div class="ce-fail-reasons">${ce.failReasons.map(r => `<span class="ce-fail-item">⚠ ${r}</span>`).join("")}</div>` : ""}
      <div class="ce-votes">${voteIcons}</div>
    </div>
  `;
}

function shortInd(name) {
  const map = { "TA Predict": "TA", "Heiken Ashi": "HA", "MACD": "MACD", "Delta 3m": "Δ3m",
    "Bollinger": "BB", "OBV": "OBV", "Heiken+OBV": "H+O", "Full Consensus": "FC", "5+ Agree": "5+" };
  return map[name] || name;
}

function renderExchange(name, data) {
  const id = name.toLowerCase();
  const priceEl = document.getElementById(`ex${name}Price`);
  const volEl = document.getElementById(`ex${name}Vol`);
  priceEl.textContent = data.price !== null ? `$${fmt(data.price, 0)}` : "—";
  volEl.textContent = data.volume !== null ? `Vol: ${fmt(data.volume, 1)} BTC` : "—";
}

// ── Render Analysis Panel ──
function renderAnalysis(analysis) {
  if (!analysis || analysis.error) {
    document.getElementById("analysisMeta").innerHTML = `<span class="empty-state">Sem dados de análise</span>`;
    return;
  }

  document.getElementById("analysisTotal").textContent = analysis.totalSnapshots;
  document.getElementById("analysisUp").textContent = analysis.upCount;
  document.getElementById("analysisDown").textContent = analysis.downCount;

  // Top indicators (accuracy >= 60%)
  const topContainer = document.getElementById("topIndicators");
  const top = analysis.indicators.filter(i => i.accuracy >= 60 && i.total >= 2);
  topContainer.innerHTML = top.slice(0, 10).map((ind, idx) => {
    const barClass = ind.accuracy >= 75 ? "good" : ind.accuracy >= 60 ? "mid" : "bad";
    const accClass = ind.accuracy >= 75 ? "color-up" : ind.accuracy >= 60 ? "color-warn" : "color-down";
    let changeHtml = "";
    if (ind.change !== null && Math.abs(ind.change) >= 0.5) {
      const dir = ind.change > 0 ? "up" : "down";
      const arrow = ind.change > 0 ? "▲" : "▼";
      changeHtml = `<span class="rank-change ${dir}">${arrow}${Math.abs(ind.change).toFixed(1)}</span>`;
    }
    return `
      <div class="rank-item">
        <span class="rank-num">${idx + 1}</span>
        <span class="rank-name">${ind.name}</span>
        <span class="rank-accuracy ${accClass}">${ind.accuracy.toFixed(1)}%${changeHtml}</span>
        <div class="rank-bar-container">
          <div class="rank-bar ${barClass}" style="width: ${ind.accuracy}%"></div>
        </div>
      </div>
    `;
  }).join("") || '<div class="empty-state">Poucos dados</div>';

  // Wallets — cumulative balance per indicator
  const walletContainer = document.getElementById("walletGrid");
  const wallets = analysis.wallets || [];
  window._walletData = wallets; // store for modal access
  if (wallets.length > 0) {
    walletContainer.innerHTML = wallets.map((w, idx) => {
      const balCls = w.balance >= 0 ? "color-up" : "color-down";
      const balSign = w.balance >= 0 ? "+" : "";
      const roi = w.invested > 0 ? ((w.balance / w.invested) * 100).toFixed(0) : "0";
      const roiCls = w.balance >= 0 ? "color-up" : "color-down";
      const barW = Math.min(Math.abs(w.balance) * 20, 100);
      const barCls = w.balance >= 0 ? "good" : "bad";
      return `
        <div class="wallet-item clickable" onclick="openWalletModal(${idx})">
          <div class="wallet-header">
            <span class="wallet-name">${w.name}</span>
            <span class="wallet-bal ${balCls}">${balSign}$${w.balance.toFixed(2)}</span>
          </div>
          <div class="wallet-stats">
            <span>${w.wins}✅ ${w.losses}❌</span>
            <span class="${roiCls}">${roi}% ROI</span>
          </div>
          <div class="rank-bar-container">
            <div class="rank-bar ${barCls}" style="width: ${barW}%"></div>
          </div>
        </div>
      `;
    }).join("");
  } else {
    walletContainer.innerHTML = '<div class="empty-state">Aguardando trades resolvidos...</div>';
  }

  // Candle history — descending order (most recent first), rich cards with model comparison
  const histContainer = document.getElementById("candleHistory");
  const candles = [...(analysis.candles || [])].reverse();

  // Full names for tooltip
  const modelNames = {
    FC:  "COMBO: Full Consensus (RSI + MACD + Heiken Ashi + OBV todos alinhados)",
    TA:  "TA Predict (probabilidade ajustada por tempo: Long% vs Short%)",
    "H+O": "COMBO: Heiken + OBV (Heiken Ashi + On Balance Volume convergindo)",
    "5+": "COMBO: 5+ Agree (5 ou mais indicadores apontam a mesma direção)",
    CE:  "⚡ Consensus Edge (≥7 indicadores concordam + preço 0.60-0.85)"
  };

  function modelBadge(label, m) {
    const fullName = modelNames[label] || label;
    if (!m || m.pred === null) {
      return `<span class="model-badge neutral" title="${fullName}&#10;Status: Neutro — indicadores não convergiram">⚪ <b>${label}</b></span>`;
    }
    const icon = m.hit ? "✅" : "❌";
    const cls  = m.hit ? "model-hit" : "model-miss";
    const dirCls = m.pred === "UP" ? "color-up" : "color-down";
    const dir    = m.pred === "UP" ? "↑" : "↓";
    return `<span class="model-badge ${cls}" title="${fullName}&#10;Pred: ${m.pred} → ${m.hit ? 'Acertou ✓' : 'Errou ✗'}">${icon} <b>${label}</b> <span class="${dirCls}">${dir}</span></span>`;
  }

  histContainer.innerHTML = candles.map(c => {
    const shortSlug  = (c.slug || "").replace(/.*-(\d+)$/, "#$1");
    const outcomeClass = c.outcome === "UP" ? "color-up" : "color-down";

    const fc = c.models?.fullConsensus || { pred: null, hit: null };
    const ta = c.models?.taPredict     || { pred: null, hit: null };
    const ho = c.models?.heikenObv     || { pred: null, hit: null };
    const fp = c.models?.fivePlus      || { pred: null, hit: null };
    const ce = c.models?.consensusEdge  || { pred: null, hit: null };

    // Winner tag
    let winnerHtml = "";
    if      (fc.hit === true && ta.hit !== true)  winnerHtml = '<span class="winner-tag fc" title="Full Consensus Venceu">🏆 FC</span>';
    else if (ta.hit === true && fc.hit !== true)  winnerHtml = '<span class="winner-tag ta" title="TA Predict Venceu">🏆 TA</span>';
    else if (fc.hit === true && ta.hit === true)  winnerHtml = '<span class="winner-tag tie" title="Ambos Acertaram">🤝</span>';
    else if (fc.pred === null && ta.hit === true) winnerHtml = '<span class="winner-tag ta" title="TA Predict Venceu (FC neutro)">🏆 TA</span>';
    else if (ta.pred !== null || fc.pred !== null) winnerHtml = '<span class="winner-tag miss" title="Nenhum acertou">💀</span>';

    return `
      <div class="candle-card">
        <div class="candle-card-header">
          <span class="candle-slug">${shortSlug}</span>
          <span class="candle-outcome ${outcomeClass}">${c.outcome === "UP" ? "▲" : "▼"} ${c.outcome}</span>
        </div>
        <div class="candle-models">
          ${modelBadge("FC", fc)}
          ${modelBadge("TA", ta)}
          ${modelBadge("H+O", ho)}
          ${modelBadge("5+", fp)}
          ${modelBadge("CE", ce, "Consensus Edge")}
        </div>
        <div class="candle-card-footer">
          <span class="signal-count">↑${c.upSignals} ↓${c.downSignals}</span>
          ${winnerHtml}
        </div>
      </div>
    `;
  }).join("") || '<div class="empty-state">Sem histórico</div>';

  // Changes
  const changesContainer = document.getElementById("analysisChanges");
  if (analysis.changes && analysis.changes.length > 0) {
    changesContainer.innerHTML = analysis.changes.map(ch => {
      const arrow = ch.direction === "up" ? "▲" : "▼";
      const cls = ch.direction === "up" ? "up" : "down";
      return `
        <div class="change-item">
          <span>${ch.name}</span>
          <span class="change-arrow ${cls}">${ch.from.toFixed(1)}% → ${ch.to.toFixed(1)}% ${arrow}</span>
        </div>
      `;
    }).join("");
  } else {
    changesContainer.innerHTML = '<div class="empty-state">Aguardando dois+ fechamentos...</div>';
  }
}

// ── Tab switching ──
document.querySelectorAll(".tf-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tf-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    activeTf = tab.dataset.tf;

    // Re-render realtime panel with data for this TF
    if (latestData[activeTf]) renderRealtime(latestData[activeTf]);

    // Always clear + request fresh analysis for the selected TF to avoid cross-contamination
    clearAnalysisPanel();
    requestAnalysis(activeTf);
  });
});

function clearAnalysisPanel() {
  document.getElementById("analysisTotal").textContent = "0";
  document.getElementById("analysisUp").textContent = "0";
  document.getElementById("analysisDown").textContent = "0";
  document.getElementById("topIndicators").innerHTML = '<div class="empty-state">Carregando...</div>';
  document.getElementById("badIndicators").innerHTML = '<div class="empty-state">Carregando...</div>';
  document.getElementById("candleHistory").innerHTML = '<div class="empty-state">Carregando...</div>';
  document.getElementById("analysisChanges").innerHTML = '<div class="empty-state">Aguardando dois+ fechamentos...</div>';
}

function requestAnalysis(tf) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ action: "analyze", timeframe: tf }));
}

// ── Analyze button ──
document.getElementById("btnAnalyze").addEventListener("click", () => {
  if (!ws || ws.readyState !== 1) return;
  const btn = document.getElementById("btnAnalyze");
  btn.classList.add("loading");
  btn.textContent = "⏳ Analisando...";
  requestAnalysis(activeTf);
  setTimeout(() => {
    btn.classList.remove("loading");
    btn.textContent = "🔄 Analisar";
  }, 2000);
});

// ── Wallet Modal ──
function openWalletModal(idx) {
  const wallets = window._walletData;
  if (!wallets || !wallets[idx]) return;
  const w = wallets[idx];
  const modal = document.getElementById("walletModal");
  const balCls = w.balance >= 0 ? "color-up" : "color-down";
  const balSign = w.balance >= 0 ? "+" : "";
  const roi = w.invested > 0 ? ((w.balance / w.invested) * 100).toFixed(0) : "0";

  // Aba ativa: "sim" ou "live"
  document.getElementById("modalTitle").innerHTML = `💰 ${w.name}`;

  // Resumo Simulação
  const simSummaryHtml = `
    <div class="modal-stats-row">
      <div class="modal-stat">
        <span class="modal-stat-label">Investido</span>
        <span class="modal-stat-value">$${w.invested}</span>
      </div>
      <div class="modal-stat">
        <span class="modal-stat-label">Retornado</span>
        <span class="modal-stat-value ${w.returned >= w.invested ? 'color-up' : 'color-down'}">$${w.returned.toFixed(2)}</span>
      </div>
      <div class="modal-stat">
        <span class="modal-stat-label">Lucro</span>
        <span class="modal-stat-value ${balCls}">${balSign}$${w.balance.toFixed(2)}</span>
      </div>
      <div class="modal-stat">
        <span class="modal-stat-label">ROI</span>
        <span class="modal-stat-value ${balCls}">${roi}%</span>
      </div>
      <div class="modal-stat">
        <span class="modal-stat-label">Trades</span>
        <span class="modal-stat-value">${w.wins}✅ ${w.losses}❌</span>
      </div>
    </div>
  `;

  // Resumo LIVE — painel financeiro real
  const liveOrders  = Array.from(_liveOrdersMap.values()).filter(t => (t.metadata?.indicator || "—") === w.name);
  const lSubmitted  = liveOrders.filter(t => t.status === "submitted");
  const lRejected   = liveOrders.filter(t => t.status === "rejected").length;
  const lSkipped    = liveOrders.filter(t => t.status === "skipped").length;
  const lExecuted   = lSubmitted.filter(t =>
    t.fillConfirmed === true || t.executionStatus === "filled_confirmed" || t.executionStatus === "resolved"
  );
  const lResolved   = lExecuted.filter(t => t.resolved === true);
  const lPendingExec = lSubmitted.filter(t =>
    !(t.fillConfirmed === true || t.executionStatus === "filled_confirmed" || t.executionStatus === "resolved")
  ).length;
  const lInvested   = lExecuted.reduce((s, t) => s + (t.sizeUsd || 0), 0);

  // P&L real para ordens resolvidas
  const lRealPnl    = lResolved.reduce((s, t) => s + (t.pnl || 0), 0);

  const lTotalPnl   = lRealPnl;
  const lRoi        = lInvested > 0 ? ((lTotalPnl / lInvested) * 100) : 0;
  const lLucroCls   = lTotalPnl >= 0 ? "color-up" : "color-down";
  const lLucroSign  = lTotalPnl >= 0 ? "+" : "";
  const lRoiCls     = lRoi >= 0 ? "color-up" : "color-down";
  const retornoLabel = "P&L Real";
  const liveSummaryHtml = `
    <div class="modal-stats-row">
      <div class="modal-stat">
        <span class="modal-stat-label">Investido</span>
        <span class="modal-stat-value">$${lInvested.toFixed(2)}</span>
      </div>
      <div class="modal-stat">
        <span class="modal-stat-label">${retornoLabel}</span>
        <span class="modal-stat-value ${lLucroCls}">${lLucroSign}$${lTotalPnl.toFixed(2)}</span>
      </div>
      <div class="modal-stat">
        <span class="modal-stat-label">ROI</span>
        <span class="modal-stat-value ${lRoiCls}">${lLucroSign}${lRoi.toFixed(0)}%</span>
      </div>
      <div class="modal-stat">
        <span class="modal-stat-label">Resolvidas</span>
        <span class="modal-stat-value">${lResolved.length}/${lExecuted.length}</span>
      </div>
      <div class="modal-stat">
        <span class="modal-stat-label">Ordens</span>
        <span class="modal-stat-value">${lExecuted.length}✅ ${lRejected}❌ ${lPendingExec}⏳ ${lSkipped}⏭️</span>
      </div>
    </div>
  `;

  document.getElementById("modalSummary").innerHTML = `
    <div id="appSimSummaryBlock">${simSummaryHtml}</div>
    <div id="appLiveSummaryBlock" style="display:none">${liveSummaryHtml}</div>
    <div class="modal-tabs">
      <button class="modal-tab active" id="tabSimBtn" onclick="switchWalletTab('sim')">🧪 Simulação</button>
      <button class="modal-tab" id="tabLiveBtn" onclick="switchWalletTab('live')">💰 LIVE</button>
    </div>
  `;

  // Guardar nome da carteira para uso nas abas
  window._activeWalletName = w.name;

  const history = w.history || [];
  let runningBalance = 0;
  const rows = history.map((t, i) => {
    runningBalance += t.pnl;
    const icon = t.won ? "✅" : "❌";
    const sideCls = t.side === "UP" ? "color-up" : "color-down";
    const pnlCls = t.pnl >= 0 ? "color-up" : "color-down";
    const balRunCls = runningBalance >= 0 ? "color-up" : "color-down";
    const shortSlug = (t.slug || "").replace(/.*-(\d+)$/, "#$1");
    const price = (t.entryPrice * 100).toFixed(1);
    const outCls = t.outcome === "UP" ? "color-up" : "color-down";
    const stake = t.stake || 1;
    return `<tr>
      <td>${i + 1}</td>
      <td>${shortSlug}</td>
      <td class="${sideCls}">${t.side === "UP" ? "↑" : "↓"} ${t.side}</td>
      <td>${price}¢</td>
      <td>$${stake.toFixed(2)}</td>
      <td>${t.timeLeft.toFixed(1)}m</td>
      <td class="${outCls}">${t.outcome}</td>
      <td>${icon}</td>
      <td class="${pnlCls}">${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}</td>
      <td class="${balRunCls}">${runningBalance >= 0 ? "+" : ""}$${runningBalance.toFixed(2)}</td>
    </tr>`;
  }).reverse(); // most recent first

  document.getElementById("modalBody").innerHTML = `
    <div id="tabSimPane">
      <table class="modal-table">
        <thead><tr>
          <th>#</th><th>Market</th><th>Lado</th><th>Preço</th><th>Stake</th>
          <th>T.Left</th><th>Result</th><th></th><th>P&L</th><th>Saldo</th>
        </tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>
    </div>
    <div id="tabLivePane" style="display:none">${renderLiveOrders(w.name)}</div>
  `;

  modal.style.display = "flex";
}

function switchWalletTab(tab) {
  document.getElementById("tabSimPane").style.display        = tab === "sim"  ? "" : "none";
  document.getElementById("tabLivePane").style.display       = tab === "live" ? "" : "none";
  document.getElementById("appSimSummaryBlock").style.display  = tab === "sim"  ? "" : "none";
  document.getElementById("appLiveSummaryBlock").style.display = tab === "live" ? "" : "none";
  document.getElementById("tabSimBtn").classList.toggle("active",  tab === "sim");
  document.getElementById("tabLiveBtn").classList.toggle("active", tab === "live");
  if (tab === "live") {
    // Re-render live orders com dados mais recentes
    document.getElementById("tabLivePane").innerHTML = renderLiveOrders(window._activeWalletName);
  }
}

function renderLiveOrders(indicatorName) {
  // Filtra ordens LIVE pelo nome do indicador (metadata.indicator)
  const all = Array.from(_liveOrdersMap.values());
  const orders = all.filter(t => (t.metadata?.indicator || "—") === indicatorName);

  if (orders.length === 0) {
    return `<div class="empty-state" style="padding:24px 0">Nenhuma ordem LIVE registrada para este indicador.</div>`;
  }

  // Ordenar mais recente primeiro
  orders.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const rows = orders.map((t, i) => {
    const time = t.timestamp ? new Date(t.timestamp).toLocaleTimeString("pt-BR") : "—";
    const dir = t.metadata?.direction || t.side || "—";
    const dirCls = dir === "UP" ? "color-up" : dir === "DOWN" ? "color-down" : "";
    const dirArrow = dir === "UP" ? "↑" : dir === "DOWN" ? "↓" : "";
    const price = t.price ? `${(t.price * 100).toFixed(1)}¢` : "—";
    const shares = t.shares ? t.shares.toFixed(2) : "—";
    const usd = t.sizeUsd ? `$${t.sizeUsd.toFixed(2)}` : "—";
    const tf = t.metadata?.timeframe || "?";
    const matchedSize = Number.isFinite(Number(t.sizeMatched ?? t.filledSize))
      ? Number(t.sizeMatched ?? t.filledSize)
      : 0;
    let statusCls = "dry-status-error";
    let statusText = t.status || "?";
    if (t.resolved === true) {
      statusCls  = t.won ? "dry-status-live" : "dry-status-error";
      const pnlSign = t.pnl >= 0 ? "+" : "";
      statusText = t.won
        ? `🏆 GANHOU ${pnlSign}$${(t.pnl || 0).toFixed(2)}`
        : `💸 PERDEU -$${Math.abs(t.pnl || 0).toFixed(2)}`;
    } else if (t.fillConfirmed === true || t.executionStatus === "filled_confirmed") {
      statusCls = "dry-status-live";
      statusText = "✅ executada";
    } else if (t.executionStatus === "partial" || matchedSize > 0) {
      statusCls = "dry-status-live";
      statusText = `◐ parcial ${matchedSize.toFixed(2)}`;
    } else if (t.status === "submitted") { statusCls = "dry-status-live"; statusText = "⏳ enviada"; }
    else if (t.status === "skipped") { statusCls = "dry-status-dry"; statusText = "⏭️ skipped"; }
    else if (t.status === "rejected") { statusCls = "dry-status-error"; statusText = "❌ rejected"; }
    else if (t.status === "error") { statusCls = "dry-status-error"; statusText = "⚠️ error"; }
    const shortToken = t.tokenId ? t.tokenId.substring(0, 10) + "…" : "—";
    return `<tr>
      <td>${i + 1}</td>
      <td>${time}</td>
      <td><span class="dry-tf-badge">${tf}</span></td>
      <td class="${dirCls}">${dirArrow} ${dir}</td>
      <td>${price}</td>
      <td>${shares}</td>
      <td>${usd}</td>
      <td class="dry-token-cell" title="${t.tokenId || ''}">${shortToken}</td>
      <td><span class="dry-status ${statusCls}">${statusText}</span></td>
    </tr>`;
  }).join("");

  return `
    <table class="modal-table">
      <thead><tr>
        <th>#</th><th>Hora</th><th>TF</th><th>Lado</th><th>Preço</th><th>Shares</th>
        <th>USD</th><th>Token</th><th>Status</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function closeWalletModal() {
  document.getElementById("walletModal").style.display = "none";
}

// Close on overlay click or ESC
document.getElementById("walletModal").addEventListener("click", (e) => {
  if (e.target.id === "walletModal") closeWalletModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeWalletModal();
});

// ── Boot ──
connect();
