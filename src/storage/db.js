import pg from "pg";

const { Pool } = pg;

let pool = null;

export function getDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
}

export function isPostgresEnabled() {
  return (process.env.TRADE_HISTORY_SOURCE || "postgres").toLowerCase() === "postgres";
}

export function getPool() {
  if (pool) return pool;
  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required when TRADE_HISTORY_SOURCE=postgres");
  }
  pool = new Pool({
    connectionString,
    max: Number(process.env.POSTGRES_POOL_MAX || 8),
    idleTimeoutMillis: Number(process.env.POSTGRES_IDLE_TIMEOUT_MS || 30_000),
    // Keep connect timeout tight so analysis fallback does not stall engine tick.
    connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS || 1_500),
    query_timeout: Number(process.env.POSTGRES_QUERY_TIMEOUT_MS || 2_000),
    statement_timeout: Number(process.env.POSTGRES_STATEMENT_TIMEOUT_MS || 2_000),
    keepAlive: true,
    allowExitOnIdle: true
  });
  pool.on("error", (err) => {
    console.warn(`⚠️  Postgres pool error: ${err?.message || err}`);
  });
  return pool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}

export async function closePool() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
