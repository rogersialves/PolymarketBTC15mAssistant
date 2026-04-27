import { query } from "./db.js";

function toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function tradeHistoryDedupeKey(record) {
  if (record?.orderId) return `order:${record.orderId}`;
  return [
    "fallback",
    record?.timestamp ?? "",
    record?.tokenId ?? "",
    record?.metadata?.indicator ?? "",
    record?.metadata?.marketSlug ?? "",
    record?.metadata?.direction ?? "",
    record?.price ?? "",
    record?.sizeUsd ?? ""
  ].join("|");
}

export function buildTradeHistoryDbRow(record) {
  const metadata = record?.metadata && typeof record.metadata === "object" ? record.metadata : {};
  return {
    dedupe_key: tradeHistoryDedupeKey(record),
    timestamp_ms: toNum(record?.timestamp, Date.now()),
    side: record?.side || null,
    price: toNum(record?.price),
    size_usd: toNum(record?.sizeUsd),
    shares: toNum(record?.shares),
    token_id: record?.tokenId || null,
    order_id: record?.orderId || null,
    status: record?.status || null,
    execution_status: record?.executionStatus || null,
    dry_run: typeof record?.dryRun === "boolean" ? record.dryRun : null,
    resolved: typeof record?.resolved === "boolean" ? record.resolved : null,
    market_closed: typeof record?.marketClosed === "boolean" ? record.marketClosed : null,
    market_resolved: typeof record?.marketResolved === "boolean" ? record.marketResolved : null,
    won: typeof record?.won === "boolean" ? record.won : null,
    pnl: toNum(record?.pnl),
    metadata,
    raw: record && typeof record === "object" ? record : {}
  };
}

export function dbRowToTradeHistoryRecord(row) {
  if (row?.raw && typeof row.raw === "object") {
    return {
      ...row.raw,
      timestamp: Number(row.timestamp_ms),
      side: row.side ?? row.raw.side,
      price: row.price !== null && row.price !== undefined ? Number(row.price) : row.raw.price,
      sizeUsd: row.size_usd !== null && row.size_usd !== undefined ? Number(row.size_usd) : row.raw.sizeUsd,
      shares: row.shares !== null && row.shares !== undefined ? Number(row.shares) : row.raw.shares,
      tokenId: row.token_id ?? row.raw.tokenId,
      orderId: row.order_id ?? row.raw.orderId,
      status: row.status ?? row.raw.status,
      executionStatus: row.execution_status ?? row.raw.executionStatus,
      dryRun: row.dry_run ?? row.raw.dryRun,
      resolved: row.resolved ?? row.raw.resolved,
      marketClosed: row.market_closed ?? row.raw.marketClosed,
      marketResolved: row.market_resolved ?? row.raw.marketResolved,
      won: row.won ?? row.raw.won,
      pnl: row.pnl !== null && row.pnl !== undefined ? Number(row.pnl) : row.raw.pnl,
      metadata: row.metadata ?? row.raw.metadata ?? {}
    };
  }
  return {};
}

export async function ensureTradeHistorySchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS trade_history (
      id bigserial PRIMARY KEY,
      dedupe_key text UNIQUE NOT NULL,
      timestamp_ms bigint NOT NULL,
      side text,
      price numeric,
      size_usd numeric,
      shares numeric,
      token_id text,
      order_id text,
      status text,
      execution_status text,
      dry_run boolean,
      resolved boolean,
      market_closed boolean,
      market_resolved boolean,
      won boolean,
      pnl numeric,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      raw jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS trade_history_timestamp_idx ON trade_history (timestamp_ms DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS trade_history_order_id_idx ON trade_history (order_id)`);
  await query(`CREATE INDEX IF NOT EXISTS trade_history_token_id_idx ON trade_history (token_id)`);
  await query(`CREATE INDEX IF NOT EXISTS trade_history_resolved_idx ON trade_history (resolved, market_resolved)`);
  await query(`CREATE INDEX IF NOT EXISTS trade_history_market_slug_idx ON trade_history ((metadata->>'marketSlug'))`);
  await query(`CREATE INDEX IF NOT EXISTS trade_history_indicator_idx ON trade_history ((metadata->>'indicator'))`);
  await query(`CREATE INDEX IF NOT EXISTS trade_history_timeframe_idx ON trade_history ((metadata->>'timeframe'))`);
}

export async function upsertTradeHistoryRecords(records = []) {
  if (!Array.isArray(records) || records.length === 0) return { upserted: 0 };
  await ensureTradeHistorySchema();

  let upserted = 0;
  for (const record of records) {
    const row = buildTradeHistoryDbRow(record);
    await query(`
      INSERT INTO trade_history (
        dedupe_key, timestamp_ms, side, price, size_usd, shares, token_id, order_id,
        status, execution_status, dry_run, resolved, market_closed, market_resolved,
        won, pnl, metadata, raw
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14,
        $15, $16, $17::jsonb, $18::jsonb
      )
      ON CONFLICT (dedupe_key) DO UPDATE SET
        timestamp_ms = EXCLUDED.timestamp_ms,
        side = EXCLUDED.side,
        price = EXCLUDED.price,
        size_usd = EXCLUDED.size_usd,
        shares = EXCLUDED.shares,
        token_id = EXCLUDED.token_id,
        order_id = EXCLUDED.order_id,
        status = EXCLUDED.status,
        execution_status = EXCLUDED.execution_status,
        dry_run = EXCLUDED.dry_run,
        resolved = EXCLUDED.resolved,
        market_closed = EXCLUDED.market_closed,
        market_resolved = EXCLUDED.market_resolved,
        won = EXCLUDED.won,
        pnl = EXCLUDED.pnl,
        metadata = EXCLUDED.metadata,
        raw = EXCLUDED.raw,
        updated_at = now()
    `, [
      row.dedupe_key,
      row.timestamp_ms,
      row.side,
      row.price,
      row.size_usd,
      row.shares,
      row.token_id,
      row.order_id,
      row.status,
      row.execution_status,
      row.dry_run,
      row.resolved,
      row.market_closed,
      row.market_resolved,
      row.won,
      row.pnl,
      JSON.stringify(row.metadata),
      JSON.stringify(row.raw)
    ]);
    upserted++;
  }
  return { upserted };
}

export async function listTradeHistoryRecords({ since = 0, limit = null } = {}) {
  await ensureTradeHistorySchema();
  const params = [];
  let sql = `SELECT * FROM trade_history`;
  if (since > 0) {
    params.push(since);
    sql += ` WHERE timestamp_ms >= $${params.length}`;
  }
  sql += ` ORDER BY timestamp_ms ASC`;
  if (Number.isFinite(Number(limit)) && Number(limit) > 0) {
    params.push(Number(limit));
    sql += ` LIMIT $${params.length}`;
  }
  const result = await query(sql, params);
  return result.rows.map(dbRowToTradeHistoryRecord);
}

export async function countTradeHistoryRecords() {
  await ensureTradeHistorySchema();
  const result = await query(`SELECT count(*)::int AS count FROM trade_history`);
  return result.rows[0]?.count || 0;
}
