# Running Gateway

Gateway runs locally and expects OpenCode to be reachable at `opencodeUrl`.

The supported public release deployment is local-only. Self-hosted, hosted, and remote-worker operation are not release claims; those boundaries are enforced by the claim registry (`opencode-gateway release claims`, see the [Decision Log](../history/decision-log.md)).

## Start And Stop

```bash
opencode-gateway start
opencode-gateway status
opencode-gateway health
opencode-gateway stop
```

`start` and `stop` are service-aware. When the Gateway service is installed (`opencode-gateway install`), `start` starts it through the service manager (`launchctl bootstrap`/`kickstart` on macOS, `systemctl --user start` on Linux) so the daemon runs supervised, and `stop` stops it the same way (`launchctl bootout`, `systemctl --user stop`) so the service manager does not resurrect it; both print which path they used. Without an installed service, `start` runs a background process with a PID file and `stop` uses graceful HTTP shutdown with a guarded PID fallback.

Service definitions send `SIGTERM` and allow 30 seconds for graceful shutdown. A clean shutdown stays stopped; only failures restart, with crash-loop throttling. The verified `install.sh` path additionally treats service-manager or strict-readiness failure as an install failure and restores the previous code/service tree.

Foreground mode for debugging:

```bash
opencode-gateway serve
```

## Dashboard

Open:

```text
http://127.0.0.1:4097/dashboard
```

The dashboard shows:

- Usage window controls: today by default, a preset dropdown, and custom date inputs.
- OpenCode token/cost burn: cost, input/output/reasoning tokens, cache read/write, cache hit rate, model breakdowns, agent breakdowns, and top sessions.
- Service health: daemon, dashboard, storage, scheduler, channel adapters, OpenCode connectivity, and config validity with concise remediation hints.
- Heartbeat health: current status, live next-ping countdown, scheduler cycle duration, last heartbeat summary, skipped-overlap count, and the latest scheduler OpenCode session.
- Needs attention: blocked work and pending OpenCode requests.
- Active work: pending, running, paused, and blocked tasks.
- Roadmaps: active roadmap state.
- Gateway sessions: Gateway-created OpenCode session sidecar state.
- Completed recently: recent done tasks and runs.
- Scheduler profiles: active profile map.
- Recent events: Gateway-owned workflow and runtime events.

Gateway discovers the OpenCode SQLite database with the official `opencode db path` command when available. Mission Control reads message-level OpenCode usage aggregates from that database and does not query account or credential tables.

Heartbeat cycle duration is the time Gateway spent checking the durable queue and dispatching/completing scheduler transitions. It is expected to be very small when no task is ready. OpenCode agent work continues asynchronously in scheduler sessions. When the current heartbeat is idle, the heartbeat card falls back to the latest durable scheduler session so there is still a useful OpenCode link to inspect.

## Logs

macOS service and CLI logs (the daemon rotates this file itself: copy-truncate at 10MB, keeping `opencode-gateway.log.1` through `.5`, checked at boot and every 5 minutes):

```text
~/Library/Logs/opencode-gateway.log
```

Linux user-service logs go to journald, which rotates them natively; `opencode-gateway logs` reads journald first on Linux and falls back to the legacy file log at `~/.local/share/opencode-gateway.log` (used by `opencode-gateway start` without an installed service, and rotated by the daemon the same way):

```bash
journalctl --user -u opencode-gateway -f
```

The unit rate-limits log bursts, but journald retention is a host policy. Check it with `journalctl --disk-usage` and have the host administrator set bounded `SystemMaxUse`/`MaxRetentionSec` in `journald.conf` when defaults are too broad; that setting affects the host journal, not only Gateway. Compose separately caps Docker `local` logs at five 10 MiB files. Neither log store is a backup or immutable audit ledger.

MCP or CLI diagnostics:

```bash
opencode-gateway logs
opencode-gateway health --json
opencode-gateway doctor
```

`opencode-gateway logs` is safe to rerun: it reads daemon `/logs` when available and falls back to the platform service log when the daemon is down.

## Service Management

`opencode-gateway install` writes the service definition **and** loads/starts it through the service manager, so the commands below are only needed for manual intervention. Rerunning `install` regenerates the definition with stable paths (the installed CLI's own location plus the Gateway config dir as working directory) and heals definitions written by older versions. The restart policy is failure-only with throttling (launchd `KeepAlive.SuccessfulExit=false`, `ThrottleInterval`, and `ExitTimeOut`; systemd `Restart=on-failure`, start limit, `KillSignal=SIGTERM`, and `TimeoutStopSec=30`): a clean stop stays stopped, and a crash loop such as a port conflict (EADDRINUSE) cannot hot-loop. The systemd unit also uses `UMask=0077` and `NoNewPrivileges=true`.

macOS (prefer `opencode-gateway start|stop`, which run these for you):

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.opencode-gateway.daemon.plist
launchctl bootout gui/$(id -u)/com.opencode-gateway.daemon
```

Linux (prefer `opencode-gateway start|stop`):

```bash
systemctl --user enable --now opencode-gateway
systemctl --user stop opencode-gateway
systemctl --user status opencode-gateway
```

## Restart After Asset Changes

When Gateway OpenCode assets change:

1. Run `npm run build`.
2. Run `opencode-gateway setup` or use Gateway OpenCode asset MCP tools.
3. Restart Gateway if daemon code changed.
4. Restart OpenCode if MCP, agent, skill, or tool config changed.
