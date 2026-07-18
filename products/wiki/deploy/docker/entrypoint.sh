#!/bin/sh
set -eu

ROOT="${OPENWIKI_ROOT:-/data/wiki}"
TITLE="${OPENWIKI_TITLE:-OpenWiki}"
HOST="${OPENWIKI_HOST:-0.0.0.0}"
PORT="${OPENWIKI_PORT:-3030}"
ROLE="${OPENWIKI_ROLE:-}"
BOOTSTRAP_MODE="${OPENWIKI_BOOTSTRAP_MODE:-inline}"
APP_USER="${OPENWIKI_CONTAINER_USER:-node}"
APP_GROUP="${OPENWIKI_CONTAINER_GROUP:-node}"
GIT_REMOTE="${OPENWIKI_GIT_REMOTE:-origin}"
GIT_BRANCH="${OPENWIKI_GIT_BRANCH:-main}"
GIT_REMOTE_URL="${OPENWIKI_GIT_REMOTE_URL:-}"
GIT_CREDENTIAL_REF="${OPENWIKI_GIT_CREDENTIAL_REF:-}"
ALLOW_LOCAL_GIT_REMOTE="${OPENWIKI_ALLOW_LOCAL_GIT_REMOTE:-0}"
GIT_PULL_ON_BOOT="${OPENWIKI_GIT_PULL_ON_BOOT:-0}"
SYNC_INTERVAL="${OPENWIKI_SYNC_INTERVAL:-}"
SYNC_PULL_ON_START="${OPENWIKI_SYNC_PULL_ON_START:-0}"
SYNC_PUSH_AFTER_COMMIT="${OPENWIKI_SYNC_PUSH_AFTER_COMMIT:-0}"
INITIALIZED_ON_BOOT=0

openwiki_cli() {
  node --no-warnings --import tsx /app/packages/cli/src/main.ts "$@"
}

git_safe() {
  GIT_TERMINAL_PROMPT=0 git -c protocol.ext.allow=never -c protocol.file.allow=user "$@"
}

validate_git_name() {
  value="$1"
  label="$2"
  if [ -z "$value" ] || [ "${value#-}" != "$value" ]; then
    echo "$label must not be empty or start with '-'" >&2
    exit 1
  fi
  case "$value" in
    *[!A-Za-z0-9._-]*)
      echo "$label must contain only letters, numbers, dots, underscores, or dashes" >&2
      exit 1
      ;;
  esac
}

validate_git_branch() {
  value="$1"
  if [ -z "$value" ] || [ "${value#-}" != "$value" ]; then
    echo "Git branch must not be empty or start with '-'" >&2
    exit 1
  fi
  case "$value" in
    *..*|*[\ ~^:?*\[\]\\]*)
      echo "Git branch contains unsupported characters" >&2
      exit 1
      ;;
  esac
}

validate_git_remote_url() {
  value="$1"
  if [ -z "$value" ]; then
    return
  fi
  if printf '%s' "$value" | LC_ALL=C grep -q '[[:cntrl:]]'; then
    echo "Git remote URL must not contain control characters" >&2
    exit 1
  fi
  case "$value" in
    *::*|file://*|git://*|ftp://*)
      echo "Git remote URL is not allowed; use credential_ref or deployment Git auth instead of unsafe transports or inline credentials" >&2
      exit 1
      ;;
    https://*@*|https://*:*@*|ssh://*:*@*)
      echo "Git remote URL must not include inline credentials; use credential_ref or deployment Git auth" >&2
      exit 1
      ;;
    https://*|ssh://*)
      ;;
    http://localhost/*|http://localhost:*/*|http://127.0.0.1/*|http://127.0.0.1:*/*|http://[::1]/*|http://[::1]:*/*)
      if [ "$ALLOW_LOCAL_GIT_REMOTE" = "1" ]; then
        return
      fi
      echo "Local HTTP Git remotes require OPENWIKI_ALLOW_LOCAL_GIT_REMOTE=1" >&2
      exit 1
      ;;
    *@*:*)
      if printf '%s' "$value" | LC_ALL=C grep -Eq '^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^[:space:]:][^[:space:]]*$'; then
        return
      fi
      echo "Git remote URL must use strict scp-like SSH syntax" >&2
      exit 1
      ;;
    /*|./*|../*|~/*|*.git|*/*|*\\*)
      if [ "$ALLOW_LOCAL_GIT_REMOTE" = "1" ]; then
        return
      fi
      echo "Local filesystem Git remotes require OPENWIKI_ALLOW_LOCAL_GIT_REMOTE=1" >&2
      exit 1
      ;;
    *)
      echo "Git remote URL must use https, ssh, or scp-like SSH syntax" >&2
      exit 1
      ;;
  esac
}

mkdir -p "$ROOT"

if [ "$(id -u)" = "0" ]; then
  if [ "${OPENWIKI_SKIP_VOLUME_CHOWN:-}" != "1" ]; then
    chown -R "$APP_USER:$APP_GROUP" "$ROOT"
  fi
  exec gosu "$APP_USER" sh "$0" "$@"
