# Docker Operations

## Service Credential Files

Docker runs Gateway in exposed HTTP mode (`0.0.0.0` inside the container), so every HTTP request must use a bearer token. Generate distinct scoped tokens:

```bash
SECRETS_DIR="$HOME/.config/opencode-gateway/compose-secrets"
install -d -m 700 "$SECRETS_DIR"
umask 077
openssl rand -hex 32 > "$SECRETS_DIR/http-read-token"
openssl rand -hex 32 > "$SECRETS_DIR/http-operator-token"
openssl rand -hex 32 > "$SECRETS_DIR/http-admin-token"
```

Compose mounts each file only into the service context that needs it; bearer values do not appear in the Compose environment or repository. Because file-backed Compose secrets are mounted with engine-specific ownership, the gateway service starts with a minimal root shim that reads `/run/secrets`, copies the values into `/run/opencode-gateway/secrets` on tmpfs as UID/GID `65532` with mode `0600`, drops to UID/GID `65532`, and then launches the daemon. The service-level `OPENCODE_GATEWAY_HTTP_*_TOKEN_FILE` variables point to those tmpfs runtime copies so both the daemon and the image healthcheck read the same scoped files. The `OPENCODE_GATEWAY_BOOTSTRAP_HTTP_*_TOKEN_FILE` variables point at `/run/secrets/...` and are used only by the startup copy shim. Keep the host directory owner-only. To use files from a host secret manager or another directory, override the host paths, not the values:

```bash
export OPENCODE_GATEWAY_HTTP_READ_TOKEN_FILE=/secure/path/gateway-read-token
export OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN_FILE=/secure/path/gateway-operator-token
export OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE=/secure/path/gateway-admin-token
```

For the host-side curl examples below, load the three values into that operator shell only (they are still not passed through Compose):

```bash
export OPENCODE_GATEWAY_HTTP_READ_TOKEN="$(tr -d '\r\n' < "$HOME/.config/opencode-gateway/compose-secrets/http-read-token")"
export OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN="$(tr -d '\r\n' < "$HOME/.config/opencode-gateway/compose-secrets/http-operator-token")"
export OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN="$(tr -d '\r\n' < "$HOME/.config/opencode-gateway/compose-secrets/http-admin-token")"
```

## Start

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

The container maps `127.0.0.1:4097` on the host to Gateway and points Gateway at host OpenCode via `http://host.docker.internal:4096`.

## Persistence

Compose uses the named volume `opencode-gateway-config` for the container user's Gateway config directory.
The image defaults to UID/GID `65532` and seeds that directory with nonroot ownership before the
volume is initialized, so Gateway can create its config, state database, and backups without running
the daemon as root. Compose runs only the startup secret-copy shim as root, then drops privileges
before the Gateway daemon starts.

Keep the named volume for normal local Docker use. If you intentionally replace it with a Linux host
bind mount, create the host directory and make it writable by UID/GID `65532` first:

```bash
mkdir -p ~/.config/opencode-gateway
sudo chown -R 65532:65532 ~/.config/opencode-gateway
```

The CI Docker smokes create fresh named volumes, verify the nonroot container can write to the
Gateway config path, run scoped HTTP auth directly, and run a Compose secret-file smoke that waits
for Docker's healthcheck to report `healthy` from the tmpfs runtime-copied read-token file.

The named volume is on the same Docker host. It is not an off-host or encrypted backup. Follow [Backup And Restore](backup-restore.md#off-host-encrypted-copy) to export, encrypt, and copy verified backups into a separate failure domain.

## Intentional Shutdown

Compose sends `SIGTERM` and allows 30 seconds for Gateway to release leases and close SQLite. The `on-failure:5` restart policy retries crashes but does not resurrect a clean application shutdown. These are intentional stop paths:

```bash
docker compose -f docker/docker-compose.yml stop -t 30 gateway
curl -fsS -X POST \
  -H "Authorization: Bearer $OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN" \
  http://127.0.0.1:4097/shutdown
```

The curl example assumes the admin token was loaded into the operator shell from its credential file. After `/shutdown`, start the stopped container explicitly with `docker compose -f docker/docker-compose.yml up -d gateway`. Use `docker compose down` to remove containers and networks; omit `--volumes` unless deleting durable Gateway state is deliberate and a verified off-host backup exists.

After five consecutive crash restarts Docker leaves the container stopped for inspection. Check `docker compose ps`, `docker compose logs gateway`, and authenticated `/readiness` before manually restarting it.

## Log Retention

Compose uses Docker's `local` log driver with five 10 MiB files for Gateway and three 5 MiB files for the optional dead-man service. This bounds container stdout/stderr independently of Gateway's application log rotation. Export only redacted incident bundles for support; do not treat retained container logs as a backup or immutable audit store.

## External Dead-Man Profile

Gateway's durable outbound alert delivery works only while its process and host are alive. For unattended operation, configure an independent off-host heartbeat receiver and enable the optional profile:

```bash
printf '%s\n' 'https://deadman.example.invalid/your-secret-heartbeat' > "$HOME/.config/opencode-gateway/compose-secrets/deadman-url"
chmod 600 "$HOME/.config/opencode-gateway/compose-secrets/deadman-url"
docker compose -f docker/docker-compose.yml --profile deadman up -d --build
```

The sidecar reads the service-scoped read token, requires authenticated `GET /readiness` to return JSON `state: "ready"`, and only then calls the private HTTPS heartbeat URL. Its inherited Gateway healthcheck is disabled because the sidecar does not serve Gateway HTTP. Heartbeat attempts run serially: the next delay starts only after the current readiness/receiver attempt finishes. `OPENCODE_GATEWAY_DEADMAN_INTERVAL_SECONDS` must be a whole number from 30 through 86,400 (default 60). Configure the off-host receiver to alert after two missed intervals. Test by stopping `gateway` and proving the receiver alerts. In-process channel alerts are complementary and cannot replace this absence detector.

## Smoke Checks

Read token:

```bash
curl -fsS -H "Authorization: Bearer $OPENCODE_GATEWAY_HTTP_READ_TOKEN" http://127.0.0.1:4097/health
```

Read token must not mutate:

```bash
curl -i -X POST -H "Authorization: Bearer $OPENCODE_GATEWAY_HTTP_READ_TOKEN" -H "Content-Type: application/json" -d '{"title":"denied"}' http://127.0.0.1:4097/tasks
```

Operator token can create durable work:

```bash
curl -fsS -X POST -H "Authorization: Bearer $OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN" -H "Content-Type: application/json" -d '{"title":"docker smoke task"}' http://127.0.0.1:4097/tasks
```

Admin token can stop the daemon:

```bash
curl -fsS -X POST -H "Authorization: Bearer $OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN" http://127.0.0.1:4097/shutdown
```

## Dashboard Note

Direct browser navigation cannot attach an `Authorization` bearer header. Use curl/API clients for Docker smoke checks, or put Gateway behind a trusted local proxy that injects the read token for dashboard routes. Do not expose that proxy beyond trusted local operators.

The image healthcheck reads `OPENCODE_GATEWAY_HTTP_READ_TOKEN_FILE` and uses authenticated `/health`, not `/readiness`, so the container can report healthy even while OpenCode itself is still starting. Use `/readiness` with the read token when you want full dependency readiness.
