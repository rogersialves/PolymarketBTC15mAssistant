import { PerformanceObserver, constants } from "node:perf_hooks";
import { diagLog } from "./diagSink.js";

let started = false;

const gcKindNames = {
  [constants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [constants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb"
};

let gcCounts = { major: 0, minor: 0, incremental: 0, weakcb: 0 };
let gcDurationMs = { major: 0, minor: 0, incremental: 0, weakcb: 0 };

// FIX BN: Global HTTP pause — when RSS exceeds HTTP_PAUSE_RSS_MB, set
// process._httpPaused=true so fetchWithTimeout() rejects ALL new requests
// immediately. This prevents new zombie sockets from forming during GC cascades.
// The pause lifts when RSS drops below HTTP_RESUME_RSS_MB (hysteresis to avoid
// oscillation). Active requests in flight are NOT cancelled — they complete via
// headersTimeout/bodyTimeout. This is more effective than per-host circuit
// breakers (Fix BL) because ALL hosts (CLOB, Gamma, Binance, Polygon) can
// contribute zombie sockets during a cascade, not just CLOB.
//
// FIX BQ: Lowered thresholds from 190/165 to 175/155 so the pause activates
// BEFORE the GC cascade becomes self-sustaining. Run 25 showed the cascade
// starting at rss=174MB (gc[major=3/66ms]) and being fully in progress by
// rss=189MB (gc[major=4/74ms], loopLag max=997ms). By the time the pause
// activated at 200MB, the cascade was irreversible — GC bitmaps alone drove
// RSS from 200MB to 361MB in ~8s even with zero new requests.
// With Fix BP (jemalloc dirty_decay_ms:0), each bitmap is returned immediately
// after GC, so even if the cascade occurs, RSS stays within 20-30MB of the
// threshold rather than accumulating 150MB+ of unreturned bitmaps.
//
// Thresholds (with jemalloc):
//   pause:  RSS > 175MB — cascade starting (sustained: 150-165MB)
//   resume: RSS < 155MB — GC resolved, pages returned to OS by jemalloc
// FIX BV: Lowered from 175→168MB. Run 28 showed RSS=174MB (1MB below 175
// threshold) → missed detection → 2s later rss=217MB (cascade). With 168MB,
// the 174MB reading triggers the pause before TLS handshake completes.
export const HTTP_PAUSE_RSS_MB  = Number(process.env.HTTP_PAUSE_RSS_MB  || 168);
export const HTTP_RESUME_RSS_MB = Number(process.env.HTTP_RESUME_RSS_MB || 152);
process._httpPaused = false; // initialise — http.js reads this flag

export function startMemoryMonitor({
  enabled = process.env.MEMORY_DEBUG !== "0",
  // FIX BW: 2000→750ms. Run 28 showed a 2s window where RSS jumped
  // 174→217MB (a TLS handshake completing). With 750ms checks we get 2-3
  // measurement opportunities in the same window, catching the crossing sooner.
  reportIntervalMs = Number(process.env.MEMORY_REPORT_MS || 750),
  gcWarnMs = Number(process.env.GC_WARN_MS || 100),
  // FIX AM: Raised 260→320 MB.
  // FIX AV: Raised 320→400 MB.
  // FIX BM: Lowered 400→320 MB.
  // Root cause: V8 major GC needs ~heapTotal/8 bytes from malloc for marking
  // bitmaps during compaction. With heapTotal ~99MB and 4-5 major GC cycles per
  // 2-second window, each GC contributes ~12MB malloc bitmap residue.
  //
  // Run 22-23: stable RSS is 150-185MB. Cascade starts at ~220MB (CLOB slow).
  // With Fix BL (CLOB circuit breaker at 200MB), the cascade should never reach
  // 250MB+ under normal conditions. If it does, exit at 320MB instead of 400MB
  // to restart faster before the cascade becomes unrecoverable (585MB at Run 22).
  // The 2-reading hysteresis (4s) prevents false exits during transient spikes.
  rssLimitMb = Number(process.env.RSS_LIMIT_MB || 320)
} = {}) {
  if (started || !enabled) return;
  started = true;

  const observer = new PerformanceObserver((items) => {
    for (const entry of items.getEntries()) {
      const kind = gcKindNames[entry.detail?.kind] || "unknown";
      const dur = entry.duration;
      if (gcCounts[kind] !== undefined) {
        gcCounts[kind] += 1;
        gcDurationMs[kind] += dur;
      }
      if (dur >= gcWarnMs) {
        diagLog(`[gc] kind=${kind} duration=${dur.toFixed(0)}ms`, { level: "warn" });
      }
    }
  });
  observer.observe({ entryTypes: ["gc"], buffered: false });

  // FIX AM: Periodic forced GC to prevent heap accumulation leading to
  // uncontrolled mark-compact pauses. Every 60 s we call global.gc() (full
  // major GC) if available (requires --expose-gc on the Node.js command line).
  // This trades one ~30–60 ms predictable pause every 60 s for multiple
  // uncontrolled 95 ms mark-compact bursts that cause 900+ ms loopLag cascades.
  let _gcTickCount = 0;
  let _rssExcessCount = 0; // FIX AU: hysteresis counter — incremented each read above limit
  const GC_FORCE_EVERY_TICKS = Math.ceil(60_000 / reportIntervalMs); // ~30 ticks at 2s

  const timer = setInterval(() => {
    // Force minor GC every tick to keep nursery clean (fast, ~1-3ms).
    if (typeof global.gc === "function") global.gc(true);

    // Force full GC every 60 s to keep old-gen from accumulating.
    _gcTickCount++;
    if (_gcTickCount >= GC_FORCE_EVERY_TICKS) {
      _gcTickCount = 0;
      if (typeof global.gc === "function") global.gc();
    }

    const m = process.memoryUsage();
    const heapUsedMb = (m.heapUsed / 1024 / 1024).toFixed(0);
    const heapTotalMb = (m.heapTotal / 1024 / 1024).toFixed(0);
    const rssMb = (m.rss / 1024 / 1024).toFixed(0);
    const externalMb = (m.external / 1024 / 1024).toFixed(0);
    const arrayBuffersMb = (m.arrayBuffers / 1024 / 1024).toFixed(0);

    const gcSummary = Object.entries(gcCounts)
      .filter(([_, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}/${gcDurationMs[k].toFixed(0)}ms`)
      .join(" ") || "none";

    diagLog(`[mem] heap=${heapUsedMb}/${heapTotalMb}MB rss=${rssMb}MB ext=${externalMb}MB ab=${arrayBuffersMb}MB gc[${gcSummary}]`);

    // FIX BN: Global HTTP pause — block new requests when RSS is high.
    // Activated here (in the 2s memory timer) rather than in fetchWithTimeout
    // to avoid the overhead of reading process.memoryUsage() on every request.
    const rssMbNum = m.rss / 1024 / 1024;
    if (rssMbNum > HTTP_PAUSE_RSS_MB && !process._httpPaused) {
      process._httpPaused = true;
      process.emit("httpPauseChanged", true);
      diagLog(`[mem] http paused rss=${rssMb}MB>${HTTP_PAUSE_RSS_MB}MB — novas requests bloqueadas`, { level: "warn" });
      // FIX BU: Trigger immediate major GC when HTTP is paused. The HTTP pause
      // stops new request allocations, creating a window where the event loop
      // has low activity and a full GC is cheap. Run 27 showed heapTotal growing
      // 77MB→104MB (+27MB) during pause with only minor GC running — old-gen
      // objects from tick analysis accumulated. A proactive full GC here:
      //   1. Collects old-gen objects immediately (e.g. tick state, JSON buffers)
      //   2. Reduces heapTotal so next major GC cycle has less to bitmap-scan
      //   3. jemalloc (dirty_decay_ms:0) returns freed GC bitmap pages to OS
      //      instantly, so RSS drops within the same 2s timer cycle
      // Safe here because HTTP is paused — no concurrent allocations from new
      // requests. Only active timers + in-flight requests (which complete shortly
      // via headersTimeout/bodyTimeout) remain.
      if (typeof global.gc === "function") {
        global.gc();  // full major GC
        diagLog(`[mem] http paused: full GC triggered`);
      }
    } else if (rssMbNum < HTTP_RESUME_RSS_MB && process._httpPaused) {
      process._httpPaused = false;
      process.emit("httpPauseChanged", false);
      diagLog(`[mem] http resumed rss=${rssMb}MB<${HTTP_RESUME_RSS_MB}MB`);
    }

    // Circuit breaker: RSS above limit means native buffers are accumulating
    // faster than GC can reclaim them. The event loop is already severely
    // degraded. Exit now for a clean restart rather than waiting for OOM.
    //
    // FIX AU: Hysteresis — require 2 consecutive readings above limit before
    // exiting. Each reading is reportIntervalMs=2s apart, so we wait 4s total.
    if (rssLimitMb > 0 && rssMbNum > rssLimitMb) {
      _rssExcessCount += 1;
      if (_rssExcessCount < 2) {
        diagLog(`[mem] RSS ${rssMb}MB > limit ${rssLimitMb}MB — aviso ${_rssExcessCount}/2 (aguardando GC)`, { level: "warn" });
        // FIX AX: Do NOT call global.gc() here. A blocking major GC during an
        // active GC cascade (which is what triggers high RSS) adds ~100-200ms
        // pause to an already frozen event loop, pushing RSS higher via new
        // marking-bitmap malloc. The periodic minor GC (every 2s) and the 60s
        // major GC cycle are already running. Let the cascade subside on its
        // own — if RSS drops below limit in the next 2s, no exit.
      } else {
        diagLog(`[mem] RSS ${rssMb}MB > limit ${rssLimitMb}MB — exiting for restart`, { level: "error" });
        process.exit(1);
      }
    } else {
      _rssExcessCount = 0;
    }

    gcCounts = { major: 0, minor: 0, incremental: 0, weakcb: 0 };
    gcDurationMs = { major: 0, minor: 0, incremental: 0, weakcb: 0 };
  }, reportIntervalMs);

  if (typeof timer.unref === "function") timer.unref();
}
