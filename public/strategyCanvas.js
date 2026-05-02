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

  /** Texto de ajuda (HTML interno) alinhado a `advanceScalp` / `scalpForce.js`. */
  function buildNodeOperationDetails(nodeId, indicatorName) {
    const is15 = String(indicatorName || "").includes("15m");
    const strengthDelta = is15
      ? "No <strong>15m</strong>, o motor exige também <strong>Delta 3m</strong> na mesma direção."
      : "No <strong>5m</strong>, não entra o requisito extra de Delta 3m na função <code>strengthAgrees</code> (só Heiken+OBV e 5+ Agree).";
    const inner = {
      [NODE.ENTRY_DIRECTION]: `
        <p>O servidor obtém o preço spot de cada bolsa marcada, descarta valores inválidos e calcula a <strong>mediana</strong>.</p>
        <p>Compara essa mediana com o <strong>Price to Beat</strong> (PTB) do mercado: mediana ≥ PTB → lado <strong>UP</strong>; caso contrário <strong>DOWN</strong>. Não usa a média aritmética.</p>
        <p>Este nó só define o <em>lado candidato</em>. A entrada real só ocorre se os nós Confirmação, Janela, Faixa e Sizing também passarem.</p>`,
      [NODE.ENTRY_STRENGTH]: `
        <p>Depois de saber UP ou DOWN, o motor chama <code>strengthAgrees</code>: todos os sinais obrigatórios para o timeframe têm de devolver <strong>exactamente</strong> esse lado.</p>
        <p><strong>Heiken+OBV</strong> e <strong>5+ Agree</strong> são sempre obrigatórios. ${strengthDelta}</p>
        <p>Os checkboxes refletem a configuração guardada no grafo; a lista efectiva no código do motor segue a regra acima por timeframe.</p>`,
      [NODE.ENTRY_WINDOW]: `
        <p>O servidor envia <code>candleElapsedMs</code> (tempo desde o início do candle). Este valor em <strong>segundos</strong> define o limite: só há entrada se o tempo decorrido for ≤ janela × 1000 ms.</p>
        <p>Se a direcção e a força estiverem ok mas o relógio já passou do limite, o estado fica fora da janela — não abre nova posição até ao próximo contexto válido.</p>`,
      [NODE.ENTRY_BAND]: `
        <p>Usa o preço do contrato Polymarket do lado escolhido (token UP ou DOWN, entre 0 e 1), converte para <strong>percentagem de cêntimos</strong> (preço × 100) e compara com <strong>Mín %</strong> e <strong>Máx %</strong>.</p>
        <p>Só entra se o preço estiver <em>dentro</em> da faixa. Isto evita comprar quando o mercado está demasiado “barato” ou “caro” vs. a tua zona operacional.</p>`,
      [NODE.SIZING]: `
        <p><strong>Stake (USD)</strong> é o mínimo em dólares; o motor calcula shares ≈ stake ÷ preço do contrato e <strong>sobe</strong> o valor se precisar de cumprir <strong>Min shares</strong> (mínimo da CLOB).</p>
        <p><strong>Cap (USD)</strong> limita o stake efectivo depois desse ajuste. <strong>Max entries / candle</strong> impede mais de N entradas completas no mesmo candle (reentradas após TP contam).</p>`,
      [NODE.EXIT_TP]: `
        <p>Durante <code>IN_POSITION</code>, o motor acompanha o preço do contrato em cêntimos (<code>pct</code>). <strong>TP %</strong> é o alvo em cêntimos do contrato: ao atingir ou ultrapassar, dispara a lógica de TP.</p>
        <p><strong>Modo exit</strong>: fecha logo que o alvo seja atingido. <strong>Modo trail</strong>: ao atingir o alvo “arma” protecção — o stop segue o máximo desde a entrada menos <strong>Trail ¢</strong>; se o preço cair até lá, sai com trailing stop.</p>
        <p><strong>Force exit</strong> ligado: com TP em modo <em>trail</em> já armado, se os sinais de força <strong>deixarem</strong> de alinhar com o lado da posição durante vários ticks seguidos (<strong>Fail ticks</strong>), o motor força saída (<code>tp_force_fail</code>) para não ficar preso quando o contexto técnico muda.</p>`,
      [NODE.EXIT_PROTECT]: `
        <p><strong>Min exit %</strong>: piso em cêntimos do contrato para várias saídas (timeout, decay, hold favorável). Abaixo disto o motor tende a forçar saída “dura” em vez de saída mínima.</p>
        <p><strong>Trail arm ¢</strong> / <strong>Trail stop ¢</strong>: o stop de protecção só <em>arma</em> depois do contrato subir pelo menos “arm” acima do preço de entrada; o stop segue o máximo desde a entrada menos o “cushion” (stop).</p>
        <p><strong>Hold máx (s)</strong>: prazo máximo em posição; findo o prazo, avalia timeout (com regra de “hold favorável” se BTC e contrato ainda ajudam). Outras protecções (hard stop, decay por BTC vs PTB) usam defaults no motor além destes campos.</p>`
    }[nodeId];
    if (!inner) return "";
    return `<details class="strategy-node-details">
      <summary class="strategy-node-details-sum">Detalhe — operação no motor Scalp</summary>
      <div class="strategy-node-details-inner">${inner}</div>
    </details>`;
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
        ${buildNodeOperationDetails(NODE.ENTRY_DIRECTION, indicatorName)}
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
        ${buildNodeOperationDetails(NODE.ENTRY_STRENGTH, indicatorName)}
        ${fieldChecklist(ind, id, "requiredStrengthSignals", tfList, sel)}
      `;
    }
    if (id === NODE.ENTRY_WINDOW) {
      return `
        <p class="strategy-node-body">Tempo após abertura do candle em que ainda aceitamos entrar.</p>
        ${buildNodeOperationDetails(NODE.ENTRY_WINDOW, indicatorName)}
        <div class="strategy-fields-row">
          ${fieldNum(ind, id, "entryOpenWindowSec", "Janela (segundos)", d.entryOpenWindowSec, 1, 1, 3600)}
        </div>
      `;
    }
    if (id === NODE.ENTRY_BAND) {
      return `
        <p class="strategy-node-body">Faixa do preço do contrato (em %) onde entradas são permitidas.</p>
        ${buildNodeOperationDetails(NODE.ENTRY_BAND, indicatorName)}
        <div class="strategy-fields-row">
          ${fieldNum(ind, id, "entryMinPct", "Mín %", d.entryMinPct, 0.5, 0, 100)}
          ${fieldNum(ind, id, "entryMaxPct", "Máx %", d.entryMaxPct, 0.5, 0, 100)}
        </div>
      `;
    }
    if (id === NODE.SIZING) {
      return `
        <p class="strategy-node-body">Tamanho base e limites de execução.</p>
        ${buildNodeOperationDetails(NODE.SIZING, indicatorName)}
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
        ${buildNodeOperationDetails(NODE.EXIT_TP, indicatorName)}
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
        ${buildNodeOperationDetails(NODE.EXIT_PROTECT, indicatorName)}
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

  function renderWorkspace(indicatorName, graph, tf, ui) {
    const nodes = graph?.nodes || [];
    const st = ui && typeof ui === "object" ? ui : {};
    const enabled = Boolean(st.enabled);
    const liveMode = Boolean(st.liveMode);
    const liveTitle = liveMode
      ? "LIVE: ordens reais neste Scalp — clicar para voltar ao SIM"
      : "SIM: simulado — clicar para ativar LIVE (ordens reais)";
    const scalpBtnLabel = enabled ? "Scalp ON" : "Scalp OFF";
    return `<div class="strategy-workspace" data-scalp-indicator="${esc(indicatorName)}" data-tf="${esc(tf)}">
      <header class="strategy-workspace-head">
        <div class="strategy-workspace-head-left">
          <h4 class="strategy-workspace-title">Canvas Workspace · ${esc(indicatorName)}</h4>
          <span class="strategy-status-badge"><span class="strategy-status-dot"></span>Status: <strong>Valid</strong></span>
        </div>
        <div class="strategy-workspace-toolbar" role="toolbar" aria-label="Controlo do canvas">
          <button type="button" class="strategy-toolbar-btn strategy-toolbar-save"
            onclick="event.stopPropagation();(window.saveConfig)&&window.saveConfig();"
            title="Gravar estratégia (canvas), parâmetros e modo no servidor">💾 Salvar</button>
          <span class="config-ind-live-pill strategy-toolbar-live ${liveMode ? "on" : ""}" data-indicator="${esc(indicatorName)}"
            onclick="event.stopPropagation();(window.toggleIndicatorLive)&&window.toggleIndicatorLive(this);"
            title="${esc(liveTitle)}">${liveMode ? "⚡LIVE" : "SIM"}</span>
          <button type="button" class="strategy-toolbar-scalp ${enabled ? "is-on" : "is-off"}"
            data-scalp-toggle="${esc(indicatorName)}" data-tf="${esc(tf)}"
            onclick="event.stopPropagation();(window.toggleScalpForceFromCanvas)&&window.toggleScalpForceFromCanvas(this);"
            aria-pressed="${enabled ? "true" : "false"}"
            title="Ativar ou desativar Scalp Force neste timeframe (5m / 15m)">${esc(scalpBtnLabel)}</button>
        </div>
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

    const cfgInd = cfg.indicatorConfigs || {};
    const en5m = (cfg.enabledIndicators5m || []).includes(SCALP_5M);
    const en15m = (cfg.enabledIndicators15m || []).includes(SCALP_15M);
    const live5m = Boolean(cfgInd[SCALP_5M]?.liveMode);
    const live15m = Boolean(cfgInd[SCALP_15M]?.liveMode);

    root.innerHTML = `
      <div class="strategy-builder-card strategy-builder-fullwidth">
        <div class="strategy-builder-head">
          <div>
            <h3 class="strategy-builder-title">Construtor de estratégia (Scalp)</h3>
            <p class="strategy-builder-sub">Cada mercado BTC tem uma estratégia fixa. O <strong>canvas</strong> (nós e ligações) é a fonte de verdade ao gravar — use o topo do workspace para Salvar, LIVE por Scalp e ligar/desligar o Scalp Force.</p>
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
            ${renderWorkspace(SCALP_5M, g5, "5m", { enabled: en5m, liveMode: live5m })}
          </div>
          <div class="strategy-canvas-panel" data-market="15m" hidden aria-hidden="true">
            ${renderWorkspace(SCALP_15M, g15, "15m", { enabled: en15m, liveMode: live15m })}
          </div>
        </div>
      </div>
    `;
    wireMarketStrip(root);
    setupResize(root);
    root.querySelectorAll(".strategy-node-input[data-node-id=\"sizing\"][data-field=\"stakeUsd\"]").forEach(inp => {
      inp.addEventListener("input", () => {
        if (typeof window.syncScalpStakeHeaderFromCanvas === "function") window.syncScalpStakeHeaderFromCanvas();
      });
    });
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
