# Troubleshooting

## Daemon Is Not Running

```bash
opencode-gateway health
opencode-gateway start
opencode-gateway doctor
```

Check logs:

```bash
opencode-gateway logs
```

macOS log file (rotated by the daemon at 10MB; older lines are in `opencode-gateway.log.1`-`.5`):

```text
~/Library/Logs/opencode-gateway.log
```

Linux service-managed logs are in journald (`journalctl --user -u opencode-gateway`); the legacy file `~/.local/share/opencode-gateway.log` only receives output from a non-service `opencode-gateway start`.

## OpenCode Is Unreachable

Confirm OpenCode is listening at the configured URL:

```bash
opencode web --port 4096 --hostname 127.0.0.1
```

Then check:

```bash
opencode-gateway doctor
```

Update `opencodeUrl` in `~/.config/opencode-gateway/config.json` if OpenCode is on a different port.

## MCP Tools Are Missing In OpenCode

1. Run `opencode-gateway setup`.
2. Confirm `opencodeConfigDir` points to the active OpenCode profile.
3. Restart OpenCode.
4. Check the active profile contains the `gateway` MCP entry.

## Agents Or Skills Are Missing

Run setup again and restart OpenCode:

```bash
opencode-gateway setup
```

Expected Gateway agents:

- `gateway-assistant`
- `gateway-planner`
- `gateway-coordinator`
- `gateway-implementer`
- `gateway-reviewer`
- `gateway-verifier`
- `gateway-supervisor`
- `gateway-auditor`

Expected Gateway skills:

- `gateway-assistant`
- `gateway-planner`
- `gateway-coordinator`
- `gateway-stage`
- `gateway-review-gate`
- `gateway-supervisor`

## Scheduler Is Not Dispatching

Inspect scheduler state:

```text
gateway_scheduler_status
gateway_task_list
gateway_run_list
```

Common causes:

- Scheduler is paused.
- This daemon is standby because another local Gateway owns the writer lease.
- `maxConcurrent` running tasks already exist.
- Task is `blocked`, `paused`, `cancelled`, `done`, or `archived`.
- Stage profile references a missing profile.
- OpenCode is unreachable.

If status reports standby, stop the duplicate writer or wait for the stale lease to expire, then restart Gateway or call `POST /gateway/leadership/recover`. Standby daemons intentionally do not dispatch scheduler work or start channel adapters.

## Channel Messages Do Not Reply

Check:

- Channel credentials are present.
- Gateway daemon is running.
- Gateway status reports this daemon as the writer, not standby.
- OpenCode is reachable.
- The chat/thread has a valid binding or can create one.
- Pending OpenCode question/permission requests are not blocking progress.

Use:

```text
gateway_channel_binding_list
gateway_question_list
gateway_permission_list
```

## Operator And Developer Triage Matrix

For support handoff, collect evidence in a safe read-only order and keep it redacted before it leaves the operator machine. Never share raw tokens, chat IDs, transcripts, webhook signatures, or machine-local paths.

Use safe read-only diagnostics first. If a row says to escalate, capture the redacted status output,
the issue ID, and the exact command that failed.

| Symptom | Likely cause | Safe diagnostic | Safe next action | Escalation path |
| --- | --- | --- | --- | --- |
| OpenCode Web link says a session is missing | OpenCode server restarted, session sidecar is stale, or the link points to an older OpenCode state directory. | `opencode-gateway operator status`, `gateway_opencode_session_list`, `gateway_task_list` | Open the task or run from Mission Control, then use the shown TUI command or `/open <task-id>` fallback. | File an issue with the redacted session ID and whether TUI fallback works. |
| Session appears stuck on a permission card | OpenCode is waiting for a native permission decision. | `gateway_permission_list`, Mission Control Needs Attention, OpenCode Web/TUI permissions panel | Approve or deny in OpenCode; if the command is unexpected, deny and add a task note. | Escalate if the same permission repeats after a decision or appears for the wrong task. |
| Telegram, WhatsApp, or Discord message does not reply | Missing trust/binding, standby daemon, provider send failure, or OpenCode unreachable. | `gateway_channel_binding_list`, `opencode-gateway readiness`, `opencode-gateway logs` | Re-run the provider setup or bind command, confirm this daemon is writer, then retry a harmless status command. | Attach redacted provider, binding, and readiness state; do not include raw chat targets. |
| Review gate blocks a worker | Missing acceptance evidence, stale base, uncommitted final diff, or a real P0/P1/P2 finding. | Read the review gate finding and `git status --short --branch` | Fix the finding, rerun focused validation, then rerun local-only review gate. | Escalate only when the gate cannot run or the fix requires changing issue scope. |
| Orphaned worktree or worker branch remains after merge | Worker cleanup did not run, thread was interrupted, or branch was held for evidence. | `git worktree list`, `git branch --list 'codex/*'` | Confirm the related Linear issue and PR are Done/merged before pruning through the coordinator workflow. | Escalate before deleting any worktree that has unpushed commits or unclear ownership. |
| Worker cleanup or runtime release failed | Local container, remote-capacity, or retained-resource cleanup reported degraded lifecycle state. | `opencode-gateway readiness` | Pause new dispatch if needed, inspect the redacted resource ID, then run the documented cleanup/recovery command for that backend. | Escalate if cleanup would remove unknown local files or the resource belongs to another active run. |
| Docs build fails | Broken link, missing nav entry, unsupported Markdown, or stale generated docs reference. | `uv run --with-requirements docs/requirements.txt mkdocs build --strict` | Fix the first reported page/link, then rerun strict build. | Escalate if the docs would need a release-claim decision change. |
| Exact `npm run verify` fails but focused tests pass | Slow concurrent timing threshold, local runtime contention, or an unrelated flaky integration path. | Rerun the failing file standalone, then rerun any touched focused tests. | Treat it as blocking if the failure touches the changed behavior; otherwise record the caveat and open/follow a reliability issue. | Escalate if the same full-suite failure repeats on a clean machine or CI. |

## Worker Handoff

When handing work to another agent, use the [Architecture Handoff Map](../development/architecture-handoff-map.md).
It names owner modules, forbidden edits, validation gates, redaction checks, review-gate requirements,
and the Linear update shape.
