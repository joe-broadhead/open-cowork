# Service Lifecycle

Gateway's service lifecycle path is designed for a single trusted local operator. It makes safe
operations easy to find and keeps destructive cleanup or uninstall actions explicit, manual, and
bounded.

Run the lifecycle plan:

```bash
opencode-gateway service lifecycle
opencode-gateway service lifecycle --json
```

The plan uses one result vocabulary:

| State | Meaning |
| --- | --- |
| `supported` | Gateway has a local operator command for the operation. |
| `read_only` | The command inspects local state, health, logs, or evidence without mutating state. |
| `dry_run_only` | Gateway lists what would be touched, but does not delete or mutate anything. |
| `manual_required` | The operation is intentionally left to the operator because it is destructive or service-manager owned. |
| `external_approval_required` | A future external approval is required before Gateway should automate the operation. |
| `unsupported` | Gateway does not implement or claim the operation. |

## Operator Path

| Need | Command | Notes |
| --- | --- | --- |
| Set up Gateway | `opencode-gateway setup --wizard` | Creates local config, routing, state, and OpenCode assets. |
| Update after pulling code | `opencode-gateway update --wizard` | Reconciles config and OpenCode assets. |
| Verified release update | Run the signed release `install.sh --version vX.Y.Z` | Builds in a sibling staging directory, switches the code tree by rename, requires managed-service and strict-readiness success, and restores the retained previous tree on failure. |
| Start Gateway | `opencode-gateway start` | Start the daemon, then run status/health. Service-aware: when the LaunchAgent/systemd unit is installed, `start` starts it via `launchctl`/`systemctl --user` so the daemon runs supervised (no detached duplicate). |
| Stop Gateway | `opencode-gateway stop` | Pause or drain active work before stopping. Service-aware: a service-managed daemon is stopped via `launchctl bootout`/`systemctl --user stop` so the service manager does not resurrect it. Otherwise graceful stop releases the writer leadership lease and removes the PID file; a stale PID file is never used to signal an unrelated process. |
| Restart Gateway | `opencode-gateway restart` | Use after config changes or dependency recovery. The restarted writer adopts still-live in-flight run leases from its predecessor, so completed agent work is harvested instead of re-run. |
| Understand current state | `opencode-gateway status` | Read daemon, sessions, queue, and service state. |
| Diagnose components | `opencode-gateway health --json` | Read health with remediation hints. |
| Full local diagnosis | `opencode-gateway doctor` | Keep output redacted before sharing. |
| Read logs | `opencode-gateway logs --lines 100` | Logs are bounded and redacted by Gateway. |
| Back up state | `opencode-gateway backup create` | Verify before restore or upgrade work. |
| Restore state | `opencode-gateway restore --from <verified-backup> --maintenance` | Manual and destructive; stop active daemon writers first. |
| Support handoff | `opencode-gateway evidence incident` | Inspect the redaction manifest before sharing. |

## Cleanup And Uninstall Boundary

Gateway does **not** claim one-command uninstall. The lifecycle plan records cleanup and uninstall
targets, but destructive deletion remains manual:

- Gateway-owned config and state roots are listed for dry-run review only.
- OpenCode assets may include non-Gateway user content and are never removed automatically.
- LaunchAgent/systemd files and service logs are service-manager owned and require operator review.
- Restore and uninstall should only happen after a verified backup and an intentional daemon stop.
- `~/opencode-gateway.previous` is a code/service rollback tree, not a durable-state backup; remove it only after the new release has operated successfully and an off-host encrypted state backup is verified.

This boundary is part of public local beta truth and does not prove release-candidate,
production-certified, hosted/team, universal-channel, arbitrary-scale, managed-support, or
unattended-operation readiness. See the canonical
[Release Claim Boundary](public-threat-model.md#release-claim-boundary).
