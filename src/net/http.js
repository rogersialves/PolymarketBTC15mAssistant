import { CONFIG } from "../config.js";
import { Agent } from "undici";

// FIX AT: Custom undici Agent — limit 1 TCP connection per host pool.
//
// Run 15 crash showed connecting[api.binance.us:?=2] — undici was establishing
// 2 simultaneous TLS handshakes to the same host even though the per-host
// semaphore (Fix AP) serialises fetch() calls. This happens because undici's
// connection pool is independent: when a socket closes (timeout/abort), undici
// may open a replacement while the old one is still in TCP FIN_WAIT. Each extra
// TLS handshake holds ~500KB–1MB in V8 heap (TLS context + read buffer) until
// the socket is fully released by the OS. With 4 simultaneous hosts this adds
// 2–4MB per host, enough to push the periodic RSS spike over the 320MB limit.
//
// Setting connections: 1 ensures undici never holds more than 1 TCP socket per
// origin in its pool, making the undici-level behaviour consistent with the
// application-level per-host semaphore.
// FIX AT (revised): Custom undici Agent — limit 1 TCP connection per host pool.
//
// With connections=1 per host, each origin can have at most 1 open TLS socket.
// This eliminates the connecting[host:?=2] pattern (Run 15/16: Binance.us opening
// 2 simultaneous TLS handshakes even though the per-host semaphore serialises
// fetch() calls). Each extra TLS handshake holds ~2-4MB TLS context in malloc
// until the OS reclaims the socket, inflating RSS during GC cascades.
//
// headersTimeout/bodyTimeout are NOT set — the application-level AbortSignal
// (Fix AO deadline timer) controls all request timeouts. Setting undici's own
// timeouts shorter than our deadlines (Fix AT-rev) caused UND_ERR_HEADERS_TIMEOUT
// errors that killed legitimate Gamma requests between 1200-2000ms, preventing
// the 15m engine from ever populating its market cache (Run 17 root cause).
//
// keepAliveTimeout=500ms: release idle sockets quickly after a request finishes
// or is aborted, so malloc can trim the TLS buffer pages back to the OS sooner.
export const httpAgent = new Agent({
  connections: 1,          // max 1 TCP/TLS socket per origin pool
  keepAliveTimeout: 500,   // release idle sockets within 500ms of finish
  keepAliveMaxTimeout: 2_000,
  // FIX BB: connectTimeout — libuv-level TLS handshake timeout (OS-level,
  // fires even during JS event loop freeze from GC cascades).
  // FIX BD: headersTimeout — undici JS-level timer, fires when loop resumes
  // after GC freeze. Prevents zombies from living 7-12s.
  // FIX BO: bodyTimeout — undici JS-level timer after headers are received.
  // Prevents stalled response bodies from holding the host semaphore slot
  // indefinitely. Set to same value as headersTimeout so neither phase can
  // exceed 2500ms. Without bodyTimeout, a response that sends headers but
  // then stalls on body (e.g. CLOB during network congestion) would hold the
  // socket open until the AbortSignal fires \u2014 which is delayed by GC freezes.
  headersTimeout: 2_500,
  bodyTimeout: 1_500,      // FIX BO: kill stalled bodies after 1500ms
  connect: { timeout: 2_000 },
});

// FIX AL + FIX AS + FIX AT + FIX BF + FIX BI: Global HTTP concurrency semaphore.
//
// Run 21 crash: inflight[binance=1, polygon=1] both zombie 12264ms simultaneously
// during a 7s event-loop freeze caused by GC cascade (major=6/149ms in 2s window).
// With HTTP_MAX=3, Binance (2500ms budget) + Polygon (1500ms budget) can both
// start their TLS handshake at the same time. When the loop freezes, BOTH become
// zombies until the loop resumes → simultaneous failures → extra GC → RSS spike.
// Fix BI: HTTP_MAX=2 serialises Binance and Polygon. Only ONE slow connection at
// a time → single failure event per congestion window → GC burden halved.
// Gamma doesn't compete because exponential backoff keeps Gamma blocked for
// 80s-300s after startup timeouts. CLOB runs on a different cadence.
const HTTP_MAX_CONCURRENT = 2;
let _httpActive = 0;
const _httpQueue = [];

