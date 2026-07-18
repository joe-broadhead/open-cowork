# Quick Start

This flow assumes OpenCode Web is already running on `127.0.0.1:4096`.

New operators should read the [Operator Mental Model](operator-mental-model.md) first. It explains what OpenCode owns, what Gateway owns, and how to read current capability states before running beta workflows.

## 1. Build And Link

```bash
npm install
npm run build
npm link
```

## 2. Configure Gateway

```bash
opencode-gateway setup
```

Use the defaults unless you need a different OpenCode URL, Gateway port, or model profile.

After pulling a newer Gateway checkout, use the idempotent update path:

```bash
npm install
npm run build
opencode-gateway update
```

For a guided non-interactive pass that installs OpenCode assets, can write a repository environment template, and can create a local no-model-spend demo, run:

```bash
opencode-gateway onboard --template node --demo
```

## 3. Start Gateway

```bash
opencode-gateway start
opencode-gateway status
```

Open the dashboard:

```text
http://127.0.0.1:4097/dashboard
```

`4097` is the default; use the port printed by `opencode-gateway status` if you changed it during setup.

## 4. Guided First Real Outcome (recommended)

The fastest way from install to a real result is the guided first-run. It runs
preflight checks, creates a real starter initiative, dispatches it to an agent,
watches the run to completion, and prints the result plus a dashboard link:

```bash
opencode-gateway quickstart
```

What it does, with narration at each step:

1. **Preflight** — Node version, `node:sqlite`, config-dir writability, config
   validity, a usable agent profile, and OpenCode reachability. Each failure
   prints the exact fix and stops **before** any work is created.
2. **Ensure the daemon** — starts it if it is not already running (pass
   `--no-start` to skip auto-start).
3. **Create a real initiative** — a starter roadmap and first task with sensible
   defaults (zero configuration required).
4. **Dispatch it** — triggers the scheduler so the task runs in an OpenCode
   session.
5. **Watch it** — polls the run to completion (`dispatched → running →
   completed`) with a sane timeout.
6. **Show the result** — run status, cost, a result snippet, and a dashboard
   drill-down link (`?view=run&id=…`), plus next steps (`triage`, `analytics`).

Useful flags:

```bash
opencode-gateway quickstart --title "Summarize this repo" --task "Produce a repo summary" --timeout 240 --open
opencode-gateway quickstart --json      # machine-readable result
```

If you prefer to stage state without spending model tokens first, run
`opencode-gateway demo`, then come back to `opencode-gateway quickstart` for the
first real dispatch.

## 5. Create Durable Work

Use the project wizard when you want a supervised roadmap, project alias, quality defaults, and initial tasks in one step:

```bash
opencode-gateway project new release-notes --title "Release notes" --task "Draft release notes" --task "Review and verify links"
```

If the daemon is running, Gateway creates the OpenCode project session for the supervisor. If the daemon is not reachable, pass `--session-id <existing-session-id>` to create the durable state directly.

For a one-command local demo that does not start OpenCode or spend model tokens:

```bash
opencode-gateway demo --open
```

From OpenCode, use the Gateway MCP tools through `gateway-assistant` or directly:

```text
Create a high-priority Gateway task titled "Write release notes" and run it through implement, review, verify.
```

Equivalent MCP tool intent:

```json
{
  "title": "Write release notes",
  "priority": "HIGH",
  "pipeline": ["implement", "review", "verify"]
}
```

## 6. Inspect Progress

```bash
opencode-gateway status
opencode-gateway task list
```

Or use MCP tools:

```text
Show the Gateway dashboard.
List active Gateway tasks.
Show pending OpenCode questions and permissions.
```

## 7. Optional Channels

Add Telegram or WhatsApp credentials when you want chat ingress. Channel messages bind to OpenCode sessions and default to `gateway-assistant`.

See [Channels](../configuration/channels.md).
