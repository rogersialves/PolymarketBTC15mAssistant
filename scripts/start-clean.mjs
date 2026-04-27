import { execSync, spawn } from "node:child_process";

const PORT = 3000;

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
  // --max-old-space-size: cap V8 old-space at 2.5 GB. Box has 4 GB total; this
  //   leaves ~1.5 GB for OS + WS clients + buffers and gives headroom for the
  //   server.js process to fail loudly via OOM instead of swap-thrashing.
  // --heapsnapshot-near-heap-limit: dump up to 3 .heapsnapshot files into CWD
  //   when V8 approaches the heap limit, so we can post-mortem actual leaks.
  const nodeOptions = [
    process.env.NODE_OPTIONS || "",
    "--max-old-space-size=2560",
    "--heapsnapshot-near-heap-limit=3"
  ].filter(Boolean).join(" ");

  const child = spawn("node", ["src/server.js"], {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: nodeOptions }
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    console.error("❌ [start] Falha ao iniciar src/server.js:", error.message);
    process.exit(1);
  });
}

cleanupPort(PORT);
startServer();
