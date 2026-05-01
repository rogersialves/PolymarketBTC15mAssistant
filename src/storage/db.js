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
    // Raised from 1500ms → 5000ms. The previous 1500ms was shorter than typical
    // event loop lag spikes (500-2000ms), causing spurious "connection timeout"
    // errors that churned the pool and grew RSS. The application-level timeout
    // (SIM_ANALYSIS_TIMEOUT_MS=1200ms) is the real guard; pg timeouts are just
    // safety nets and must be above the application timeout.
    connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS || 5_000),
    // Raised from 2000ms → 6000ms so a query does not get killed at the pg
    // level before the 1200ms application-level timeout can reject it cleanly.
    // Without this, pg destroys the connection (indeterminate protocol state)
    // which forces a reconnect and grows RSS.
    query_timeout: Number(process.env.POSTGRES_QUERY_TIMEOUT_MS || 6_000),
    statement_timeout: Number(process.env.POSTGRES_STATEMENT_TIMEOUT_MS || 6_000),
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
