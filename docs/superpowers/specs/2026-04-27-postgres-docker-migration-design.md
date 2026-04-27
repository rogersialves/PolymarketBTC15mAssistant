# Postgres and Docker Migration Design

Date: 2026-04-27

## Goal

Move the project's structured runtime history from CSV and JSON files to PostgreSQL, and run the app with new Docker resources that do not collide with existing containers from other projects.

The selected approach is direct migration:

- Import existing structured files into PostgreSQL.
- Stop using CSV and JSON files as the app's source of truth.
- Keep old files only as backup inputs for the migration and manual audit.

This is intended to reduce event-loop blocking, repeated file parsing, large JSON serialization, and CPU/GC pressure in the current tick loop.

## Current State

The app currently persists and reads hot runtime data from files under `logs/`:

- `trade_history.json`
- `sim_trades_5m.csv`
- `sim_trades_15m.csv`
- `scalp_trades_5m.csv`
- `scalp_trades_15m.csv`
- `snapshots.csv`
- `snapshots_5m.csv`
- `snapshots_15m.csv`
- `signals.csv`
- `trading_config.runtime.json`

Key hot paths currently parse or rewrite these files:

- `src/polyTrader.js` loads and rewrites `trade_history.json`.
- `src/server.js` reads sim/scalp CSVs for wallet and analysis payloads.
- `src/server.js` writes snapshots and signals CSVs during the main loop.
- `src/server.js` and `scripts/resolve-pending-trades.mjs` reconcile resolved trades.
- `src/simTradeHistoryBackfill.js` backfills token/order columns by parsing CSV and JSON history.

The JSON market dumps named `polymarket_market_*.json` are operational cache/audit artifacts. They are not part of the first database migration unless a later requirement needs querying those payloads.

## Docker Design

Add project-local Docker resources with a `bot` prefix:

- `bot-postgres`: PostgreSQL database container.
- `bot-app`: Node app container.
- `bot-postgres-data`: named volume for database storage.
- `bot-network`: private Docker network.

Use a non-default host port for Postgres to avoid conflicts:

- Host `55432` maps to container `5432`.

The app remains on:

- Host `3000` maps to container `3000`, configurable through `PORT`.

The compose file must not reuse generic container names such as `postgres`, `db`, or `app`.

## Database Schema

Use PostgreSQL as the primary store. Use typed columns for frequently filtered fields and `jsonb` for variable payloads.

### `trade_history`

Replaces `trade_history.json`.

Primary fields:

