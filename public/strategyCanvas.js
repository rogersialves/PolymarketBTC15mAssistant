/**
 * Scalp strategy canvas (settings page).
 * Visual flow editor inspired pelo Stitch reference: workspace com grid,
 * nós ancorados em colunas, conexões SVG curvas entre portas.
 *
 * Cada nó é uma "card de canvas" com controlos inline:
 *  - Direção: checkboxes de fontes (bolsas spot) usadas na mediana.
 *  - Confirmação: lista de sinais que devem confirmar a direção (Heiken+OBV, etc.).
 *  - Janela de entrada: segundos.
 *  - Faixa de contrato: min/max %.
 *  - Sizing, Alvo/TP, Proteções: campos numéricos.
 *
 * BTC 5M ↔ Scalp Force 5m; BTC 15M ↔ Scalp Force 15m.
 * Schema: src/scalp/strategyGraph.js (schemaVersion 1).
 */
(function () {
  const SCALP_5M = "Scalp Force 5m";
  const SCALP_15M = "Scalp Force 15m";
  const FAM_5M = "btc-updown-5m";
  const FAM_15M = "btc-updown-15m";

  const NODE = {
    ENTRY_DIRECTION: "entry_direction",
    ENTRY_STRENGTH: "entry_strength",
    ENTRY_WINDOW: "entry_window",
    ENTRY_BAND: "entry_band",
    SIZING: "sizing",
    EXIT_TP: "exit_tp",
    EXIT_PROTECT: "exit_protect"
  };

  const NODE_ICONS = {
    [NODE.ENTRY_DIRECTION]: "↗",
    [NODE.ENTRY_STRENGTH]: "✓",
    [NODE.ENTRY_WINDOW]: "⏱",
    [NODE.ENTRY_BAND]: "⇿",
    [NODE.SIZING]: "$",
    [NODE.EXIT_TP]: "🎯",
    [NODE.EXIT_PROTECT]: "🛡"
  };

  // Layout (col, row) — 3 colunas, 2-3 linhas; deve coincidir com CSS grid abaixo
  const NODE_LAYOUT = {
    [NODE.ENTRY_DIRECTION]: { col: 1, row: 1 },
    [NODE.ENTRY_STRENGTH]:  { col: 1, row: 2 },
    [NODE.ENTRY_WINDOW]:    { col: 2, row: 1 },
    [NODE.ENTRY_BAND]:      { col: 2, row: 2 },
    [NODE.SIZING]:          { col: 2, row: 3 },
    [NODE.EXIT_TP]:         { col: 3, row: 1 },
    [NODE.EXIT_PROTECT]:    { col: 3, row: 3 }
  };

  const ALL_DIR_SOURCES = [
    { id: "binance", label: "Binance" },
    { id: "coinbase", label: "Coinbase" },
    { id: "kraken", label: "Kraken" },
    { id: "bybit", label: "Bybit" },
    { id: "okx", label: "OKX" }
  ];
  const STRENGTH_SIGNALS_5M = [
    { id: "Heiken+OBV", label: "Heiken+OBV" },
    { id: "5+ Agree", label: "5+ Agree" },
    { id: "Delta 3m", label: "Delta 3m (opcional)" }
  ];
  const STRENGTH_SIGNALS_15M = [
    { id: "Heiken+OBV", label: "Heiken+OBV" },
    { id: "5+ Agree", label: "5+ Agree" },
    { id: "Delta 3m", label: "Delta 3m" }
  ];

  let lastActiveMkt = "5m";

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fieldNum(ind, nodeId, field, label, value, step, min, max) {
    const v = value === null || value === undefined ? "" : value;
    return `<label class="strategy-field">
      <span class="strategy-field-label">${esc(label)}</span>
      <input type="number" class="strategy-node-input" data-indicator="${esc(ind)}" data-node-id="${esc(nodeId)}" data-field="${esc(field)}" value="${esc(v)}" step="${step}" min="${min}" max="${max}">
    </label>`;
  }

  function fieldSelect(ind, nodeId, field, label, value, options) {
    const opts = options.map(o => `<option value="${esc(o.value)}"${String(value) === String(o.value) ? " selected" : ""}>${esc(o.label)}</option>`).join("");
    return `<label class="strategy-field">
      <span class="strategy-field-label">${esc(label)}</span>
      <select class="strategy-node-input" data-indicator="${esc(ind)}" data-node-id="${esc(nodeId)}" data-field="${esc(field)}">${opts}</select>
    </label>`;
  }

  function fieldBoolSelect(ind, nodeId, field, label, value) {
    const b = value !== false;
    return fieldSelect(ind, nodeId, field, label, b ? "true" : "false", [
      { value: "true", label: "on" },
      { value: "false", label: "off" }
    ]);
  }

  function fieldChecklist(ind, nodeId, field, options, selectedSet) {
    return `<div class="strategy-checklist" data-indicator="${esc(ind)}" data-node-id="${esc(nodeId)}" data-field="${esc(field)}">
      ${options.map(opt => {
        const on = selectedSet.has(opt.id);
        return `<label class="strategy-check">
          <input type="checkbox" class="strategy-node-multi" data-value="${esc(opt.id)}"${on ? " checked" : ""}>
          <span>${esc(opt.label)}</span>
        </label>`;
      }).join("")}
    </div>`;
  }

  function buildNodeBody(ind, indicatorName, n) {
    const id = n.id;
    const d = n.data || {};
    if (id === NODE.ENTRY_DIRECTION) {
      const sel = new Set(Array.isArray(d.directionSources) ? d.directionSources : ["binance", "coinbase", "kraken", "bybit", "okx"]);
      return `
        <p class="strategy-node-body">Mediana das bolsas vs <em>Price to Beat</em>. Marque as fontes consideradas na mediana.</p>
        ${fieldChecklist(ind, id, "directionSources", ALL_DIR_SOURCES, sel)}
        <p class="strategy-node-note">Saída: <span class="strategy-pill up">UP</span> ou <span class="strategy-pill down">DOWN</span> conforme mediana ≥ PTB.</p>
      `;
    }
    if (id === NODE.ENTRY_STRENGTH) {
      const tfList = String(indicatorName).includes("15m") ? STRENGTH_SIGNALS_15M : STRENGTH_SIGNALS_5M;
      const fallback = String(indicatorName).includes("15m")
        ? ["Heiken+OBV", "5+ Agree", "Delta 3m"]
        : ["Heiken+OBV", "5+ Agree"];
      const sel = new Set(Array.isArray(d.requiredStrengthSignals) ? d.requiredStrengthSignals : fallback);
      return `
        <p class="strategy-node-body">Sinais que precisam confirmar a direção para armar entrada.</p>
        ${fieldChecklist(ind, id, "requiredStrengthSignals", tfList, sel)}
      `;
    }
    if (id === NODE.ENTRY_WINDOW) {
      return `
        <p class="strategy-node-body">Tempo após abertura do candle em que ainda aceitamos entrar.</p>
        <div class="strategy-fields-row">
          ${fieldNum(ind, id, "entryOpenWindowSec", "Janela (segundos)", d.entryOpenWindowSec, 1, 1, 3600)}
        </div>
      `;
    }
    if (id === NODE.ENTRY_BAND) {
      return `
        <p class="strategy-node-body">Faixa do preço do contrato (em %) onde entradas são permitidas.</p>
        <div class="strategy-fields-row">
          ${fieldNum(ind, id, "entryMinPct", "Mín %", d.entryMinPct, 0.5, 0, 100)}
          ${fieldNum(ind, id, "entryMaxPct", "Máx %", d.entryMaxPct, 0.5, 0, 100)}
        </div>
      `;
    }
    if (id === NODE.SIZING) {
      return `
        <p class="strategy-node-body">Tamanho base e limites de execução.</p>
        <div class="strategy-fields-row">
          ${fieldNum(ind, id, "stakeUsd", "Stake (USD)", d.stakeUsd, 0.5, 0.1, 10000)}
          ${fieldNum(ind, id, "minSharesFloor", "Min shares", d.minSharesFloor, 1, 0, 10000)}
          ${fieldNum(ind, id, "maxEffectiveStakeUsd", "Cap (USD)", d.maxEffectiveStakeUsd, 0.5, 0.1, 10000)}
          ${fieldNum(ind, id, "maxEntriesPerCandle", "Max entries / candle", d.maxEntriesPerCandle, 1, 1, 20)}
        </div>
      `;
    }
    if (id === NODE.EXIT_TP) {
      return `
        <p class="strategy-node-body">Saída por take-profit. Modo <em>trail</em> deixa correr.</p>
        <div class="strategy-fields-row">
          ${fieldNum(ind, id, "takeProfitPct", "TP %", d.takeProfitPct, 0.5, 0, 100)}
          ${fieldSelect(ind, id, "tpExitMode", "Modo", d.tpExitMode || "exit", [
            { value: "exit", label: "exit" }, { value: "trail", label: "trail" }
          ])}
          ${fieldNum(ind, id, "tpTrailCents", "Trail ¢", d.tpTrailCents, 0.5, 0, 100)}
          ${fieldBoolSelect(ind, id, "tpForceExitEnabled", "Force exit", d.tpForceExitEnabled)}
          ${fieldNum(ind, id, "tpForceFailTicks", "Fail ticks", d.tpForceFailTicks, 1, 1, 20)}
        </div>
      `;
    }
    if (id === NODE.EXIT_PROTECT) {
      return `
        <p class="strategy-node-body">Limites mínimos, trailing-stop e tempo máximo de hold.</p>
        <div class="strategy-fields-row">
          ${fieldNum(ind, id, "minExitPct", "Min exit %", d.minExitPct, 0.5, 0, 100)}
          ${fieldNum(ind, id, "trailingArmingCents", "Trail arm ¢", d.trailingArmingCents, 0.5, 0, 100)}
          ${fieldNum(ind, id, "trailingCushionCents", "Trail stop ¢", d.trailingCushionCents, 0.5, 0, 100)}
          ${fieldNum(ind, id, "maxHoldSec", "Hold máx (s)", d.maxHoldSec, 1, 1, 86400)}
        </div>
      `;
    }
    return `<p class="strategy-node-body">${esc(n.body || "")}</p>`;
  }

  function renderNode(indicatorName, n) {
    const layout = NODE_LAYOUT[n.id] || { col: 2, row: 1 };
    const icon = NODE_ICONS[n.id] || "•";
    return `<article class="strategy-node-card strategy-node-type-${esc(n.type)}" data-node-id="${esc(n.id)}" style="grid-column:${layout.col};grid-row:${layout.row};">
      <span class="strategy-node-port strategy-node-port-in" aria-hidden="true"></span>
      <span class="strategy-node-port strategy-node-port-out" aria-hidden="true"></span>
      <header class="strategy-node-head">
        <span class="strategy-node-icon">${esc(icon)}</span>
        <h4 class="strategy-node-title">${esc(n.title)}</h4>
      </header>
      ${buildNodeBody(indicatorName, indicatorName, n)}
    </article>`;
  }

  function renderWorkspace(indicatorName, graph) {
    const nodes = graph?.nodes || [];
    return `<div class="strategy-workspace" data-scalp-indicator="${esc(indicatorName)}">
      <header class="strategy-workspace-head">
        <h4 class="strategy-workspace-title">Canvas Workspace · ${esc(indicatorName)}</h4>
        <span class="strategy-status-badge"><span class="strategy-status-dot"></span>Status: <strong>Valid</strong></span>
      </header>
      <div class="strategy-canvas-grid" role="group" aria-label="Fluxo de estratégia">
        <svg class="strategy-edges-layer" aria-hidden="true" preserveAspectRatio="none"></svg>
        ${nodes.map(n => renderNode(indicatorName, n)).join("")}
      </div>
    </div>`;
  }

  function curvedPath(x1, y1, x2, y2) {
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  function redrawEdgesFor(panel) {
    const ws = panel.querySelector(".strategy-workspace");
    if (!ws) return;
    const grid = ws.querySelector(".strategy-canvas-grid");
    const svg = ws.querySelector(".strategy-edges-layer");
    if (!grid || !svg) return;
    const gridRect = grid.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${gridRect.width} ${gridRect.height}`);
    svg.setAttribute("width", String(gridRect.width));
    svg.setAttribute("height", String(gridRect.height));

    const indicatorName = ws.dataset.scalpIndicator;
    const graph = currentGraphsByIndicator[indicatorName];
    if (!graph) {
      svg.innerHTML = "";
      return;
    }
    const cards = {};
    grid.querySelectorAll(".strategy-node-card[data-node-id]").forEach(c => {
      cards[c.dataset.nodeId] = c;
    });

    function portCenter(card, side) {
      const port = card.querySelector(`.strategy-node-port-${side}`);
      if (!port) return null;
      const r = port.getBoundingClientRect();
      return {
        x: r.left + r.width / 2 - gridRect.left,
        y: r.top + r.height / 2 - gridRect.top
      };
    }

    const paths = (graph.edges || []).map(e => {
      const from = cards[e.from];
      const to = cards[e.to];
      if (!from || !to) return "";
      const a = portCenter(from, "out");
      const b = portCenter(to, "in");
      if (!a || !b) return "";
      return `<path class="strategy-edge-path" d="${curvedPath(a.x, a.y, b.x, b.y)}" fill="none" />`;
    }).join("");
    svg.innerHTML = paths;
  }

  const currentGraphsByIndicator = {};
  let resizeObserver = null;

  function setupResize(root) {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (typeof ResizeObserver === "undefined") return;
    resizeObserver = new ResizeObserver(() => {
      root.querySelectorAll(".strategy-canvas-panel:not([hidden])").forEach(p => redrawEdgesFor(p));
    });
    root.querySelectorAll(".strategy-canvas-panel").forEach(p => resizeObserver.observe(p));
  }

  function applyActive(root) {
    root.querySelectorAll(".strategy-market-pick").forEach(b => {
      const on = b.dataset.market === lastActiveMkt;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    root.querySelectorAll(".strategy-canvas-panel").forEach(p => {
      const on = p.dataset.market === lastActiveMkt;
      p.hidden = !on;
      p.setAttribute("aria-hidden", on ? "false" : "true");
    });
    requestAnimationFrame(() => {
      root.querySelectorAll(".strategy-canvas-panel:not([hidden])").forEach(p => redrawEdgesFor(p));
    });
  }

  function wireMarketStrip(root) {
    root.querySelectorAll(".strategy-market-pick").forEach(btn => {
      btn.addEventListener("click", () => {
        lastActiveMkt = btn.dataset.market;
        sessionStorage.setItem("strategyCanvasMkt", lastActiveMkt);
        applyActive(root);
      });
    });
    applyActive(root);
  }

  window.renderScalpStrategyUI = function (cfg) {
    const root = document.getElementById("strategyCanvasRoot");
    if (!root) return;
    const saved = sessionStorage.getItem("strategyCanvasMkt");
    if (saved === "5m" || saved === "15m") lastActiveMkt = saved;

    const b = cfg.scalpStrategyBindings || {};
    const g5 = b[SCALP_5M]?.graph;
    const g15 = b[SCALP_15M]?.graph;
    if (g5) currentGraphsByIndicator[SCALP_5M] = g5;
    if (g15) currentGraphsByIndicator[SCALP_15M] = g15;

    root.innerHTML = `
      <div class="strategy-builder-card strategy-builder-fullwidth">
        <div class="strategy-builder-head">
          <div>
            <h3 class="strategy-builder-title">Construtor de estratégia (Scalp)</h3>
            <p class="strategy-builder-sub">Cada mercado BTC tem uma estratégia fixa. Clique no mercado para abrir o canvas e editar Direção, Confirmação, Janela, Faixa, Sizing e Saídas.</p>
          </div>
          <span class="strategy-valid-badge" title="Schema v1">Valid · v1</span>
        </div>
        <div class="strategy-market-strip" role="tablist" aria-label="Mercados BTC">
          <button type="button" class="strategy-market-pick" role="tab" data-market="5m">
            <span class="strategy-market-kicker">Mercados BTC 5M</span>
            <span class="strategy-market-strategy">${esc(SCALP_5M)}</span>
            <span class="strategy-market-hint">Clique para abrir o canvas</span>
          </button>
          <button type="button" class="strategy-market-pick" role="tab" data-market="15m">
            <span class="strategy-market-kicker">Mercados BTC 15M</span>
            <span class="strategy-market-strategy">${esc(SCALP_15M)}</span>
            <span class="strategy-market-hint">Clique para abrir o canvas</span>
          </button>
        </div>
        <p class="strategy-hint-bar">Slugs fora de <code>btc-updown-5m</code> / <code>btc-updown-15m</code> não são filtrados (legado). Cada Scalp opera apenas no seu mercado.</p>
        <div class="strategy-canvas-stage">
          <div class="strategy-canvas-panel" data-market="5m" hidden aria-hidden="true">
            ${renderWorkspace(SCALP_5M, g5)}
          </div>
          <div class="strategy-canvas-panel" data-market="15m" hidden aria-hidden="true">
            ${renderWorkspace(SCALP_15M, g15)}
          </div>
        </div>
      </div>
    `;
    wireMarketStrip(root);
    setupResize(root);
    if (!window.__strategyCanvasResizeBound) {
      window.addEventListener("resize", () => {
        root.querySelectorAll(".strategy-canvas-panel:not([hidden])").forEach(p => redrawEdgesFor(p));
      });
      window.__strategyCanvasResizeBound = true;
    }
  };

  function collectGraphForIndicator(name) {
    let ws = null;
    document.querySelectorAll(".strategy-workspace").forEach(el => {
      if (el.dataset.scalpIndicator === name) ws = el;
    });
    if (!ws) return null;
    const baseGraph = currentGraphsByIndicator[name] || { schemaVersion: 1, indicatorName: name, nodes: [], edges: [] };

    // Read inline numeric / select inputs
    const nodeData = {};
    ws.querySelectorAll(".strategy-node-input").forEach(inp => {
      const nid = inp.dataset.nodeId;
      const field = inp.dataset.field;
      if (!nid || !field) return;
      if (!nodeData[nid]) nodeData[nid] = {};
      if (inp.tagName === "SELECT" && field === "tpForceExitEnabled") {
        nodeData[nid][field] = inp.value === "true";
      } else if (inp.tagName === "SELECT") {
        nodeData[nid][field] = inp.value;
      } else {
        const v = parseFloat(inp.value);
        if (Number.isFinite(v)) nodeData[nid][field] = v;
      }
    });
    // Read multi-select checklists
    ws.querySelectorAll(".strategy-checklist").forEach(list => {
      const nid = list.dataset.nodeId;
      const field = list.dataset.field;
      if (!nid || !field) return;
      const vals = [];
      list.querySelectorAll(".strategy-node-multi").forEach(cb => {
        if (cb.checked && cb.dataset.value) vals.push(cb.dataset.value);
      });
      if (!nodeData[nid]) nodeData[nid] = {};
      nodeData[nid][field] = vals;
    });

    const nodes = (baseGraph.nodes || []).map(n => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      data: { ...(n.data || {}), ...(nodeData[n.id] || {}) }
    }));
    return {
      schemaVersion: 1,
      indicatorName: name,
      nodes,
      edges: baseGraph.edges || []
    };
  }

  window.collectScalpStrategyBindingsForSave = function () {
    if (!document.getElementById("strategyCanvasRoot")) return null;
    return {
      scalpStrategyBindings: {
        [SCALP_5M]: {
          allowedSlugFamilies: [FAM_5M],
          graph: collectGraphForIndicator(SCALP_5M)
        },
        [SCALP_15M]: {
          allowedSlugFamilies: [FAM_15M],
          graph: collectGraphForIndicator(SCALP_15M)
        }
      }
    };
  };
})();
