import fs from "node:fs";
import path from "node:path";

let writer = null;
let writePath = null;

function ensureWriter() {
  if (writer || process.env.DIAG_LOG_FILE === "0") return writer;
  const filePath = process.env.DIAG_LOG_PATH
    || path.join(process.cwd(), "logs", "diagnostics.log");

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writer = fs.createWriteStream(filePath, { flags: "a" });
    writePath = filePath;
    writer.on("error", () => {
      try { writer?.destroy(); } catch {}
      writer = null;
    });
    writer.write(`\n=== diag session start ${new Date().toISOString()} pid=${process.pid} ===\n`);
  } catch {
    writer = null;
  }
  return writer;
}

export function diagLog(line, { level = "log" } = {}) {
  // Console first — preserva o comportamento atual.
  if (level === "warn") console.warn(line);
  else console.log(line);

  const w = ensureWriter();
  if (w) {
    try {
      w.write(`${new Date().toISOString()} ${line}\n`);
    } catch {
      // ignore
    }
  }
}

export function getDiagLogPath() {
  return writePath;
}
