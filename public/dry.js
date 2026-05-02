/**
 * dry.js — Client-side logic for the Scalp Monitor trading page.
 * Connects to the same WebSocket as the main dashboard,
 * but focuses on showing Scalp Monitor (SIM) trade activity from PolyTrader.
 */

// ── State ──
let activeTf = "5m";
let latestData = { "5m": null, "15m": null };
let latestDataUpdatedAt = { "5m": null, "15m": null };
let latestAnalysis = { "5m": null, "15m": null };
let latestEngineErrors = { "5m": null, "15m": null };
let ws = null;
let reconnectTimer = null;
/** 60s analyze refresh on Scalp Monitor only; cleared on reconnect. */
let analyzeRefreshIntervalId = null;
/** Dedicated settings page (`settings.html`); WebSocket handles config only. */
const isSettingsPage = document.body?.dataset?.page === "settings";
let tradeLog = []; // Accumulated trade log (ALL timeframes)
let seenTradeIds = new Set();
let walletData = { "5m": [], "15m": [] }; // Stored per-timeframe for modal access
let scalpWalletData = {}; // Stored by indicator name for scalp wallet modal
let currentDryRunMode = true; // Mirrors polyTrader.dryRun from server payload
const MODAL_HISTORY_LIMIT = 500;

function clientLog(event, data = {}, level = "warn") {
  const payload = {
    event,
    tf: activeTf,
    level,
    data,
    ts: new Date().toISOString()
  };
  try {
    fetch("/api/client-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => {});
  } catch {
    // ignore logging failures
  }
  const logger = level === "error" ? console.error : level === "info" ? console.log : console.warn;
  logger(`[client-log] ${event}`, data);
}

let lastClientHeartbeat = performance.now();
setInterval(() => {
  const now = performance.now();
  const lagMs = now - lastClientHeartbeat - 2_000;
  if (lagMs > 1_500) {
    clientLog("event_loop_lag", {
      lagMs: Math.round(lagMs),
      activeTf,
      lastGoodAt: latestDataUpdatedAt[activeTf]
    }, "warn");
  }
  lastClientHeartbeat = now;
}, 2_000);

// ── Helpers ──
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

const FEED_STATUS_LABELS = {
  ok: "OK",
  down: "FORA",
  stale: "VELHO",
  unknown: "—",
  misconfigured: "SEM RPC",
  degraded: "LENTO"
};

function feedStatusLabel(status) {
  return FEED_STATUS_LABELS[status] || String(status || "—").toUpperCase();
}

function feedStatusClass(status) {
  if (status === "ok") return "color-up";
  if (status === "down" || status === "misconfigured") return "color-down";
  if (status === "stale" || status === "degraded") return "color-warn";
  return "color-dim";
}

function renderFeedSourceRow(elId, entry) {
  const el = document.getElementById(elId);
  if (!el || !entry) return;
  const detail = entry.detail ? String(entry.detail) : "";
  const bits = [];
  bits.push(feedStatusLabel(entry.status));
  if (entry.source) bits.push(String(entry.source));
  if (entry.ageMs != null && Number.isFinite(Number(entry.ageMs))) {
    bits.push(`há ${(Number(entry.ageMs) / 1000).toFixed(0)}s`);
  } else if (entry.latencyMs != null && Number.isFinite(Number(entry.latencyMs))) {
    bits.push(`${Math.round(Number(entry.latencyMs))}ms`);
  }
  const line = bits.join(" · ");
  el.textContent = line;
  el.className = `feed-status ${feedStatusClass(entry.status)}`;
  const ageHint = entry.ageMs != null && Number.isFinite(Number(entry.ageMs))
    ? "Tempo desde o último fetch REST bem-sucedido desta fonte — não é o intervalo de atualização das velas 1m usadas nos indicadores TA (isso vem de INDICATOR_CANDLE_SOURCE / BINANCE_KLINES_CACHE_MS)."
    : "";
  el.title = [detail, ageHint, line].filter(Boolean).join("\n");
}

/** Atualiza badges BN/OKX nas linhas de indicadores (fonte das velas 1m). */
function applyTaCandleSourceBadges(srcRaw) {
  const src = srcRaw || "binance";
  const grid = document.getElementById("dryIndicatorsGrid");
  if (grid) grid.dataset.taSource = src;
  const slug = src === "okx" ? "okx" : src === "binance_fallback" ? "fb" : "bn";
  const label = src === "okx" ? "OKX (BTC-USDT)" : src === "binance_fallback" ? "Binance (fallback)" : "Binance";
  document.querySelectorAll("#dryIndicatorsGrid [data-role=\"ta-candle-source\"]").forEach((el) => {
    el.className = `ind-src-badge src-${slug}`;
    el.title = `Velas 1m para estes indicadores: ${label}`;
    el.setAttribute("aria-label", `Fonte velas TA: ${label}`);
  });
}

function marketSlugTooltip(slug) {
  if (!slug) return "Slug do mercado na Polymarket.";
  const parts = String(slug).split("-");
  const tail = Number(parts[parts.length - 1]);
  if (!Number.isFinite(tail) || tail < 1_000_000_000) {
    return "Identificador do mercado (Polymarket). Não indica “última atualização” dos indicadores.";
  }
  const iso = new Date(tail * 1000).toISOString();
  return `O número final do slug é o início da janela do mercado (UTC ≈ ${iso}). Não é o tempo desde a última atualização dos indicadores.`;
}

function shortToken(token) {
  const s = String(token || "");
  if (!s) return "—";
  if (s.length <= 22) return s;
  return `${s.slice(0, 10)}…${s.slice(-8)}`;
}

function resolveSimTokenId(simTrade, tf, indicatorName) {
  const directToken = simTrade?.tokenId || simTrade?.token_id || "";
  if (directToken) return directToken;

  // Frontend safety-net: if CSV/history row has no token, recover it from
  // order log using the closest matching order for this wallet trade.
  const slug = simTrade?.slug || "";
  const side = simTrade?.side || "";
  const tradeTs = Date.parse(simTrade?.ts || "");

  const candidates = tradeLog.filter(o => {
    const md = o?.metadata || {};
    if (!o?.tokenId) return false;
    if ((md.indicator || "") !== (indicatorName || "")) return false;
    if ((md.marketSlug || "") !== slug) return false;
    if ((md.direction || "") !== side) return false;
    if ((o._timeframe || md.timeframe || "") !== tf) return false;
    return true;
  });

  if (candidates.length === 0) return "";
  if (!Number.isFinite(tradeTs)) return candidates[candidates.length - 1]?.tokenId || "";

  let best = candidates[0];
  let bestDelta = Infinity;
  for (const c of candidates) {
    const ts = Number(c?.timestamp) || 0;
    const delta = Math.abs(ts - tradeTs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = c;
    }
  }
  return best?.tokenId || "";
}

function timeStr(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── WebSocket ──
function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    const conn = document.getElementById("connectionStatus");
    if (conn) conn.className = "status-dot connected";
    if (isSettingsPage) {
      ws.send(JSON.stringify({ action: "getConfig" }));
    } else {
      ws.send(JSON.stringify({ action: "analyze", timeframe: "5m",  mode: "DRY_RUN" }));
      ws.send(JSON.stringify({ action: "analyze", timeframe: "15m", mode: "DRY_RUN" }));
      if (analyzeRefreshIntervalId) clearInterval(analyzeRefreshIntervalId);
      analyzeRefreshIntervalId = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: "analyze", timeframe: "5m",  mode: "DRY_RUN" }));
          ws.send(JSON.stringify({ action: "analyze", timeframe: "15m", mode: "DRY_RUN" }));
        }
      }, 60_000);
    }
  };

  ws.onclose = () => {
    const conn = document.getElementById("connectionStatus");
    if (conn) conn.className = "status-dot disconnected";
    clientLog("ws_close", { activeTf, lastGoodAt: latestDataUpdatedAt[activeTf] }, "warn");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    clientLog("ws_error", { activeTf, lastGoodAt: latestDataUpdatedAt[activeTf] }, "error");
    ws.close();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "config" && msg.data) {
        currentConfig = msg.data;
        updateTradingBadge(msg.data);
        if (document.getElementById("configDryRunToggle")) populateConfigModal(msg.data);
      }
      if (isSettingsPage) return;

      if (msg.type === "tick" && msg.data) {
        latestEngineErrors[msg.timeframe] = null;
        latestData[msg.timeframe] = msg.data;
        latestDataUpdatedAt[msg.timeframe] = Date.now();
        if (msg.timeframe === activeTf) renderDataWarning();
        // NOTE: Do NOT use msg.analysis from tick — it's unfiltered (all modes).
        // Wallet data comes from the filtered WS "analysis" response only.
        // Always ingest trades from ALL timeframes
        if (msg.data.trading) {
          ingestTrades(msg.data.trading.recentTrades || [], msg.timeframe);
        }
        // Scalp cards / strip show BOTH timeframes regardless of active tab.
        renderScalpAll();
        // Only render the rest if active timeframe
        if (msg.timeframe === activeTf) {
          renderAll(msg.data);
        }
      }
      if (msg.type === "analysis" && msg.data) {
        // Store simulation analysis payloads
        if (!msg.mode || msg.mode === "DRY_RUN") {
          latestAnalysis[msg.timeframe] = msg.data;
          // Always render to the timeframe's own container (side-by-side)
          renderWallets(msg.data, msg.timeframe);
        }
      }
      if (msg.type === "error") {
        latestEngineErrors[msg.timeframe] = msg.error || "Erro desconhecido";
        if (msg.timeframe === activeTf) renderTickError(msg);
      }
      if (msg.type === "engine_status") {
        const message = msg.message || "Loop do servidor lento/travado";
        const targets = msg.timeframe ? [msg.timeframe] : ["5m", "15m"];
        for (const tf of targets) latestEngineErrors[tf] = message;
        renderDataWarning();
        clientLog("engine_status", {
          status: msg.status,
          message,
          ageMs: msg.ageMs,
          loopId: msg.loopId
        }, msg.status === "stalled" ? "error" : "warn");
      }
    } catch { /* ignore */ }
  };
}

