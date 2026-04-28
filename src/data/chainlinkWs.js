import WebSocket from "ws";
import { ethers } from "ethers";
import { CONFIG } from "../config.js";
import { wsAgentForUrl } from "../net/proxy.js";
import { fetchChainlinkBtcUsd } from "./chainlink.js";

const ANSWER_UPDATED_TOPIC0 = ethers.id("AnswerUpdated(int256,uint256,uint256)");
const HTTP_HEARTBEAT_MS = Math.max(2_000, Number(process.env.CHAINLINK_HTTP_HEARTBEAT_MS || 10_000));
// Se WS atualizou há menos que isso, heartbeat HTTP não sobrescreve.
const WS_FRESHNESS_WINDOW_MS = 30_000;

function getWssCandidates() {
  const fromList = Array.isArray(CONFIG.chainlink.polygonWssUrls) ? CONFIG.chainlink.polygonWssUrls : [];
  const single = CONFIG.chainlink.polygonWssUrl ? [CONFIG.chainlink.polygonWssUrl] : [];
  const all = [...fromList, ...single].map((s) => String(s).trim()).filter(Boolean);
  return Array.from(new Set(all));
}

function hexToSignedBigInt(hex) {
  const x = ethers.toBigInt(hex);
  const TWO_255 = 1n << 255n;
  const TWO_256 = 1n << 256n;
  return x >= TWO_255 ? x - TWO_256 : x;
}

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export function startChainlinkPriceStream({
  aggregator = CONFIG.chainlink.btcUsdAggregator,
  decimals = 8,
  onUpdate
} = {}) {
  const wssUrls = getWssCandidates();
  if (!aggregator) {
    return {
      getLast() {
        return { price: null, updatedAt: null, source: "chainlink_ws" };
      },
      close() {}
    };
  }

  let ws = null;
  let closed = false;
  let reconnectMs = 500;
  let urlIndex = 0;

  let lastPrice = null;
  let lastUpdatedAt = null;
  let lastSource = "chainlink_ws";
  let heartbeatTimer = null;

  let nextId = 1;
  let subId = null;

  const runHeartbeat = async () => {
    if (closed) return;
    try {
      const result = await fetchChainlinkBtcUsd();
      const price = result?.price;
      if (price === null || !Number.isFinite(price)) return;

      // WS é mais preciso quando fresco — só sobrescrevemos se WS está parado.
      const wsAgeMs = lastUpdatedAt && lastSource === "chainlink_ws"
        ? Date.now() - lastUpdatedAt
        : Infinity;
      if (wsAgeMs <= WS_FRESHNESS_WINDOW_MS) return;

      lastPrice = price;
      lastUpdatedAt = result.updatedAt || Date.now();
      lastSource = "chainlink_http";
      if (typeof onUpdate === "function") {
        onUpdate({ price: lastPrice, updatedAt: lastUpdatedAt, source: lastSource });
      }
    } catch {
      // ignore — preserva último valor conhecido
    }
  };

  // Heartbeat HTTP roda independente do WS: garante que getLast() sempre tem
  // preço fresco mesmo quando POLYGON_WSS_URLS está vazio ou caiu.
  const startHeartbeat = () => {
    if (heartbeatTimer) return;
    runHeartbeat();
    heartbeatTimer = setInterval(runHeartbeat, HTTP_HEARTBEAT_MS);
    if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  };

  const connect = () => {
    if (closed) return;
    if (wssUrls.length === 0) return;

    const url = wssUrls[urlIndex % wssUrls.length];
    urlIndex += 1;

    ws = new WebSocket(url, { agent: wsAgentForUrl(url) });

    const send = (obj) => {
      try {
        ws?.send(JSON.stringify(obj));
      } catch {
        // ignore
      }
    };

    const scheduleReconnect = () => {
      if (closed) return;
      try {
        ws?.terminate();
      } catch {
        // ignore
      }
      ws = null;
      subId = null;
      const wait = reconnectMs;
      reconnectMs = Math.min(10_000, Math.floor(reconnectMs * 1.5));
      setTimeout(connect, wait);
    };

    ws.on("open", () => {
      reconnectMs = 500;
      const id = nextId++;
      send({
        jsonrpc: "2.0",
        id,
        method: "eth_subscribe",
        params: [
          "logs",
          {
            address: aggregator,
            topics: [ANSWER_UPDATED_TOPIC0]
          }
        ]
      });
    });

    ws.on("message", (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }

      if (msg.id && msg.result && typeof msg.result === "string" && !subId) {
        subId = msg.result;
        return;
      }

      if (msg.method !== "eth_subscription") return;
      const params = msg.params;
      if (!params || !params.result) return;

      const log = params.result;
      const topics = Array.isArray(log.topics) ? log.topics : [];
      if (topics.length < 2) return;

      try {
        const answer = hexToSignedBigInt(topics[1]);
        const price = toNumber(answer) / 10 ** Number(decimals);
        const updatedAtHex = typeof log.data === "string" ? log.data : null;
        const updatedAt = updatedAtHex ? toNumber(ethers.toBigInt(updatedAtHex)) : null;

        lastPrice = Number.isFinite(price) ? price : lastPrice;
        lastUpdatedAt = updatedAt ? updatedAt * 1000 : lastUpdatedAt;
        lastSource = "chainlink_ws";

        if (typeof onUpdate === "function") {
          onUpdate({ price: lastPrice, updatedAt: lastUpdatedAt, source: lastSource });
        }
      } catch {
        return;
      }
    });

    ws.on("close", scheduleReconnect);
    ws.on("error", scheduleReconnect);
  };

  startHeartbeat();
  connect();

  return {
    getLast() {
      return { price: lastPrice, updatedAt: lastUpdatedAt, source: lastSource };
    },
    close() {
      closed = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      try {
        if (ws && subId) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "eth_unsubscribe", params: [subId] }));
        }
      } catch {
        // ignore
      }
      try {
        ws?.close();
      } catch {
        // ignore
      }
      ws = null;
      subId = null;
    }
  };
}
