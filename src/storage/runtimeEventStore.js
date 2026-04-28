import { query } from "./db.js";

let schemaReadyPromise = null;
let insertDisabledUntilMs = 0;

function isTransientDbError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("timeout")
    || msg.includes("connection terminated")
    || msg.includes("connect")
    || msg.includes("econn")
    || msg.includes("server closed the connection")
  );
}

function normalizeTimestamp(value) {
  const d = value ? new Date(value) : new Date();
  return Number.isFinite(d.getTime()) ? d : new Date();
}

function rowObject(header = [], values = []) {
  const raw = {};
  for (let i = 0; i < header.length; i++) {
    raw[header[i]] = values[i] ?? null;
  }
  return raw;
}

export function buildRuntimeEventRow({
  eventType,
  timeframe = null,
  marketSlug = null,
  timestamp = null,
  header = [],
  values = [],
  raw = null
} = {}) {
  const payload = raw && typeof raw === "object" ? raw : rowObject(header, values);
  const ts = timestamp || payload.timestamp || payload.ts || null;
  return {
    event_type: String(eventType || "event"),
    timeframe,
    market_slug: marketSlug || payload.market_slug || payload.marketSlug || null,
    timestamp: normalizeTimestamp(ts),
    raw: payload
  };
}

export async function ensureRuntimeEventSchema() {
  if (schemaReadyPromise) return schemaReadyPromise;
  schemaReadyPromise = (async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS runtime_events (
      id bigserial PRIMARY KEY,
      event_type text NOT NULL,
      timeframe text,
      market_slug text,
      timestamp timestamptz NOT NULL,
      raw jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS runtime_events_type_time_idx ON runtime_events (event_type, timestamp DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS runtime_events_tf_time_idx ON runtime_events (timeframe, timestamp DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS runtime_events_market_slug_idx ON runtime_events (market_slug)`);
  })();
  try {
    await schemaReadyPromise;
  } catch (err) {
    schemaReadyPromise = null;
    throw err;
  }
}

export async function insertRuntimeEvent(input) {
  if (Date.now() < insertDisabledUntilMs) {
    return null;
  }

  await ensureRuntimeEventSchema();
  const row = buildRuntimeEventRow(input);
  try {
    await query(`
      INSERT INTO runtime_events (event_type, timeframe, market_slug, timestamp, raw)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `, [
      row.event_type,
      row.timeframe,
      row.market_slug,
      row.timestamp,
      JSON.stringify(row.raw)
    ]);
    return row;
  } catch (err) {
    if (isTransientDbError(err)) {
      const cooldownMs = Number(process.env.RUNTIME_EVENTS_DB_COOLDOWN_MS || 60_000);
      insertDisabledUntilMs = Date.now() + Math.max(5_000, cooldownMs);
      console.warn(`⚠️  runtime_events temporariamente desabilitado por ${Math.round((insertDisabledUntilMs - Date.now()) / 1000)}s: ${err?.message || err}`);
      return null;
    }
    throw err;
  }
}

export async function countRuntimeEvents(eventType = null) {
  await ensureRuntimeEventSchema();
  if (eventType) {
    const result = await query(`SELECT count(*)::int AS count FROM runtime_events WHERE event_type = $1`, [eventType]);
    return result.rows[0]?.count || 0;
  }
  const result = await query(`SELECT count(*)::int AS count FROM runtime_events`);
  return result.rows[0]?.count || 0;
}
