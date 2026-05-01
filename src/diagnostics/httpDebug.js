import diagnosticsChannel from "node:diagnostics_channel";
import { diagLog } from "./diagSink.js";

let started = false;

const inflightByRequest = new WeakMap();
const counts = new Map();
const slowCounts = new Map();
const errorCounts = new Map();
const socketsOpen = new Map();
const socketsConnecting = new Map();
let totalRequests = 0;
let totalSlow = 0;
let totalErrors = 0;

function bump(map, key, delta = 1) {
  const next = (map.get(key) || 0) + delta;
  if (next === 0) map.delete(key);
  else map.set(key, next);
}

function originOfRequest(request) {
  try {
    if (request?.origin) return String(request.origin);
    const path = String(request?.path || "/");
    const u = new URL(path);
    return u.origin;
  } catch {
    return "unknown";
  }
}

function safeSubscribe(name, handler) {
  try {
    diagnosticsChannel.subscribe(name, (msg) => {
      try { handler(msg); } catch { /* swallow — never break the host process */ }
    });
    return true;
  } catch {
    return false;
  }
}

export function startHttpDebug({
  enabled = process.env.HTTP_DEBUG !== "0",
  slowMs = Number(process.env.HTTP_DEBUG_SLOW_MS || 1_500),
  reportIntervalMs = Number(process.env.HTTP_DEBUG_REPORT_MS || 5_000)
} = {}) {
  if (started || !enabled) return;
  started = true;

  safeSubscribe("undici:request:create", ({ request }) => {
    if (!request) return;
    const origin = originOfRequest(request);
    const entry = {
      origin,
      path: String(request.path || ""),
      method: String(request.method || "GET"),
      t0: Date.now(),
      headersAt: null
    };
    inflightByRequest.set(request, entry);
    bump(counts, origin, 1);
    totalRequests += 1;
  });

  safeSubscribe("undici:request:headers", ({ request }) => {
    const entry = inflightByRequest.get(request);
    if (entry) entry.headersAt = Date.now();
  });

  const finalize = (request, errored, errMsg) => {
    const entry = inflightByRequest.get(request);
    if (!entry) return;
    const total = Date.now() - entry.t0;
    bump(counts, entry.origin, -1);
    if (errored) {
      bump(errorCounts, entry.origin, 1);
      totalErrors += 1;
    }
    if (total >= slowMs || errored) {
      bump(slowCounts, entry.origin, 1);
      totalSlow += 1;
      const ttfb = entry.headersAt ? entry.headersAt - entry.t0 : -1;
      const tag = errored ? "ERR" : "SLOW";
      const path = entry.path.length > 80 ? entry.path.slice(0, 77) + "..." : entry.path;
      diagLog(`[httpDebug] ${tag} ${entry.method} ${entry.origin}${path} total=${total}ms ttfb=${ttfb}ms${errMsg ? ` err=${errMsg}` : ""}`, { level: "warn" });
    }
    inflightByRequest.delete(request);
  };

  safeSubscribe("undici:request:trailers", ({ request }) => finalize(request, false));
  safeSubscribe("undici:request:error", ({ request, error }) => {
    finalize(request, true, error?.code || error?.message);
  });

  // Connection lifecycle — counts open sockets per origin so we can detect
  // socket-pool exhaustion vs DNS/connect stalls vs server-side slowness.
  safeSubscribe("undici:client:beforeConnect", ({ connectParams }) => {
    const origin = `${connectParams?.protocol || "https:"}//${connectParams?.hostname || "?"}:${connectParams?.port || "?"}`;
    bump(socketsConnecting, origin, 1);
  });

  safeSubscribe("undici:client:connected", ({ connectParams }) => {
    const origin = `${connectParams?.protocol || "https:"}//${connectParams?.hostname || "?"}:${connectParams?.port || "?"}`;
    bump(socketsConnecting, origin, -1);
    bump(socketsOpen, origin, 1);
  });

  safeSubscribe("undici:client:connectError", ({ connectParams, error }) => {
    const origin = `${connectParams?.protocol || "https:"}//${connectParams?.hostname || "?"}:${connectParams?.port || "?"}`;
    bump(socketsConnecting, origin, -1);
    diagLog(`[httpDebug] connectError ${origin} ${error?.code || error?.message}`, { level: "warn" });
  });

  // No reliable channel for socket close in all undici versions; sockets that
  // close naturally are not strictly tracked, so socketsOpen drifts up over
  // time. We correct by resetting socketsOpen on each periodic report so the
  // gauge reflects "opened in last window" rather than absolute open count.
  let lastTotalRequests = 0;
  let lastTotalSlow = 0;
  let lastTotalErrors = 0;

  const timer = setInterval(() => {
    const inflightLines = [];
    for (const [origin, c] of counts) {
      if (c > 0) inflightLines.push(`${origin}=${c}`);
    }
    const connectingLines = [];
    for (const [origin, c] of socketsConnecting) {
      if (c > 0) connectingLines.push(`${origin}=${c}`);
    }
    const reqDelta = totalRequests - lastTotalRequests;
    const slowDelta = totalSlow - lastTotalSlow;
    const errDelta = totalErrors - lastTotalErrors;
    lastTotalRequests = totalRequests;
    lastTotalSlow = totalSlow;
    lastTotalErrors = totalErrors;

    if (reqDelta > 0 || inflightLines.length || connectingLines.length) {
      const parts = [`req=${reqDelta}`, `slow=${slowDelta}`, `err=${errDelta}`];
      if (inflightLines.length) parts.push(`inflight[${inflightLines.join(",")}]`);
      if (connectingLines.length) parts.push(`connecting[${connectingLines.join(",")}]`);
      diagLog(`[httpDebug] ${parts.join(" ")}`);
    }
    socketsOpen.clear();
  }, reportIntervalMs);

  if (typeof timer.unref === "function") timer.unref();
}

export function getHttpDebugSnapshot() {
  return {
    started,
    totalRequests,
    totalSlow,
    totalErrors,
    inflight: Object.fromEntries(counts),
    slowByOrigin: Object.fromEntries(slowCounts),
    errorsByOrigin: Object.fromEntries(errorCounts),
    socketsConnecting: Object.fromEntries(socketsConnecting)
  };
}