- `id bigserial primary key`
- `dedupe_key text unique not null`
- `timestamp_ms bigint not null`
- `side text`
- `price numeric`
- `size_usd numeric`
- `shares numeric`
- `token_id text`
- `order_id text`
- `status text`
- `execution_status text`
- `dry_run boolean`
- `resolved boolean`
- `market_closed boolean`
- `market_resolved boolean`
- `won boolean`
- `pnl numeric`
- `metadata jsonb not null default '{}'::jsonb`
- `raw jsonb not null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Indexes:

- `timestamp_ms desc`
- `order_id`
- `token_id`
- `(resolved, market_resolved)`
- `(metadata->>'marketSlug')`
- `(metadata->>'indicator')`
- `(metadata->>'timeframe')`

The `dedupe_key` follows the existing `tradeHistoryKey` behavior:

- `order:<orderId>` when `orderId` exists.
- fallback built from timestamp, token, indicator, market slug, direction, price, and size.

### `sim_trades`

Replaces `sim_trades_5m.csv` and `sim_trades_15m.csv`.

Fields:

- `id bigserial primary key`
- `timestamp timestamptz not null`
- `market_slug text not null`
- `timeframe text not null`
- `window_min integer not null`
- `indicator text not null`
- `side text not null`
- `entry_price numeric`
- `entry_time_left numeric`
- `outcome text`
- `won boolean`
- `pnl_usd numeric`
- `stake numeric`
- `mode text`
- `explanation text`
- `token_id text`
- `order_id text`
- `order_ts bigint`
- `created_at timestamptz not null default now()`

Indexes:

- `(timeframe, timestamp desc)`
- `(timeframe, market_slug)`
- `(indicator, timeframe)`
- `order_id`
- `token_id`

### `scalp_trades`

Replaces `scalp_trades_5m.csv` and `scalp_trades_15m.csv`.

Fields mirror the existing scalp CSV header from `SCALP_CSV_HEADER`, with normalized columns for:

- timestamp
- market slug
- timeframe/window
- indicator
- side
- entry/exit prices
- entry/exit timestamps
- hold seconds
- exit reason
- stake/effective stake
- shares
- pnl
- token/order identifiers

Unknown or future scalp-specific fields may be retained in `raw jsonb`.

Indexes:

- `(timeframe, timestamp desc)`
- `(indicator, timeframe)`
- `(market_slug, side)`
- `order_id`
- `token_id`

### `snapshots`

Replaces `snapshots.csv`, `snapshots_5m.csv`, and `snapshots_15m.csv`.

Use typed columns for the current snapshot header where practical:

- timestamp
- market slug
- timeframe/window
- probability fields
- indicator values
- Polymarket prices/liquidity
- exchange prices/volumes
- oracle fields
- regime/signal/recommendation

Retain the full imported row as `raw jsonb` to keep backward compatibility with historical columns and future additions.

Indexes:

- `(timeframe, timestamp desc)`
- `market_slug`
- `recommendation`
- `signal`

### `signals`

Replaces `signals.csv`.

Fields:

- timestamp
- window/timeframe
- entry minute
- time left
- regime
- signal
- model and market probabilities
- edge fields
- recommendation
- raw jsonb

Indexes:

- `(window_min, timestamp desc)`
- `recommendation`

### `runtime_config`

Replaces `trading_config.runtime.json`.

Fields:

- `key text primary key`
- `value jsonb not null`
- `updated_at timestamptz not null default now()`

The first key is `trading_config`.

## Storage Layer

Add `src/storage/` modules:

- `db.js`: PostgreSQL pool and health check.
- `migrations.js`: migration runner.
- `tradeHistoryStore.js`: read, upsert, merge, query recent, query pending.
- `simTradesStore.js`: insert resolved sim trades, query analysis rows, update token/order columns.
- `scalpTradesStore.js`: insert and query scalp wallet rows.
- `snapshotStore.js`: insert snapshots and signals.
- `runtimeConfigStore.js`: load/save runtime config.

The rest of the app should call these modules instead of using `fs` for structured runtime data.

## Migration Flow

Add scripts:

- `npm run db:migrate`: create/update schema.
- `npm run db:migrate-files`: import existing files into Postgres.
- `npm run db:check`: print table counts and recent rows.

`db:migrate-files` behavior:

1. Ensure schema exists.
2. Read current structured files from `logs/`.
3. Import `trade_history.json` with dedupe keys.
4. Import sim trades from both timeframes.
5. Import scalp trades from both timeframes.
6. Import snapshots and signals.
7. Import runtime config.
8. Print counts, skipped rows, duplicate rows, and malformed rows.

The script must be idempotent. Running it more than once must not duplicate records.

## App Changes

### Startup

On startup, the app connects to Postgres before creating timeframe engines. If Postgres is unavailable, startup fails loudly. There is no silent fallback to CSV/JSON in the direct migration approach.

### Trade History

`PolyTrader` loads initial history from `trade_history`. New and updated trades are upserted into `trade_history`.

The in-memory `orderHistory` array may remain as a bounded runtime cache, but full history queries must use Postgres.

`getStatus()` continues broadcasting only recent trades.

### Simulation Analysis

`computeSimAnalysis` reads rows from `sim_trades` and joins/enriches from `trade_history` when token/order data is needed.

Wallet histories should be capped in SQL or in the store layer, not rebuilt from every historical row on every tick.

### Resolutions and Reconciliation

The `/api/resolve-trades` flow updates `trade_history` rows directly.

CSV reconciliation/backfill functions are replaced with database equivalents:

- update resolved status and pnl in `trade_history`
- update affected `sim_trades` rows
- fill missing token/order fields from matched trade history

### Snapshots and Signals

Snapshot and signal writes use Postgres inserts.

The app does not append to the old CSV files during normal operation.

### Runtime Config

Runtime config reads and writes use `runtime_config`.

The old JSON file is imported once during migration.

## Error Handling

- Database connection failure at startup stops the app.
- Per-row import failures are collected and reported without stopping the entire import.
- Runtime insert/upsert failures are logged to the existing watchdog diagnostics and surfaced as engine errors where relevant.
- Database writes in hot paths should be async and bounded by short timeouts. A slow database must not create unbounded pending promises.

## Performance Expectations

Expected steady-state improvements:

- No repeated full parse of large CSV/JSON files per tick.
- No full rewrite of `trade_history.json`.
- Analysis reads can use indexed queries and bounded result sets.
- Token/order enrichment can be done with indexed lookups.
- Dockerized Postgres isolates storage and makes performance easier to observe.

Expected remaining hot paths:

- market data fetches
- indicator calculations
- WebSocket serialization
- Polymarket CLOB/Gamma calls

## Rollback

Because the selected approach stops writing CSV/JSON, rollback is operational:

1. Stop `bot-app`.
2. Keep old `logs/` files untouched as pre-migration backup.
3. Run the previous code version that still reads files.

No automatic reverse export is required for the first migration. A later `db:export-files` command can be added if rollback with post-migration trades becomes necessary.

## Validation

Before considering the migration complete:

- `docker compose up -d bot-postgres` starts a fresh isolated database.
- `npm run db:migrate` creates schema successfully.
- `npm run db:migrate-files` imports existing structured files without duplicate inflation.
- `npm run db:check` reports expected counts.
- `npm start` connects to Postgres and serves the dashboard.
- `/api/trade-history` returns records from Postgres.
- `/api/analysis/5m` and `/api/analysis/15m` return analysis from Postgres-backed data.
- A new simulated resolution writes into `sim_trades`.
- A new trade writes/upserts into `trade_history`.
- No normal runtime path writes to `sim_trades_*.csv`, `scalp_trades_*.csv`, `snapshots*.csv`, `signals.csv`, or `trade_history.json`.

## Out of Scope

- Migrating `polymarket_market_*.json` operational dumps into Postgres.
- Rewriting all historical analysis scripts in the same pass unless they block runtime verification.
- Adding a full admin UI for database inspection.
- Maintaining dual-write CSV and Postgres mode.