fi

if [ "$#" -gt 0 ] && [ "$1" != "serve" ]; then
  case "$1" in
    pnpm|openwiki|sh|bash|node)
      exec "$@"
      ;;
    *)
      exec node --no-warnings --import tsx /app/packages/cli/src/main.ts --root "$ROOT" "$@"
      ;;
  esac
fi

validate_git_name "$GIT_REMOTE" "Git remote name"
validate_git_branch "$GIT_BRANCH"
validate_git_remote_url "$GIT_REMOTE_URL"

if [ ! -f "$ROOT/openwiki.json" ] && [ -n "$GIT_REMOTE_URL" ]; then
  if [ -z "$(find "$ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    if git_safe ls-remote --exit-code --heads "$GIT_REMOTE_URL" "$GIT_BRANCH" >/dev/null 2>&1; then
      git_safe clone --branch "$GIT_BRANCH" -- "$GIT_REMOTE_URL" "$ROOT"
    else
      if git_safe ls-remote --exit-code --heads "$GIT_REMOTE_URL" >/dev/null 2>&1; then
        echo "Git remote does not contain branch '$GIT_BRANCH'" >&2
        exit 1
      fi
      git_safe clone -- "$GIT_REMOTE_URL" "$ROOT"
      git_safe -C "$ROOT" checkout -B "$GIT_BRANCH"
    fi
  fi
fi

if [ ! -f "$ROOT/openwiki.json" ]; then
  openwiki_cli init "$ROOT" --title "$TITLE"
  INITIALIZED_ON_BOOT=1
fi

if [ -n "$GIT_REMOTE_URL" ] || [ -n "${OPENWIKI_GIT_REMOTE:-}" ] || [ -n "${OPENWIKI_GIT_BRANCH:-}" ] || [ -n "$GIT_CREDENTIAL_REF" ]; then
  set -- --root "$ROOT" git configure --remote "$GIT_REMOTE" --branch "$GIT_BRANCH"
  if [ -n "$GIT_REMOTE_URL" ]; then
    set -- "$@" --remote-url "$GIT_REMOTE_URL"
  fi
  if [ -n "$GIT_CREDENTIAL_REF" ]; then
    set -- "$@" --credential-ref "$GIT_CREDENTIAL_REF"
  fi
  openwiki_cli "$@"
fi

if [ "$GIT_PULL_ON_BOOT" = "1" ] && [ "$INITIALIZED_ON_BOOT" != "1" ]; then
  openwiki_cli --root "$ROOT" git pull --remote "$GIT_REMOTE" --branch "$GIT_BRANCH"
elif [ "$GIT_PULL_ON_BOOT" = "1" ]; then
  echo "Skipping boot pull because OpenWiki was initialized locally on this boot; commit and push the initial wiki before enabling pull-on-boot for this volume."
fi

if [ -n "$SYNC_INTERVAL" ]; then
  set -- --root "$ROOT" sync enable --every "$SYNC_INTERVAL" --remote "$GIT_REMOTE" --branch "$GIT_BRANCH"
  if [ "$SYNC_PULL_ON_START" = "1" ]; then
    set -- "$@" --pull-on-start
  fi
  if [ "$SYNC_PUSH_AFTER_COMMIT" = "1" ]; then
    set -- "$@" --push-after-commit
  fi
  openwiki_cli "$@"
  if ! git_safe -C "$ROOT" remote get-url "$GIT_REMOTE" >/dev/null 2>&1; then
    echo "Warning: OPENWIKI_SYNC_INTERVAL is set but Git remote '$GIT_REMOTE' has no URL. Configure OPENWIKI_GIT_REMOTE_URL before relying on scheduled sync." >&2
  fi
fi

case "$BOOTSTRAP_MODE" in
  inline|skip)
    ;;
  *)
    echo "Unsupported OPENWIKI_BOOTSTRAP_MODE '$BOOTSTRAP_MODE'. Expected inline or skip." >&2
    exit 1
    ;;
esac

if [ "$BOOTSTRAP_MODE" = "inline" ]; then
  if [ -n "${OPENWIKI_DATABASE_URL:-${DATABASE_URL:-}}" ]; then
    openwiki_cli --root "$ROOT" db migrate
  fi

  openwiki_cli --root "$ROOT" index
  openwiki_cli --root "$ROOT" db rebuild
  if [ -n "${OPENWIKI_DATABASE_URL:-${DATABASE_URL:-}}" ]; then
    openwiki_cli --root "$ROOT" db sync-postgres
  fi
else
  echo "Skipping inline OpenWiki bootstrap because OPENWIKI_BOOTSTRAP_MODE=skip. Run db migrate, index, db rebuild, and db sync-postgres from a one-shot job before serving."
fi
if [ -n "$ROLE" ]; then
  exec node --no-warnings --import tsx /app/packages/cli/src/main.ts --root "$ROOT" serve --host "$HOST" --port "$PORT" --role "$ROLE"
fi

exec node --no-warnings --import tsx /app/packages/cli/src/main.ts --root "$ROOT" serve --host "$HOST" --port "$PORT"
