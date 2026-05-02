#!/usr/bin/env bash
# Full logical backup of the bot Postgres database (all tables, data, indexes).
# Produces a custom-format archive for pg_restore on another VPS.
#
# Prerequisite: either `docker compose` with service `bot-postgres` running,
# or `pg_dump` on PATH + DATABASE_URL in .env.
#
# Usage (from repo root):
#   ./scripts/db-dump-for-migration.sh
# Transfer the printed path with scp/rsync (do not commit dumps to git).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

mkdir -p data/backups
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="data/backups/polymarket_bot_${STAMP}.dump"
ABS_OUT="$ROOT/$OUT"

if docker compose ps bot-postgres --status running -q 2>/dev/null | grep -q .; then
  echo "pg_dump via docker (bot-postgres) -> $OUT" >&2
  docker compose exec -T bot-postgres \
    pg_dump -U "${POSTGRES_USER:-bot}" -d "${POSTGRES_DB:-polymarket_bot}" \
    --format=custom --no-owner --no-acl >"$ABS_OUT"
else
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "ERROR: bot-postgres is not running and DATABASE_URL is not set." >&2
    exit 1
  fi
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "ERROR: pg_dump not found. Start Postgres with docker compose or install postgresql-client." >&2
    exit 1
  fi
  echo "pg_dump via DATABASE_URL -> $OUT" >&2
  pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl -f "$ABS_OUT"
fi

BYTES="$(wc -c <"$ABS_OUT" | tr -d ' ')"
echo "OK $OUT ($BYTES bytes)" >&2
echo "$ABS_OUT"
