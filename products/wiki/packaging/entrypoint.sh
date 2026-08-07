#!/bin/sh
# OpenWiki container entrypoint.
#
# Boot order (idempotent, safe on restarts):
#   1. init  the wiki root when openwiki.json is missing
#   2. bootstrap the Git working tree (Git stays canonical)
#   3. rebuild derived index store when missing
#   4. run Postgres runtime migrations when OPENWIKI_DATABASE_URL is set
#   5. configure the local backup destination when OPENWIKI_BACKUP_PATH is set
#   6. exec the requested role: serve (default), worker, or cron
set -eu

OPENWIKI_BIN="${OPENWIKI_BIN:-/usr/local/bin/openwiki}"
WIKI_ROOT="${OPENWIKI_ROOT:-/data/wiki}"
PORT="${OPENWIKI_PORT:-3030}"
GIT_USER_NAME="${OPENWIKI_GIT_USER_NAME:-openwiki}"
GIT_USER_EMAIL="${OPENWIKI_GIT_USER_EMAIL:-openwiki@localhost}"
WORKER_MAX_JOBS="${OPENWIKI_WORKER_MAX_JOBS:-1}"
WORKER_POLL_MS="${OPENWIKI_WORKER_POLL_MS:-2000}"
BACKUP_INTERVAL_SECONDS="${OPENWIKI_BACKUP_INTERVAL_SECONDS:-3600}"

mkdir -p "$WIKI_ROOT"
git config --global --add safe.directory "$WIKI_ROOT" 2>/dev/null || true

# 1. init
if [ ! -f "$WIKI_ROOT/openwiki.json" ]; then
  echo "[entrypoint] initializing wiki workspace at $WIKI_ROOT"
  "$OPENWIKI_BIN" init "$WIKI_ROOT"
fi

# 2. Git bootstrap (source of truth)
if [ ! -d "$WIKI_ROOT/.git" ]; then
  echo "[entrypoint] bootstrapping Git history"
  git -C "$WIKI_ROOT" init -q -b main
  git -C "$WIKI_ROOT" config user.name "$GIT_USER_NAME"
  git -C "$WIKI_ROOT" config user.email "$GIT_USER_EMAIL"
  git -C "$WIKI_ROOT" add -A
  git -C "$WIKI_ROOT" commit -q -m "Bootstrap OpenWiki workspace" 2>/dev/null || true
fi

# 3. Derived stores: search index (index/) then rule engine index-store (index-store/).
#    `readyz` gates on .openwiki/index/openwiki.sqlite existing.
if [ ! -f "$WIKI_ROOT/.openwiki/index/openwiki.sqlite" ]; then
  echo "[entrypoint] building search index"
  "$OPENWIKI_BIN" --root "$WIKI_ROOT" index --json >/dev/null 2>&1 || true
fi
if [ ! -f "$WIKI_ROOT/.openwiki/index-store/openwiki.sqlite" ]; then
  echo "[entrypoint] rebuilding derived index-store"
  "$OPENWIKI_BIN" --root "$WIKI_ROOT" db rebuild --json >/dev/null 2>&1 || true
fi

# 4. Postgres runtime migrations (lazy auto-migrate is on unless OPENWIKI_POSTGRES_MIGRATE=0)
if [ -n "${OPENWIKI_DATABASE_URL:-}" ]; then
  echo "[entrypoint] applying Postgres runtime migrations"
  "$OPENWIKI_BIN" --root "$WIKI_ROOT" db migrate >/dev/null 2>&1 || true
fi

# 5. Local backup destination (archive to a mounted volume)
if [ -n "${OPENWIKI_BACKUP_PATH:-}" ]; then
  "$OPENWIKI_BIN" --root "$WIKI_ROOT" backup configure local --id backup-local --path "$OPENWIKI_BACKUP_PATH" >/dev/null 2>&1 || true
fi

ROLE="${1:-serve}"
case "$ROLE" in
  serve)
    shift || true
    EXTRA=""
    if [ -n "${OPENWIKI_TRUST_AUTH_HEADERS_SECRET:-}" ]; then
      EXTRA="$EXTRA --trust-headers --trusted-header-secret $OPENWIKI_TRUST_AUTH_HEADERS_SECRET"
    fi
    # shellcheck disable=SC2086
    exec "$OPENWIKI_BIN" --root "$WIKI_ROOT" serve --host 0.0.0.0 --port "$PORT" $EXTRA "$@"
    ;;
  worker)
    shift || true
    exec "$OPENWIKI_BIN" --root "$WIKI_ROOT" worker --max-jobs "$WORKER_MAX_JOBS" --poll-ms "$WORKER_POLL_MS" "$@"
    ;;
  cron)
    # Scheduler role: periodic backup (always) and git sync (when OPENWIKI_SYNC_REMOTE is set).
    echo "[entrypoint] cron role: interval=${BACKUP_INTERVAL_SECONDS}s backup=1 sync=${OPENWIKI_SYNC_REMOTE:-0}"
    while true; do
      "$OPENWIKI_BIN" --root "$WIKI_ROOT" backup create >/dev/null 2>&1 || echo "[cron] backup failed"
      if [ -n "${OPENWIKI_SYNC_REMOTE:-}" ]; then
        "$OPENWIKI_BIN" --root "$WIKI_ROOT" sync now >/dev/null 2>&1 || echo "[cron] sync failed"
      fi
      sleep "$BACKUP_INTERVAL_SECONDS"
    done
    ;;
  *)
    echo "unknown role: $ROLE (expected serve|worker|cron)" >&2
    exit 2
    ;;
esac