// ── Main Render ──
function compactErrorMessage(error) {
  const text = String(error || "Erro desconhecido").replace(/\s+/g, " ").trim();
  if (text.includes("451") && text.toLowerCase().includes("binance")) {
    return "Binance bloqueada por região (HTTP 451). Tentando fallback...";
  }
  if (text.toLowerCase().includes("fetch failed")) {
    const rawDetail = text.replace(/fetch failed\s*\|?\s*/i, "").trim();
    const detail = rawDetail.length > 160 ? `${rawDetail.slice(0, 160)}...` : rawDetail;
    const suffix = detail ? ` Detalhe: ${detail}` : "";
    return `Falha temporária ao buscar dados externos. Pode ser API, VPN, proxy ou DNS. Mantendo o último dado bom e tentando novamente.${suffix}`;
  }
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

function fmtClock(ms) {
  if (!ms) return "sem dado anterior";
  return new Date(ms).toLocaleTimeString("pt-BR", { hour12: false });
}

function renderDataWarning() {
  const el = document.getElementById("dryDataWarning");
  if (!el) return;
  const error = latestEngineErrors[activeTf];
  if (!error) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  const lastGood = latestDataUpdatedAt[activeTf];
  el.hidden = false;
  el.innerHTML = `<b>${activeTf}</b>: ${escapeAttr(compactErrorMessage(error))} <span>Último dado bom: ${escapeAttr(fmtClock(lastGood))}</span>`;
}

function renderTickError(msg) {
  const text = compactErrorMessage(msg.error);
  renderDataWarning();
  if (latestData[msg.timeframe]) {
    return;
  }
  const titleEl = document.getElementById("dryDashTitle");
  const slugEl = document.getElementById("dryDashSlug");
  const marketEl = document.getElementById("dryMarket");
  const timeLeftEl = document.getElementById("dryTimeLeft");
  const dashTimeLeftEl = document.getElementById("dryDashTimeLeft");
  const sessionEl = document.getElementById("sessionInfo");
  const gridEl = document.getElementById("dryUnifiedGrid");

  if (titleEl) titleEl.textContent = `Erro de dados ${msg.timeframe || ""}`;
  if (slugEl) slugEl.textContent = text;
  if (marketEl) marketEl.textContent = text;
  if (timeLeftEl) timeLeftEl.textContent = "--:--";
  if (dashTimeLeftEl) dashTimeLeftEl.textContent = "--:--";
  if (sessionEl) sessionEl.textContent = text;
  if (gridEl && !latestData[msg.timeframe]) {
    gridEl.innerHTML = `<span class="color-down">${escapeAttr(text)}</span>`;
  }
}

function renderAll(d) {
  // Session info
  if (d.session) {
    document.getElementById("sessionInfo").textContent = `${d.session.time} | ${d.session.name}`;
  }

  // Market info
  if (d.market) {
    document.getElementById("dryMarket").textContent = d.market.slug || "—";
    const timerEl = document.getElementById("dryTimeLeft");
    timerEl.textContent = d.market.timeLeftFormatted || "--:--";
    const tl = d.market.timeLeft;
    const wm = d.market.windowMinutes || 5;
    timerEl.className = "dry-stat-value timer " + (tl > wm * 0.66 ? "green" : tl > wm * 0.3 ? "yellow" : "red");
  }

  // Trading status
  if (d.trading) {
    renderTradingStats(d.trading);
    renderTradingBadge(d.trading);
  }

  // Dashboard indicators (replicated from main dashboard)
  renderDashIndicators(d);

  // Simulation data
  if (d.simulation) {
    renderUnifiedGrid(d.simulation);
    if (d.simulation.lastResolved) {
      renderLastResolved(d.simulation.lastResolved);
    }
    renderCeStatus(d.simulation.ceStatus);
  }
}

const PTB_PRICE_DECIMALS = 2;

const PTB_COMPARE_ROWS = [
  { key: "event_page", label: "Página / _next/data" },
  { key: "chainlink_stream_open", label: "Stream Polymarket (≥ abertura)" },
  { key: "chainlink_window", label: "Chainlink on-chain Polygon (slug)" },
  { key: "gamma_title", label: "Gamma · título (parse)" },
  { key: "gamma_walk", label: "Gamma · walk (heurística)" },
  { key: "chainlink_live_latch", label: "Latch pós-warmup (legado)" },
  { key: "chainlink_live_now", label: "Chainlink stream (agora)" }
];

function fmtPtbCandidate(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `$${fmt(n, PTB_PRICE_DECIMALS)}`;
}

/** Painel comparativo: mesmas chaves que `ptbSource` no payload do Scalp. */
function renderPtbComparePanel(poly) {
  const el = document.getElementById("dryPtbCompare");
  if (!el) return;
  const c = poly.ptbCandidates;
  if (!c || typeof c !== "object") {
    el.innerHTML = "";
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const chosenKey = String(poly.ptbSource || "");
  const warmup = poly.ptbWarmupActive === true;
  const msLeft = Number(poly.ptbWarmupMsRemaining) || 0;
  const warmLine = warmup
    ? `<div class="dry-ptb-warmup">Warmup: walk + latch ao vivo off · ~${Math.ceil(msLeft / 1000)}s</div>`
    : "";

  const body = PTB_COMPARE_ROWS.map(({ key, label }) => {
    const val = c[key];
    const active = Boolean(chosenKey && chosenKey === key);
    const cls = active ? "dry-ptb-row dry-ptb-row--active" : "dry-ptb-row";
    return `<div class="${cls}" data-ptb-source="${escapeAttr(key)}"><span class="dry-ptb-label">${escapeAttr(label)}</span><span class="dry-ptb-val">${fmtPtbCandidate(val)}</span></div>`;
  }).join("");

  const foot = poly.ptbCompareFootnote
    ? `<div class="dry-ptb-footnote">${escapeAttr(poly.ptbCompareFootnote)}</div>`
    : "";

  el.innerHTML = `
    <div class="dry-ptb-compare-head">Comparar PTB <span class="dry-ptb-picked">motor: <code>${escapeAttr(chosenKey || "—")}</code></span></div>
    ${warmLine}
    <div class="dry-ptb-grid">${body}</div>
    ${foot}
  `;
}

// ── Dashboard Indicators (mirrors main dashboard panel) ──
function renderDashIndicators(d) {
  if (d.market) {
    const titleEl = document.getElementById("dryDashTitle");
    if (titleEl) titleEl.textContent = d.market.title || "Connecting...";
    const slugEl = document.getElementById("dryDashSlug");
    if (slugEl) {
      slugEl.textContent = d.market.slug || "—";
      slugEl.title = marketSlugTooltip(d.market.slug || "");
    }
    const tlEl = document.getElementById("dryDashTimeLeft");
    if (tlEl) {
      tlEl.textContent = d.market.timeLeftFormatted || "--:--";
      const tl = d.market.timeLeft;
      const wm = d.market.windowMinutes || 5;
      tlEl.className = "timer " + (tl > wm * 0.66 ? "green" : tl > wm * 0.3 ? "yellow" : "red");
    }
  }

  const ind = d.indicators;
  if (ind) {
    if (ind.taPredict) {
      const longPct = ind.taPredict.longPct !== null ? (ind.taPredict.longPct * 100).toFixed(0) : "?";
      const shortPct = ind.taPredict.shortPct !== null ? (ind.taPredict.shortPct * 100).toFixed(0) : "?";
      const taIsBull = ind.taPredict.longPct > ind.taPredict.shortPct;
      setHTML("dval-taPredict",
        `<span class="${taIsBull ? "color-up" : "color-down"}">LONG ${longPct}%</span> / <span class="${taIsBull ? "color-down" : "color-up"}">SHORT ${shortPct}%</span>`);
    }
    if (ind.heikenAshi) {
      const hColor = ind.heikenAshi.color || "—";
      const hClass = hColor === "green" ? "color-up" : hColor === "red" ? "color-down" : "color-dim";
      setHTML("dval-heiken", `<span class="${hClass}">${hColor} x${ind.heikenAshi.streak || "?"}</span>`);
    }
    if (ind.rsi) {
      const rsiVal = ind.rsi.value !== null ? ind.rsi.value.toFixed(1) : "—";
      const rsiArrow = ind.rsi.slope > 0 ? " ↑" : ind.rsi.slope < 0 ? " ↓" : "";
      const rsiClass = ind.rsi.value > 70 ? "color-down" : ind.rsi.value < 30 ? "color-up" : "color-neutral";
      const rsiOBOS = ind.rsi.value > 70 ? " OB" : ind.rsi.value < 30 ? " OS" : "";
      setHTML("dval-rsi", `<span class="${rsiClass}">${rsiVal}${rsiArrow}${rsiOBOS}</span>`);
    }
    if (ind.macd) {
      const macdClass = ind.macd.label.includes("bullish") ? "color-up" : ind.macd.label.includes("bearish") ? "color-down" : "color-dim";
      setHTML("dval-macd", `<span class="${macdClass}">${ind.macd.label}</span>`);
    }
    if (ind.delta) {
      const d1 = fmtDelta(ind.delta.d1m, ind.delta.latestClose);
      const d3 = fmtDelta(ind.delta.d3m, ind.delta.latestClose);
      setHTML("dval-delta",
        `<span class="${colorClass(ind.delta.d1m)}">${d1}</span> | <span class="${colorClass(ind.delta.d3m)}">${d3}</span>`);
    }
    if (ind.vwap) {
      const distPct = ind.vwap.distance !== null ? (ind.vwap.distance * 100).toFixed(2) : "?";
      const slopeClass = ind.vwap.slopeLabel === "UP" ? "color-up" : ind.vwap.slopeLabel === "DOWN" ? "color-down" : "color-dim";
      setHTML("dval-vwap", `${fmt(ind.vwap.price, 0)} (${distPct}%) | <span class="${slopeClass}">slope ${ind.vwap.slopeLabel}</span>`);
    }
    if (ind.bollinger) {
      const pctBVal = ind.bollinger.pctB !== null ? ind.bollinger.pctB.toFixed(2) : "—";
      const bwVal = ind.bollinger.bandwidth !== null ? (ind.bollinger.bandwidth * 100).toFixed(2) : "—";
      const sqz = ind.bollinger.isSqueeze ? ' <span class="color-warn">SQUEEZE</span>' : "";
      setHTML("dval-bollinger", `${pctBVal} (%B) | BW ${bwVal}%${sqz}`);
    }
    if (ind.stochRsi) {
      const kVal = Number.isFinite(Number(ind.stochRsi.k)) ? Math.round(Number(ind.stochRsi.k)) : "—";
      const dVal = Number.isFinite(Number(ind.stochRsi.d)) ? Math.round(Number(ind.stochRsi.d)) : "—";
      const tag = ind.stochRsi.overbought ? ' <span class="color-down">OB</span>' : ind.stochRsi.oversold ? ' <span class="color-up">OS</span>' : "";
      setHTML("dval-stochRsi", `K ${kVal} / D ${dVal}${tag}${ind.stochRsi.crossLabel || ""}`);
    }
    if (ind.emaCross) {
      const lbl = ind.emaCross.label || "—";
      const cls = lbl.includes("bullish") || lbl.includes("↑") ? "color-up"
                : lbl.includes("bearish") || lbl.includes("↓") ? "color-down" : "color-dim";
      const sp = ind.emaCross.spread !== null ? ` ($${Math.abs(ind.emaCross.spread).toFixed(0)})` : "";
      setHTML("dval-ema", `<span class="${cls}">${lbl}${sp}</span>`);
    }
    if (ind.obv) {
      const dir = ind.obv.slope > 0 ? "↑" : ind.obv.slope < 0 ? "↓" : "→";
      const lbl = ind.obv.divergence || "confirming";
      const cls = lbl.includes("DIV") ? "color-warn" : ind.obv.slope > 0 ? "color-up" : ind.obv.slope < 0 ? "color-down" : "color-dim";
      setHTML("dval-obv", `<span class="${cls}">${dir} ${lbl}</span>`);
    }
    if (ind.atr) {
      const v = ind.atr.value !== null ? `$${ind.atr.value.toFixed(2)}` : "—";
      const cls = ind.atr.level === "high" ? "color-warn" : ind.atr.level === "low" ? "color-neutral" : "";
      setHTML("dval-atr", `<span class="${cls}">${v} (${ind.atr.level || "—"})</span>`);
    }
  }

  const poly = d.polymarket;
  if (poly) {
    setText("dpolyUp", fmtPolyPrice(poly.upPrice));
    setText("dpolyDown", fmtPolyPrice(poly.downPrice));
    setText("dpolyLiquidity", fmt(poly.liquidity, 0));
    setText("dpriceToBeat", poly.priceToBeat !== null ? `$${fmt(poly.priceToBeat, PTB_PRICE_DECIMALS)}` : "—");
    renderPtbComparePanel(poly);
    const cpVal = poly.currentPrice !== null ? `$${fmt(poly.currentPrice, 2)}` : "—";
    const deltaStr = poly.priceDelta !== null ? ` (${poly.priceDelta > 0 ? "+" : ""}$${poly.priceDelta.toFixed(2)})` : "";
    const cpClass = poly.priceDelta > 0 ? "color-up" : poly.priceDelta < 0 ? "color-down" : "";
    setHTML("dcurrentPrice", `<span class="${cpClass}">${cpVal}${deltaStr}</span>`);
    if (!poly.currentPriceFresh) {
      setHTML("dcurrentPrice", `<span class="color-warn">STALE</span>`);
    }
  }

  const ex = d.exchanges;
  if (ex) {
    renderDashExchange("Binance", ex.binance);
    renderDashExchange("Coinbase", ex.coinbase);
    renderDashExchange("Kraken", ex.kraken);
    renderDashExchange("Bybit", ex.bybit);
    renderDashExchange("Okx", ex.okx);
  }

  const oracle = d.oracle;
  if (oracle) {
    setText("doracleLag", oracle.lagMs !== null ? `${(oracle.lagMs / 1000).toFixed(1)}s` : "—");
    setText("doracleSpread", oracle.spreadPct !== null ? fmtPct(oracle.spreadPct, 3) : "—");
    const src = oracle.indicatorCandleSource || "binance";
    const labEl = document.getElementById("dvsOracleLabel");
    if (labEl) {
      labEl.textContent = src === "okx" ? "OKX vs Oracle" : src === "binance_fallback" ? "Bin vs Oracle (fallback)" : "Bin vs Oracle";
    }
    const bvo = src === "okx" ? oracle.taVsOracle : oracle.binanceVsOracle;
    const bvoEl = document.getElementById("dbinVsOracle");
    if (bvoEl) {
      bvoEl.textContent = bvo !== null ? `$${bvo > 0 ? "+" : ""}${bvo.toFixed(2)}` : "—";
      bvoEl.className = `value ${colorClass(bvo)}`;
    }
  }

  const feeds = d.feedSources;
  if (feeds) {
    renderFeedSourceRow("dfeedBinanceCom", feeds.binanceCom);
    renderFeedSourceRow("dfeedBinanceUs", feeds.binanceUs);
    renderFeedSourceRow("dfeedCoinbaseTicker", feeds.coinbaseTicker);
    renderFeedSourceRow("dfeedKrakenTicker", feeds.krakenTicker);
    renderFeedSourceRow("dfeedBybitTicker", feeds.bybitTicker);
    renderFeedSourceRow("dfeedOkxTicker", feeds.okxTicker);
    renderFeedSourceRow("dfeedChainlink", feeds.chainlink);
  }

  applyTaCandleSourceBadges(d.oracle?.indicatorCandleSource);
}

function renderDashExchange(name, data) {
  if (!data) return;
  const priceEl = document.getElementById(`dex${name}Price`);
  const volEl = document.getElementById(`dex${name}Vol`);
  if (priceEl) priceEl.textContent = data.price !== null ? `$${fmt(data.price, 0)}` : "—";
  if (volEl) volEl.textContent = data.volume !== null ? `Vol: ${fmt(data.volume, 1)} BTC` : "—";
}

function setText(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }
function setHTML(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }

// ── Trading Stats ──
function renderTradingStats(t) {
  const modeEl = document.getElementById("dryMode");
  modeEl.textContent = t.dryRun ? "📡 SIM" : "💰 LIVE";
  modeEl.style.color = t.dryRun ? "#ffd740" : "#00e676";

  document.getElementById("dryTotalOrders").textContent = t.totalTradesPlaced || 0;
  document.getElementById("dryMaxStake").textContent = `$${t.maxStake || 0}`;

  const balEl = document.getElementById("dryBalance");
  if (t.usdcBalance !== null && t.usdcBalance !== undefined) {
    balEl.textContent = `$${t.usdcBalance.toFixed(2)}`;
    balEl.style.color = "#00e676";
  } else {
    balEl.textContent = t.dryRun ? "N/A (SIM)" : "—";
    balEl.style.color = "";
  }
}

// ── Trading Badge ──
function renderTradingBadge(trading) {
  const badge = document.getElementById("tradingBadge");
  if (!badge || !trading) return;
  currentDryRunMode = trading.dryRun !== false;
  if (trading.dryRun) {
    badge.textContent = `📡 SIM (${trading.totalTradesPlaced || 0})`;
    badge.className = "trading-badge dry-run";
  } else {
    const bal = trading.usdcBalance !== null ? `$${trading.usdcBalance.toFixed(2)}` : "—";
    badge.textContent = `💰 LIVE ${bal}`;
    badge.className = "trading-badge live";
  }
}

// ── Ingest trades from polyTrader.recentTrades ──
function ingestTrades(trades, timeframe) {
  if (!Array.isArray(trades)) return;
  let changed = false;
  for (const trade of trades) {
    const id = trade.orderId || `${trade.timestamp}_${trade.metadata?.indicator}`;
    trade._timeframe = trade.metadata?.timeframe || timeframe || "?";

    if (seenTradeIds.has(id)) {
      // Update existing record in-place (resolved/pnl/fillStatus may have changed)
      const idx = tradeLog.findIndex(t =>
        (t.orderId || `${t.timestamp}_${t.metadata?.indicator}`) === id
      );
      if (idx >= 0) {
        const prev = tradeLog[idx];
        const wasResolved = prev.resolved;
        Object.assign(prev, trade);
        if (!wasResolved && prev.resolved) changed = true; // newly resolved
      }
      continue;
    }

    seenTradeIds.add(id);
    tradeLog.unshift(trade); // newest first
    changed = true;
  }
  if (changed) {
    renderTradeLog();
  }
}

// ── Trade Log Table ──
function renderTradeLog() {
  const tbody = document.getElementById("dryLogBody");
  if (!tbody) return;

  // Sort by timestamp DESC (most recent first), independent of insertion order
  const sorted = tradeLog.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  tbody.innerHTML = sorted.map((t, i) => {
    const ts = t.timestamp ? new Date(t.timestamp) : null;
    const date = ts ? ts.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "—";
    const time = ts ? ts.toLocaleTimeString("pt-BR", { hour12: false }) : "—";
    const indicator = t.metadata?.indicator || "—";
    const direction = t.metadata?.direction || t.side;
    const dirClass = direction === "UP" ? "color-up" : direction === "DOWN" ? "color-down" : "";
    const dirArrow = direction === "UP" ? "↑" : direction === "DOWN" ? "↓" : "";
    const price = t.price ? `${(t.price * 100).toFixed(1)}¢` : "—";
    const shares = t.shares ? t.shares.toFixed(2) : "—";
    const usd = t.sizeUsd ? `$${t.sizeUsd.toFixed(2)}` : "—";
    const token = t.tokenId ? t.tokenId.substring(0, 10) + "…" : "—";
    const matchedSize = Number.isFinite(Number(t.sizeMatched ?? t.filledSize))
      ? Number(t.sizeMatched ?? t.filledSize)
      : 0;
    let statusCls = t.dryRun ? "dry-status-dry" : "dry-status-error";
    let statusText = t.dryRun ? "DRY" : t.status || "?";
    if (!t.dryRun) {
      if (t.resolved === true) {
        if (t.unfilled === true) {
          statusCls = "dry-status-dry";
          statusText = "expirada";
        } else {
          statusCls = t.won ? "dry-status-live" : "dry-status-error";
          statusText = t.won ? "GANHOU" : "PERDEU";
        }
      } else if (t.fillConfirmed === true || t.executionStatus === "filled_confirmed") {
        statusCls = "dry-status-live";
        statusText = "executada";
      } else if (t.executionStatus === "partial" || matchedSize > 0) {
        statusCls = "dry-status-live";
        statusText = `parcial ${matchedSize.toFixed(2)}`;
      } else if (t.status === "submitted") {
        statusCls = "dry-status-live";
        statusText = "enviada";
      }
    }

    // Result + P&L (resolved orders only — both filled and unfilled)
    let resultIcon = "—";
    let resultCls = "dim";
    let pnlCell = "—";
    let pnlCls = "dim";
    if (t.resolved === true) {
      resultIcon = t.won ? "✅" : "❌";
      resultCls = t.won ? "color-up" : "color-down";
      const pnl = Number(t.pnl) || 0;
      pnlCls = pnl > 0 ? "color-up" : pnl < 0 ? "color-down" : "dim";
      pnlCell = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
    }

    const isNew = i < 3 ? "new-entry" : "";
    const tf = t._timeframe || t.metadata?.timeframe || "?";

    return `<tr class="${isNew}">
      <td>${date}</td>
      <td>${time}</td>
      <td><span class="dry-tf-badge">${tf}</span></td>
      <td><strong>${indicator}</strong></td>
      <td class="${dirClass}">${dirArrow} ${direction}</td>
      <td>${price}</td>
      <td>${shares}</td>
      <td>${usd}</td>
      <td class="dry-token-cell" title="${t.tokenId || ''}">${token}</td>
      <td><span class="dry-status ${statusCls}">${statusText}</span></td>
      <td class="${resultCls}">${resultIcon}</td>
      <td class="${pnlCls}">${pnlCell}</td>
    </tr>`;
  }).join("");

  document.getElementById("dryLogCount").textContent = `${tradeLog.length} ordens registradas`;
}

// ── Unified Positions + Indicators Grid ──
const SCALP_INDICATOR_NAMES = ["Scalp Force 5m", "Scalp Force 15m"];
const ALL_INDICATORS = [
  "Full Consensus", "Heiken+OBV", "5+ Agree",
  "TA Predict", "Heiken Ashi", "OBV", "MACD", "Delta 3m", "Bollinger",
  "Consensus Edge",
  ...SCALP_INDICATOR_NAMES
];
// Legacy unified grid skips scalp cards because they render in their
// own dedicated section above.
const LEGACY_INDICATORS = ALL_INDICATORS.filter(n => !SCALP_INDICATOR_NAMES.includes(n));
function isScalpIndicatorName(name) { return SCALP_INDICATOR_NAMES.includes(name); }

function renderUnifiedGrid(sim) {
  const container = document.getElementById("dryUnifiedGrid");
  if (!container) return;

  const count = sim.activated || 0;
  // Count legacy indicators only — scalp cards are rendered separately.
  const total = LEGACY_INDICATORS.length;
  const counterEl = document.getElementById("dryIndicatorCount");
  if (counterEl) counterEl.textContent = `${count} / ${total}`;

  const activeMap = {};
  if (sim.positions) {
    for (const p of sim.positions) {
      if (isScalpIndicatorName(p.name)) continue;
      activeMap[p.name] = p;
    }
  }

  container.innerHTML = LEGACY_INDICATORS.map(name => {
    const pos = activeMap[name];
    if (pos) {
      // Active — show colored card with trade details
      const cls = pos.side === "UP" ? "up" : "down";
      const arrow = pos.side === "UP" ? "↑" : "↓";
      const price = (pos.entryPrice * 100).toFixed(1);
      const stake = pos.stake || 1;
      return `<div class="dry-unified-card active ${cls}" title="${name}: ${pos.side} @ ${price}¢ · $${stake.toFixed(2)}">
        <span class="dry-unified-name">${name}</span>
        <span class="dry-unified-detail">${arrow} ${pos.side} @ ${price}¢ · $${stake.toFixed(2)}</span>
      </div>`;
    } else {
      // Inactive — gray card
      return `<div class="dry-unified-card inactive" title="${name}: aguardando sinal">
        <span class="dry-unified-name">${name}</span>
      </div>`;
    }
  }).join("");
}

// ── Scalp: P&L do mercado atual (slug) + última saída — espelha o log de ordens ──
function scalpHistoryForSlug(history, slug) {
  const s = String(slug || "");
  if (!s || !Array.isArray(history)) return [];
  return history.filter((h) => String(h.slug || "") === s);
}

function scalpLastClosedForSlug(history, slug) {
  const rows = scalpHistoryForSlug(history, slug);
  if (!rows.length) return null;
  return rows.reduce((best, h) => (String(h.ts || "") > String(best.ts || "") ? h : best));
}

/** Únicos slugs ordenados do mais recente fechamento ao mais antigo (hist já por trade). */
const SCALP_MARKET_FOOTER_SLUGS = 5;

function recentScalpMarketSlugsByLastExit(history, limit) {
  const hist = Array.isArray(history) ? history.slice() : [];
  hist.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  const slugs = [];
  const seen = new Set();
  for (const h of hist) {
    const s = String(h.slug || "");
    if (!s || seen.has(s)) continue;
    seen.add(s);
    slugs.push(s);
    if (slugs.length >= limit) break;
  }
  return slugs;
}

/** Garante o mercado do tick atual na lista (no topo se ainda não houver fechos). Máx. `limit` slugs. */
function mergeCurrentSlugIntoRecentSlugs(slugs, currentSlug, limit) {
  const cur = String(currentSlug || "");
  const out = slugs.slice();
  if (cur && !out.includes(cur)) out.unshift(cur);
  return out.slice(0, Math.max(1, limit));
}

function scalpSlugDisplay(slug) {
  const s = String(slug || "");
  const short = s.replace(/.*-(\d+)$/, "#$1") || (s.length > 36 ? `${s.slice(0, 36)}…` : s);
  return { full: s, short: short || "—" };
}

function renderScalpMarketFooter() {
  const el = document.getElementById("dryScalpMarketFooter");
  if (!el) return;
  const pnlCls = (v) => (Number(v) >= 0 ? "color-up" : "color-down");
  const pnlSign = (v) => (Number(v) >= 0 ? "+" : "");

  const blocks = [];
  for (const tf of ["5m", "15m"]) {
    const d = latestData[tf];
    const currentSlug = String(d?.market?.slug || "");
    const strip = d?.simulation?.scalp?.strip;
    const latestExitTf = strip?.latestExit || null;
    const w = getScalpWalletForTf(tf);
    const hist = Array.isArray(w?.history) ? w.history : [];

    const recentFromHist = recentScalpMarketSlugsByLastExit(hist, SCALP_MARKET_FOOTER_SLUGS);
    const slugList = mergeCurrentSlugIntoRecentSlugs(recentFromHist, currentSlug, SCALP_MARKET_FOOTER_SLUGS);

    const subRows = [];
    if (!w) {
      subRows.push('<div class="dry-scalp-market-sub"><span class="dim">sem carteira Scalp no payload</span></div>');
    } else if (slugList.length === 0) {
      subRows.push(
        '<div class="dry-scalp-market-sub"><span class="dim">' +
        (!currentSlug ? "Mercado ainda não identificado." : "Sem fechos recentes na carteira para listar.") +
        "</span></div>"
      );
    } else {
      for (const slugStr of slugList) {
        const sessionRows = scalpHistoryForSlug(hist, slugStr);
        const sessionPnl = sessionRows.reduce((s, h) => s + (Number(h.pnl) || 0), 0);
        const n = sessionRows.length;
        const lastRow = scalpLastClosedForSlug(hist, slugStr);
        const { short, full } = scalpSlugDisplay(slugStr);
        const isCurrent = currentSlug && slugStr === currentSlug;
        const badge = isCurrent ? '<span class="dry-scalp-market-atual">atual</span>' : "";

        let tail = "";
        const le = latestExitTf && String(latestExitTf.marketSlug || "") === slugStr
          ? latestExitTf
          : null;
        if (le) {
          const p = Number(le.pnlUsd) || 0;
          tail += ` · <span class="${pnlCls(p)}">saída: ${escapeAttr(le.exitReason || "?")} ${pnlSign(p)}$${p.toFixed(2)}</span>`;
        } else if (lastRow) {
          const p = Number(lastRow.pnl) || 0;
          tail += ` · <span class="${pnlCls(p)}">último fech.: ${escapeAttr(lastRow.exitReason || "")} ${pnlSign(p)}$${p.toFixed(2)}</span>`;
        } else if (n === 0) {
          tail += ' <span class="dim">— sem fechamento neste mercado</span>';
        }

        subRows.push(
          `<div class="dry-scalp-market-sub">
            <span class="dry-scalp-market-sub-slug" title="${escapeAttr(full)}">${escapeAttr(short)}</span>${badge}
            <span class="dry-scalp-market-sub-detail">
              <span class="${pnlCls(sessionPnl)}">${pnlSign(sessionPnl)}$${sessionPnl.toFixed(2)}</span>
              <span class="dim"> · ${n} fech.</span>${tail}
            </span>
          </div>`
        );
      }
    }

    blocks.push(
      `<div class="dry-scalp-market-line">
        <span class="dry-scalp-market-tf"><b>${tf}</b></span>
        <div class="dry-scalp-market-tf-block">
          ${subRows.join("")}
        </div>
      </div>`
    );
  }

  el.innerHTML = `
    <div class="dry-scalp-market-head">📌 Scalp — últimos ${SCALP_MARKET_FOOTER_SLUGS} mercados por timeframe</div>
    <div class="dry-scalp-market-summary">${blocks.join("")}</div>
  `;
}

// ── Last Resolved ──
function renderLastResolved(resolved) {
  const el = document.getElementById("dryLastResolved");
  if (!el) return;
  if (!resolved) {
    el.innerHTML = "";
    el.hidden = true;
    return;
  }
  el.hidden = false;

  const pnl = resolved.pnl != null
    ? resolved.pnl
    : (resolved.trades || []).reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const pnlSign = pnl >= 0 ? "+" : "";
  const pnlCls = pnl >= 0 ? "color-up" : "color-down";
  const trades = resolved.trades || [];

  const badges = trades.map(t => {
    const cls = t.won ? "win" : "loss";
    const pSign = t.pnl >= 0 ? "+" : "";
    return `<span class="dry-resolved-badge ${cls}">${t.won ? "✅" : "❌"} ${t.name} ${pSign}$${t.pnl?.toFixed(2) || "0"}</span>`;
  }).join("");

  el.innerHTML = `
    <div class="dry-resolved-header">
      <span class="dry-resolved-slug">📊 ${resolved.slug || "?"} → ${resolved.outcome || "?"}</span>
      <span class="dry-resolved-pnl ${pnlCls}">Lucro: ${pnlSign}$${pnl.toFixed(2)}</span>
    </div>
    <div class="dry-resolved-badges">${badges}</div>
  `;
}

// ── CE Status (reused from main dashboard) ──
function renderCeStatus(ce) {
  const el = document.getElementById("dryCeStatus");
  if (!el) return;
  if (!ce) { el.innerHTML = ''; return; }

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

  const allCriteriaExceptTime = concordanceOk && priceOk;
  const panelCls = ce.active ? "ce-active" : (allCriteriaExceptTime ? "ce-ready" : "ce-inactive");
  const statusIcon = ce.active ? "🟢" : (allCriteriaExceptTime ? "🟡" : "🔴");
  const statusText = ce.active ? "ATIVO" : (allCriteriaExceptTime ? "AGUARDANDO TEMPO" : "INATIVO");

  const voteIcons = (ce.votes || []).map(v => {
    const icon = v.side === "UP" ? "↑" : v.side === "DOWN" ? "↓" : "—";
    const cls = v.side === "UP" ? "color-up" : v.side === "DOWN" ? "color-down" : "color-dim";
    return `<span class="ce-vote ${cls}">${concordanceOk && v.side === ce.majoritySide ? "✅" : v.side ? "❌" : "⚪"} ${v.name} ${icon}</span>`;
  }).join(" ");

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

// ── Scalp Force Cards ──
const SCALP_STATUS_LABELS = {
  idle: { label: "Idle", cls: "scalp-idle", icon: "⚪" },
  armed: { label: "Armado", cls: "scalp-armed", icon: "🟡" },
  in_position: { label: "Em posição", cls: "scalp-in", icon: "🟢" },
  closed_tp: { label: "TP", cls: "scalp-tp", icon: "✅" },
  closed_timeout_min_exit: { label: "Timeout OK", cls: "scalp-timeout", icon: "⏱" },
  closed_timeout_force_exit: { label: "Timeout forçado", cls: "scalp-force", icon: "⚠" },
  closed_decay_stop_min: { label: "Decay Stop OK", cls: "scalp-timeout", icon: "📉" },
  closed_decay_stop_force: { label: "Decay Stop", cls: "scalp-force", icon: "📉" },
  closed_trailing_stop: { label: "Trailing Stop", cls: "scalp-timeout", icon: "TS" },
  closed_hard_stop: { label: "Hard Stop", cls: "scalp-force", icon: "🛑" },
  closed_tp_trailing_stop: { label: "TP Trail", cls: "scalp-tp", icon: "TP" },
  closed_tp_force_fail: { label: "TP Força", cls: "scalp-tp", icon: "TP" },
  cancelled: { label: "Cancelado", cls: "scalp-cancelled", icon: "✕" }
};

function escapeAttr(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function fmtHoldSec(ms) {
  if (ms === null || ms === undefined) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const SCALP_FIELD_HELP = {
  stakeUsd: "Stake Base é o mínimo em USD da entrada. O stake efetivo usa o maior valor entre Stake Base e Min shares × preço do contrato. Ex.: contrato 0.1¢ com Stake Base $1 compra 1000 shares.",
  entryMinPct: "Menor preço do contrato aceito para abrir entrada. Ex.: 45 significa comprar só se o contrato estiver em 45¢ ou acima.",
  entryMaxPct: "Maior preço do contrato aceito para abrir entrada. Evita entrar caro quando o movimento já andou demais.",
  takeProfitPct: "Preço alvo do contrato. No modo exit, vende assim que atingir. No modo trail, arma proteção de lucro ao atingir.",
  tpExitMode: "Define o comportamento ao atingir o TP. exit vende imediatamente. trail mantém a posição aberta e protege o lucro com trailing e falha de força.",
  tpTrailCents: "Folga do trailing após o TP ser atingido. Ex.: topo 82¢ e TP trail 3¢ gera stop em 79¢.",
  tpForceExitEnabled: "Quando ligado, sai após o TP se os indicadores de força deixarem de confirmar a direção por Fail ticks consecutivos.",
  tpForceFailTicks: "Quantidade de ticks consecutivos de falha nos indicadores após TP antes de sair por tp_force_fail.",
  minExitPct: "Piso mínimo usado para classificar saídas por timeout/decay. Acima dele a saída é considerada aceitável; abaixo é saída forçada.",
  trailingArmingCents: "Quanto o contrato precisa subir acima da entrada para armar o trailing defensivo. Evita stop falso por spread logo após entrar.",
  trailingCushionCents: "Distância entre o topo do contrato e o stop defensivo depois de armado. Ex.: topo 55¢ e stop 4.5¢ sai em 50.5¢.",
  maxEntriesPerCandle: "Número máximo de entradas permitidas no mesmo candle após saídas defensivas. TP continua encerrando o ciclo do candle.",
  entryOpenWindowSec: "Tempo máximo desde a abertura do candle em que novas entradas podem ocorrer.",
  maxHoldSec: "Tempo máximo da posição antes do timeout/hold favorável assumir a decisão de saída.",
  minSharesFloor: "Quantidade mínima de shares exigida para calcular stake efetivo e evitar rejeição por tamanho mínimo.",
  maxEffectiveStakeUsd: "Limite máximo de stake efetivo após ajuste para min shares. Bloqueia entradas que passariam desse valor."
};

function scalpHelp(key) {
  return SCALP_FIELD_HELP[key] || "";
}

function scalpExitExplanation(row) {
  const reason = String(row?.exitReason || "");
  const side = row?.side && row.side !== "—" ? row.side : "posição";
  const entry = row?.entry || "—";
  const exit = row?.exit || "—";
  const hold = row?.hold || "—";
  const status = row?.statusText || "";
  const mode = row?.mode || "";

  if (mode === "LIVE" && (!reason || reason === "—")) {
    if (/rejeitada|erro/i.test(status)) return `Ordem LIVE não entrou: ${status}. Não considerar P&L até haver fill confirmado.`;
    if (/pendente|submetida|parcial/i.test(status)) return `Ordem LIVE ainda sem resultado final. A carteira só consolida após fill/saída ou resolução.`;
    return `Ordem LIVE registrada como ${status || "sem status final"}.`;
  }

  const base = `${side} entrou em ${entry}, saiu em ${exit}, hold ${hold}.`;
  const explanations = {
    tp_hit: `Alvo atingido. ${base} O contrato alcançou o TP configurado e a posição foi encerrada com realização imediata.`,
    tp_trailing_stop: `TP em modo trail. ${base} Após bater o alvo, o bot manteve a posição e saiu quando o preço voltou até o stop móvel do lucro.`,
    tp_force_fail: `Falha de força após TP. ${base} Depois do alvo, os indicadores deixaram de confirmar a direção pelo número configurado de ticks.`,
    trailing_stop: `Trailing defensivo. ${base} O contrato subiu o suficiente para armar o trailing e depois devolveu até o stop calculado a partir do topo.`,
    timeout_min_exit: `Tempo máximo com saída aceitável. ${base} O hold máximo venceu e o contrato ainda estava acima do piso mínimo configurado.`,
    timeout_force_exit: `Tempo máximo com saída forçada. ${base} O hold máximo venceu e o contrato estava abaixo do piso mínimo, então o bot encerrou para não carregar risco.`,
    decay_stop_min_exit: `Decay contra a posição. ${base} O movimento do BTC perdeu força contra a entrada, mas o contrato ainda permitia saída acima do mínimo.`,
    decay_stop_force_exit: `Decay contra a posição. ${base} O movimento do BTC ficou contra a entrada e o contrato estava abaixo do mínimo, gerando saída forçada.`,
    expiry_win: `Expiração vencedora. ${base} O candle virou e o preço final ficou a favor do lado comprado; o contrato foi tratado como 100¢.`,
    expiry_loss: `Expiração perdedora. ${base} O candle virou e o preço final ficou contra o lado comprado; o contrato foi tratado como 0¢.`,
    slug_rollover_unresolved: `Rollover sem dados suficientes. ${base} O mercado mudou de candle, mas faltou preço oracle/PTB para resolver vitória ou derrota com segurança.`,
    slug_rollover: `Rollover legado. ${base} Registro antigo fechado de forma neutra quando o mercado mudou de candle; versões novas resolvem como expiry_win/expiry_loss.`
  };

  return explanations[reason] || `Saída ${reason || "sem motivo informado"}. ${base}`;
}

function cardInputRow(label, cfgKey, value, indicator, suffix, step = 1) {
  const safeVal = value === null || value === undefined ? "" : value;
  return `<label class="scalp-input-row" title="${escapeAttr(scalpHelp(cfgKey))}">
    <span class="scalp-input-label">${label}</span>
    <input type="number" class="scalp-param-input" step="${step}" min="0"
      data-indicator="${escapeAttr(indicator)}" data-key="${cfgKey}"
      value="${escapeAttr(safeVal)}">
    <span class="scalp-input-suffix">${suffix}</span>
  </label>`;
}

function cardSelectRow(label, cfgKey, value, indicator, options, dataType = "string") {
  const opts = options.map(opt => {
    const selected = String(opt.value) === String(value) ? "selected" : "";
    return `<option value="${escapeAttr(opt.value)}" ${selected}>${escapeAttr(opt.label)}</option>`;
  }).join("");
  return `<label class="scalp-input-row" title="${escapeAttr(scalpHelp(cfgKey))}">
    <span class="scalp-input-label">${label}</span>
    <select class="scalp-param-input" data-type="${escapeAttr(dataType)}"
      data-indicator="${escapeAttr(indicator)}" data-key="${cfgKey}">
      ${opts}
    </select>
    <span class="scalp-input-suffix"></span>
  </label>`;
}

function scalpParamGroup(title, rows) {
  return `<fieldset class="scalp-param-group">
    <legend>${escapeAttr(title)}</legend>
    <div class="scalp-form-grid">${rows.join("")}</div>
  </fieldset>`;
}

function renderScalpCardHtml(card) {
  if (!card) return "";
  const cfg = card.config || {};
  const ind = card.indicator;
  const stat = SCALP_STATUS_LABELS[card.status] || SCALP_STATUS_LABELS.idle;
  const dirCls = card.direction === "UP" ? "dir-up" : card.direction === "DOWN" ? "dir-down" : "";
  const priceStr = card.entryPrice != null ? `${(card.entryPrice * 100).toFixed(1)}¢` : "—";
  const tgtStr = card.targetPrice != null ? `${(card.targetPrice * 100).toFixed(1)}¢` : "—";
  const remaining = fmtHoldSec(card.remainingMs);
  const effStake = card.effectiveStakeUsd != null ? `$${card.effectiveStakeUsd.toFixed(2)}` : "—";
  const shares = card.shares != null ? card.shares.toFixed(2) : "—";
  const entries = `${card.entriesThisCandle ?? 0}/${cfg.maxEntriesPerCandle ?? 1}`;
  const inPosition = card.status === "in_position";
  const favorableHoldBadge = inPosition && card.inFavorableHold
    ? ` <span class="scalp-ext-badge">hold favorável</span>`
    : "";
  const liveModeNotice = inPosition
    ? `<div class="scalp-card-mode-hint">⚡ Entrada ${currentDryRunMode === false ? "LIVE" : "SIM"} · saída SIM${favorableHoldBadge}</div>`
    : "";

  // Decay stop live diagnostic (only while in position and data available)
  let decayDiagHtml = "";
  if (inPosition && card.decayStopDiag) {
    const d = card.decayStopDiag;
    const cur = d.currentSignedDelta;
    const entry = d.entrySignedDelta;
    const margin = d.margin;
    const triggered = d.triggered;
    const fmtDelta = v => v == null ? "—" : `${v >= 0 ? "+" : ""}$${Math.abs(v).toFixed(0)}`;
    const marginCls = triggered ? "color-down" : margin != null && margin < 10 ? "color-warn" : "color-up";
    const marginText = triggered
      ? "DISPARADO"
      : margin != null ? `margem $${margin.toFixed(0)}` : "—";
    decayDiagHtml = `<div class="scalp-decay-diag">
      <span class="scalp-decay-label">📉 Decay stop</span>
      <span>entrada <b>${fmtDelta(entry)}</b></span>
      <span>atual <b>${fmtDelta(cur)}</b></span>
      <span>stop &lt; <b>${fmtDelta(d.threshold)}</b></span>
      <span class="${marginCls}"><b>${marginText}</b></span>
    </div>`;
  }
  let trailingDiagHtml = "";
  if (inPosition && card.trailingStopDiag) {
    const t = card.trailingStopDiag;
    const fmtC = v => v == null || !Number.isFinite(Number(v)) ? "—" : `${Number(v).toFixed(1)}¢`;
    const armed = !!t.armed;
    const stateCls = t.triggered ? "color-down" : armed ? "color-up" : "color-warn";
    const stateText = t.triggered ? "DISPARADO" : armed ? "ARMADO" : "aguardando";
    trailingDiagHtml = `<div class="scalp-decay-diag scalp-trailing-diag">
      <span class="scalp-trailing-label">Trail stop</span>
      <span>topo <b>${fmtC(t.maxPct)}</b></span>
      <span>arma <b>${fmtC(t.armingThreshold)}</b></span>
      <span>stop <b>${fmtC(t.stopPct)}</b></span>
      <span class="${stateCls}"><b>${stateText}</b></span>
    </div>`;
  }
  let tpTrailDiagHtml = "";
  if (inPosition && card.tpTrailDiag) {
    const t = card.tpTrailDiag;
    const fmtC = v => v == null || !Number.isFinite(Number(v)) ? "—" : `${Number(v).toFixed(1)}¢`;
    const armed = !!t.armed;
    const stateCls = t.forceFail || t.trailHit ? "color-down" : armed ? "color-up" : "color-warn";
    const stateText = t.forceFail
      ? "FORÇA FALHOU"
      : t.trailHit ? "STOP"
      : armed ? `ARMADO ${t.forceFailCount ?? 0}/${t.forceFailTicks ?? 2}` : `aguardando TP ${fmtC(t.targetPct)}`;
    tpTrailDiagHtml = `<div class="scalp-decay-diag scalp-tp-trail-diag">
      <span class="scalp-tp-trail-label">TP trail</span>
      <span>topo <b>${fmtC(t.maxPct)}</b></span>
      <span>stop <b>${fmtC(t.stopPct)}</b></span>
      <span>folga <b>${fmtC(t.trailCents)}</b></span>
      <span class="${stateCls}"><b>${stateText}</b></span>
    </div>`;
  }
  return `<div class="scalp-card ${stat.cls} ${dirCls}" data-indicator="${escapeAttr(ind)}">
    <div class="scalp-card-header">
      <span class="scalp-card-title">${stat.icon} ${ind}</span>
      <span class="scalp-card-status">${stat.label}${card.direction ? ` · ${card.direction}` : ""}</span>
    </div>
    <div class="scalp-card-body">
      <div class="scalp-metric"><span class="label">Entrada</span><span class="value">${priceStr}</span></div>
      <div class="scalp-metric"><span class="label">Alvo (TP)</span><span class="value">${tgtStr}</span></div>
      <div class="scalp-metric"><span class="label">Stake efetivo</span><span class="value">${effStake}</span></div>
      <div class="scalp-metric"><span class="label">Shares</span><span class="value">${shares}</span></div>
      <div class="scalp-metric"><span class="label">Entradas</span><span class="value">${entries}</span></div>
      <div class="scalp-metric"><span class="label">Restante</span><span class="value">${remaining}</span></div>
    </div>
    ${liveModeNotice}
    ${decayDiagHtml}
    ${tpTrailDiagHtml}
    ${trailingDiagHtml}
    <div class="scalp-card-reason">${escapeAttr(card.reason || "")}</div>
  </div>`;
}

function renderScalpRequirementPanel(card) {
  if (!card) return "";
  const diagnostics = card.diagnostics;
  if (!diagnostics || !Array.isArray(diagnostics.requirements)) {
    return `<div class="scalp-req-panel">
      <div class="scalp-req-head">
        <span>${escapeAttr(card.indicator || "Scalp Force")}</span>
        <span class="scalp-req-badge fail">sem checklist</span>
      </div>
      <div class="scalp-req-empty">Aguardando diagnóstico do motor.</div>
    </div>`;
  }

  const badgeCls = diagnostics.ready ? "ok" : "fail";
  const badgeText = diagnostics.ready ? "pronto" : "bloqueado";
  const direction = diagnostics.direction || "sem direção";
  const contract = diagnostics.contractPct === null || diagnostics.contractPct === undefined
    ? "--"
    : `${Number(diagnostics.contractPct).toFixed(1)}¢`;

  const rows = diagnostics.requirements.map((req) => {
    const ok = req.status === "ok";
    return `<div class="scalp-req-row ${ok ? "ok" : "fail"}">
      <span class="scalp-req-state">${ok ? "OK" : "NOK"}</span>
      <span class="scalp-req-name">${escapeAttr(req.label)}</span>
      <span class="scalp-req-actual">${escapeAttr(req.actual)}</span>
      <span class="scalp-req-expected">${escapeAttr(req.expected)}</span>
    </div>`;
  }).join("");

  return `<div class="scalp-req-panel">
    <div class="scalp-req-head">
      <span>${escapeAttr(card.indicator)}</span>
      <span class="scalp-req-meta">${escapeAttr(direction)} · contrato ${escapeAttr(contract)}</span>
      <span class="scalp-req-badge ${badgeCls}">${badgeText}</span>
    </div>
    <div class="scalp-req-grid">
      <div class="scalp-req-row header">
        <span></span>
        <span>Indicador</span>
        <span>Atual</span>
        <span>Precisa bater</span>
      </div>
      ${rows}
    </div>
  </div>`;
}

function renderScalpRequirements(card5m, card15m) {
  const el = document.getElementById("dryScalpRequirements");
  if (!el) return;
  const cards = [card5m, card15m].filter(Boolean);
  if (!cards.length) {
    el.innerHTML = '<span class="dim">Aguardando checklist Scalp Force...</span>';
    return;
  }
  el.innerHTML = `
    <div class="scalp-req-title">Checklist Scalp Force</div>
    <div class="scalp-req-panels">
      ${cards.map(renderScalpRequirementPanel).join("")}
    </div>
  `;
}

function renderScalpAll() {
  const container = document.getElementById("dryScalpCards");
  if (!container) return;
  const cards5m = latestData["5m"]?.simulation?.scalp?.cards || {};
  const cards15m = latestData["15m"]?.simulation?.scalp?.cards || {};
  const card5m = cards5m["Scalp Force 5m"];
  const card15m = cards15m["Scalp Force 15m"];
  const html = [card5m, card15m].filter(Boolean).map(renderScalpCardHtml).join("");
  container.innerHTML = html || '<span class="dim">Aguardando dados...</span>';
  renderScalpRequirements(card5m, card15m);

  const strip5m = latestData["5m"]?.simulation?.scalp?.strip;
  const strip15m = latestData["15m"]?.simulation?.scalp?.strip;
  renderScalpStrip(strip5m, strip15m);
  renderScalpMarketFooter();
  if (latestAnalysis["5m"]) renderWallets(latestAnalysis["5m"], "5m");
  if (latestAnalysis["15m"]) renderWallets(latestAnalysis["15m"], "15m");
}

function renderScalpStrip(strip5m, strip15m) {
  const el = document.getElementById("dryScalpStrip");
  if (!el) return;
  const actives = [...(strip5m?.activePositions || []), ...(strip15m?.activePositions || [])];
  const cumulative = { ...(strip5m?.cumulativePnlByIndicator || {}), ...(strip15m?.cumulativePnlByIndicator || {}) };
  const wallets = [...(strip5m?.wallets || []), ...(strip15m?.wallets || [])];
  scalpWalletData = Object.fromEntries(wallets.map(w => [w.name, w]));
  const exits = [strip5m?.latestExit, strip15m?.latestExit].filter(Boolean);
  const latestExit = exits.sort((a, b) => (b?.exitTime || "").localeCompare(a?.exitTime || ""))[0] || null;

  const activeHtml = actives.length
    ? actives.map(a => {
        const pct = a.entryPrice != null ? `${(a.entryPrice * 100).toFixed(1)}¢` : "—";
        const dirCls = a.direction === "UP" ? "color-up" : "color-down";
        return `<span class="scalp-strip-chip ${dirCls}">${escapeAttr(a.indicator)}: ${a.direction} @ ${pct} · $${(a.effectiveStakeUsd || 0).toFixed(2)} · ${fmtHoldSec(a.remainingMs)}</span>`;
      }).join(" ")
    : '<span class="dim">Sem posições ativas</span>';

  const cumHtml = Object.entries(cumulative).map(([name, pnl]) => {
    const cls = pnl >= 0 ? "color-up" : "color-down";
    const sign = pnl >= 0 ? "+" : "";
    return `<span class="scalp-strip-cum">${escapeAttr(name)}: <span class="${cls}">${sign}$${pnl.toFixed(2)}</span></span>`;
  }).join(" · ") || '<span class="dim">—</span>';

  let exitHtml = '<span class="dim">Nenhuma saída registrada</span>';
  if (latestExit) {
    const pnl = latestExit.pnlUsd ?? 0;
    const cls = pnl >= 0 ? "color-up" : "color-down";
    const sign = pnl >= 0 ? "+" : "";
    exitHtml = `<span>Última saída: <b>${escapeAttr(latestExit.exitReason || "?")}</b> · ${escapeAttr(latestExit.indicator)} · <span class="${cls}">${sign}$${pnl.toFixed(2)}</span> · ${latestExit.holdSeconds?.toFixed?.(1) ?? "?"}s hold</span>`;
  }

  el.innerHTML = `
    <div class="scalp-strip-row"><span class="scalp-strip-label">Ativas:</span> ${activeHtml}</div>
    <div class="scalp-strip-row">${exitHtml}</div>
    <div class="scalp-strip-row"><span class="scalp-strip-label">Cumulativo:</span> ${cumHtml}</div>
  `;
}

function getScalpWalletForTf(tf) {
  const name = tf === "15m" ? "Scalp Force 15m" : "Scalp Force 5m";
  const wallets = latestData[tf]?.simulation?.scalp?.strip?.wallets || [];
  return wallets.find(w => w.name === name) || scalpWalletData[name] || null;
}

function renderScalpWalletCard(w) {
  if (!w) return "";
  const balance = Number(w.balance) || 0;
  const invested = Number(w.invested) || 0;
  const roi = invested > 0 ? (balance / invested) * 100 : 0;
  const cls = balance >= 0 ? "profit" : "loss";
  const balCls = balance >= 0 ? "color-up" : "color-down";
  const sign = balance >= 0 ? "+" : "";
  const historyCount = Array.isArray(w.history) ? w.history.length : 0;
  const lOrders = tradeLog.filter(t => !t.dryRun && t.side === "BUY" && (t.metadata?.indicator || "") === w.name);
  const lExec = lOrders.filter(t => t.fillConfirmed === true || t.executionStatus === "filled_confirmed" || t.executionStatus === "resolved");
  const lResolved = lExec.filter(t => t.resolved === true && t.unfilled !== true);
  const lPnl = lResolved.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const lWins = lResolved.filter(t => t.won === true).length;
  const lLosses = lResolved.filter(t => t.won !== true).length;
  const lInvested = lExec.filter(t => t.side === "BUY").reduce((s, t) => s + (Number(t.sizeUsd) || 0), 0);
  const lPnlCls = lResolved.length === 0 ? "color-dim" : lPnl >= 0 ? "color-up" : "color-down";
  const lPnlText = lResolved.length === 0 ? "—" : `${lPnl >= 0 ? "+" : ""}$${lPnl.toFixed(2)}`;
  const lPending = lExec.length - lResolved.length;
  return `<button class="scalp-wallet-card embedded-scalp-wallet-card ${cls}" onclick="openScalpWalletModal('${escapeAttr(w.name)}')">
    <div class="scalp-wallet-header">
      <span class="scalp-wallet-name">${escapeAttr(w.name)}</span>
      <span class="scalp-wallet-balance ${balCls}">${sign}$${balance.toFixed(2)}</span>
    </div>
    <div class="scalp-wallet-row scalp-wallet-row-sim">
      <span class="scalp-wallet-row-label">SIM</span>
      <span>${w.wins || 0}✅ ${w.losses || 0}❌ · ${roi.toFixed(0)}% ROI · ${historyCount} trades</span>
    </div>
    <div class="scalp-wallet-row scalp-wallet-row-live">
      <span class="scalp-wallet-row-label">LIVE</span>
      <span>${lExec.length > 0
        ? `${lWins}✅ ${lLosses}❌${lPending > 0 ? ` · ${lPending}⏳` : ""} · $${lInvested.toFixed(2)} · <span class="${lPnlCls}">${lPnlText}</span>`
        : '<span class="color-dim">sem ordens</span>'
      }</span>
    </div>
  </button>`;
}

function openScalpWalletModal(name) {
  const modalStartedAt = performance.now();
  const w = scalpWalletData[name];
  if (!w) return;

  // ── SIM aggregates (from scalp wallet — closed trades) ──
  const simBalance = Number(w.balance) || 0;
  const simInvested = Number(w.invested) || 0;
  const simReturned = Number(w.returned) || 0;
  const simRoi = simInvested > 0 ? (simBalance / simInvested) * 100 : 0;
  const simCls = simBalance >= 0 ? "color-up" : "color-down";
  const simSign = simBalance >= 0 ? "+" : "";

  // ── LIVE aggregates (from tradeLog filtered by indicator) ──
  // Mostra apenas ordens BUY (posições abertas). Ordens SELL (saídas tp/timeout)
  // são saídas de execução e não geram linha própria no histórico de posições.
  const liveOrders = tradeLog.filter(t =>
    !t.dryRun &&
    t.side === "BUY" &&
    (t.metadata?.indicator || "—") === w.name
  );
  const lSubmitted = liveOrders.filter(t => t.status === "submitted");
  const lRejected = liveOrders.filter(t => t.status === "rejected").length;
  const lSkipped = liveOrders.filter(t => t.status === "skipped").length;
  const lExecuted = lSubmitted.filter(t =>
    t.fillConfirmed === true || t.executionStatus === "filled_confirmed" || t.executionStatus === "resolved"
  );
  const lPendingExec = lSubmitted.filter(t =>
    !(t.fillConfirmed === true || t.executionStatus === "filled_confirmed" || t.executionStatus === "resolved")
  ).length;
  const liveInvested = lExecuted.reduce((s, t) => s + (Number(t.sizeUsd) || 0), 0);
  const lResolved = lExecuted.filter(t => t.resolved === true && t.unfilled !== true);
  const livePnl = lResolved.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const livePnlCls = lResolved.length === 0 ? "color-dim" : livePnl >= 0 ? "color-up" : "color-down";
  const livePnlText = lResolved.length === 0 ? "pendente" : `${livePnl >= 0 ? "+" : ""}$${livePnl.toFixed(2)}`;
  const lWins = lResolved.filter(t => t.won === true).length;
  const lLosses = lResolved.filter(t => t.won !== true).length;
  const liveInvestedBuy = lExecuted.filter(t => t.side === "BUY").reduce((s, t) => s + (Number(t.sizeUsd) || 0), 0);
  const liveRoi = liveInvestedBuy > 0 ? (livePnl / liveInvestedBuy) * 100 : 0;
  const liveRoiCls = lResolved.length === 0 ? "color-dim" : liveRoi >= 0 ? "color-up" : "color-down";

  // ── SIM history rows ──
  const simHistory = Array.isArray(w.history) ? w.history : [];
  const simRows = simHistory.map(t => {
    const ts = t.ts ? new Date(t.ts) : null;
    const pnl = Number(t.pnl) || 0;
    const stake = Number(t.effectiveStake) || Number(t.stake) || 0;
    const entryPrice = Number(t.entryPrice) || 0;
    const sharesRaw = Number(t.shares) || 0;
    const shares = sharesRaw > 0 ? sharesRaw : (stake > 0 && entryPrice > 0 ? stake / entryPrice : 0);
    const row = {
      mode: "SIM",
      tsMs: ts ? ts.getTime() : 0,
      date: ts ? ts.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "—",
      time: ts ? ts.toLocaleTimeString("pt-BR", { hour12: false }) : "—",
      market: (t.slug || "").replace(/.*-(\d+)$/, "#$1") || "—",
      tf: `${t.windowMin || "?"}m`,
      side: t.side || "—",
      entry: entryPrice > 0 ? `${(entryPrice * 100).toFixed(1)}¢` : "—",
      exit: Number(t.exitPrice) > 0 ? `${(Number(t.exitPrice) * 100).toFixed(1)}¢` : "—",
      shares: shares > 0 ? shares.toFixed(2) : "—",
      stake: `$${stake.toFixed(2)}`,
      exitReason: t.exitReason || "—",
      hold: Number.isFinite(Number(t.holdSeconds)) ? `${Number(t.holdSeconds).toFixed(1)}s` : "—",
      statusText: "simulada",
      statusCls: "dry-status-dry",
      tokenId: t.tokenId || t.token_id || "",
      pnlValue: pnl,
      pnlText: `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
      contributesToBalance: true
    };
    row.explanation = scalpExitExplanation(row);
    return row;
  });

  const liveRows = liveOrders.map(t => {
    const ts = t.timestamp ? new Date(t.timestamp) : null;
    const meta = liveOrderStatusMeta(t);
    const price = Number(t.price);
    const shares = Number(t.shares);
    const usd = Number(t.sizeUsd);
    const isResolved = t.resolved === true;
    const isUnfilled = t.unfilled === true;
    const isExitRejected = t.exitRejected === true || t.executionStatus === "exit_rejected";
    // Scalp pair resolution (exitPrice stamped by resolveScalpPair) takes priority
    // over legacy candle-expiry resolution (t.won = true/false).
    const hasScalpExit = isResolved && t.exitPrice !== undefined;
    const attemptedScalpExit = isExitRejected && t.exitPriceAttempted !== undefined;
    const pnlValue = (isResolved && !isUnfilled) ? (Number(t.pnl) || 0) : 0;
    const exitStr = hasScalpExit
      ? `${(Number(t.exitPrice) * 100).toFixed(1)}¢`
      : attemptedScalpExit ? `${(Number(t.exitPriceAttempted) * 100).toFixed(1)}¢ tentado`
      : isResolved && !isUnfilled ? (t.won ? "100.0¢" : "0.0¢") : "—";
    const isSaldoInsuficiente = isUnfilled && typeof t.error === "string" && t.error.includes("Saldo insuficiente");
    const exitReasonStr = hasScalpExit
      ? (t.exitReason || "—")
      : isExitRejected ? `${t.exitReason || "saída"} rejeitada`
      : isResolved ? (isUnfilled ? (isSaldoInsuficiente ? "saldo_insuficiente" : "nao_preenchida") : "expirou_candle") : "—";
    const holdStr = hasScalpExit && Number.isFinite(Number(t.holdSeconds))
      ? `${Number(t.holdSeconds).toFixed(1)}s`
      : isExitRejected && Number.isFinite(Number(t.holdSeconds)) ? `${Number(t.holdSeconds).toFixed(1)}s`
      : "—";
    const row = {
      mode: "LIVE",
      tsMs: ts ? ts.getTime() : 0,
      date: ts ? ts.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "—",
      time: ts ? ts.toLocaleTimeString("pt-BR", { hour12: false }) : "—",
      market: t.metadata?.marketSlug ? String(t.metadata.marketSlug).replace(/.*-(\d+)$/, "#$1") : "—",
      tf: t._timeframe || t.metadata?.timeframe || "?",
      side: t.metadata?.direction || t.side || "—",
      entry: Number.isFinite(price) ? `${(price * 100).toFixed(1)}¢` : "—",
      exit: exitStr,
      shares: Number.isFinite(shares) ? shares.toFixed(2) : "—",
      stake: Number.isFinite(usd) ? `$${usd.toFixed(2)}` : "—",
      exitReason: exitReasonStr,
      hold: holdStr,
      statusText: meta.statusText,
      statusCls: meta.statusCls,
      tokenId: t.tokenId || "",
      pnlValue,
      pnlText: (isResolved && !isUnfilled) ? `${pnlValue >= 0 ? "+" : ""}$${pnlValue.toFixed(2)}` : "—",
      contributesToBalance: isResolved && !isUnfilled
    };
    row.explanation = scalpExitExplanation(row);
    return row;
  });

  const combinedRows = [...simRows, ...liveRows].sort((a, b) => a.tsMs - b.tsMs);
  const historyHtml = renderWalletHistoryPanels(simRows, liveRows);

  const overlay = document.createElement("div");
  overlay.className = "dry-modal-overlay";
  overlay.innerHTML = `
    <div class="dry-modal scalp-wallet-modal">
      <div class="dry-modal-header">
        <h3 class="dry-modal-title">⚡ ${escapeAttr(w.name)}</h3>
        <button class="dry-modal-close" onclick="this.closest('.dry-modal-overlay').remove()">✕</button>
      </div>
      <div class="dry-modal-summary">
        <div class="dry-modal-sections">
          <div class="dry-modal-section dry-modal-section-sim">
            <div class="dry-modal-section-title">Simulação</div>
            <div class="dry-modal-stats-row">
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">Investido</span><span class="dry-modal-stat-value">$${simInvested.toFixed(2)}</span></div>
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">Retornado</span><span class="dry-modal-stat-value ${simReturned >= simInvested ? 'color-up' : 'color-down'}">$${simReturned.toFixed(2)}</span></div>
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">Lucro</span><span class="dry-modal-stat-value ${simCls}">${simSign}$${simBalance.toFixed(2)}</span></div>
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">ROI</span><span class="dry-modal-stat-value ${simCls}">${simRoi.toFixed(0)}%</span></div>
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">Trades</span><span class="dry-modal-stat-value">${w.wins || 0}✅ ${w.losses || 0}❌</span></div>
            </div>
          </div>
          <div class="dry-modal-section dry-modal-section-live">
            <div class="dry-modal-section-title">Live</div>
            <div class="dry-modal-stats-row">
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">Investido</span><span class="dry-modal-stat-value">$${liveInvestedBuy.toFixed(2)}</span></div>
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">Ordens</span><span class="dry-modal-stat-value">${lExecuted.length}/${lSubmitted.length} · ${lRejected}❌ ${lPendingExec}⏳ ${lSkipped}⏭</span></div>
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">Resultado</span><span class="dry-modal-stat-value">${lWins}✅ ${lLosses}❌</span></div>
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">Lucro</span><span class="dry-modal-stat-value ${livePnlCls}">${livePnlText}</span></div>
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">ROI</span><span class="dry-modal-stat-value ${liveRoiCls}">${lResolved.length === 0 ? "—" : `${liveRoi >= 0 ? "+" : ""}${liveRoi.toFixed(0)}%`}</span></div>
            </div>
          </div>
        </div>
      </div>
      <div class="dry-modal-body">${historyHtml}</div>
    </div>
  `;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  clientLog("scalp_wallet_modal_open", {
    name: w.name,
    simHistory: simHistory.length,
    liveOrders: liveOrders.length,
    renderedRows: Math.min(combinedRows.length, MODAL_HISTORY_LIMIT),
    durationMs: Math.round(performance.now() - modalStartedAt)
  }, combinedRows.length > MODAL_HISTORY_LIMIT ? "warn" : "info");
}
window.openScalpWalletModal = openScalpWalletModal;

function applyScalpParams(indicator) {
  const inputs = document.querySelectorAll(`.scalp-param-input[data-indicator="${CSS.escape(indicator)}"]`);
  const patch = {};
  inputs.forEach(inp => {
    const key = inp.dataset.key;
    if (!key) return;
    if (inp.dataset.type === "boolean") {
      patch[key] = inp.value === "true";
      return;
    }
    if (inp.dataset.type === "string") {
      patch[key] = inp.value;
      return;
    }
    const val = parseFloat(inp.value);
    if (Number.isFinite(val)) patch[key] = val;
  });
  if (ws && ws.readyState === WebSocket.OPEN && Object.keys(patch).length) {
    ws.send(JSON.stringify({
      action: "setConfig",
      indicatorConfigs: { [indicator]: patch }
    }));
  }
}
window.applyScalpParams = applyScalpParams;

// ── Clear log ──
document.getElementById("dryClearLog")?.addEventListener("click", () => {
  tradeLog = [];
  seenTradeIds.clear();
  renderTradeLog();
});

// ── Timeframe Tabs ──
document.querySelectorAll(".tf-tab[data-tf]").forEach(btn => {
  btn.addEventListener("click", () => {
    activeTf = btn.dataset.tf;
    document.querySelectorAll(".tf-tab[data-tf]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    renderDataWarning();
    // Re-render from cache immediately
    const d = latestData[activeTf];
    if (d) renderAll(d);
    // Wallets are always visible side-by-side — no switching needed
  });
});

// ── Wallet Cards (per-timeframe) ──
function renderWallets(analysis, tf) {
  const container = document.getElementById(`dryWalletGrid${tf === "15m" ? "15m" : "5m"}`);
  const summary = document.getElementById(`dryWalletSummary${tf === "15m" ? "15m" : "5m"}`);
  if (!container) return;

  const wallets = analysis?.wallets || [];
  walletData[tf] = wallets; // store for modal
  const scalpWallet = getScalpWalletForTf(tf);

  if (wallets.length === 0 && !scalpWallet) {
    container.innerHTML = '<span class="dim">Aguardando trades resolvidos...</span>';
    if (summary) summary.textContent = "—";
    return;
  }

  // Summary: total SIM P&L (from wallets) + total LIVE P&L (from tradeLog for this tf)
  const simTotalPnl = wallets.reduce((s, w) => s + w.balance, 0) + (scalpWallet ? Number(scalpWallet.balance) || 0 : 0);
  const simTotalWins = wallets.reduce((s, w) => s + w.wins, 0) + (scalpWallet ? Number(scalpWallet.wins) || 0 : 0);
  const simTotalLosses = wallets.reduce((s, w) => s + w.losses, 0) + (scalpWallet ? Number(scalpWallet.losses) || 0 : 0);
  const simPnlSign = simTotalPnl >= 0 ? "+" : "";
  const simPnlCls = simTotalPnl >= 0 ? "color-up" : "color-down";

  // LIVE totals from tradeLog filtered by timeframe
  const liveAllOrders = tradeLog.filter(t => !t.dryRun && t.side === "BUY" && (t._timeframe === tf || t.metadata?.timeframe === tf));
  const liveAllExec = liveAllOrders.filter(t => t.fillConfirmed === true || t.executionStatus === "filled_confirmed" || t.executionStatus === "resolved");
  const liveAllResolved = liveAllExec.filter(t => t.resolved === true && t.unfilled !== true);
  const liveTotalPnl = liveAllResolved.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const liveTotalWins = liveAllResolved.filter(t => t.won === true).length;
  const liveTotalLosses = liveAllResolved.filter(t => t.won !== true).length;
  const livePnlSign = liveTotalPnl >= 0 ? "+" : "";
  const livePnlCls = liveTotalPnl >= 0 ? "color-up" : "color-down";
  const liveHasData = liveAllExec.length > 0;

  if (summary) summary.innerHTML = `
    <span class="dry-summary-badge dry-summary-sim">
      <span class="dry-summary-badge-label">SIM</span>
      <span class="${simPnlCls}">${simPnlSign}$${simTotalPnl.toFixed(2)}</span>
      <span class="dry-summary-badge-detail">${simTotalWins}✅ ${simTotalLosses}❌</span>
    </span>
    ${liveHasData ? `<span class="dry-summary-badge dry-summary-live">
      <span class="dry-summary-badge-label">LIVE</span>
      <span class="${livePnlCls}">${livePnlSign}$${liveTotalPnl.toFixed(2)}</span>
      <span class="dry-summary-badge-detail">${liveTotalWins}✅ ${liveTotalLosses}❌</span>
    </span>` : ""}
  `;

  const scalpCardHtml = scalpWallet ? renderScalpWalletCard(scalpWallet) : "";
  const walletCardsHtml = wallets.map((w, idx) => {
    const balCls = w.balance >= 0 ? "color-up" : "color-down";
    const balSign = w.balance >= 0 ? "+" : "";
    const roi = w.invested > 0 ? ((w.balance / w.invested) * 100).toFixed(0) : "0";
    const barW = Math.min(Math.abs(w.balance) * 10, 100);
    const barCls = w.balance >= 0 ? "profit" : "loss";
    const cardCls = w.balance >= 0 ? "profit" : "loss";

    // LIVE stats from tradeLog for this indicator
    const lOrders = tradeLog.filter(t => !t.dryRun && t.side === "BUY" && (t.metadata?.indicator || "") === w.name);
    const lExec = lOrders.filter(t => t.fillConfirmed === true || t.executionStatus === "filled_confirmed" || t.executionStatus === "resolved");
    const lResolved = lExec.filter(t => t.resolved === true && t.unfilled !== true);
    const lPnl = lResolved.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
    const lWins = lResolved.filter(t => t.won === true).length;
    const lLosses = lResolved.filter(t => t.won !== true).length;
    const lPending = lExec.length - lResolved.length;
    const lPnlCls = lResolved.length === 0 ? "color-dim" : lPnl >= 0 ? "color-up" : "color-down";
    const lPnlText = lResolved.length === 0 ? "—" : `${lPnl >= 0 ? "+" : ""}$${lPnl.toFixed(2)}`;
    const liveContent = lExec.length > 0
      ? `${lWins}✅ ${lLosses}❌${lPending > 0 ? ` · ${lPending}⏳` : ""} <span class="${lPnlCls}">${lPnlText}</span>`
      : '<span class="color-dim">sem ordens</span>';

    return `
      <div class="dry-wallet-card ${cardCls}" onclick="openWalletModal('${tf}', ${idx})" title="${w.name}">
        <div class="dry-wallet-header-row">
          <span class="dry-wallet-name">${w.name}</span>
          <span class="dry-wallet-bal ${balCls}">${balSign}$${w.balance.toFixed(2)}</span>
        </div>
        <div class="dry-wallet-mode-row dry-wallet-sim-row">
          <span class="dry-wallet-mode-label">SIM</span>
          <span>${w.wins}✅ ${w.losses}❌ · ${roi}%</span>
        </div>
        <div class="dry-wallet-mode-row dry-wallet-live-row">
          <span class="dry-wallet-mode-label">LIVE</span>
          <span>${liveContent}</span>
        </div>
        <div class="dry-wallet-bar"><div class="dry-wallet-bar-fill ${barCls}" style="width: ${barW}%"></div></div>
      </div>
    `;
  }).join("");
  container.innerHTML = `${scalpCardHtml}${walletCardsHtml}`;
}

// ── Wallet Detail Modal ──
function openWalletModal(tf, idx) {
  const modalStartedAt = performance.now();
  const w = walletData[tf]?.[idx];
  if (!w) return;

  const balCls = w.balance >= 0 ? "color-up" : "color-down";
  const balSign = w.balance >= 0 ? "+" : "";
  const roi = w.invested > 0 ? ((w.balance / w.invested) * 100).toFixed(0) : "0";

  const simSummaryHtml = `
    <div class="dry-modal-stats-row">
      <div class="dry-modal-stat">
        <span class="dry-modal-stat-label">Investido</span>
        <span class="dry-modal-stat-value">$${w.invested?.toFixed(2) || "0"}</span>
      </div>
      <div class="dry-modal-stat">
        <span class="dry-modal-stat-label">Retornado</span>
        <span class="dry-modal-stat-value ${w.returned >= w.invested ? 'color-up' : 'color-down'}">$${(w.returned || 0).toFixed(2)}</span>
      </div>
      <div class="dry-modal-stat">
        <span class="dry-modal-stat-label">Lucro</span>
        <span class="dry-modal-stat-value ${balCls}">${balSign}$${w.balance.toFixed(2)}</span>
      </div>
      <div class="dry-modal-stat">
        <span class="dry-modal-stat-label">ROI</span>
        <span class="dry-modal-stat-value ${balCls}">${roi}%</span>
      </div>
      <div class="dry-modal-stat">
        <span class="dry-modal-stat-label">Trades</span>
        <span class="dry-modal-stat-value">${w.wins}✅ ${w.losses}❌</span>
      </div>
    </div>
  `;

  const history = w.history || w.trades || [];
  const hiddenCount = Math.max(0, history.length - MODAL_HISTORY_LIMIT);
  const visibleHistory = hiddenCount > 0 ? history.slice(-MODAL_HISTORY_LIMIT) : history;
  let runningBalance = history.slice(0, hiddenCount).reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  
  const rows = visibleHistory.map((t, i) => {
    // If running from sim trades, it's t.pnl. If missing, maybe fallback to something else, but pnl should be there.
    const pnl = t.pnl || 0;
    runningBalance += pnl;
    const icon = t.won ? "✅" : "❌";
    const sideCls = t.side === "UP" ? "color-up" : "color-down";
    const pnlCls = pnl >= 0 ? "color-up" : "color-down";
    const balRunCls = runningBalance >= 0 ? "color-up" : "color-down";
    const shortSlug = (t.slug || "").replace(/.*-(\d+)$/, "#$1");
    const price = t.entryPrice ? (t.entryPrice * 100).toFixed(1) : "—";
    const outCls = t.outcome === "UP" ? "color-up" : "color-down";
    const stake = t.stake || 1;
    const timeLeft = t.timeLeft !== undefined ? t.timeLeft.toFixed(1) + "m" : "—";
    
    return `<tr>
      <td>${hiddenCount + i + 1}</td>
      <td>${shortSlug}</td>
      <td class="${sideCls}">${t.side === "UP" ? "↑" : "↓"} ${t.side}</td>
      <td>${price}¢</td>
      <td>$${stake.toFixed(2)}</td>
      <td>${timeLeft}</td>
      <td class="${outCls}">${t.outcome || "—"}</td>
      <td>${icon}</td>
      <td class="${pnlCls}">${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</td>
      <td class="${balRunCls}">${runningBalance >= 0 ? "+" : ""}$${runningBalance.toFixed(2)}</td>
    </tr>`;
  }).reverse();

  const limitNotice = hiddenCount > 0
    ? `<div class="dry-history-limit">Mostrando os últimos ${MODAL_HISTORY_LIMIT} de ${history.length} trades. O saldo acumulado considera todo o histórico.</div>`
    : "";

  const tradesHtml = history.length > 0 ? `
    ${limitNotice}
    <table class="dry-modal-table">
      <thead><tr>
        <th>#</th><th>Market</th><th>Lado</th><th>Preço</th><th>Stake</th>
        <th>T.Left</th><th>Result</th><th></th><th>P&L</th><th>Saldo</th>
      </tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  ` : '<span class="dim">Sem histórico de trades</span>';

  // Ordens LIVE para este indicador
  const liveOrders = tradeLog.filter(t => !t.dryRun && (t.metadata?.indicator || "—") === w.name);

  // Resumo LIVE — painel financeiro real
  const lSubmitted = liveOrders.filter(t => t.status === "submitted");
  const lRejected  = liveOrders.filter(t => t.status === "rejected").length;
  const lSkipped   = liveOrders.filter(t => t.status === "skipped").length;
  const lExecuted  = lSubmitted.filter(t =>
    t.fillConfirmed === true || t.executionStatus === "filled_confirmed" || t.executionStatus === "resolved"
  );
  const lResolved  = lExecuted.filter(t => t.resolved === true);
  const lPendingExec = lSubmitted.filter(t =>
    !(t.fillConfirmed === true || t.executionStatus === "filled_confirmed" || t.executionStatus === "resolved")
  ).length;
  const lInvested  = lExecuted.reduce((s, t) => s + (t.sizeUsd || 0), 0);

  // P&L real para ordens resolvidas
  const lRealPnl   = lResolved.reduce((s, t) => s + (t.pnl || 0), 0);
  const lTotalPnl   = lRealPnl;
  const lRoi        = lInvested > 0 ? ((lTotalPnl / lInvested) * 100) : 0;
  const lLucroCls   = lTotalPnl >= 0 ? "color-up" : "color-down";
  const lLucroSign  = lTotalPnl >= 0 ? "+" : "";
  const lRoiCls     = lRoi >= 0 ? "color-up" : "color-down";

  const retornoLabel = "P&L Real";
  const retornoVal   = lTotalPnl;
  const retornoCls   = retornoVal >= 0 ? "color-up" : "color-down";

  const liveSummaryHtml = `
    <div class="dry-modal-stats-row">
      <div class="dry-modal-stat">
        <span class="dry-modal-stat-label">Investido</span>
        <span class="dry-modal-stat-value">$${lInvested.toFixed(2)}</span>
      </div>
      <div class="dry-modal-stat">
        <span class="dry-modal-stat-label">${retornoLabel}</span>
        <span class="dry-modal-stat-value ${retornoCls}">${retornoVal >= 0 ? "+" : ""}$${retornoVal.toFixed(2)}</span>
      </div>
      <div class="dry-modal-stat">
        <span class="dry-modal-stat-label">ROI</span>
        <span class="dry-modal-stat-value ${lRoiCls}">${lLucroSign}${lRoi.toFixed(0)}%</span>
      </div>
      <div class="dry-modal-stat">
        <span class="dry-modal-stat-label">Resolvidas</span>
        <span class="dry-modal-stat-value">${lResolved.length}/${lExecuted.length}</span>
      </div>
      <div class="dry-modal-stat">
        <span class="dry-modal-stat-label">Ordens</span>
        <span class="dry-modal-stat-value">${lExecuted.length}✅ ${lRejected}❌ ${lPendingExec}⏳ ${lSkipped}⏭️</span>
      </div>
    </div>
  `;
  let liveHtml;
  if (liveOrders.length === 0) {
    liveHtml = '<div class="empty-state" style="padding:24px 0">Nenhuma ordem LIVE registrada para este indicador.</div>';
  } else {
    const ordered = liveOrders.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    let liveRunningBalance = 0;
    const liveRowsArr = ordered.map((t, i) => {
      const ts = t.timestamp ? new Date(t.timestamp) : null;
      const date = ts ? ts.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "—";
      const time = ts ? ts.toLocaleTimeString("pt-BR", { hour12: false }) : "—";
      const dir = t.metadata?.direction || t.side || "—";
      const dirCls = dir === "UP" ? "color-up" : dir === "DOWN" ? "color-down" : "";
      const dirArrow = dir === "UP" ? "↑" : dir === "DOWN" ? "↓" : "";
      const price = t.price ? `${(t.price * 100).toFixed(1)}¢` : "—";
      const shares = t.shares ? t.shares.toFixed(2) : "—";
      const usd = t.sizeUsd ? `$${t.sizeUsd.toFixed(2)}` : "—";
      const tf = t._timeframe || t.metadata?.timeframe || "?";
      const matchedSize = Number.isFinite(Number(t.sizeMatched ?? t.filledSize))
        ? Number(t.sizeMatched ?? t.filledSize)
        : 0;
      let statusCls = "dry-status-error";
      let statusText = t.status || "?";
      if (t.resolved === true) {
        if (t.unfilled === true) {
          statusCls  = "dry-status-dry";
          statusText = "⏭️ expirada";
        } else {
          statusCls  = t.won ? "dry-status-live" : "dry-status-error";
          statusText = t.won ? "🏆 finalizada" : "💸 finalizada";
        }
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

      let resultIcon = "—";
      let resultCls = "dim";
      let pnlCell = "—";
      let pnlCls = "dim";
      let balCell = "—";
      let balCls = "dim";
      if (t.resolved === true) {
        const pnl = Number(t.pnl) || 0;
        liveRunningBalance += pnl;
        resultIcon = t.won ? "✅" : "❌";
        resultCls = t.won ? "color-up" : "color-down";
        pnlCls = pnl >= 0 ? "color-up" : "color-down";
        pnlCell = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
        balCls = liveRunningBalance >= 0 ? "color-up" : "color-down";
        balCell = `${liveRunningBalance >= 0 ? "+" : ""}$${liveRunningBalance.toFixed(2)}`;
      }

      const shortToken = t.tokenId ? t.tokenId.substring(0, 10) + "…" : "—";
      return `<tr>
        <td>${i + 1}</td>
        <td>${date}</td>
        <td>${time}</td>
        <td><span class="dry-tf-badge">${tf}</span></td>
        <td class="${dirCls}">${dirArrow} ${dir}</td>
        <td>${price}</td>
        <td>${shares}</td>
        <td>${usd}</td>
        <td class="dry-token-cell" title="${t.tokenId || ''}">${shortToken}</td>
        <td><span class="dry-status ${statusCls}">${statusText}</span></td>
        <td class="${resultCls}">${resultIcon}</td>
        <td class="${pnlCls}">${pnlCell}</td>
        <td class="${balCls}">${balCell}</td>
      </tr>`;
    });
    const liveRows = liveRowsArr.reverse().join("");
    liveHtml = `
      <table class="dry-modal-table">
        <thead><tr>
          <th>#</th><th>Data</th><th>Hora</th><th>TF</th><th>Lado</th><th>Preço</th><th>Shares</th>
          <th>USD</th><th>Token</th><th>Status</th><th>Result</th><th>P&L</th><th>Saldo</th>
        </tr></thead>
        <tbody>${liveRows}</tbody>
      </table>
    `;
  }

  const overlay = document.createElement("div");
  overlay.className = "dry-modal-overlay";
  overlay.innerHTML = `
    <div class="dry-modal">
      <div class="dry-modal-header">
        <h3 class="dry-modal-title">💰 ${w.name}</h3>
        <button class="dry-modal-close" onclick="this.closest('.dry-modal-overlay').remove()">✕</button>
      </div>
      <div class="dry-modal-summary">
        <div id="drySimSummaryBlock">${simSummaryHtml}</div>
        <div id="dryLiveSummaryBlock" style="display:none">${liveSummaryHtml}</div>
        <div class="modal-tabs">
          <button class="modal-tab active" id="dryTabSimBtn" onclick="switchDryTab('sim')">🧪 Simulação</button>
          <button class="modal-tab" id="dryTabLiveBtn" onclick="switchDryTab('live')">💰 LIVE</button>
        </div>
      </div>
      <div class="dry-modal-body">
        <div id="dryTabSimPane">${tradesHtml}</div>
        <div id="dryTabLivePane" style="display:none">${liveHtml}</div>
      </div>
    </div>
  `;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  clientLog("wallet_modal_open", {
    tf,
    name: w.name,
    historyTotal: history.length,
    renderedRows: visibleHistory.length,
    durationMs: Math.round(performance.now() - modalStartedAt)
  }, history.length > MODAL_HISTORY_LIMIT ? "warn" : "info");
}
window.openWalletModal = openWalletModal;

function switchDryTab(tab) {
  const simPane    = document.getElementById("dryTabSimPane");
  const livePane   = document.getElementById("dryTabLivePane");
  const simSummary = document.getElementById("drySimSummaryBlock");
  const liveSummary= document.getElementById("dryLiveSummaryBlock");
  const simBtn     = document.getElementById("dryTabSimBtn");
  const liveBtn    = document.getElementById("dryTabLiveBtn");
  if (!simPane || !livePane) return;
  simPane.style.display    = tab === "sim"  ? "" : "none";
  livePane.style.display   = tab === "live" ? "" : "none";
  if (simSummary)  simSummary.style.display  = tab === "sim"  ? "" : "none";
  if (liveSummary) liveSummary.style.display = tab === "live" ? "" : "none";
  if (simBtn)  simBtn.classList.toggle("active",  tab === "sim");
  if (liveBtn) liveBtn.classList.toggle("active", tab === "live");
}
window.switchDryTab = switchDryTab;

function liveOrderStatusMeta(t) {
  const matchedSize = Number.isFinite(Number(t.sizeMatched ?? t.filledSize))
    ? Number(t.sizeMatched ?? t.filledSize)
    : 0;
  if (t.resolved === true) {
    if (t.unfilled === true) return { statusCls: "dry-status-dry", statusText: "⏭ expirada" };
    return { statusCls: t.won ? "dry-status-live" : "dry-status-error", statusText: t.won ? "🏆 finalizada" : "💸 finalizada" };
  }
  if (t.exitRejected === true || t.executionStatus === "exit_rejected") return { statusCls: "dry-status-error", statusText: "❌ saída rejeitada" };
  if (t.fillConfirmed === true || t.executionStatus === "filled_confirmed") return { statusCls: "dry-status-live", statusText: "✅ executada" };
  if (t.executionStatus === "partial" || matchedSize > 0) return { statusCls: "dry-status-live", statusText: `● parcial ${matchedSize.toFixed(2)}` };
  if (t.status === "submitted") return { statusCls: "dry-status-live", statusText: "⏳ enviada" };
  if (t.status === "skipped") return { statusCls: "dry-status-dry", statusText: "⏭ skipped" };
  if (t.status === "rejected") return { statusCls: "dry-status-error", statusText: "❌ rejected" };
  if (t.status === "error") return { statusCls: "dry-status-error", statusText: "⚠ error" };
  return { statusCls: "dry-status-error", statusText: t.status || "?" };
}

function renderUnifiedWalletHistory(rows, hiddenCount) {
  // Independent running balances per mode
  let runningSimBalance = rows
    .filter(r => r._hiddenForBalance && r.mode === "SIM" && r.contributesToBalance)
    .reduce((s, r) => s + (Number(r.pnlValue) || 0), 0);
  let runningLiveBalance = rows
    .filter(r => r._hiddenForBalance && r.mode === "LIVE" && r.contributesToBalance)
    .reduce((s, r) => s + (Number(r.pnlValue) || 0), 0);

  const visibleRows = rows.filter(r => !r._hiddenForBalance);
  const tableRows = visibleRows.map((r, i) => {
    if (r.mode === "SIM" && r.contributesToBalance) runningSimBalance += Number(r.pnlValue) || 0;
    if (r.mode === "LIVE" && r.contributesToBalance) runningLiveBalance += Number(r.pnlValue) || 0;
    const bal = r.mode === "SIM" ? runningSimBalance : runningLiveBalance;
    const balText = (r.mode === "LIVE" && !r.contributesToBalance)
      ? "—"
      : `${bal >= 0 ? "+" : ""}$${bal.toFixed(2)}`;
    const sideCls = r.side === "UP" ? "color-up" : r.side === "DOWN" ? "color-down" : "";
    const sideArrow = r.side === "UP" ? "↑" : r.side === "DOWN" ? "↓" : "";
    const pnlCls = r.pnlValue > 0 ? "color-up" : r.pnlValue < 0 ? "color-down" : "dim";
    const balCls = bal > 0 ? "color-up" : bal < 0 ? "color-down" : "dim";
    const modeBadge = r.mode === "LIVE"
      ? `<span class="dry-mode-badge dry-mode-live">LIVE</span>`
      : `<span class="dry-mode-badge dry-mode-sim">SIM</span>`;
    return `<tr class="dry-row-${r.mode.toLowerCase()}">
      <td>${hiddenCount + i + 1}</td>
      <td>${escapeAttr(r.date)}</td>
      <td>${escapeAttr(r.time)}</td>
      <td>${modeBadge}</td>
      <td>${escapeAttr(r.market)}</td>
      <td><span class="dry-tf-badge">${escapeAttr(r.tf)}</span></td>
      <td class="${sideCls}">${sideArrow} ${escapeAttr(r.side || "—")}</td>
      <td>${escapeAttr(r.entry || "—")}</td>
      <td>${escapeAttr(r.exit || "—")}</td>
      <td>${escapeAttr(r.shares || "—")}</td>
      <td>${escapeAttr(r.stake || "—")}</td>
      <td><span class="${r.statusCls}">${escapeAttr(r.statusText)}</span></td>
      <td>${escapeAttr(r.exitReason || "—")}</td>
      <td class="dry-token-cell" title="${escapeAttr(r.tokenId || "")}">${escapeAttr(shortToken(r.tokenId))}</td>
      <td>${escapeAttr(r.hold || "—")}</td>
      <td class="dry-explanation-cell" title="${escapeAttr(r.explanation || "")}">${escapeAttr(r.explanation || "—")}</td>
      <td class="${r.contributesToBalance ? pnlCls : 'color-dim'}">${escapeAttr(r.pnlText)}</td>
      <td class="${balCls}">${escapeAttr(balText)}</td>
    </tr>`;
  }).reverse();

  const limitNotice = hiddenCount > 0
    ? `<div class="dry-history-limit">Mostrando os últimos ${MODAL_HISTORY_LIMIT} de ${rows.length} registros. Saldo SIM e LIVE acumulam separadamente.</div>`
    : "";
  return visibleRows.length > 0 ? `
    ${limitNotice}
    <table class="dry-modal-table wallet-history-table">
      <thead><tr>
        <th>#</th><th>Data</th><th>Hora</th><th>Modo</th><th>Market</th><th>TF</th><th>Lado</th>
        <th>Entry</th><th>Exit</th><th>Shares</th><th>Stake</th><th>Status</th><th>Saída</th><th>Token</th><th>Hold</th><th>Explicação</th><th>P&L</th><th>Saldo</th>
      </tr></thead>
      <tbody>${tableRows.join("")}</tbody>
    </table>
  ` : '<span class="dim">Sem histórico de trades</span>';
}

function renderWalletHistoryPanels(simRows, liveRows) {
  const modes = [
    { key: "sim", label: "Simulação", rows: simRows },
    { key: "live", label: "LIVE", rows: liveRows }
  ];
  const activeMode = simRows.length > 0 ? "sim" : "live";
  const buttons = modes.map(m => `
    <button class="dry-history-tab ${m.key === activeMode ? "active" : ""}"
      type="button" data-history-mode="${m.key}"
      onclick="switchWalletHistoryMode(this, '${m.key}')">
      <span>${m.label}</span>
      <b>${m.rows.length}</b>
    </button>
  `).join("");

  const panels = modes.map(m => {
    const orderedRows = [...m.rows].sort((a, b) => a.tsMs - b.tsMs);
    const hiddenCount = Math.max(0, orderedRows.length - MODAL_HISTORY_LIMIT);
    const limitedRows = orderedRows.map((r, i) => ({ ...r, _hiddenForBalance: i < hiddenCount }));
    return `<div class="dry-history-panel ${m.key === activeMode ? "active" : ""}" data-history-mode="${m.key}">
      ${renderUnifiedWalletHistory(limitedRows, hiddenCount)}
    </div>`;
  }).join("");

  const maxRows = Math.max(simRows.length, liveRows.length);
  const scrollHint = maxRows > 10
    ? " Role o painel abaixo da barra para ver todas as linhas."
    : "";
  return `
    <div class="dry-history-toolbar">
      <div class="dry-history-tabs" role="tablist" aria-label="Modo do histórico">
        ${buttons}
      </div>
      <div class="dry-history-hint">Histórico separado por modo; o saldo da tabela é só no modo ativo. Simulação mostra trades fechados (saída + P&L). Entradas DRY em aberto ficam no log de ordens até fechar.${scrollHint}</div>
    </div>
    ${panels}
  `;
}

function switchWalletHistoryMode(button, mode) {
  const modal = button?.closest?.(".dry-modal");
  if (!modal) return;
  modal.querySelectorAll(".dry-history-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.historyMode === mode);
  });
  modal.querySelectorAll(".dry-history-panel").forEach(panel => {
    panel.classList.toggle("active", panel.dataset.historyMode === mode);
  });
}
window.switchWalletHistoryMode = switchWalletHistoryMode;

function openWalletModalUnified(tf, idx) {
  const modalStartedAt = performance.now();
  const w = walletData[tf]?.[idx];
  if (!w) return;

  const simBalance = Number(w.balance) || 0;
  const simInvested = Number(w.invested) || 0;
  const simReturned = Number(w.returned) || 0;
  const simRoi = simInvested > 0 ? (simBalance / simInvested) * 100 : 0;
  const simCls = simBalance >= 0 ? "color-up" : "color-down";
  const simSign = simBalance >= 0 ? "+" : "";

  const liveOrders = tradeLog.filter(t => !t.dryRun && (t.metadata?.indicator || "—") === w.name);
  const lSubmitted = liveOrders.filter(t => t.status === "submitted");
  const lRejected = liveOrders.filter(t => t.status === "rejected").length;
  const lSkipped = liveOrders.filter(t => t.status === "skipped").length;
  const lExecuted = lSubmitted.filter(t =>
    t.fillConfirmed === true || t.executionStatus === "filled_confirmed" || t.executionStatus === "resolved"
  );
  const lResolved = lExecuted.filter(t => t.resolved === true && t.unfilled !== true);
  const lPendingExec = lSubmitted.filter(t =>
    !(t.fillConfirmed === true || t.executionStatus === "filled_confirmed" || t.executionStatus === "resolved")
  ).length;
  const liveInvested = lExecuted.reduce((s, t) => s + (Number(t.sizeUsd) || 0), 0);
  const livePnl = lResolved.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const liveRoi = liveInvested > 0 ? (livePnl / liveInvested) * 100 : 0;
  const liveCls = livePnl >= 0 ? "color-up" : "color-down";
  const liveSign = livePnl >= 0 ? "+" : "";
  const lWins = lResolved.filter(t => t.won === true).length;
  const lLosses = lResolved.filter(t => t.won !== true).length;
  const livePnlText = lResolved.length === 0 ? "pendente" : `${liveSign}$${livePnl.toFixed(2)}`;

  const simRows = (w.history || w.trades || []).map(t => {
    const ts = t.ts ? new Date(t.ts) : null;
    const pnl = Number(t.pnl) || 0;
    const stake = Number(t.stake) || 1;
    const entryPriceUni = Number(t.entryPrice) || 0;
    const sharesRawUni = Number(t.shares) || 0;
    const sharesUni = sharesRawUni > 0 ? sharesRawUni : (stake > 0 && entryPriceUni > 0 ? stake / entryPriceUni : 0);
    const exitPrice = t.won ? "100.0¢" : "0.0¢";
    const timeLeftVal = Number(t.timeLeft);
    return {
      mode: "SIM",
      tsMs: ts ? ts.getTime() : 0,
      date: ts ? ts.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "—",
      time: ts ? ts.toLocaleTimeString("pt-BR", { hour12: false }) : "—",
      market: (t.slug || "").replace(/.*-(\d+)$/, "#$1") || "—",
      tf,
      side: t.side || "—",
      entry: entryPriceUni > 0 ? `${(entryPriceUni * 100).toFixed(1)}¢` : "—",
      exit: exitPrice,
      shares: sharesUni > 0 ? sharesUni.toFixed(2) : "—",
      stake: `$${stake.toFixed(2)}`,
      statusText: "simulada",
      statusCls: "dry-status-dry",
      exitReason: "expirou_candle",
      hold: Number.isFinite(timeLeftVal) ? `${timeLeftVal.toFixed(1)}m` : "—",
      explanation: t.explanation || t.reason || "—",
      tokenId: resolveSimTokenId(t, tf, w.name),
      pnlValue: pnl,
      pnlText: `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
      contributesToBalance: true
    };
  });

  const liveRows = liveOrders.map(t => {
    const ts = t.timestamp ? new Date(t.timestamp) : null;
    const isResolved = t.resolved === true;
    const isUnfilled = t.unfilled === true;
    const pnl = (isResolved && !isUnfilled) ? Number(t.pnl) || 0 : 0;
    const meta = liveOrderStatusMeta(t);
    const price = Number(t.price);
    const shares = Number(t.shares);
    const usd = Number(t.sizeUsd);
    const exitStr = isResolved
      ? (isUnfilled ? "expirada" : (t.won ? "100.0¢" : "0.0¢"))
      : "—";
    const isSaldoInsuficiente = isUnfilled && typeof t.error === "string" && t.error.includes("Saldo insuficiente");
    const exitReason = isResolved
      ? (isUnfilled ? (isSaldoInsuficiente ? "saldo_insuficiente" : "nao_preenchida") : "expirou_candle")
      : "—";
    return {
      mode: "LIVE",
      tsMs: ts ? ts.getTime() : 0,
      date: ts ? ts.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "—",
      time: ts ? ts.toLocaleTimeString("pt-BR", { hour12: false }) : "—",
      market: t.metadata?.marketSlug ? String(t.metadata.marketSlug).replace(/.*-(\d+)$/, "#$1") : "—",
      tf: t._timeframe || t.metadata?.timeframe || "?",
      side: t.metadata?.direction || t.side || "—",
      entry: Number.isFinite(price) ? `${(price * 100).toFixed(1)}¢` : "—",
      exit: exitStr,
      shares: Number.isFinite(shares) ? shares.toFixed(2) : "—",
      stake: Number.isFinite(usd) ? `$${usd.toFixed(2)}` : "—",
      statusText: meta.statusText,
      statusCls: meta.statusCls,
      exitReason,
      hold: "—",
      explanation: t.metadata?.explanation || t.explanation || "—",
      tokenId: t.tokenId || "",
      pnlValue: pnl,
      pnlText: (isResolved && !isUnfilled) ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : "—",
      contributesToBalance: isResolved && !isUnfilled
    };
  });

  const combinedRows = [...simRows, ...liveRows].sort((a, b) => a.tsMs - b.tsMs);
  const historyHtml = renderWalletHistoryPanels(simRows, liveRows);

  const overlay = document.createElement("div");
  overlay.className = "dry-modal-overlay";
  overlay.innerHTML = `
    <div class="dry-modal scalp-wallet-modal">
      <div class="dry-modal-header">
        <h3 class="dry-modal-title">💰 ${escapeAttr(w.name)}</h3>
        <button class="dry-modal-close" onclick="this.closest('.dry-modal-overlay').remove()">✕</button>
      </div>
      <div class="dry-modal-summary">
        <div class="dry-modal-sections">
          <div class="dry-modal-section dry-modal-section-sim">
            <div class="dry-modal-section-title">Simulação</div>
            <div class="dry-modal-stats-row">
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">Investido</span><span class="dry-modal-stat-value">$${simInvested.toFixed(2)}</span></div>
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">Retornado</span><span class="dry-modal-stat-value ${simReturned >= simInvested ? 'color-up' : 'color-down'}">$${simReturned.toFixed(2)}</span></div>
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">Lucro</span><span class="dry-modal-stat-value ${simCls}">${simSign}$${simBalance.toFixed(2)}</span></div>
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">ROI</span><span class="dry-modal-stat-value ${simCls}">${simRoi.toFixed(0)}%</span></div>
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">Trades</span><span class="dry-modal-stat-value">${w.wins || 0}✅ ${w.losses || 0}❌</span></div>
            </div>
          </div>
          <div class="dry-modal-section dry-modal-section-live">
            <div class="dry-modal-section-title">Live</div>
            <div class="dry-modal-stats-row">
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">Investido</span><span class="dry-modal-stat-value">$${liveInvested.toFixed(2)}</span></div>
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">Ordens</span><span class="dry-modal-stat-value">${lExecuted.length}/${lSubmitted.length} · ${lRejected}❌ ${lPendingExec}⏳ ${lSkipped}⏭</span></div>
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">Resultado</span><span class="dry-modal-stat-value">${lWins}✅ ${lLosses}❌</span></div>
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">Lucro</span><span class="dry-modal-stat-value ${liveCls}">${livePnlText}</span></div>
              <div class="dry-modal-stat"><span class="dry-modal-stat-label">ROI</span><span class="dry-modal-stat-value ${liveRoi >= 0 ? 'color-up' : 'color-down'}">${liveSign}${liveRoi.toFixed(0)}%</span></div>
            </div>
          </div>
        </div>
      </div>
      <div class="dry-modal-body">${historyHtml}</div>
    </div>
  `;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  clientLog("wallet_modal_open_unified", {
    tf,
    name: w.name,
    historyTotal: combinedRows.length,
    renderedRows: Math.min(combinedRows.length, MODAL_HISTORY_LIMIT),
    durationMs: Math.round(performance.now() - modalStartedAt)
  }, combinedRows.length > MODAL_HISTORY_LIMIT ? "warn" : "info");
}
window.openWalletModal = openWalletModalUnified;

// ── Config Modal ──
let currentConfig = null;

function openConfigModal() {
  window.location.href = "/settings.html";
}
window.openConfigModal = openConfigModal;

function closeConfigModal() {
  document.getElementById("configOverlay")?.classList.remove("open");
}
window.closeConfigModal = closeConfigModal;

function populateConfigModal(cfg) {
  // Mode toggle
  const toggle = document.getElementById("configDryRunToggle");
  const label = document.getElementById("configModeLabel");
  const desc = document.getElementById("configModeDesc");
  const walletInfo = document.getElementById("configWalletInfo");

  // checked = LIVE mode (inverted: dryRun=false means LIVE)
  toggle.checked = !cfg.dryRun;
  if (cfg.dryRun) {
    label.textContent = "📡 SCALP MONITOR (SIM)";
    label.className = "config-mode-label dry";
    desc.textContent = "Ordens simuladas — sem execução real";
  } else {
    label.textContent = "💰 LIVE TRADING";
    label.className = "config-mode-label live";
    desc.textContent = "⚠️ Compras e vendas REAIS na Polymarket";
  }

  if (cfg.walletAddress) {
    walletInfo.textContent = `Wallet: ${cfg.walletAddress.substring(0, 6)}...${cfg.walletAddress.slice(-4)} | Max Stake: $${cfg.maxStake}`;
  }

  // Indicator grids — one per timeframe
  const enabled5m  = new Set(cfg.enabledIndicators5m  || cfg.enabledIndicators || []);
  const enabled15m = new Set(cfg.enabledIndicators15m || cfg.enabledIndicators || []);
  const stakes = cfg.stakesPerIndicator || {};
  const cfgConfigs = cfg.indicatorConfigs || {};

  const INDICATOR_TOOLTIPS = {
    "Top3 5m":             "Combinação: Delta 3m + TA Predict + Bollinger",
    "Top3 15m":            "Combinação: Delta 3m + Heiken Ashi + OBV",
    "Delta 3m Fade 5m":   "Contra-tendência: quando Delta 3m=UP entra DOWN, e vice-versa (exclusivo 5m)",
    "Delta 3m Fade 15m":  "Contra-tendência: quando Delta 3m=UP entra DOWN, e vice-versa (exclusivo 15m)",
    "Full Consensus": "RSI (>55/<45) + MACD + Heiken Ashi + OBV todos alinhados",
    "Consensus Edge": "Voto ponderado de 9 indicadores: TA Predict, Heiken Ashi, MACD, Delta 3m, Bollinger, OBV, Heiken+OBV, Full Consensus, 5+ Agree (≥7/9 + filtro de preço 60-85¢)",
    "Heiken+OBV":     "Heiken Ashi + OBV alinhados na mesma direção",
    "5+ Agree":       "5 ou mais de 7 base concordam: HA, RSI, MACD, EMA, OBV, VWAP, Delta 3m",
    "Heiken Ashi":    "Sequência de candles Heiken Ashi — verde=UP, vermelho=DOWN",
    "OBV":            "On-Balance Volume — slope positivo=UP, negativo=DOWN",
    "Delta 3m":       "Delta de preço BTC nos últimos 3 minutos — positivo=UP, negativo=DOWN",
    "MACD":           "MACD — cruzamento bullish=UP, bearish=DOWN",
    "Bollinger":      "Bollinger Bands — %B > 0.5 = UP, %B < 0.5 = DOWN",
    "TA Predict":     "Probabilidade ajustada pelo tempo restante — UP vs DOWN",
  };

  function buildGrid(containerId, enabledSet) {
    const grid = document.getElementById(containerId);
    const tf = containerId.includes("15m") ? "15m" : "5m";
    const only15m = new Set(cfg.only15mIndicators || []);
    const only5m  = new Set(cfg.only5mIndicators  || []);
    // Scalp indicators have their own dedicated advanced section below; skip them here.
    // only15mIndicators / only5mIndicators are exclusive to their respective tabs.
    const regular = (cfg.allIndicators || []).filter(n =>
      !isScalpIndicatorName(n) &&
      (tf === "15m" || !only15m.has(n)) &&
      (tf === "5m"  || !only5m.has(n))
    );
    grid.innerHTML = regular.map(name => {
      const active = enabledSet.has(name);
      const cls = active ? "active" : "inactive";
      const indCfg = cfgConfigs[name] || {};
      const stakeVal = ((indCfg.stakeUsd ?? stakes[name] ?? 1)).toFixed(2);
      const isLive = Boolean(indCfg.liveMode);
      const tooltip = INDICATOR_TOOLTIPS[name] || "";
      return `
        <div class="config-indicator-item ${cls}${isLive ? ' live-mode' : ''}" onclick="toggleIndicator(this, '${escapeAttr(name)}', '${tf}')"${tooltip ? ` title="${escapeAttr(tooltip)}"` : ''}>
          <div class="config-indicator-toggle config-switch">
            <input type="checkbox" data-indicator="${escapeAttr(name)}" data-tf="${tf}" ${active ? "checked" : ""} style="display:none">
            <span class="config-slider-visual ${active ? 'on' : ''}"></span>
          </div>
          <span class="config-indicator-name">${name}</span>
          <div class="config-ind-right">
            <span class="config-ind-live-pill ${isLive ? 'on' : ''}" data-indicator="${escapeAttr(name)}"
              onclick="event.stopPropagation(); toggleIndicatorLive(this)"
              title="${isLive ? 'LIVE: ordens reais — clicar para voltar ao SIM' : 'SIM: simulado — clicar para ativar LIVE'}">
              ${isLive ? '⚡LIVE' : 'SIM'}
            </span>
            <input type="number" class="config-stake-input" data-indicator="${escapeAttr(name)}"
              value="${stakeVal}" min="0.10" max="100" step="0.50"
              onclick="event.stopPropagation()" title="Stake base em USD para ${name}">
          </div>
        </div>
      `;
    }).join("");
  }

  function scalpParamInput(name, key, value, step, suffix, title) {
    const safeVal = value === null || value === undefined ? "" : value;
    return `<label class="config-scalp-field" title="${escapeAttr(scalpHelp(key) || title || "")}">
      <span class="config-scalp-field-label">${title}</span>
      <span class="config-scalp-field-input">
        <input type="number" class="config-scalp-input" data-indicator="${escapeAttr(name)}" data-key="${key}"
          value="${escapeAttr(safeVal)}" min="0" step="${step}" onclick="event.stopPropagation()">
        <span class="config-scalp-suffix">${suffix}</span>
      </span>
    </label>`;
  }

  function scalpParamSelect(name, key, value, title, options, dataType = "string") {
    const opts = options.map(opt => {
      const selected = String(opt.value) === String(value) ? "selected" : "";
      return `<option value="${escapeAttr(opt.value)}" ${selected}>${escapeAttr(opt.label)}</option>`;
    }).join("");
    return `<label class="config-scalp-field" title="${escapeAttr(scalpHelp(key) || title || "")}">
      <span class="config-scalp-field-label">${title}</span>
      <span class="config-scalp-field-input">
        <select class="config-scalp-input" data-type="${escapeAttr(dataType)}"
          data-indicator="${escapeAttr(name)}" data-key="${key}" onclick="event.stopPropagation()">
          ${opts}
        </select>
        <span class="config-scalp-suffix"></span>
      </span>
    </label>`;
  }

  function configScalpGroup(title, rows) {
    return `<fieldset class="config-scalp-param-group">
      <legend>${escapeAttr(title)}</legend>
      <div class="config-scalp-grid">${rows.join("")}</div>
    </fieldset>`;
  }

  function buildScalpSection(containerId, enabledSet) {
    const section = document.getElementById(containerId);
    if (!section) return;
    const tf = containerId.includes("15m") ? "15m" : "5m";
    const scalpName = tf === "15m" ? "Scalp Force 15m" : "Scalp Force 5m";
    const active = enabledSet.has(scalpName);
    const indCfg = cfgConfigs[scalpName] || {};
    const stakeVal = ((indCfg.stakeUsd ?? stakes[scalpName] ?? 1)).toFixed(2);
    const isLive = Boolean(indCfg.liveMode);
    const entryRows = [
      scalpParamInput(scalpName, "entryMinPct", indCfg.entryMinPct ?? 50, 0.5, "%", "Entry min"),
      scalpParamInput(scalpName, "entryMaxPct", indCfg.entryMaxPct ?? 55, 0.5, "%", "Entry max"),
      scalpParamInput(scalpName, "entryOpenWindowSec", indCfg.entryOpenWindowSec ?? 20, 1, "s", "Janela")
    ];
    const tpRows = [
      scalpParamInput(scalpName, "takeProfitPct", indCfg.takeProfitPct ?? 75, 0.5, "%", "TP"),
      scalpParamSelect(scalpName, "tpExitMode", indCfg.tpExitMode ?? "exit", "TP mode", [
        { value: "exit", label: "exit" },
        { value: "trail", label: "trail" }
      ]),
      scalpParamInput(scalpName, "tpTrailCents", indCfg.tpTrailCents ?? 3, 0.5, "¢", "TP trail"),
      scalpParamSelect(scalpName, "tpForceExitEnabled", indCfg.tpForceExitEnabled !== false ? "true" : "false", "TP força", [
        { value: "true", label: "on" },
        { value: "false", label: "off" }
      ], "boolean"),
      scalpParamInput(scalpName, "tpForceFailTicks", indCfg.tpForceFailTicks ?? 2, 1, "x", "Fail ticks")
    ];
    const protectionRows = [
      scalpParamInput(scalpName, "minExitPct", indCfg.minExitPct ?? 58, 0.5, "%", "Min exit"),
      scalpParamInput(scalpName, "trailingArmingCents", indCfg.trailingArmingCents ?? 2, 0.5, "¢", "Trail arm"),
      scalpParamInput(scalpName, "trailingCushionCents", indCfg.trailingCushionCents ?? 3, 0.5, "¢", "Trail stop"),
      scalpParamInput(scalpName, "maxHoldSec", indCfg.maxHoldSec ?? 150, 1, "s", "Hold max")
    ];
    const executionRows = [
      scalpParamInput(scalpName, "maxEntriesPerCandle", indCfg.maxEntriesPerCandle ?? 2, 1, "x", "Max entries"),
      scalpParamInput(scalpName, "minSharesFloor", indCfg.minSharesFloor ?? 5, 1, "sh", "Min shares"),
      scalpParamInput(scalpName, "maxEffectiveStakeUsd", (indCfg.maxEffectiveStakeUsd ?? 10), 0.5, "$", "Cap stake")
    ];

    section.innerHTML = `
      <div class="config-scalp-block ${active ? 'active' : 'inactive'}" data-indicator="${escapeAttr(scalpName)}">
        <div class="config-scalp-head" onclick="toggleScalpBlock(this.closest('.config-scalp-block'), '${escapeAttr(scalpName)}', '${tf}')">
          <div class="config-scalp-toggle-wrap">
            <input type="checkbox" data-indicator="${escapeAttr(scalpName)}" data-tf="${tf}" ${active ? "checked" : ""} style="display:none">
            <span class="config-slider-visual ${active ? 'on' : ''}"></span>
          </div>
          <span class="config-scalp-head-title">⚡ ${scalpName}</span>
          <span class="config-scalp-tag">scalp</span>
          <span class="config-ind-live-pill ${isLive ? 'on' : ''}" data-indicator="${escapeAttr(scalpName)}"
            onclick="event.stopPropagation(); toggleIndicatorLive(this)"
            title="${isLive ? 'LIVE: ordens reais — clicar para voltar ao SIM' : 'SIM: simulado — clicar para ativar LIVE'}">
            ${isLive ? '⚡LIVE' : 'SIM'}
          </span>
          <label class="config-scalp-stake" onclick="event.stopPropagation()" title="${escapeAttr(scalpHelp('stakeUsd'))}">
            <span>Stake base $</span>
            <input type="number" class="config-stake-input" data-indicator="${escapeAttr(scalpName)}"
              value="${stakeVal}" min="0.10" max="1000" step="0.50">
          </label>
        </div>
        <div class="config-scalp-groups">
          ${configScalpGroup("Entrada", entryRows)}
          ${configScalpGroup("Alvo / TP", tpRows)}
          ${configScalpGroup("Proteções", protectionRows)}
          ${configScalpGroup("Execução", executionRows)}
        </div>
      </div>
    `;
  }

  buildGrid("configIndicatorGrid5m",  enabled5m);
  buildGrid("configIndicatorGrid15m", enabled15m);
  buildScalpSection("configScalpSection5m",  enabled5m);
  buildScalpSection("configScalpSection15m", enabled15m);
  updateIndicatorCount();
  if (typeof window.renderScalpStrategyUI === "function") {
    window.renderScalpStrategyUI(cfg);
  }
}

function toggleIndicator(el, name, tf) {
  const cb = el.querySelector('input[type="checkbox"]');
  cb.checked = !cb.checked;
  const slider = el.querySelector('.config-slider-visual');
  if (slider) slider.className = `config-slider-visual ${cb.checked ? 'on' : ''}`;
  el.className = `config-indicator-item ${cb.checked ? "active" : "inactive"}`;
  updateIndicatorCount();
}
window.toggleIndicator = toggleIndicator;

function toggleAllIndicators(state) {
  // Only toggle the currently visible tab (indicator grid + scalp section)
  const tf = document.getElementById("tab15m")?.classList.contains("active") ? "15m" : "5m";
  const gridId = `configIndicatorGrid${tf}`;
  const scalpId = `configScalpSection${tf}`;
  document.querySelectorAll(`#${gridId} .config-indicator-item`).forEach(item => {
    const cb = item.querySelector('input[type="checkbox"]');
    cb.checked = state;
    const slider = item.querySelector('.config-slider-visual');
    if (slider) slider.className = `config-slider-visual ${state ? 'on' : ''}`;
    item.className = `config-indicator-item ${state ? "active" : "inactive"}`;
  });
  document.querySelectorAll(`#${scalpId} .config-scalp-block`).forEach(block => {
    const cb = block.querySelector('input[type="checkbox"]');
    cb.checked = state;
    const slider = block.querySelector('.config-slider-visual');
    if (slider) slider.className = `config-slider-visual ${state ? 'on' : ''}`;
    block.className = `config-scalp-block ${state ? "active" : "inactive"}`;
  });
  updateIndicatorCount();
}
window.toggleAllIndicators = toggleAllIndicators;

function toggleScalpBlock(blockEl, name, tf) {
  const cb = blockEl.querySelector('input[type="checkbox"]');
  cb.checked = !cb.checked;
  const slider = blockEl.querySelector('.config-slider-visual');
  if (slider) slider.className = `config-slider-visual ${cb.checked ? 'on' : ''}`;
  blockEl.className = `config-scalp-block ${cb.checked ? 'active' : 'inactive'}`;
  updateIndicatorCount();
}
window.toggleScalpBlock = toggleScalpBlock;

function toggleIndicatorLive(pill) {
  const name = pill.dataset.indicator || "?";
  const isCurrentlyLive = pill.classList.contains('on');
  if (!isCurrentlyLive) {
    const confirmed = confirm(
      `⚠️ MODO LIVE INDIVIDUAL — "${name}"\n\n` +
      `Este indicador vai executar ordens REAIS na Polymarket\n` +
      `mesmo com o modo global em SIM (Scalp Monitor).\n\n` +
      `Confirmar?`
    );
    if (!confirmed) return;
  }
  const newLive = !isCurrentlyLive;
  pill.classList.toggle('on', newLive);
  pill.textContent = newLive ? '⚡LIVE' : 'SIM';
  pill.title = newLive ? 'LIVE: ordens reais — clicar para voltar ao SIM' : 'SIM: simulado — clicar para ativar LIVE';
  const card = pill.closest('.config-indicator-item');
  if (card) card.classList.toggle('live-mode', newLive);
}
window.toggleIndicatorLive = toggleIndicatorLive;

function updateIndicatorCount() {
  const tf = document.getElementById("tab15m")?.classList.contains("active") ? "15m" : "5m";
  const gridId = `configIndicatorGrid${tf}`;
  const scalpId = `configScalpSection${tf}`;
  // Count only the enable checkboxes — stake/param numeric inputs are excluded.
  const allToggles = document.querySelectorAll(
    `#${gridId} .config-indicator-toggle input[type="checkbox"], #${scalpId} .config-scalp-toggle-wrap input[type="checkbox"]`
  );
  const checkedToggles = [...allToggles].filter(cb => cb.checked);
  const el = document.getElementById("configIndicatorCount");
  if (el) el.textContent = `${tf}: ${checkedToggles.length}/${allToggles.length}`;
}

function switchIndicatorTab(tf) {
  // Update tab buttons
  document.getElementById("tab5m").classList.toggle("active", tf === "5m");
  document.getElementById("tab15m").classList.toggle("active", tf === "15m");
  // Update pane visibility (both indicator grid AND scalp section follow the tabs)
  document.getElementById("configIndicatorGrid5m").classList.toggle("active-pane", tf === "5m");
  document.getElementById("configIndicatorGrid15m").classList.toggle("active-pane", tf === "15m");
  const scalp5m = document.getElementById("configScalpSection5m");
  const scalp15m = document.getElementById("configScalpSection15m");
  if (scalp5m) scalp5m.classList.toggle("active-pane", tf === "5m");
  if (scalp15m) scalp15m.classList.toggle("active-pane", tf === "15m");
  updateIndicatorCount();
}
window.switchIndicatorTab = switchIndicatorTab;

function handleModeToggle(checkbox) {
  if (checkbox.checked) {
    // Switching to LIVE — require double confirmation
    const confirmed = confirm(
      "⚠️ ATENÇÃO!\n\n" +
      "Isso ATIVARÁ compras e vendas REAIS na Polymarket.\n" +
      "Todas as próximas ordens serão executadas com dinheiro real.\n\n" +
      "Tem certeza que deseja continuar?"
    );
    if (!confirmed) {
      checkbox.checked = false;
      return;
    }
    // Second confirmation
    const confirmed2 = confirm(
      "💰 CONFIRMAÇÃO FINAL\n\n" +
      "Modo LIVE será ativado AGORA.\n" +
      "Clique OK para confirmar."
    );
    if (!confirmed2) {
      checkbox.checked = false;
      return;
    }
  }
  // Update label immediately
  const label = document.getElementById("configModeLabel");
  const desc = document.getElementById("configModeDesc");
  if (checkbox.checked) {
    label.textContent = "💰 LIVE TRADING";
    label.className = "config-mode-label live";
    desc.textContent = "⚠️ Compras e vendas REAIS na Polymarket";
  } else {
    label.textContent = "📡 SCALP MONITOR (SIM)";
    label.className = "config-mode-label dry";
    desc.textContent = "Ordens simuladas — sem execução real";
  }
}
window.handleModeToggle = handleModeToggle;

function saveConfig() {
  const enabledIndicators5m  = [];
  const enabledIndicators15m = [];
  document.querySelectorAll('#configIndicatorGrid5m  input[type="checkbox"]:checked').forEach(cb => {
    enabledIndicators5m.push(cb.dataset.indicator);
  });
  document.querySelectorAll('#configIndicatorGrid15m input[type="checkbox"]:checked').forEach(cb => {
    enabledIndicators15m.push(cb.dataset.indicator);
  });
  document.querySelectorAll('#configScalpSection5m  input[type="checkbox"]:checked').forEach(cb => {
    enabledIndicators5m.push(cb.dataset.indicator);
  });
  document.querySelectorAll('#configScalpSection15m input[type="checkbox"]:checked').forEach(cb => {
    enabledIndicators15m.push(cb.dataset.indicator);
  });
  const dryRun = !document.getElementById("configDryRunToggle").checked;

  // Collect per-indicator stakes (from either grid — both share same indicator names)
  const stakesPerIndicator = {};
  document.querySelectorAll('.config-stake-input').forEach(input => {
    const name = input.dataset.indicator;
    const val = parseFloat(input.value);
    if (name && Number.isFinite(val) && val >= 0.1) {
      stakesPerIndicator[name] = Math.round(val * 100) / 100;
    }
  });

  // Collect scalp advanced fields (min shares floor, max effective stake USD)
  const indicatorConfigs = {};
  document.querySelectorAll('.config-scalp-input').forEach(input => {
    const name = input.dataset.indicator;
    const key = input.dataset.key;
    if (!name || !key) return;
    if (!indicatorConfigs[name]) indicatorConfigs[name] = {};
    if (input.dataset.type === "boolean") {
      indicatorConfigs[name][key] = input.value === "true";
      return;
    }
    if (input.dataset.type === "string") {
      indicatorConfigs[name][key] = input.value;
      return;
    }
    const val = parseFloat(input.value);
    if (!Number.isFinite(val)) return;
    indicatorConfigs[name][key] = val;
  });

  // Collect per-indicator liveMode flags (LIVE override por indicador)
  document.querySelectorAll('.config-ind-live-pill').forEach(pill => {
    const name = pill.dataset.indicator;
    if (!name) return;
    if (!indicatorConfigs[name]) indicatorConfigs[name] = {};
    indicatorConfigs[name].liveMode = pill.classList.contains('on');
  });

  if (ws && ws.readyState === WebSocket.OPEN) {
    const payload = {
      action: "setConfig",
      enabledIndicators5m,
      enabledIndicators15m,
      stakesPerIndicator,
      indicatorConfigs,
      dryRun
    };
    if (typeof window.collectScalpStrategyBindingsForSave === "function") {
      const sb = window.collectScalpStrategyBindingsForSave();
      if (sb?.scalpStrategyBindings) payload.scalpStrategyBindings = sb.scalpStrategyBindings;
    }
    ws.send(JSON.stringify(payload));
  }
  if (isSettingsPage) {
    showSettingsSaveFeedback();
  } else {
    closeConfigModal();
  }
}
window.saveConfig = saveConfig;

function showSettingsSaveFeedback() {
  const el = document.getElementById("settingsSaveHint");
  if (!el) return;
  el.textContent = "Configuração salva.";
  el.hidden = false;
  if (showSettingsSaveFeedback._t) clearTimeout(showSettingsSaveFeedback._t);
  showSettingsSaveFeedback._t = setTimeout(() => {
    el.hidden = true;
    el.textContent = "";
  }, 3500);
}

function updateTradingBadge(cfg) {
  const badge = document.getElementById("tradingBadge");
  if (!badge) return;
  const n5m  = cfg.enabledIndicators5m?.length  ?? cfg.enabledIndicators?.length ?? 0;
  const n15m = cfg.enabledIndicators15m?.length ?? cfg.enabledIndicators?.length ?? 0;
  if (cfg.dryRun) {
    badge.textContent = `📡 SIM (5m:${n5m} / 15m:${n15m})`;
    badge.className = "trading-badge dry-run";
  } else {
    badge.textContent = `💰 LIVE (5m:${n5m} / 15m:${n15m})`;
    badge.className = "trading-badge live";
  }
}

// ── Init ──
connect();
