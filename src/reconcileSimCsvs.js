import fs from "node:fs";
import path from "node:path";

function toBoolText(value) {
  return String(value).trim().toLowerCase();
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function buildCorrectionIndex(correctedTrades) {
  const correctedByKey = new Map();

  for (const t of Array.isArray(correctedTrades) ? correctedTrades : []) {
    if (!t?.resolved || !t?.marketResolved) continue;

    const slug = t.metadata?.marketSlug;
    const indicator = t.metadata?.indicator;
    const direction = t.metadata?.direction;
    if (!slug || !indicator || (direction !== "UP" && direction !== "DOWN")) continue;

    const outcome = t.won ? direction : (direction === "UP" ? "DOWN" : "UP");
    correctedByKey.set(`${slug}|${indicator}`, {
      outcome,
      won: Boolean(t.won)
    });
  }

  return correctedByKey;
}

function normalizeFields(fields, length) {
  while (fields.length < length) fields.push("");
  return fields;
}

export function reconcileSimCsvs({
  correctedTrades,
  simCsvPaths,
  dryRun = false,
  includeModes = null,
  logger = null
} = {}) {
  const correctedByKey = buildCorrectionIndex(correctedTrades);
  const result = {
    totalReconciled: 0,
    perFile: {},
    samples: []
  };

  if (correctedByKey.size === 0) return result;

  const allowedModes = Array.isArray(includeModes)
    ? new Set(includeModes.map(m => String(m).toUpperCase()))
    : null;

  for (const csvPath of Array.isArray(simCsvPaths) ? simCsvPaths : []) {
    if (!fs.existsSync(csvPath)) continue;

    const raw = fs.readFileSync(csvPath, "utf8");
    if (!raw.trim()) continue;

    const hasTrailingNewline = raw.endsWith("\n");
    const lines = raw.split("\n").map(l => l.replace(/\r$/, ""));
    const headerLine = lines[0];
    if (!headerLine) continue;

    const headerCols = headerLine.split(",");
    const idx = {
      market_slug: headerCols.indexOf("market_slug"),
      indicator: headerCols.indexOf("indicator"),
      side: headerCols.indexOf("side"),
      entry_price: headerCols.indexOf("entry_price"),
      outcome: headerCols.indexOf("outcome"),
      won: headerCols.indexOf("won"),
      pnl_usd: headerCols.indexOf("pnl_usd"),
      stake: headerCols.indexOf("stake"),
      mode: headerCols.indexOf("mode")
    };

    const required = [
      idx.market_slug,
      idx.indicator,
      idx.side,
      idx.entry_price,
      idx.outcome,
      idx.won,
      idx.pnl_usd,
      idx.stake
    ];
    if (required.some(v => v < 0)) continue;

    let modified = 0;
    const modeCounts = {};
    const newLines = [headerLine];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) {
        if (i !== lines.length - 1 || hasTrailingNewline) newLines.push(line);
        continue;
      }

      const fields = normalizeFields(line.split(","), headerCols.length);
      const mode = idx.mode >= 0 ? String(fields[idx.mode] || "LEGACY").toUpperCase() : "LEGACY";
      if (allowedModes && !allowedModes.has(mode)) {
        newLines.push(line);
        continue;
      }

      const key = `${fields[idx.market_slug]}|${fields[idx.indicator]}`;
      const correction = correctedByKey.get(key);
      if (!correction) {
        newLines.push(line);
        continue;
      }

      const csvSide = fields[idx.side];
      const entryPrice = parseFloat(fields[idx.entry_price]);
      const stake = parseFloat(fields[idx.stake]) || 1;
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        newLines.push(line);
        continue;
      }

      const newWon = csvSide === correction.outcome;
      const shares = stake / entryPrice;
      const newReturned = newWon ? shares : 0;
      const newPnl = round4(newReturned - stake);

      const oldOutcome = fields[idx.outcome];
      const oldWonText = toBoolText(fields[idx.won]);
      const oldPnl = parseFloat(fields[idx.pnl_usd]);
      const pnlDiffers = !Number.isFinite(oldPnl) || Math.abs(oldPnl - newPnl) > 0.0001;
      const differs = oldOutcome !== correction.outcome
        || oldWonText !== String(newWon)
        || pnlDiffers;

      if (!differs) {
        newLines.push(line);
        continue;
      }

      fields[idx.outcome] = correction.outcome;
      fields[idx.won] = String(newWon);
      fields[idx.pnl_usd] = String(newPnl);
      newLines.push(fields.join(","));

      modified++;
      modeCounts[mode] = (modeCounts[mode] || 0) + 1;
      if (result.samples.length < 20) {
        result.samples.push({
          file: path.basename(csvPath),
          line: i + 1,
          marketSlug: fields[idx.market_slug],
          indicator: fields[idx.indicator],
          mode,
          oldOutcome,
          newOutcome: correction.outcome,
          oldPnl: Number.isFinite(oldPnl) ? oldPnl : null,
          newPnl
        });
      }
    }

    if (modified > 0) {
      const fileName = path.basename(csvPath);
      result.perFile[fileName] = { modified, modes: modeCounts };
      result.totalReconciled += modified;

      if (!dryRun) {
        const backupPath = csvPath.replace(".csv", `.backup-${Date.now()}.csv`);
        fs.copyFileSync(csvPath, backupPath);
        fs.writeFileSync(csvPath, newLines.join("\n"), "utf8");
        logger?.(`[CSV] ${fileName} reconciliado: ${modified} linha(s) | backup: ${path.basename(backupPath)}`);
      } else {
        logger?.(`[DRY_RUN] ${fileName}: ${modified} linha(s) seria(m) corrigida(s)`);
      }
    }
  }

  return result;
}
