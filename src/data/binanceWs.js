import WebSocket from "ws";
import { CONFIG } from "../config.js";
import { wsAgentForUrl } from "../net/proxy.js";

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// FIX #21 (30/04/2026): Trocado `@trade` por `@bookTicker`.
//
// Causa raiz da cascade RSS no serverScalp: `@trade` envia CADA execução
// individual de trade — BTCUSDT recebe 10-50 mensagens/seg em horário ativo.
// Cada mensagem aloca: Buffer (nativo) + buf.toString() + JSON.parse(). Sob
// alta frequência, o Buffer pool nativo (controlado pelo libuv, não pelo GC
// do V8) acumula páginas que jemalloc não consegue liberar quando event loop
// está ocupado. Resultado: RSS escala 144→236MB→309MB→processo morto, mesmo
// com heap V8 estável em 30-50MB. Heap snapshot confirmou que a memória NÃO
// está em V8.
//
// `@bookTicker` envia update apenas quando MELHOR bid/ask muda — frequência
// ~1-5 msgs/seg (10x menos). Schema: { u, s, b: bestBid, B: bidQty,
// a: bestAsk, A: askQty }. Para Scalp/dashboard, mid = (b+a)/2 é
// adequado e reflete o mercado melhor que o último trade isolado.
function buildWsUrl(symbol) {
  const s = String(symbol || "").toLowerCase();
  return `${CONFIG.binanceWsBaseUrl.replace(/\/$/, "")}/ws/${s}@bookTicker`;
}

// Throttle defensivo: mesmo com bookTicker, processa no máximo 1 update a
// cada MIN_UPDATE_INTERVAL_MS. Mensagens dentro da janela são consumidas
// (Buffer liberado) mas não geram trabalho extra (sem onUpdate, sem state mut).
const MIN_UPDATE_INTERVAL_MS = Number(process.env.BINANCE_WS_MIN_UPDATE_MS || 200);

export function startBinanceTradeStream({ symbol = CONFIG.symbol, onUpdate } = {}) {
  let ws = null;
  let closed = false;
  let reconnectMs = 500;
  let lastPrice = null;
  let lastTs = null;
  let lastUpdateAt = 0;

  const connect = () => {
    if (closed) return;

    const url = buildWsUrl(symbol);
    ws = new WebSocket(url, { agent: wsAgentForUrl(url) });

    ws.on("open", () => {
      reconnectMs = 500;
    });

    ws.on("message", (buf) => {
      // Throttle: consome buffer mas não processa se ainda estiver na janela.
      const now = Date.now();
      if (now - lastUpdateAt < MIN_UPDATE_INTERVAL_MS) return;

      try {
        const msg = JSON.parse(buf.toString());
        // bookTicker schema: b=bestBid, a=bestAsk. mid = avg.
        const bid = toNumber(msg.b);
        const ask = toNumber(msg.a);
        const p = bid !== null && ask !== null ? (bid + ask) / 2
          : bid !== null ? bid : ask;
        if (p === null || !Number.isFinite(p)) return;
        lastPrice = p;
        lastTs = now;
        lastUpdateAt = now;
        if (typeof onUpdate === "function") onUpdate({ price: lastPrice, ts: lastTs });
      } catch {
        return;
      }
    });

    const scheduleReconnect = () => {
      if (closed) return;
      try {
        ws?.terminate();
      } catch {
        // ignore
      }
      ws = null;
      const wait = reconnectMs;
      reconnectMs = Math.min(10_000, Math.floor(reconnectMs * 1.5));
      setTimeout(connect, wait);
    };

    ws.on("close", scheduleReconnect);
    ws.on("error", scheduleReconnect);
  };

  connect();

  return {
    getLast() {
      return { price: lastPrice, ts: lastTs };
    },
    close() {
      closed = true;
      try {
        ws?.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  };
}
