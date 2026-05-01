import { execSync, spawn } from "node:child_process";

const PORT = 3000;

// Phase 1 Scalp-Only entrypoint is the DEFAULT.
// The full legacy src/server.js is opt-in only because it still runs the paused
// non-Scalp workflows and reproduces the RSS cascade. See MEMORY.md Bug #23.
function resolveEntryFlag() {
  const cliArg = process.argv.find(a => a.startsWith("--entry="));
  if (cliArg) return cliArg.slice("--entry=".length).trim();
  return String(process.env.ENTRY || "").trim();
}

function resolveServerEntryPath() {
  const flag = resolveEntryFlag().toLowerCase();
  if (flag === "full" || flag === "server" || flag === "legacy" || flag === "web") {
    return "src/server.js";
  }
  return "src/serverScalp.js";
}

function unique(values) {
  return [...new Set(values)];
}

function pidsFromSs(port) {
  try {
    const output = execSync(`ss -ltnp "sport = :${port}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return unique([...output.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])));
  } catch {
    return [];
  }
}

function pidsFromLsof(port) {
  try {
    const output = execSync(`lsof -t -iTCP:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return unique(
      output
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    );
  } catch {
    return [];
  }
}

function getPortPids(port) {
  const ssPids = pidsFromSs(port);
  if (ssPids.length > 0) {
    return ssPids;
  }
  return pidsFromLsof(port);
}

function killPid(pid) {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function cleanupPort(port) {
  const pids = getPortPids(port);
  if (pids.length === 0) {
    return;
  }

  console.log(`🧹 [start] Liberando porta ${port}. PIDs encontrados: ${pids.join(", ")}`);
  for (const pid of pids) {
    const killed = killPid(pid);
    if (killed) {
      console.log(`✅ [start] Processo finalizado: PID ${pid}`);
    } else {
      console.log(`⚠️  [start] Não foi possível finalizar PID ${pid} (pode já ter encerrado)`);
    }
  }
}

function startServer() {
  // FIX AC: Cap V8 old-space at 200 MB (was 1792 MB).
  // With 1792 MB, V8 deferred GC until old-gen was 800-1400 MB, causing
  // catastrophic 250-480 ms major-GC pauses that froze the event loop long
  // enough to prevent AbortSignal processing. With 200 MB the old-gen is GC'd
  // at ~100-150 MB (V8 adaptive), producing ~15-30 ms pauses instead.
  // Normal operation uses ~50-70 MB old-gen; 200 MB provides 3× headroom.
  // --heapsnapshot-near-heap-limit removed: with 200 MB limit it would write
  // 100 MB snapshot files at the worst moment (during cascade).
  // FIX AM: --expose-gc exposes global.gc() used by memoryMonitor to trigger
  // proactive minor + periodic full GC, preventing uncontrolled mark-compact
  // pauses that caused the 962ms loopLag → cascade crash pattern.
  const nodeOptions = [
    process.env.NODE_OPTIONS || "",
    // FIX BT: Lowered from 150→100. Run 27 showed heapTotal growing from
    // 77MB→104MB (+27MB) during HTTP pause window. With max-old-space-size=100,
    // V8 triggers major GC sooner (at ~80MB used) before heapTotal/RSS can
    // accumulate 30-40MB of JS objects during cascade.
    "--max-old-space-size=100",
    "--expose-gc"
  ].filter(Boolean).join(" ");

  // FIX AJ: UV_THREADPOOL_SIZE=8 — libuv default is 4 workers shared by ALL
  // async TLS handshakes (crypto). With Polygon RPC + Gamma + CLOB + Binance
  // all potentially slow simultaneously, 4 workers stall the event loop.
  // 8 workers handle up to 8 concurrent TLS connections without stalling.
  const entryPath = resolveServerEntryPath();
  console.log(`🚀 [start] Entrypoint: ${entryPath}`);
  const child = spawn("node", [entryPath], {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      UV_THREADPOOL_SIZE: "8",
      // FIX BH: MALLOC_ARENA_MAX=1 — glibc malloc creates up to 8 arenas by
      // default (one per CPU thread). Each arena holds freed pages in its free
      // list without returning them to the OS until malloc_trim is called.
      // With UV_THREADPOOL_SIZE=8 creating 8 threads, malloc creates 8 arenas
      // each holding ~20-40MB freed GC bitmap residue = up to 320MB of "freed
      // but not OS-released" RSS. With MALLOC_ARENA_MAX=1, a single arena is
      // used for all threads — freed pages are returned to OS much faster via
      // the main arena's brk() shrink mechanism.
      // NOTE: MALLOC_ARENA_MAX is still set as fallback in case LD_PRELOAD fails.
      MALLOC_ARENA_MAX: "1",
      // FIX BP: jemalloc via LD_PRELOAD with dirty_decay_ms:0.
      // Benchmark (Run 25 analysis): glibc RSS after major GC = 138MB,
      // jemalloc RSS = 129MB (9MB less per GC cycle). During a 4-major-GC-per-2s
      // cascade (Fix-BP confirmed: 4×13MB bitmaps = 52MB per 2s window), jemalloc
      // returns dirty pages to OS IMMEDIATELY (dirty_decay_ms:0) instead of
      // holding them in its per-thread cache for up to 10 seconds (glibc default).
      // muzzy_decay_ms:0 also forces immediate MADV_FREE/MADV_DONTNEED for
      // hugepages. Net effect: Run 22-25 RSS cascade (200→361MB in 8s) should
      // become (200→220MB in 8s) because bitmaps are returned each GC cycle.
      LD_PRELOAD: "/usr/lib/x86_64-linux-gnu/libjemalloc.so.2",
      MALLOC_CONF: "dirty_decay_ms:0,muzzy_decay_ms:0",
    }
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    console.error(`❌ [start] Falha ao iniciar ${entryPath}:`, error.message);
    process.exit(1);
  });
}

cleanupPort(PORT);
startServer();
