# Installation

OpenCode Gateway runs as a local Node.js service next to an OpenCode Web/TUI server.

## Requirements

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | `>=22.13 <23 || >=23.4` | Gateway uses `node:sqlite`, which only loads without `--experimental-sqlite` from Node 22.13 (or 23.4+/24+). |
| npm | bundled with Node | Used for install and build. |
| OpenCode | `>= 1.17` | Must expose a local API, usually `http://127.0.0.1:4096`. |
| cosign | current | Required to verify the signed checksum manifest for release bootstrap. |
| Git | current | Required only for a source checkout or explicit unsafe-ref install. |

## Install From Source

```bash
git clone https://github.com/joe-broadhead/opencode-gateway.git
cd opencode-gateway
npm ci --ignore-scripts
npm rebuild esbuild --ignore-scripts=false
npm run build
npm install -g . --ignore-scripts
```

## One-Command Bootstrap

Tagged GitHub releases attach `install.sh`, a source archive, `SHA256SUMS`, and a Sigstore bundle. Download all four from one immutable tag, verify the checksum manifest against the exact tag workflow identity, verify both payload checksums, and only then execute the installer:

```bash
TAG=v1.3.0
TMP="$(mktemp -d)"
BASE="https://github.com/joe-broadhead/opencode-gateway/releases/download/$TAG"
ARCHIVE="opencode-gateway-$TAG.tar.gz"

curl -fSLo "$TMP/install.sh" "$BASE/install.sh"
curl -fSLo "$TMP/SHA256SUMS" "$BASE/SHA256SUMS"
curl -fSLo "$TMP/SHA256SUMS.sigstore.json" "$BASE/SHA256SUMS.sigstore.json"
curl -fSLo "$TMP/$ARCHIVE" "$BASE/$ARCHIVE"

cosign verify-blob \
  --bundle "$TMP/SHA256SUMS.sigstore.json" \
  --certificate-identity "https://github.com/joe-broadhead/opencode-gateway/.github/workflows/ci.yml@refs/tags/$TAG" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "$TMP/SHA256SUMS"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$TMP" && sha256sum -c SHA256SUMS)
else
  (cd "$TMP" && shasum -a 256 -c SHA256SUMS)
fi

bash "$TMP/install.sh" --version "$TAG"
rm -rf "$TMP"
```

Do not use `curl ... | bash` or a mutable `main` URL for normal installation: the shell would execute before its signature and checksum could be verified. If the requested GitHub release or any required asset is absent, curl and `install.sh` fail clearly before changing the live installation.

The installer independently re-verifies the signed manifest and archive checksum. It creates a collision-safe sibling such as `~/opencode-gateway.transaction.A1b2C3`, writes an installer ownership marker, and stages/builds inside it before changing the live tree. After the atomic switch it polls `readiness --strict` for a bounded startup grace (60 seconds by default, configurable from 10 through 300 with `OPENCODE_GATEWAY_INSTALL_STARTUP_GRACE_SECONDS`). An update failure stops the failed release, restores the transaction's `previous` tree, reinstalls its service definition, and polls until the restored release is ready. A failed first install also disables/removes the global CLI and user-service artifacts created by that run. If a global CLI or loaded/installed Gateway user service already exists without the selected install tree, the script stops before switching rather than treating those artifacts as its own. Configuration, durable state, and OpenCode profile assets are retained for diagnosis and retry. Failed rollback is reported as an operator incident, never as install success.

When stdin is not a terminal, setup uses non-interactive defaults; run `opencode-gateway setup` afterward to review them. From a terminal on a fresh install, the guided setup wizard runs. Flags:

