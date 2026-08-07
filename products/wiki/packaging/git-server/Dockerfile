# syntax=docker/dockerfile:1
# Minimal self-hosted Git remote for OpenWiki sync ("Git as source of truth"
# stays on-prem). Serves SSH (git protocol) with a bare repo per wiki.
#
# Build context: monorepo root.
# Usage (compose profile `git`):
#   docker compose --profile git up -d --build
#   # authorize the wiki app key once:
#   docker compose exec git-server sh -c "mkdir -p /root/.ssh/authorized_keys.d"
#   cat secrets/ssh/id_ed25519.pub | docker compose exec -T git-server tee /root/.ssh/authorized_keys.d/app.key
#   docker compose exec git-server regenerate-authorized-keys
#   docker compose exec git-server create-wiki-repo wiki
# App side (wiki container): add the remote
#   git remote add origin git@git-server:/srv/git/wiki.git

FROM alpine:3.20
RUN apk add --no-cache git openssh-server openssh-keygen bash
RUN mkdir -p /run/sshd /srv/git /root/.ssh/authorized_keys.d \
  && ssh-keygen -A

COPY docker-entrypoint.sh /usr/local/bin/git-server-entrypoint
RUN chmod +x /usr/local/bin/git-server-entrypoint
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/git-server-entrypoint"]
