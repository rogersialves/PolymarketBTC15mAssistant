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

# Absolute path for docker compose cp (relative paths are resolved from repo root)
if command -v realpath >/dev/null 2>&1; then
  ABS_DUMP="$(realpath "$DUMP")"
else
  ABS_DUMP="$(cd "$(dirname "$DUMP")" && pwd)/$(basename "$DUMP")"
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
  # pg_restore from stdin (-) often fails through "docker compose exec" (closed or
  # mishandled stdin). Copy the archive into the container and restore from a path.
  TMP_IN_CONTAINER="/tmp/polymarket_bot_restore_$$.dump"
  echo "pg_restore via docker (compose cp -> ${TMP_IN_CONTAINER}) -> ${POSTGRES_DB:-polymarket_bot}" >&2
  docker compose cp "$ABS_DUMP" "bot-postgres:${TMP_IN_CONTAINER}"
  docker compose exec -T bot-postgres \
    pg_restore -U "${POSTGRES_USER:-bot}" -d "${POSTGRES_DB:-polymarket_bot}" \
    --no-owner --clean --if-exists -v "$TMP_IN_CONTAINER"
  docker compose exec -T bot-postgres rm -f "$TMP_IN_CONTAINER"
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
  pg_restore -d "$DATABASE_URL" --no-owner --clean --if-exists -v "$ABS_DUMP"
fi

echo "OK restore finished." >&2
