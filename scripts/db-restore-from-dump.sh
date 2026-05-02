#!/usr/bin/env bash
# Restore a full database from a custom-format dump produced by db-dump-for-migration.sh.
# Run on the TARGET VPS after copying the .dump file (same Postgres major version recommended: 16).
#
# This uses --clean --if-exists so existing objects in the target DB are replaced.
# Use only on a database you intend to overwrite (or a fresh empty polymarket_bot).
#
# Usage (from repo root):
#   ./scripts/db-restore-from-dump.sh /path/to/polymarket_bot_YYYYMMDDTHHMMSSZ.dump

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DUMP="${1:-}"
if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
  echo "Usage: $0 /path/to/polymarket_bot_....dump" >&2
  exit 1
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

echo "WARNING: This will replace schema/data in the target DB (pg_restore --clean)." >&2
sleep 1

if docker compose ps bot-postgres --status running -q 2>/dev/null | grep -q .; then
  echo "pg_restore via docker (stdin) -> ${POSTGRES_DB:-polymarket_bot}" >&2
  cat "$DUMP" | docker compose exec -T bot-postgres \
    pg_restore -U "${POSTGRES_USER:-bot}" -d "${POSTGRES_DB:-polymarket_bot}" \
    --no-owner --clean --if-exists -v -
else
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "ERROR: bot-postgres is not running and DATABASE_URL is not set." >&2
    exit 1
  fi
  if ! command -v pg_restore >/dev/null 2>&1; then
    echo "ERROR: pg_restore not found. Install postgresql-client or use docker compose." >&2
    exit 1
  fi
  echo "pg_restore via DATABASE_URL" >&2
  pg_restore -d "$DATABASE_URL" --no-owner --clean --if-exists -v "$DUMP"
fi

echo "OK restore finished." >&2
