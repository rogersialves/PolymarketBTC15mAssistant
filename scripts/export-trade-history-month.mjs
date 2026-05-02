#!/usr/bin/env node
/**
 * Export trade_history from Postgres for one UTC calendar month.
 * Output is a JSON array compatible with: node scripts/import-trade-history.mjs <file>
 *
 * Usage: node scripts/export-trade-history-month.mjs 2026-05
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseYm(arg) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(arg || "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return { y, monthIndex };
}

const ym = parseYm(process.argv[2]);
if (!ym) {
  console.error("Usage: node scripts/export-trade-history-month.mjs YYYY-MM   (e.g. 2026-05)");
  process.exit(1);
}

const { y, monthIndex } = ym;
const startMs = Date.UTC(y, monthIndex, 1, 0, 0, 0, 0);
const endMs = Date.UTC(y, monthIndex + 1, 1, 0, 0, 0, 0);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const result = await client.query(
  `SELECT raw FROM trade_history
   WHERE timestamp_ms >= $1 AND timestamp_ms < $2
   ORDER BY timestamp_ms ASC`,
  [startMs, endMs]
);
await client.end();

const records = result.rows.map((row) => row.raw);
const label = `${y}-${String(monthIndex + 1).padStart(2, "0")}`;
const outDir = path.join(__dirname, "..", "data", "sync");
const outPath = path.join(outDir, `trade_history_${label}.json`);
const relFromRepo = path.join("data", "sync", `trade_history_${label}.json`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      monthUtc: label,
      count: records.length,
      path: relFromRepo,
      importHint: `node scripts/import-trade-history.mjs ${relFromRepo}`
    },
    null,
    2
  )
);
