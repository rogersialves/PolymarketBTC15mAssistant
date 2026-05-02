/**
 * Versioned strategy graph for Scalp Force UI (canvas) and round-trip to indicatorConfigs.
 * Node semantics match scalpForce.js (not generic RSI/MACD retail labels).
 */

export const STRATEGY_GRAPH_SCHEMA_VERSION = 1;

export const SLUG_FAMILY_BTC_UPDOWN_5M = "btc-updown-5m";
export const SLUG_FAMILY_BTC_UPDOWN_15M = "btc-updown-15m";

/** Known node ids for compile / layout stability */
export const SCALP_GRAPH_NODE_IDS = Object.freeze({
  ENTRY_DIRECTION: "entry_direction",
  ENTRY_STRENGTH: "entry_strength",
  ENTRY_WINDOW: "entry_window",
  ENTRY_BAND: "entry_band",
  SIZING: "sizing",
  EXIT_TP: "exit_tp",
  EXIT_PROTECT: "exit_protect"
});

/**
 * Build a read-only graph from flat scalp config (same keys as mergeScalpConfigPatch).
 * @param {string} indicatorName e.g. "Scalp Force 5m"
 */
export function buildScalpStrategyGraphFromConfig(cfg, indicatorName) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const nodes = [
    {
      id: SCALP_GRAPH_NODE_IDS.ENTRY_DIRECTION,
      type: "trigger",
      title: "Direção",
      body: "Mediana das bolsas vs Price to Beat → lado UP ou DOWN."
    },
    {
      id: SCALP_GRAPH_NODE_IDS.ENTRY_STRENGTH,
      type: "trigger",
      title: "Confirmação",
      body: "Indicadores de força (strengthAgrees) alinhados à direção."
    },
    {
      id: SCALP_GRAPH_NODE_IDS.ENTRY_WINDOW,
      type: "gate",
      title: "Janela de entrada",
      body: `Até ${c.entryOpenWindowSec ?? "—"}s após abertura do candle.`
    },
    {
      id: SCALP_GRAPH_NODE_IDS.ENTRY_BAND,
      type: "gate",
      title: "Faixa de contrato",
      body: `Preço do contrato entre ${c.entryMinPct ?? "—"}% e ${c.entryMaxPct ?? "—"}%.`
    },
    {
      id: SCALP_GRAPH_NODE_IDS.SIZING,
      type: "sizing",
      title: "Tamanho / execução",
      body: `Stake $${c.stakeUsd ?? "—"} · min shares ${c.minSharesFloor ?? "—"} · cap $${c.maxEffectiveStakeUsd ?? "—"} · max entries/candle ${c.maxEntriesPerCandle ?? "—"}.`
    },
    {
      id: SCALP_GRAPH_NODE_IDS.EXIT_TP,
      type: "exit",
      title: "Alvo / TP",
      body: `TP ${c.takeProfitPct ?? "—"}% · modo ${c.tpExitMode ?? "exit"} · trail ${c.tpTrailCents ?? "—"}¢ · força TP ${c.tpForceExitEnabled !== false ? "on" : "off"} · fail ticks ${c.tpForceFailTicks ?? "—"}.`
    },
    {
      id: SCALP_GRAPH_NODE_IDS.EXIT_PROTECT,
      type: "exit",
      title: "Proteções / tempo",
      body: `Min exit ${c.minExitPct ?? "—"}% · trail arm ${c.trailingArmingCents ?? "—"}¢ · trail stop ${c.trailingCushionCents ?? "—"}¢ · hold max ${c.maxHoldSec ?? "—"}s.`
    }
  ];

  const E = SCALP_GRAPH_NODE_IDS;
  const edges = [
    { id: "e_dir_window", from: E.ENTRY_DIRECTION, to: E.ENTRY_WINDOW },
    { id: "e_str_window", from: E.ENTRY_STRENGTH, to: E.ENTRY_WINDOW },
    { id: "e_window_band", from: E.ENTRY_WINDOW, to: E.ENTRY_BAND },
    { id: "e_band_sizing", from: E.ENTRY_BAND, to: E.SIZING },
    { id: "e_sizing_tp", from: E.SIZING, to: E.EXIT_TP },
    { id: "e_sizing_protect", from: E.SIZING, to: E.EXIT_PROTECT }
  ];

  return {
    schemaVersion: STRATEGY_GRAPH_SCHEMA_VERSION,
    indicatorName,
    nodes,
    edges
  };
}

/**
 * Extract numeric patch from graph nodes (editable fields embedded in node.data).
 * Returns {} if graph invalid or empty.
 */