- `--yes` / `--non-interactive` — skip the wizard and use defaults even on a terminal.
- `--dry-run` — print what the script would do and exit.
- `--version <vX.Y.Z>` — select an immutable signed release (default is the package's current release tag).
- `--unsafe-ref <ref> --allow-unsafe-ref` — explicit development-only escape hatch that bypasses release signature/checksum and protected-main evidence.

On later runs the script uses the non-interactive update path so existing `~/.config/opencode-gateway/config.json`, `routing.json`, Gateway state, and channel credentials are preserved. The retained previous tree lives under its uniquely named, marker-owned transaction directory and rolls back code and service files only; it is not a state backup. Create and export a verified backup before upgrades that may affect durable state.

## Setup Path

For a local checkout, use this command path:

```bash
npm ci --ignore-scripts
npm rebuild esbuild --ignore-scripts=false
npm run build
npm install -g . --ignore-scripts
opencode-gateway setup
opencode-gateway install
opencode-gateway start
```

`opencode-gateway install` writes the LaunchAgent (macOS) or systemd user unit (Linux) **and loads/starts it** through the service manager, so the daemon is supervised immediately and at login. Rerunning `install` after moving the checkout or upgrading regenerates (heals) the service definition with stable paths. `opencode-gateway start`/`stop` are service-aware: when the service is installed they start/stop it via `launchctl`/`systemctl --user`, so a stopped daemon stays stopped instead of being resurrected by the service manager.

`opencode-gateway setup` guides OpenCode integration, dashboard/service port, model profiles, channel settings, and optional secret placeholders. Secrets are only written when entered intentionally; setup summaries redact configured channel secrets.

For a non-interactive pass using defaults:

```bash
opencode-gateway setup --yes
```

Setup/update is idempotent. Running it again keeps existing values unless the wizard is used to change them, keeps `routing.json` when it already exists, reinstalls Gateway OpenCode assets safely, and initializes the Gateway state database without deleting work.

## Update Path

For a verified bootstrap installation, rerun the verified release procedure above with the new tag. The installer builds off to the side and rolls back failed service/readiness activation. For a development checkout, run:

```bash
git pull --ff-only
npm ci --ignore-scripts
npm rebuild esbuild --ignore-scripts=false
npm run build
opencode-gateway update
opencode-gateway restart
```

Use `opencode-gateway update --wizard` when you want to review or change local values during an update. The update report shows config, routing, state, and OpenCode asset changes without printing raw secrets.

For beta handoff or release-operations certification, run the current local gates:

```bash
npm run release:artifacts -- --json
```

The current supported release, backup, support, and manual cleanup bounds are enforced by the claim registry (`opencode-gateway release claims`).

The package name `opencode-gateway` is intentionally marked `private` because the unscoped npm name does not have an established ownership/provenance path. Releases are source archives and signed container images, not npm-registry publications. Local `npm install -g . --ignore-scripts` remains supported.

## Uninstall Or Local Cleanup

Gateway does not delete durable state automatically. Create and verify a backup before cleanup:

```bash
opencode-gateway backup create --label before-uninstall
opencode-gateway backup list
opencode-gateway backup verify ~/.config/opencode-gateway/backups/gateway-backup-YYYYMMDDTHHMMSSZ-before-uninstall
```

Stop and remove the user service on macOS:

```bash
opencode-gateway stop
launchctl unload ~/Library/LaunchAgents/com.opencode-gateway.daemon.plist 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.opencode-gateway.daemon.plist
```

Stop and remove the user service on Linux:

```bash
opencode-gateway stop
systemctl --user disable --now opencode-gateway.service
rm -f ~/.config/systemd/user/opencode-gateway.service
systemctl --user daemon-reload
```

If you installed the CLI globally from source, remove the global link/package:

```bash
npm uninstall -g opencode-gateway
```

If you used the one-command bootstrap and want to remove the checkout after backing up state:

```bash
rm -rf ~/opencode-gateway
for transaction in ~/opencode-gateway.transaction.*; do
  [ -d "$transaction" ] || continue
  marker="$transaction/.opencode-gateway-installer-transaction"
  [ "$(cat "$marker" 2>/dev/null)" = opencode-gateway-installer-transaction-v1 ] || {
    echo "Refusing unvalidated path: $transaction" >&2
    continue
  }
  rm -rf -- "$transaction"
done
```

Only remove Gateway state when you are certain the backup is sufficient:

```bash
rm -rf ~/.config/opencode-gateway
```

Gateway setup installs OpenCode MCP, agent, and skill assets into your OpenCode profile. Leave them in place if you may reinstall Gateway later. If you intentionally remove them, delete only the Gateway-owned `gateway` MCP entry and `gateway-*` agents/skills from your OpenCode config directory.

## First-Time Setup

```bash
opencode-gateway setup
```

Setup writes `~/.config/opencode-gateway/config.json`, creates `routing.json` if needed, and installs the base Gateway MCP, agents, and skills into the configured OpenCode profile.

Service commands require the config file. If it is missing, run:

```bash
opencode-gateway setup
```

## Start The Daemon

```bash
opencode-gateway start
opencode-gateway status
```

Install as a user service:

```bash
opencode-gateway install
```

macOS writes a LaunchAgent named `com.opencode-gateway.daemon`. Linux writes a systemd user unit named `opencode-gateway.service`. Load/start the service with the command printed by `opencode-gateway install`, or use `opencode-gateway start` for a foreground local daemon.

## Supported Platforms

Local installs are supported on macOS and Linux with Node.js `>=22.13 <23 || >=23.4`, npm, Git, and a local OpenCode server. macOS uses a LaunchAgent service file. Linux uses a user-level systemd service file.

Known limitations:

- Windows service installation is not automated.
- OpenCode must be restarted after setup/update if it was already running.
- Channel ingress requires manually supplied Telegram or WhatsApp credentials.
- Public webhooks and non-local HTTP binding remain opt-in security settings.

## Reload OpenCode

Restart OpenCode after setup if it was already running. OpenCode loads agent, skill, and MCP configuration at startup.

## Manual MCP Entry

If setup cannot edit your OpenCode profile, add the Gateway MCP manually:

```json
{
  "mcp": {
    "gateway": {
      "type": "local",
      "command": ["node", "/absolute/path/to/opencode-gateway/dist/mcp.js"],
      "environment": {
        "GATEWAY_DAEMON_URL": "http://127.0.0.1:4097",
        "GATEWAY_MCP_TOOLS": "operate",
        "OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN_FILE": "/absolute/path/to/opencode-gateway-config/http-admin-token"
      }
    }
  }
}
```

`4097` is the default Gateway port. If setup chose a different port, use the `Port` printed by `opencode-gateway status` in the MCP URL. The generated entry uses the owner-only local daemon credential through an operator-named token-file variable and keeps the MCP surface at `operate`; it never embeds the bearer value in OpenCode config. Use the admin MCP tier and an admin credential only for a separately trusted administrative surface.
