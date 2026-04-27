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
    connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS || 5_000)
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