export function compileScalpStrategyGraphToPatch(graph) {
  if (!graph || graph.schemaVersion !== STRATEGY_GRAPH_SCHEMA_VERSION || !Array.isArray(graph.nodes)) {
    return {};
  }
  const byId = Object.fromEntries(graph.nodes.filter(n => n?.id).map(n => [n.id, n]));
  const patch = {};

  const num = (v, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    return Math.max(min, Math.min(max, n));
  };

  const ew = byId[SCALP_GRAPH_NODE_IDS.ENTRY_WINDOW]?.data;
  if (ew && ew.entryOpenWindowSec != null) {
    const v = num(ew.entryOpenWindowSec, 1, 3600);
    if (v !== undefined) patch.entryOpenWindowSec = Math.round(v);
  }
  const eb = byId[SCALP_GRAPH_NODE_IDS.ENTRY_BAND]?.data;
  if (eb) {
    if (eb.entryMinPct != null) {
      const v = num(eb.entryMinPct, 0, 100);
      if (v !== undefined) patch.entryMinPct = Math.round(v * 100) / 100;
    }
    if (eb.entryMaxPct != null) {
      const v = num(eb.entryMaxPct, 0, 100);
      if (v !== undefined) patch.entryMaxPct = Math.round(v * 100) / 100;
    }
  }
  const sz = byId[SCALP_GRAPH_NODE_IDS.SIZING]?.data;
  if (sz) {
    if (sz.stakeUsd != null) {
      const v = num(sz.stakeUsd, 0.1, 10_000);
      if (v !== undefined) patch.stakeUsd = Math.round(v * 100) / 100;
    }
    if (sz.minSharesFloor != null) {
      const v = num(sz.minSharesFloor, 0, 10_000);
      if (v !== undefined) patch.minSharesFloor = Math.round(v);
    }
    if (sz.maxEffectiveStakeUsd != null) {
      const v = num(sz.maxEffectiveStakeUsd, 0.1, 10_000);
      if (v !== undefined) patch.maxEffectiveStakeUsd = Math.round(v * 100) / 100;
    }
    if (sz.maxEntriesPerCandle != null) {
      const v = num(sz.maxEntriesPerCandle, 1, 20);
      if (v !== undefined) patch.maxEntriesPerCandle = Math.round(v);
    }
  }
  const tp = byId[SCALP_GRAPH_NODE_IDS.EXIT_TP]?.data;
  if (tp) {
    if (tp.takeProfitPct != null) {
      const v = num(tp.takeProfitPct, 0, 100);
      if (v !== undefined) patch.takeProfitPct = Math.round(v * 100) / 100;
    }
    if (tp.tpTrailCents != null) {
      const v = num(tp.tpTrailCents, 0, 100);
      if (v !== undefined) patch.tpTrailCents = Math.round(v * 100) / 100;
    }
    if (tp.tpForceFailTicks != null) {
      const v = num(tp.tpForceFailTicks, 1, 20);
      if (v !== undefined) patch.tpForceFailTicks = Math.round(v);
    }
    if (tp.tpExitMode === "trail" || tp.tpExitMode === "exit") patch.tpExitMode = tp.tpExitMode;
    if (typeof tp.tpForceExitEnabled === "boolean") patch.tpForceExitEnabled = tp.tpForceExitEnabled;
  }
  const pr = byId[SCALP_GRAPH_NODE_IDS.EXIT_PROTECT]?.data;
  if (pr) {
    if (pr.minExitPct != null) {
      const v = num(pr.minExitPct, 0, 100);
      if (v !== undefined) patch.minExitPct = Math.round(v * 100) / 100;
    }
    if (pr.trailingArmingCents != null) {
      const v = num(pr.trailingArmingCents, 0, 100);
      if (v !== undefined) patch.trailingArmingCents = Math.round(v * 100) / 100;
    }
    if (pr.trailingCushionCents != null) {
      const v = num(pr.trailingCushionCents, 0, 100);
      if (v !== undefined) patch.trailingCushionCents = Math.round(v * 100) / 100;
    }
    if (pr.maxHoldSec != null) {
      const v = num(pr.maxHoldSec, 1, 86_400);
      if (v !== undefined) patch.maxHoldSec = Math.round(v);
    }
  }

  return patch;
}

