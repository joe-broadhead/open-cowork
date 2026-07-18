# Operator Onboarding

This guide takes a local beta operator from a fresh checkout to a running Gateway workspace, a passing healthcheck, and a first supervised run.

Use it as the day-zero runbook. Feedback triage lives in [Operator Feedback Loop](operator-feedback-loop.md).

## Operator Goal

By the end of this guide, you should have:

- A local Gateway workspace built from the current repository.
- OpenCode connected through the Gateway MCP, agents, and skills.
- The Gateway daemon installed or started locally.
- `opencode-gateway health` and `opencode-gateway doctor` evidence.
- A verified backup or recovery drill.
- A passing `npm run verify` gate result.
- A first supervised Issue visible across OpenCode and Mission Control.
- Any setup friction captured through the [Operator Feedback Loop](operator-feedback-loop.md) with category, severity, evidence, desired outcome, and triage decision.

Gateway Method language is used throughout: an Initiative is the long-running goal, a Project scopes a visible outcome, an Issue is executable work, a Run is one stage attempt, a Channel is a user-facing surface, and a Session is owned by OpenCode. Existing command names still use compatibility aliases such as `task`, `roadmap`, and `run`; see [Gateway Method](../concepts/gateway-method.md).

## Prerequisites

Start from a trusted local machine. The local beta supports macOS and Linux user-service installs.

| Requirement | Expected evidence |
| --- | --- |
| Node.js `>=22.13 <23 || >=23.4` and npm | `node --version` and `npm --version` |
| Git | `git --version` |
| OpenCode `>= 1.17` | `opencode --version` |
| Local OpenCode Web/TUI server | `opencode web --port 4096 --hostname 127.0.0.1` or equivalent |
| Gateway source checkout | `git rev-parse --short HEAD` |
| Optional trusted channel | Telegram or WhatsApp credentials and allowlist, redacted in evidence |
| Optional issue tracker | Somewhere durable (for example Linear or GitHub issues) to record setup friction and follow-ups |

Keep secrets out of shell history, docs, Git commits, and issue trackers. Use redacted values such as `<redacted-telegram-token>` in evidence. Gateway diagnostics redact known channel secrets, but operators are still responsible for reviewing transcripts before sharing them.

## Fresh Checkout Install

Clone, build, and link Gateway from source:

```bash
git clone https://github.com/joe-broadhead/open-cowork.git
cd open-cowork
corepack enable
pnpm install --frozen-lockfile
pnpm --filter cowork-gateway build
pnpm --filter cowork-gateway exec npm link
```

Run the setup wizard:

```bash
cowork-gateway setup
```

The wizard configures the local Gateway workspace, dashboard/service port, OpenCode URL, model profiles, optional channel settings, Gateway state, routing, and OpenCode assets. It writes local config under the Gateway config directory and installs Gateway MCP, agents, and skills into the selected OpenCode profile.

For a non-interactive default pass on a disposable local profile:

```bash
cowork-gateway setup --yes
```

Restart OpenCode after setup if it was already running. OpenCode reads MCP, agent, and skill configuration at startup.

Expected evidence:

- Build command passed.
- Setup reported config/state/assets as created or current.
- No raw provider tokens appear in setup output.
- OpenCode profile now contains the `gateway` MCP entry.

For the canonical install details, see [Installation](../getting-started/installation.md) and [OpenCode Setup](../getting-started/opencode-setup.md).

## Update An Existing Workspace

Before changing a workspace, capture a backup:

```bash
opencode-gateway backup create --label before-update
opencode-gateway backup list
```

Update from the repository root:

```bash
git pull --ff-only
npm install
npm run build
opencode-gateway update
opencode-gateway restart
```

Use the wizard when the update changes local configuration or OpenCode profile targets:

```bash
opencode-gateway update --wizard
```

Expected evidence:

- The pre-update backup path.
- The commit after update.
- `opencode-gateway update` summary with secrets redacted.
- `opencode-gateway restart` result and fresh health output.

## Service Lifecycle

Install the user service when this machine will run Gateway beyond a foreground test:

```bash
opencode-gateway install
opencode-gateway start
opencode-gateway status
```

Use foreground mode for first-run debugging or when channel credentials only exist in the current shell:

```bash
opencode-gateway serve
```

Stop or restart the daemon:

```bash
opencode-gateway stop
opencode-gateway restart
```

Read logs:

```bash
opencode-gateway logs
```

Platform service labels:

