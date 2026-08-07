#!/bin/sh
set -eu
BARE_ROOT="/srv/git"

create_wiki_repo() {
  name="${1:-wiki}"
  repo="$BARE_ROOT/$name.git"
  if [ ! -d "$repo" ]; then
    echo "[git-server] creating bare repo $repo"
    mkdir -p "$repo"
    git init --bare --initial-branch=main "$repo" >/dev/null 2>&1 || git init --bare "$repo" >/dev/null 2>&1
  fi
}

rebuild_authorized_keys() {
  : > /root/.ssh/authorized_keys
  for f in /root/.ssh/authorized_keys.d/*; do
    [ -f "$f" ] && cat "$f" >> /root/.ssh/authorized_keys
  done
  chmod 600 /root/.ssh/authorized_keys
  echo "[git-server] authorized_keys rebuilt ($(wc -l < /root/.ssh/authorized_keys) keys)"
}

# Helper subcommands (for docker compose exec/run)
case "${1:-}" in
  create-wiki) create_wiki_repo "${2:-wiki}"; exit 0 ;;
  git-authorized) rebuild_authorized_keys; exit 0 ;;
esac

rebuild_authorized_keys
echo "[git-server] starting sshd on :22"
exec /usr/sbin/sshd -D -e