function _httpAcquire(signal) {
  if (_httpActive < HTTP_MAX_CONCURRENT) {
    _httpActive++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const entry = { resolve, cancelled: false };
    _httpQueue.push(entry);
    if (signal) {
      const onAbort = () => {
        if (entry.cancelled) return;
        entry.cancelled = true;
        const i = _httpQueue.indexOf(entry);
        if (i !== -1) _httpQueue.splice(i, 1);
        resolve(false);
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

function _httpRelease() {
  while (_httpQueue.length > 0) {
    const next = _httpQueue.shift();
    if (!next.cancelled) {
      next.resolve(true);
      return;
    }
  }
  _httpActive--;
}

// FIX AP + FIX BJ: Per-hostname concurrency semaphore — max 1 simultaneous
// connection per remote host, queue depth limited to HOST_MAX_QUEUE.
//
// Run 22 crash: inflight[clob.polymarket.com=10] — ten CLOB fetch() calls were
// active simultaneously despite HOST_MAX_CONCURRENT=1. Root cause: during GC
// cascades the event loop processes intermediate ticks between GC pauses
// (major=4×178ms = 712ms pause in a 2s window). Each intermediate tick generates
// 2 CLOB price requests (up+down tokenIds). Without a queue depth cap, these pile
// up unbounded in the host semaphore queue: 1 active + N queued. Each queued
// entry holds a AbortController, a deadline timer, and the full request closure.
// 10 simultaneous CLOB entries × ~35MB each = 350MB of extra RSS.
//
// Fix BJ: cap host queue at HOST_MAX_QUEUE=1. At most 2 CLOB requests exist
// simultaneously (1 active + 1 queued). The 3rd+ are rejected immediately.
// Callers handle rejection by using cached prices — acceptable degradation.
const HOST_MAX_CONCURRENT = 1;
const HOST_MAX_QUEUE = 1; // FIX BJ: max pending in semaphore queue per host
const _hostActive = new Map(); // hostname -> count
const _hostQueues = new Map(); // hostname -> [{resolve, cancelled}]

// FIX BY: Global pause signal propagated from memoryMonitor.
// process._httpPaused blocks NEW requests, but requests already queued/in-flight
// before the pause can still run for many seconds during loopLag spikes.
// This controller aborts all active/queued fetches as soon as pause toggles on.
let _httpPauseState = Boolean(process._httpPaused);
let _httpPauseController = new AbortController();
if (_httpPauseState) {
  _httpPauseController.abort(new Error("HTTP paused"));
}

process.on("httpPauseChanged", (paused) => {
  const next = Boolean(paused);
  if (next === _httpPauseState) return;
  _httpPauseState = next;
  if (next) {
    _httpPauseController.abort(new Error("HTTP paused"));
  } else {
    _httpPauseController = new AbortController();
  }
});

function _hostKey(url) {
  try { return new URL(url).hostname; } catch { return String(url); }
}

function _hostAcquire(key, signal) {
  const active = _hostActive.get(key) || 0;
  if (active < HOST_MAX_CONCURRENT) {
    _hostActive.set(key, active + 1);
    return Promise.resolve(true);
  }
  if (!_hostQueues.has(key)) _hostQueues.set(key, []);
  const queue = _hostQueues.get(key);
  // FIX BJ: Reject immediately if the host queue is already full.
  // Prevents the "inflight=10" accumulation pattern from Run 22 where GC
  // cascade ticks pile up unbounded requests in the host semaphore queue,
  // each holding closures + timers that inflate RSS from 200MB to 585MB.
  if (queue.length >= HOST_MAX_QUEUE) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const entry = { resolve, cancelled: false };
    queue.push(entry);
    if (signal) {
      const onAbort = () => {
        if (entry.cancelled) return;
        entry.cancelled = true;
        const i = queue.indexOf(entry);
        if (i !== -1) queue.splice(i, 1);
        resolve(false);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function _hostRelease(key) {
  const queue = _hostQueues.get(key) || [];
  // FIX BX: When HTTP is globally paused, drain the queue by rejecting all
  // pending requests rather than admitting the next one. Queued requests were
  // submitted BEFORE the pause activated — admitting them now would trigger
  // new TLS connections (the reconnect after an abort costs ~40MB native mem).
  // Run 28: a queued CLOB request was admitted after Request-1 aborted,
  // triggered TLS reconnect, +43MB RSS (174→217MB) in a single 2s window.
  if (process._httpPaused) {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next.cancelled) next.resolve(false); // reject: HTTP paused
    }
    const current = _hostActive.get(key) || 1;
    if (current <= 1) _hostActive.delete(key);
    else _hostActive.set(key, current - 1);
    return;
  }
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next.cancelled) { next.resolve(true); return; }
  }
  const current = _hostActive.get(key) || 1;
  if (current <= 1) _hostActive.delete(key);
  else _hostActive.set(key, current - 1);
}

export async function fetchWithTimeout(url, options = {}, { timeoutMs = CONFIG.httpTimeoutMs, label = "fetch", signal: externalSignal } = {}) {
  // FIX BN: Global HTTP pause — reject immediately if RSS is above threshold.
  // process._httpPaused is set/cleared by memoryMonitor every 2s based on RSS.
  // When active, ALL new requests fail fast, preventing new zombie sockets from
  // forming during GC cascades. Active requests also receive the pause signal,
  // so they abort instead of holding sockets through a lag spike.
  if (process._httpPaused) {
    throw Object.assign(
      new Error(`${label} paused (RSS limit, try later)`),
      { name: "AbortError" }
    );
  }

  // FIX AO: Start the deadline timer BEFORE acquiring any semaphore slot so
  // that total time (queue wait + request) is bounded by timeoutMs.
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => {
    deadlineController.abort(new Error(`${label} timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  const queueSignal = externalSignal
    ? AbortSignal.any([deadlineController.signal, externalSignal, _httpPauseController.signal])
    : AbortSignal.any([deadlineController.signal, _httpPauseController.signal]);

  // FIX AL: Global safety-net slot.
  const gotSlot = await _httpAcquire(queueSignal);
  if (!gotSlot) {
    clearTimeout(deadlineTimer);
    if (deadlineController.signal.aborted) throw new Error(`${label} timeout after ${timeoutMs}ms`);
    throw Object.assign(new Error(`${label} aborted`), { name: "AbortError" });
  }

  // FIX AP + FIX BJ: Per-hostname slot.
  const hostKey = _hostKey(url);
  const gotHostSlot = await _hostAcquire(hostKey, queueSignal);
  if (!gotHostSlot) {
    _httpRelease();
    clearTimeout(deadlineTimer);
    if (deadlineController.signal.aborted) throw new Error(`${label} timeout after ${timeoutMs}ms`);
    // FIX BJ: host queue full OR aborted — fast-fail, caller uses cache
    throw Object.assign(new Error(`${label} aborted (host busy)`), { name: "AbortError" });
  }

  try {
    const activeSignal = externalSignal
      ? AbortSignal.any([deadlineController.signal, externalSignal, _httpPauseController.signal])
      : AbortSignal.any([deadlineController.signal, _httpPauseController.signal]);

    return await fetch(url, { ...options, signal: activeSignal, dispatcher: httpAgent });
  } catch (err) {
    const msg = String(err?.message || "");
    if (externalSignal?.aborted && (err?.name === "AbortError" || msg.includes("aborted"))) {
      throw new Error(`${label} aborted`);
    }
    if (_httpPauseController.signal.aborted && (err?.name === "AbortError" || msg.includes("aborted"))) {
      throw Object.assign(new Error(`${label} aborted (HTTP paused)`), { name: "AbortError" });
    }
    if (err?.name === "AbortError" || msg.includes("timeout after")) {
      throw new Error(`${label} timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(deadlineTimer);
    _hostRelease(hostKey);
    _httpRelease();
  }
}
