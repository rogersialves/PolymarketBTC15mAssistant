import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildScalpStrategyGraphFromConfig,
  compileScalpStrategyGraphToPatch,
  embedConfigIntoScalpGraph,
  SCALP_GRAPH_NODE_IDS,
  STRATEGY_GRAPH_SCHEMA_VERSION,
  getScalpDirectionSourceKeys,
  exchangePricesForMedianFromKeys,
  SCALP_DIRECTION_EXCHANGE_KEYS
} from "./strategyGraph.js";

test("buildScalpStrategyGraphFromConfig produces versioned graph with edges", () => {
  const cfg = { entryOpenWindowSec: 20, entryMinPct: 50, entryMaxPct: 55, stakeUsd: 2 };
  const g = buildScalpStrategyGraphFromConfig(cfg, "Scalp Force 5m");
  assert.equal(g.schemaVersion, STRATEGY_GRAPH_SCHEMA_VERSION);
  assert.ok(Array.isArray(g.nodes) && g.nodes.length >= 5);
  assert.ok(g.edges.length >= g.nodes.length - 1);
});

test("compileScalpStrategyGraphToPatch reads node.data fields", () => {
  const graph = {
    schemaVersion: STRATEGY_GRAPH_SCHEMA_VERSION,
    nodes: [
      { id: SCALP_GRAPH_NODE_IDS.ENTRY_WINDOW, data: { entryOpenWindowSec: 45 } },
      { id: SCALP_GRAPH_NODE_IDS.ENTRY_BAND, data: { entryMinPct: 48, entryMaxPct: 52 } },
      { id: SCALP_GRAPH_NODE_IDS.SIZING, data: { stakeUsd: 3, minSharesFloor: 6 } },
      {
        id: SCALP_GRAPH_NODE_IDS.EXIT_TP,
        data: { takeProfitPct: 80, tpExitMode: "trail", tpForceExitEnabled: false, tpForceFailTicks: 3 }
      },
      { id: SCALP_GRAPH_NODE_IDS.EXIT_PROTECT, data: { maxHoldSec: 200, minExitPct: 60 } }
    ],
    edges: []
  };
  const patch = compileScalpStrategyGraphToPatch(graph);
  assert.equal(patch.entryOpenWindowSec, 45);
  assert.equal(patch.entryMinPct, 48);
  assert.equal(patch.stakeUsd, 3);
  assert.equal(patch.takeProfitPct, 80);
  assert.equal(patch.tpExitMode, "trail");
  assert.equal(patch.tpForceExitEnabled, false);
  assert.equal(patch.maxHoldSec, 200);
});

test("embedConfigIntoScalpGraph fills node.data from flat config", () => {
  const base = buildScalpStrategyGraphFromConfig({}, "Scalp Force 15m");
  const cfg = {
    entryOpenWindowSec: 30,
    entryMinPct: 51,
    entryMaxPct: 56,
    stakeUsd: 1.5,
    takeProfitPct: 70,
    maxHoldSec: 300
  };
  const g = embedConfigIntoScalpGraph(base, cfg);
  const byId = Object.fromEntries(g.nodes.map(n => [n.id, n]));
  assert.equal(byId[SCALP_GRAPH_NODE_IDS.ENTRY_WINDOW].data.entryOpenWindowSec, 30);
  assert.equal(byId[SCALP_GRAPH_NODE_IDS.SIZING].data.stakeUsd, 1.5);
  assert.equal(byId[SCALP_GRAPH_NODE_IDS.EXIT_TP].data.takeProfitPct, 70);
});

test("getScalpDirectionSourceKeys reads canvas node and falls back to all venues", () => {
  const cfg = {};
  const all = [...SCALP_DIRECTION_EXCHANGE_KEYS];
  assert.deepEqual(getScalpDirectionSourceKeys(null, cfg, "Scalp Force 5m"), all);

  const graph = {
    schemaVersion: STRATEGY_GRAPH_SCHEMA_VERSION,
    indicatorName: "Scalp Force 5m",
    nodes: [
      {
        id: SCALP_GRAPH_NODE_IDS.ENTRY_DIRECTION,
        data: { directionSources: ["OKX", "binance", "unknown"] }
      }
    ],
    edges: []
  };
  assert.deepEqual(getScalpDirectionSourceKeys(graph, cfg, "Scalp Force 5m"), ["okx", "binance"]);

  const emptySel = {
    schemaVersion: STRATEGY_GRAPH_SCHEMA_VERSION,
    nodes: [{ id: SCALP_GRAPH_NODE_IDS.ENTRY_DIRECTION, data: { directionSources: [] } }],
    edges: []
  };
  assert.deepEqual(getScalpDirectionSourceKeys(emptySel, cfg, "Scalp Force 5m"), all);
});

test("exchangePricesForMedianFromKeys collects prices in key order", () => {
  const exchanges = {
    binance: { price: 100 },
    okx: { price: 102 },
    coinbase: { price: null }
  };
  const { prices, keysWithPrice } = exchangePricesForMedianFromKeys(exchanges, ["okx", "binance", "coinbase"]);
  assert.deepEqual(keysWithPrice, ["okx", "binance"]);
  assert.deepEqual(prices, [102, 100]);
});