| Platform | Service |
| --- | --- |
| macOS | LaunchAgent `com.opencode-gateway.daemon` |
| Linux | systemd user unit `opencode-gateway.service` |

Generated service files must not embed Telegram, WhatsApp, Discord, or provider tokens. See [Running Gateway](running.md) for service commands and log locations.

## Healthcheck Gate

Run the local health and diagnostic gate before first real use:

```bash
opencode-gateway health
opencode-gateway doctor
opencode-gateway readiness
```

Passing evidence should show:

- Daemon, dashboard, storage, scheduler, OpenCode connectivity, channel adapter, and config checks are `ok`, or any degraded check has a concrete next action.
- OpenCode URL points at the active local server.
- Gateway MCP assets are installed in the active OpenCode profile.
- Channel providers with credentials have a concrete connector state and next action; trusted provider targets are established by claim code or an explicit allowlist.
- Diagnostics redact token-like values.

`opencode-gateway health` exits non-zero when any component is unhealthy. Treat that as a stop sign for first-run use unless the degraded component is intentionally outside the scenario and is recorded with the run evidence.

## Backup And Restore Drill

Create and verify a backup:

```bash
opencode-gateway backup create --label onboarding-start
opencode-gateway backup list
opencode-gateway backup verify ~/.config/opencode-gateway/backups/gateway-backup-YYYYMMDDTHHMMSSZ
```

Run the recovery drill for stronger evidence:

```bash
opencode-gateway backup drill --from ~/.config/opencode-gateway/backups/gateway-backup-YYYYMMDDTHHMMSSZ
```

Expected evidence:

- Backup path and verification status.
- Recovery drill `evidence.json` or `report.md` path.
- Confirmation that backup metadata contains only Gateway state files and a config hash, not `config.json` or channel secrets.
- Any restore limitation filed as a follow-up before proceeding.

For restore procedures and maintenance-mode behavior, see [Backup And Restore](backup-restore.md).

## Local Gates

Run the standard gate before relying on a fresh workspace:

```bash
npm run verify
```

This runs typecheck, tests, build, and the release contract check. It covers runtime compatibility, release metadata, and local behavior, but it does not prove live Telegram, WhatsApp, or Discord credentials.

Record live-channel checks separately; local gates do not prove a real trusted channel handoff. See [Testing And Release](../development/testing-release.md).

## First Supervised Run

The fastest no-model-spend proof of the full loop is the built-in demo:

```bash
opencode-gateway demo --open
```

Then run the first live workflow:

1. Start OpenCode TUI or Web against the same local OpenCode profile.
2. Ask `gateway-assistant` to create a small Issue with acceptance criteria, definition of done, and evidence requirements — or create a supervised project directly:

```bash
opencode-gateway project new demo-project --title "Onboarding demo" --task "Prove the first supervised run"
```

3. Inspect state:

```bash
opencode-gateway status
opencode-gateway readiness
opencode-gateway task list
```

4. Open Mission Control:

```text
http://127.0.0.1:4097/dashboard
```

Use the port shown by `opencode-gateway status` if your setup changed the default Gateway port.

5. Capture the Issue ID, Run ID, Session ID, readiness state, and dashboard evidence.

If Telegram is the selected channel, use the shared connector flow before relying on channel handoff:

```bash
opencode-gateway channel setup telegram
opencode-gateway channel verify telegram
opencode-gateway channel claim telegram
```

The command evidence must include the provider, redacted target label, channel binding ID, parent OpenCode Session ID, delegated Issue/Run IDs, progress and final receipts, and proof that untrusted targets did not receive sensitive state. See [Channels](../configuration/channels.md) and [Security](security.md).

If WhatsApp is the selected channel, use the shared connector flow:

```bash
opencode-gateway channel setup whatsapp
opencode-gateway channel verify whatsapp
opencode-gateway channel claim whatsapp
```

For a live local run, use the Cloud API direct path and record only redacted evidence that the access token, phone number ID, verify token, app secret, callback exposure, messages subscription, trusted sender claim, and binding are satisfied. If the run depends on Embedded Signup or a provider-managed install, record it as scaffolded unless the Meta app, business prerequisites, backend token exchange, provider asset capture, webhook subscription, trust handoff, and redacted install evidence have all been implemented and verified.

## Reporting Failures

Stop the run when a workflow fails. Create or update a durable follow-up rather than lowering the bar.

Use this failure shape:

