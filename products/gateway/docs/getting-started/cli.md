# CLI Commands

The CLI is for local setup, service operations, diagnostics, and simple task inspection. Durable work creation from agents should usually use Gateway MCP tools.

## Commands

| Command | Purpose |
| --- | --- |
| `opencode-gateway setup [--yes]` | First-time config, Gateway state bootstrap, routing, and OpenCode asset installation. |
| `opencode-gateway quickstart [--title text] [--task text] [--timeout secs] [--no-start] [--open] [--json]` | Guided first run: preflight checks, a real starter initiative, an agent dispatch, and a visible result with a dashboard link. The recommended way to reach a first real outcome. |
| `opencode-gateway update [--wizard]` | Reconcile config, state, routing, and OpenCode assets after updating code while preserving local state. |
| `opencode-gateway onboard [--template kind] [--demo]` | Non-interactive first-run helper for OpenCode assets, environment templates, and optional demo state. |
| `opencode-gateway demo [--open]` | Create a local no-model-spend demo project with an artifact link. |
| `opencode-gateway project new <alias> --title <title> [--task text] [--directory <repo-path>]` | Create a supervised project roadmap, alias, quality defaults, and initial tasks. Pass `--directory` to bind a real local repo so agents do (and reviewers verify) actual file work there. |
| `opencode-gateway channel list` | List Telegram, WhatsApp, and Discord connector lifecycle states with safe next actions. |
| `opencode-gateway channel status [provider] [--json]` | Show redacted channel connector status, missing prerequisites, diagnostics, callback readiness, and evidence refs. |
| `opencode-gateway channel setup <provider>` | Guide a provider through Connect -> Verify -> Trust -> Bind without printing secrets or private target IDs. |
| `opencode-gateway channel verify <provider>` | Check local config completeness and webhook route readiness without sending provider messages. |
| `opencode-gateway channel trust <provider>` | Show trusted-target setup guidance and allowlist/claim-code policy for the provider. |
| `opencode-gateway channel claim <provider> [--ttl 10m] [--prove-denial]` | Generate a short-lived trusted-target claim code or one-shot denied-inbound probe code without printing the channel target ID. |
| `opencode-gateway channel repair <provider>` | Show redacted diagnostics and exact safe repair actions for a blocked or degraded connector. |
| `opencode-gateway env template <kind> [directory] [--stdout] [--force]` | Generate a `.gateway/env.yaml` template. |
| `opencode-gateway start` | Start the daemon (via the service manager when the service is installed, otherwise in the background). |
| `opencode-gateway stop` | Stop the daemon (via `launchctl`/`systemctl --user` when service-managed so it stays stopped; otherwise graceful shutdown). |
| `opencode-gateway restart` | Stop and start the daemon. |
| `opencode-gateway status` | Show daemon, component health, Gateway session, and queue counts. |
| `opencode-gateway operator status [--json]` | Show the redacted beta operator cockpit: scheduler safety, queue, attention, validated surfaces, and deferred gates. |
| `opencode-gateway operator hygiene [--json]` | Show the read-only live-state hygiene report (stale claim codes, expired gates, stale session links and receipts). |
| `opencode-gateway operator pause\|resume\|recover\|reset-stale` | Pause or resume new scheduler dispatch, recover expired leases/missing sessions through existing retry policy, or reset stale live state. |
| `opencode-gateway operator run <runId> <cancel\|stop\|retry\|restart> --lease-owner <owner>` | Apply one lease-safe control to an active Gateway/OpenCode run. Retry/restart requeue durable work and do not reuse the current OpenCode session. |
| `opencode-gateway readiness` | Show local operating readiness state and checks. |
| `opencode-gateway secrets status [--json]` | Inspect value-free secret lifecycle posture (inventory, rotation, injection scopes). |
| `opencode-gateway secrets injection-check --reference <secretref> --env <ENV_NAME> [--context ...] [--json]` | Check whether a scoped secret reference may inject into a named env var for a given context without printing values. |
| `opencode-gateway governance` | Show budget, cost, token, and runtime governance state. |
| `opencode-gateway analytics [--scorecard] [--by profile\|agent\|roadmap] [--window <days>] [--roadmap id] [--profile name] [--agent name] [--json]` | Read-only run-history analytics over a bounded window: spend/usage by profile, agent, or roadmap, outcome distribution, retry hotspots, and budget trend. `--scorecard` shows the completion + cost scorecard (completion rate, avg attempts, cost-per-completed-task) with derived underperformers. Note: cost-per-completed is an approximate per-group ratio (group spend ÷ completed tasks), not an exact per-task unit cost, since cost is attributed per run within a dimension while completed tasks are counted per task. |
| `opencode-gateway release claims [--json]` | Print the machine-checked claim registry report; exits non-zero when a claim invariant fails. |
| `opencode-gateway performance budgets [--json] [--fail-blocked]` | Report the local performance and responsiveness budget checks. |
| `opencode-gateway service lifecycle [--json]` | Print the service lifecycle plan: install/start/stop/uninstall and cleanup bounds for the platform service manager. |
| `opencode-gateway mcp [--tools read\|operate\|admin]` | Serve the `gateway_*` MCP tools over stdio for OpenCode and other MCP clients; the tool tier can also be set with `GATEWAY_MCP_TOOLS`. |
| `opencode-gateway evidence export [output-dir] [--task id] [--run id] [--session id] [--roadmap id] [--project id]` | Write a deterministic redacted evidence bundle for operator reports, beta handoff, or Linear/GitHub review. |
| `opencode-gateway evidence incident [output] [--alert id] [--task id] [--run id] [--json]` | Write a redacted incident bundle with manifest, trace correlation, SLO state, and alert summaries. |
| `opencode-gateway health [--json]` | Report daemon, dashboard, storage, scheduler, channel adapter, OpenCode, and config health with remediation hints. Exits `0` only when all components are healthy. |
| `opencode-gateway doctor` | Print local diagnostics for config, OpenCode, daemon, queue, and service install. |
| `opencode-gateway install` | Write the macOS LaunchAgent or Linux systemd user unit and print start/enable commands. |
| `opencode-gateway serve` | Run the daemon in the foreground for debugging. |
| `opencode-gateway logs [--lines 100]` | Show recent daemon log lines, falling back to the local service log when the daemon is down. |
| `opencode-gateway backup create [--label name]` | Create a timestamped Gateway state backup. |
| `opencode-gateway backup list` | List backups and verification status. |
| `opencode-gateway backup verify <path>` | Verify backup metadata, checksums, and SQLite integrity. |
| `opencode-gateway backup doctor [--json] [--backup path]` | Scan the redacted storage source inventory for schema drift, corrupt sidecars, channel checkpoint/outbox mismatch, and backup coverage gaps. |
| `opencode-gateway backup export [file]` | Export durable Gateway state as JSON for audit or machine transfer. |
| `opencode-gateway backup drill [--from path]` | Restore a backup into an isolated state directory and write scheduler/storage/channel recovery evidence. |
| `opencode-gateway backup rollback-drill --from path` | Record a rollback receipt after an isolated restore, storage doctor, and recovery drill pass. |
| `opencode-gateway backend status [--json]` | Show backend activation mode, runtime persistence, cutover/rollback readiness, and any blockers without host or secret values. |
| `opencode-gateway backend doctor\|consistency-scan [--json] [--backup path]` | Run the backend consistency scan through storage doctor and report activation status and issues. |
| `opencode-gateway backend consistency-proof [--json] [--backup path]` | Emit a value-free consistency proof covering runtime posture, scan, backup freshness, and rollback status. |
| `opencode-gateway backend durable-state-proof [--json] [--backup path]` | Prove durable-state ownership, scanner posture, and backup/restore lifecycle across all sources. |
| `opencode-gateway backend durable-state-integrity [--json] [--backup path]` | Report the durable-state source inventory, consistency scan, unsafe-restore refusal, and repair boundaries. |
| `opencode-gateway backend durable-state-adapter [--json] [--backup path]` | Report the local durable-state adapter contract, inspect posture, backup status, and repair capabilities. |
| `opencode-gateway backend durable-state-repair --operation <op> --idempotency-key <key> [--from path] [--maintenance]` | Run an explicit, idempotent durable-state repair (record blocker, create verified backup, or restore verified backup) with a durable receipt. |
| `opencode-gateway backend durable-state-round-trip [--json] [--backup path] [--label name] [--output-dir dir]` | Validate a backup round-trip and recovery drill into isolated state and write redacted evidence. |
| `opencode-gateway backend observability-plane [--fixture\|--no-fixture] [--store path] [--json]` | Report the local observability/support evidence plane, trace coverage, and SLO status. |
| `opencode-gateway backend rollback-dry-run --from path` | Restore an isolated backup and prove rollback/recovery without touching live state. |
| `opencode-gateway restore --from <path>` | Restore a verified backup; refuses while daemon is active unless `--maintenance` is passed. |
| `opencode-gateway task list` | List durable scheduler tasks. |
| `opencode-gateway task add <text>` | Create a simple high-priority task locally. |
| `opencode-gateway task done <text>` | Mark a matching local task done. |