/** Merge compile output into graph nodes' .data for editor round-trip */
export function embedConfigIntoScalpGraph(graph, cfg) {
  const g = graph && typeof graph === "object" ? { ...graph, nodes: [...(graph.nodes || [])] } : null;
  if (!g || !Array.isArray(g.nodes)) return buildScalpStrategyGraphFromConfig(cfg, graph?.indicatorName || "");
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const tfMin = String(graph?.indicatorName || "").includes("15m") ? 15 : 5;
  const defaultDirectionSources = ["binance", "coinbase", "kraken", "bybit", "okx"];
  const defaultStrengthSignals = tfMin === 15
    ? ["Heiken+OBV", "5+ Agree", "Delta 3m"]
    : ["Heiken+OBV", "5+ Agree"];
  for (const n of g.nodes) {
    if (!n?.id) continue;
    if (n.id === SCALP_GRAPH_NODE_IDS.ENTRY_DIRECTION) {
      const cur = Array.isArray(n.data?.directionSources) ? n.data.directionSources : defaultDirectionSources;
      n.data = { ...(n.data || {}), directionSources: [...cur] };
    } else if (n.id === SCALP_GRAPH_NODE_IDS.ENTRY_STRENGTH) {
      const cur = Array.isArray(n.data?.requiredStrengthSignals) ? n.data.requiredStrengthSignals : defaultStrengthSignals;
      n.data = { ...(n.data || {}), requiredStrengthSignals: [...cur] };
    } else if (n.id === SCALP_GRAPH_NODE_IDS.ENTRY_WINDOW) {
      n.data = { ...(n.data || {}), entryOpenWindowSec: c.entryOpenWindowSec };
    } else if (n.id === SCALP_GRAPH_NODE_IDS.ENTRY_BAND) {
      n.data = { ...(n.data || {}), entryMinPct: c.entryMinPct, entryMaxPct: c.entryMaxPct };
    } else if (n.id === SCALP_GRAPH_NODE_IDS.SIZING) {
      n.data = {
        ...(n.data || {}),
        stakeUsd: c.stakeUsd,
        minSharesFloor: c.minSharesFloor,
        maxEffectiveStakeUsd: c.maxEffectiveStakeUsd,
        maxEntriesPerCandle: c.maxEntriesPerCandle
      };
    } else if (n.id === SCALP_GRAPH_NODE_IDS.EXIT_TP) {
      n.data = {
        ...(n.data || {}),
        takeProfitPct: c.takeProfitPct,
        tpExitMode: c.tpExitMode,
        tpTrailCents: c.tpTrailCents,
        tpForceExitEnabled: c.tpForceExitEnabled,
        tpForceFailTicks: c.tpForceFailTicks
      };
    } else if (n.id === SCALP_GRAPH_NODE_IDS.EXIT_PROTECT) {
      n.data = {
        ...(n.data || {}),
        minExitPct: c.minExitPct,
        trailingArmingCents: c.trailingArmingCents,
        trailingCushionCents: c.trailingCushionCents,
        maxHoldSec: c.maxHoldSec
      };
    }
  }
  return g;
}

/** Spot venue keys supported for Direção (median vs PTB). Keep in sync with `getExchangeTickers()`. */
export const SCALP_DIRECTION_EXCHANGE_KEYS = Object.freeze([
  "binance",
  "coinbase",
  "kraken",
  "bybit",
  "okx"
]);

/**
 * Resolve which exchange keys participate in the scalp "bolsas" median.
 * Uses persisted canvas graph when provided; otherwise embeds defaults from flat cfg.
 * @param {object|null|undefined} graph Saved strategy graph (nodes include entry_direction), or null
 * @param {object} cfg Flat scalp indicator config (for embed fallback)
 * @param {string} indicatorName e.g. "Scalp Force 5m"
 * @returns {string[]} Ordered unique keys from the Direção node (subset of SCALP_DIRECTION_EXCHANGE_KEYS)
 */
export function getScalpDirectionSourceKeys(graph, cfg, indicatorName) {
  const baseCfg = cfg && typeof cfg === "object" ? cfg : {};
  const ind = String(indicatorName || "");
  let g = graph && typeof graph === "object" && Array.isArray(graph.nodes) ? graph : null;
  if (!g) {
    g = embedConfigIntoScalpGraph(buildScalpStrategyGraphFromConfig(baseCfg, ind), baseCfg);
  } else {
    g = embedConfigIntoScalpGraph(g, baseCfg);
  }
  const node = g.nodes?.find(n => n?.id === SCALP_GRAPH_NODE_IDS.ENTRY_DIRECTION);
  const raw = Array.isArray(node?.data?.directionSources) ? node.data.directionSources : [];
  const normalized = [...new Set(
    raw.map(s => String(s).toLowerCase().trim()).filter(k => SCALP_DIRECTION_EXCHANGE_KEYS.includes(k))
  )];
  if (normalized.length === 0) return [...SCALP_DIRECTION_EXCHANGE_KEYS];
  return normalized;
}

/**
 * Collect finite spot prices for median, in canvas key order.
 * @param {Record<string, { price?: number|null }>} exchanges Snapshot from getExchangeTickers()
 * @param {string[]} keys From getScalpDirectionSourceKeys
 * @returns {{ prices: number[], keysWithPrice: string[] }}
 */
export function exchangePricesForMedianFromKeys(exchanges, keys) {
  const prices = [];
  const keysWithPrice = [];
  for (const k of keys) {
    const p = exchanges?.[k]?.price;
    if (p !== null && Number.isFinite(p) && p > 0) {
      prices.push(p);
      keysWithPrice.push(k);
    }
  }
  return { prices, keysWithPrice };
}
