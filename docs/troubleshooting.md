# Troubleshooting

Common issues downstream ops teams and first-time installers hit, with
concrete diagnostic paths. Open an issue if you run into something
here the guide doesn't cover.

## MCP doesn't show up in the agent builder

Two probable causes.

**The MCP refused to start.** Open **Capabilities → your MCP → Test
MCP**. If the test returns "Cannot connect" or "Missing Authorization
header," the introspection failed. For HTTP MCPs behind OAuth the
browser sign-in flow may not have completed. For stdio MCPs the
command path may be wrong — check the app log at
`~/Library/Application Support/Open Cowork/logs/open-cowork-<date>.log`
and search for your MCP's name.

**The MCP URL is blocked by the SSRF guard.** HTTP MCPs default to
public-internet only. If the MCP lives at `http://localhost:3000`
or inside `10.*` / `192.168.*` you'll see *"URL resolves to
loopback / RFC1918"*. Toggle **Allow private network** in the MCP's
form — a documented opt-in, not a bypass.

## Pulse dashboard shows empty totals

"No threads in this window yet" is correct when the selected time
range contains no sessions with persisted summaries. Widen the
window (YTD → All time), or check the warning chips beneath the
filter:

- **"N sessions couldn't be reconstructed"** — older sessions whose
  on-disk summary was missing and a backfill failed. Totals may be
  understated for that time window. Typical cause is a partially-
  written session from a prior crash. Deleting the stale session
  record clears the warning.
- **"Still loading N older sessions"** — background backfill is
  working through sessions that didn't have summaries yet. The
  dashboard refreshes automatically when it's done.

## Chart rendered but nothing appears in the Artifacts sidebar

Chart PNGs are captured client-side after the vega view renders. If
the interactive chart shows an error (e.g. "Chart frame did not
initialize"), no PNG is captured. Check the renderer console
(View → Toggle Developer Tools) for the underlying error.

When the chart renders but the pill doesn't appear, confirm the
session has a `sessionId` in the URL — capture skips for preview-
only chart renders (e.g. isolated test fixtures).

## Google sign-in opens a browser but never completes

Three spots to check.

1. **Config has `auth.mode: google-oauth`**. Look at
   `open-cowork.config.json` (or your downstream overlay). `auth.mode:
   none` means the sign-in button shouldn't appear at all; seeing it
   suggests a mis-layered config.
2. **OAuth client ID / secret** — the sign-in browser tab needs to
   reach a consent screen. If you see "This app is not verified"
   that's expected for downstream test builds and can be bypassed
   from the consent screen. If you see "redirect_uri_mismatch,"
   the OAuth client doesn't have `http://127.0.0.1:<port>` as an
   authorized redirect URI.
3. **Firewall / VPN** blocking `127.0.0.1:<dynamic port>` — the app
   binds a short-lived localhost server to receive the redirect.
   Corporate VPNs sometimes reject that. Disconnect the VPN during
   sign-in if possible.

## "Can't reach internal MCP at 10.0.0.*"

By default the HTTP MCP guard rejects RFC1918 ranges. Enable **Allow
private network** on the MCP (see the SSRF section above). If that
doesn't unblock it, check `pnpm test` locally against
`tests/mcp-url-policy.test.ts` to confirm the policy evaluates the
URL shape correctly.

## `pnpm dev` fails with missing `packages/shared/dist/`

If startup fails with errors around `@open-cowork/shared` or a missing
`packages/shared/dist/` directory, the shared workspace package has not
been built yet.

Fix sequence:

1. Verify Node is `v22.12.0+` and that `pnpm` is installed via Corepack:
   ```bash
   node -v
   corepack enable
   corepack prepare pnpm@10.32.1 --activate
   pnpm -v
   ```
2. Reinstall workspace dependencies:
   ```bash
   pnpm install
   ```
3. Build the shared package explicitly, then restart dev:
   ```bash
   pnpm build:shared
   pnpm dev
   ```

The root `pnpm dev` command performs this shared build automatically.
This manual step is mainly for direct `apps/desktop` workspace launches
or interrupted installs.

## Settings reset on reboot

Credentials are persisted via Electron's `safeStorage`, which uses
Keychain on macOS, DPAPI on Windows, and libsecret on Linux. If
`safeStorage.isEncryptionAvailable()` returns false on your platform
the app will refuse to persist credentials in production builds
(dev falls back to a plaintext file). The main-process log will
show *"Cannot save settings: secure storage unavailable in
production"*. On Linux this usually means `gnome-keyring` or a
similar secrets daemon isn't running. The same fail-closed behavior
applies to downstream Google OAuth token storage when
`auth.mode: google-oauth` is enabled.

If settings existed previously but vanished: check for a
`.tmp-<pid>-*` file in `~/Library/Application Support/Open Cowork/`
or the equivalent user-data dir. That would indicate a crash
mid-write leaving a temp file orphaned — rare because the atomic-
write helper cleans up on failure, but recoverable by restoring
the orphan manually.

## Renderer shows "View Error" after a patch

The view error boundary catches renderer panics so the rest of the
app stays usable. The panic is forwarded to the main process and
logged with a `[renderer] Renderer error view=...` entry. Open
the diagnostics bundle (Settings → Export diagnostics) for the full
stack — it's safe to attach to a bug report because the sanitizer
scrubs tokens and file paths first.

"Back to home" resets the boundary; the underlying data is
unchanged.

## Windows support

Not currently implemented. The build matrix produces macOS (DMG /
zip) and Linux (AppImage / deb). Contributions welcome — tracking
in the roadmap.

## Logs, in short

- **Main process**: `~/Library/Application Support/Open Cowork/logs/`
  on macOS, `~/.config/Open Cowork/logs/` on Linux.
- **Renderer**: Open DevTools (View → Toggle Developer Tools).
- **Diagnostics bundle**: Settings → Export diagnostics saves a
  sanitized ZIP safe to share.
- **Session registry**: `session-registry.json` in the user-data
  dir. Corrupt? Delete it; the app rebuilds from the OpenCode
  runtime on next boot.