## Common Examples

```bash
opencode-gateway doctor
opencode-gateway health
opencode-gateway operator status
opencode-gateway operator run run_123 cancel --lease-owner daemon-local
opencode-gateway governance
opencode-gateway channel list
opencode-gateway channel setup whatsapp
opencode-gateway channel verify whatsapp
opencode-gateway channel claim whatsapp
opencode-gateway channel repair whatsapp
opencode-gateway evidence export --project roadmap_123
opencode-gateway backup create --label before-upgrade
opencode-gateway backup drill --from ~/.config/opencode-gateway/backups/gateway-backup-YYYYMMDDTHHMMSSZ
opencode-gateway task list
opencode-gateway logs
```

## Service Files

| Platform | Service file | Runtime label |
| --- | --- | --- |
| macOS | `~/Library/LaunchAgents/com.opencode-gateway.daemon.plist` | `com.opencode-gateway.daemon` |
| Linux | `~/.config/systemd/user/opencode-gateway.service` | `opencode-gateway.service` |

The generated service file does not embed Telegram or WhatsApp tokens. Supply channel credentials through Gateway config or the shell environment used to start the daemon. `opencode-gateway health` reports missing credentials, allowlists, webhook signature settings, OpenCode connectivity, storage, and scheduler state with next actions.

Service commands require `~/.config/opencode-gateway/config.json`. If it is missing or invalid, run `opencode-gateway setup` to create an actionable local config before starting the daemon.
