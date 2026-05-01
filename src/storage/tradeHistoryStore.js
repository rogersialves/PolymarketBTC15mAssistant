import { query } from "./db.js";

let schemaReadyPromise = null;

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
  if (schemaReadyPromise) return schemaReadyPromise;
  schemaReadyPromise = (async () => {
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
  })();
  try {
    await schemaReadyPromise;
  } catch (err) {
    schemaReadyPromise = null;
    throw err;
  }
}

export async function upsertTradeHistoryRecords(records = []) {
  if (!Array.isArray(records) || records.length === 0) return { upserted: 0 };
  await ensureTradeHistorySchema();

  // Deduplicate by dedupe_key before touching Postgres.
  // PostgreSQL's ON CONFLICT DO UPDATE cannot affect the same row twice in
  // a single statement — if two records in the same UNNEST batch share a
  // dedupe_key it throws "ON CONFLICT DO UPDATE command cannot affect row a
  // second time". Keep the last occurrence (most-recent state wins).
  const seen = new Map();
  for (const rec of records) seen.set(tradeHistoryDedupeKey(rec), rec);
  const deduped = Array.from(seen.values());

  const CHUNK = 200;
  let upserted = 0;

  for (let i = 0; i < deduped.length; i += CHUNK) {
    const chunk = deduped.slice(i, i + CHUNK);
    const rows = chunk.map(buildTradeHistoryDbRow);

    const dedupeKeys   = rows.map(r => r.dedupe_key);
    const timestampMs  = rows.map(r => r.timestamp_ms);
    const sides        = rows.map(r => r.side);
    const prices       = rows.map(r => r.price);
    const sizeUsds     = rows.map(r => r.size_usd);
    const sharesArr    = rows.map(r => r.shares);
    const tokenIds     = rows.map(r => r.token_id);
    const orderIds     = rows.map(r => r.order_id);
    const statuses     = rows.map(r => r.status);
    const execStatuses = rows.map(r => r.execution_status);
    const dryRuns      = rows.map(r => r.dry_run);
    const resolveds    = rows.map(r => r.resolved);
    const mktCloseds   = rows.map(r => r.market_closed);
    const mktResolveds = rows.map(r => r.market_resolved);
    const wons         = rows.map(r => r.won);
    const pnls         = rows.map(r => r.pnl);
    const metadatas    = rows.map(r => JSON.stringify(r.metadata));
    const raws         = rows.map(r => JSON.stringify(r.raw));

    await query(`
      INSERT INTO trade_history (
        dedupe_key, timestamp_ms, side, price, size_usd, shares, token_id, order_id,
        status, execution_status, dry_run, resolved, market_closed, market_resolved,
        won, pnl, metadata, raw
      )
      SELECT * FROM UNNEST(
        $1::text[], $2::bigint[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[],
        $7::text[], $8::text[], $9::text[], $10::text[], $11::boolean[], $12::boolean[],
        $13::boolean[], $14::boolean[], $15::boolean[], $16::numeric[], $17::jsonb[], $18::jsonb[]
      ) AS t(
        dedupe_key, timestamp_ms, side, price, size_usd, shares, token_id, order_id,
        status, execution_status, dry_run, resolved, market_closed, market_resolved,
        won, pnl, metadata, raw
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
      dedupeKeys, timestampMs, sides, prices, sizeUsds, sharesArr,
      tokenIds, orderIds, statuses, execStatuses, dryRuns, resolveds,
      mktCloseds, mktResolveds, wons, pnls, metadatas, raws
    ]);

    upserted += chunk.length;
  }

  // FIX U: Notify analysis cache that new data was persisted — it must re-fetch
  // on next call even if TTL hasn't expired yet.
  if (upserted > 0) _analysisVersion++;

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

// ── Lightweight record for in-engine analysis ─────────────────────────────
// Excludes the `raw` JSONB column (which is the full trade record serialised
// verbatim, typically 1-3 KB each) and returns plain JS objects with only
// the columns that buildTradeHistoryAnalysis actually uses.
// With 2845 rows this saves 3-8 MB of data transfer + avoids spreading
// thousands of objects on the V8 heap, eliminating the major-GC cascade.

function lightDbRowToRecord(row) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return {
    timestamp: Number(row.timestamp_ms),
    side: row.side ?? null,
    price: row.price !== null && row.price !== undefined ? Number(row.price) : null,
    sizeUsd: row.size_usd !== null && row.size_usd !== undefined ? Number(row.size_usd) : null,
    shares: row.shares !== null && row.shares !== undefined ? Number(row.shares) : null,
    tokenId: row.token_id ?? null,
    orderId: row.order_id ?? null,
    status: row.status ?? null,
    executionStatus: row.execution_status ?? null,
    dryRun: row.dry_run ?? null,
    resolved: row.resolved ?? null,
    marketClosed: row.market_closed ?? null,
    marketResolved: row.market_resolved ?? null,
    won: row.won ?? null,
    pnl: row.pnl !== null && row.pnl !== undefined ? Number(row.pnl) : null,
    metadata
  };
}

// Shared across both engines (5m and 15m). Both engines call this every
// ANALYSIS_REFRESH_MS (15s) simultaneously — without coordination they
// would fire 2 concurrent SELECT queries. The shared promise ensures only
// ONE query is in flight at a time and both engines receive the same result.
//
// FIX U: Version-based cache invalidation — only re-query when a new trade
// was upserted (incrementing _analysisVersion). Safety net: force re-fetch
// if cache is older than ANALYSIS_CACHE_MAX_TTL_MS regardless of version.
// SQL filter: only fetch rows usable by isAnalyzableTrade (resolved BUY wins/losses).
let _analysisVersion = 0;            // incremented by upsertTradeHistoryRecords
let _analysisCache = null;           // { records, version, fetchedAt }
let _analysisInFlight = null;
const ANALYSIS_CACHE_MAX_TTL_MS = 5 * 60_000;  // safety: force refresh every 5 min

export async function listTradeHistoryForAnalysis() {
  await ensureTradeHistorySchema();

  // Fast path: return cached records if nothing was upserted since last fetch.
  // Safety net: expire after ANALYSIS_CACHE_MAX_TTL_MS even without new upserts.
  if (_analysisCache) {
    const ageMs = Date.now() - _analysisCache.fetchedAt;
    if (_analysisCache.version === _analysisVersion && ageMs < ANALYSIS_CACHE_MAX_TTL_MS) {
      return _analysisCache.records;
    }
  }
  if (_analysisInFlight) return _analysisInFlight;

  _analysisInFlight = (async () => {
    const versionAtStart = _analysisVersion;
    try {
      // FIX U: Filter to only resolved BUY trades with a definitive outcome.
      // isAnalyzableTrade() requires resolved=true, market_resolved=true, side='BUY',
      // typeof won==='boolean'. Filtering here avoids transmitting or allocating
      // unresolvable records (pending/cancelled/unresolved trades).
      // Uses trade_history_resolved_idx (resolved, market_resolved) for efficiency.
      //
      // FIX BS: LIMIT 1000 most recent — full history (1915+ rows) costs ~28MB RSS
      // per engine per analysis call. Limiting to the most recent 1000 resolved
      // trades reduces allocation by ~50% while keeping enough history for
      // statistically significant indicator accuracy (1000 resolved trades = months
      // of history). Subquery orders DESC to get MOST RECENT 1000, outer ORDER BY
      // restores ASC for buildTradeHistoryAnalysis which expects chronological order.
      const result = await query(
        `SELECT timestamp_ms, side, price, size_usd, shares, token_id, order_id,
                status, execution_status, dry_run, resolved, market_closed,
                market_resolved, won, pnl, metadata
         FROM (
           SELECT timestamp_ms, side, price, size_usd, shares, token_id, order_id,
                  status, execution_status, dry_run, resolved, market_closed,
                  market_resolved, won, pnl, metadata
           FROM trade_history
           WHERE resolved = true
             AND market_resolved = true
             AND side = 'BUY'
             AND won IS NOT NULL
           ORDER BY timestamp_ms DESC
           LIMIT 1000
         ) recent
         ORDER BY timestamp_ms ASC`
      );
      const records = result.rows.map(lightDbRowToRecord);
      _analysisCache = { records, version: versionAtStart, fetchedAt: Date.now() };
      return records;
    } finally {
      _analysisInFlight = null;
    }
  })();

  return _analysisInFlight;
}

export async function countTradeHistoryRecords() {
  await ensureTradeHistorySchema();
  const result = await query(`SELECT count(*)::int AS count FROM trade_history`);
  return result.rows[0]?.count || 0;
}
