import { monitorEventLoopDelay } from "node:perf_hooks";
import { diagLog } from "./diagSink.js";

let started = false;

export function startEventLoopMonitor({
  enabled = process.env.EVENT_LOOP_DEBUG !== "0",
  resolutionMs = Number(process.env.EVENT_LOOP_RESOLUTION_MS || 20),
  reportIntervalMs = Number(process.env.EVENT_LOOP_REPORT_MS || 5_000),
  warnMs = Number(process.env.EVENT_LOOP_WARN_MS || 200)
} = {}) {
  if (started || !enabled) return;
  started = true;

  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();

  const startedAt = Date.now();
  let lastReportedAt = startedAt;

  const timer = setInterval(() => {
    const max = histogram.max / 1e6;
    const p99 = histogram.percentile(99) / 1e6;
    const p50 = histogram.percentile(50) / 1e6;
    const mean = histogram.mean / 1e6;

    if (max >= warnMs) {
      const windowSec = ((Date.now() - lastReportedAt) / 1000).toFixed(1);
      diagLog(`[loopLag] window=${windowSec}s max=${max.toFixed(0)}ms p99=${p99.toFixed(0)}ms p50=${p50.toFixed(0)}ms mean=${mean.toFixed(1)}ms`, { level: "warn" });
    }
    histogram.reset();
    lastReportedAt = Date.now();
  }, reportIntervalMs);

  if (typeof timer.unref === "function") timer.unref();
}