```text
Workflow: setup / observability / channel handoff / delegated work / progress policy / review evidence / restart recovery
Expected:
Observed:
Impact: blocks onboarding / blocks daily use / follow-up only
Evidence:
- commit:
- command:
- log or artifact path:
- Issue/Run/Session/Channel IDs:
Secrets review: redacted / no channel transcript included / not applicable
Next action:
```

Add a short summary with the run evidence paths, skipped live-channel checks, and follow-up IDs. Do not paste raw channel bodies, tokens, private message content, or machine-local paths that another operator cannot interpret.

## Troubleshooting

Use this table before escalating. Each row includes the evidence to collect for a follow-up.

| Symptom | Next actions | Evidence |
| --- | --- | --- |
| `npm install` or `npm run build` fails | Confirm Node `>= 22.13`; rerun from a clean checkout; attach the first failing TypeScript or npm error. | `node --version`, `npm --version`, failing command, first error block. |
| `opencode-gateway setup` cannot find OpenCode | Start OpenCode locally; confirm the configured `opencodeUrl`; rerun setup after selecting the active OpenCode profile. | `opencode --version`, OpenCode URL, setup summary, `opencode-gateway doctor`. |
| MCP tools, agents, or skills are missing in OpenCode | Run `opencode-gateway setup`; verify `opencodeConfigDir`; restart OpenCode. | Active profile path, MCP entry presence, setup output, OpenCode restart note. |
| Service commands say config is missing | Run `opencode-gateway setup`; check the config directory used by the current shell and service. | `opencode-gateway doctor`, config path, service log excerpt. |
| Daemon starts but health is degraded | Run `opencode-gateway health --json`, `opencode-gateway doctor`, and `opencode-gateway logs`; fix the named component before continuing. | Health JSON, doctor summary, last 100 log lines. |
| Dashboard does not load | Confirm daemon port and local binding; check `/gateway/health`; restart Gateway. | Dashboard URL, health output, browser or curl error, logs. |
| Channel status is `credentials_needed` | Run `opencode-gateway channel setup <provider>` and add only the named env/config keys. Restart Gateway when credentials come from the service environment. | Redacted `channel status <provider> --json`, missing key names, restart note. |
| Channel status is `webhook_needed` or `verification_pending` | Expose only the documented webhook route, run `opencode-gateway channel verify <provider>`, and fix callback URL, verify token, signature, or public route mode. | Redacted verify output, route path, route exposure mode, challenge/signature readiness. |
| Readiness fails on channel trust or status is `trusted_target_pending` | Run `opencode-gateway channel claim <provider>` and send the code from the intended target, or add an explicit allowlist when claim is unavailable. Do not use unsafe allow-all outside isolated local testing. | Redacted claim/audit event or allowlist shape, readiness check, provider target label. |
| Channel binding points at the wrong session or project | Inspect Mission Control or `gateway_channel_binding_list`; rebind only with an explicit channel command or MCP update. | Binding ID, provider, redacted target label, intended Session/Issue/Initiative ID. |
| Telegram/WhatsApp messages do not reply | Confirm credentials, trusted target, daemon status, channel binding, and pending OpenCode questions or permissions. | Provider name, redacted chat/thread label, `gateway_channel_binding_list` or dashboard excerpt, logs. |
| Scheduler does not dispatch an Issue | Check task status, dependencies, gates, scheduler pause state, `maxConcurrent`, profile references, and OpenCode connectivity. | `opencode-gateway status`, task/run excerpts, readiness, relevant workflow events. |
| Backup verify or drill fails | Do not proceed with an update; preserve the failed drill evidence and file a follow-up. | Backup path, verify output, drill `evidence.json`, restore refusal message. |
| `npm run verify` fails | Fix the named failing gate (typecheck, tests, build, or release contract) before handoff. | `npm run verify` output, failing step, commit SHA. |

More focused troubleshooting lives in [Troubleshooting](troubleshooting.md), [Running Gateway](running.md), [Backup And Restore](backup-restore.md), and [Observability And Incidents](observability-incidents.md).

## Day-Zero Completion Check

The onboarding run is complete when:

- Health, doctor, readiness, backup, and `npm run verify` evidence are captured.
- A first supervised Issue has live evidence from OpenCode TUI/Web and Gateway state.
- Mission Control can explain what is running, what needs attention, and why.
- Any skipped live-channel check is called out with a reason and follow-up.
- All failed workflows have durable follow-ups with redacted evidence.
- Run evidence links to artifacts without exposing secrets or private channel content.
