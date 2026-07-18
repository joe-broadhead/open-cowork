# OpenWiki OpenCode Pack

This pack configures OpenCode as an OpenWiki maintainer and client.

It provides:

- Project rules for OpenWiki edits.
- Researcher, editor, reviewer, inbox, inbox-operator, meeting-curator, and
  monitor agent prompts.
- Skills for cited research, transcript inbox intake, meeting curation, inbox
  triage, and proposal-safe edits.
- MCP-first examples for local stdio and hosted HTTP agent access. Reference
  local tool stubs live under `tools/`, but the installer does not copy them by
  default because MCP is the supported OpenCode tool surface.
- Guardrail notes for keeping agent output inside the proposal workflow.
- Eval recorder plugin guidance for agent, MCP, and tool-call telemetry.
- Local stdio and hosted HTTP proposal-mode MCP examples in `examples/`.

## MCP Client Mode

Add an OpenWiki MCP server to the project OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "openwiki": {
      "type": "local",
      "enabled": true,
      "command": ["openwiki", "mcp", "--stdio", "--tools", "proposal"]
    }
  }
}
```

The installer binds that local MCP command only when it knows the wiki root:

```sh
openwiki integrate opencode --out-dir /path/to/project --wiki-root /path/to/wiki
```

Without `--wiki-root`, the pack installs agents, skills, examples, and rules but
leaves MCP unconfigured so the project does not accidentally point at the wrong
wiki.

Use `--tools read` for normal coding sessions and reserve `--tools write` for trusted maintainer jobs.

Use the inbox agent when local automations or remote users submit transcripts,
notes, or files into OpenWiki:

```sh
opencode run --agent openwiki-inbox "Use openwiki-personal MCP. Triage received transcript inbox items and propose wiki updates."
```

Use the meeting curator when the inbox item is a meeting transcript and you
want linked meeting, person, organization, project, topic, action-item, and
decision proposals:

```sh
opencode run --agent openwiki-meeting-curator "Use openwiki-personal MCP. Process pending meeting transcripts, search existing pages first, and propose wiki updates with source IDs."
```

For local personal wikis, start from `examples/opencode.local-proposal.json`.
For hosted team wikis, start from
`examples/opencode.hosted-http-proposal.json` and provide
`OPENWIKI_PROPOSAL_TOKEN` through the environment or your runtime secret
manager.

## OpenCode Gateway Dream Schedule

OpenWiki owns the dream-cycle phase registry, policy checks, run records,
events, and proposal creation. OpenCode Gateway should only schedule a narrow
agent profile that calls OpenWiki MCP or CLI.

Use `examples/opencode.gateway-dream.yaml` as the Gateway profile fragment. It
keeps the Gateway profile readonly, enables only the OpenWiki MCP, disables PR
creation and merging, and creates the schedule through Gateway's `/cron add`
command path instead of direct database writes.

The scheduled prompt should call `wiki.dream_run` in proposal MCP mode with
`create_proposals=false` by default, then report the run ID with
`wiki.dream_status`. Operators can run proposal-producing phases explicitly by
setting `wait=true` and `create_proposals=true`; OpenWiki will enforce proposal
scopes and per-page path policy before creating proposals.

Install agent prompt files into `.opencode/agents/` for a project or `~/.config/opencode/agents/` globally. Install skills into `.opencode/skills/` for a project or `~/.config/opencode/skills/` globally.

## Model Selection

The user-installed OpenWiki OpenCode pack does not pin a model. Set the model
in project/user OpenCode config or pass `--model` to `opencode run`:

```sh
opencode run --model openrouter/deepseek/deepseek-chat-v3-0324:free --agent openwiki-monitor "Use openwiki-personal MCP. Report Git status and open proposals."
```

Release evals keep their own reproducible model baseline outside the installed
agent files:

```sh
OPENWIKI_OPENCODE_MODEL="opencode-go/kimi-k2.6" \
  pnpm eval:opencode-tools -- --retries 1 --timeout-ms 240000
```

## Tool Coverage Evals

Run the official OpenWiki OpenCode tool coverage evals with the configured
eval model:

```sh
pnpm eval:opencode-tools -- --retries 1 --timeout-ms 240000
```

To compare another provider or free OpenRouter model without editing fixtures,
set `OPENWIKI_OPENCODE_MODEL`:

```sh
OPENWIKI_OPENCODE_MODEL="openrouter/deepseek/deepseek-chat-v3-0324:free" \
  pnpm eval:opencode-tools -- --retries 1 --timeout-ms 240000
```

The eval harness creates a temporary OpenWiki repo and local bare Git remote, disables inherited personal MCP config, exposes an isolated write-mode `openwiki-eval` MCP server, installs the generic recorder plugin from `opencode-tools`, and verifies completed calls across every `wiki.*` tool.
The JSON result distinguishes provider failures, model timeouts/refusals,
OpenCode process failures, and OpenWiki tool regressions so contributors can
separate model availability from product regressions.

For CI and ordinary PR validation, run the setup smoke without provider
credentials:

```sh
pnpm eval:opencode-tools -- --setup-only
```

Setup-only mode still creates the temporary wiki, seed proposals, isolated MCP
config, OpenCode agents, and skills, then writes
`evals/opencode-tool-coverage/latest.json`. The report records
`seed.recorder_plugin.skipped: true`,
`seed.recorder_plugin.skip_category: "setup_only"`, whether a recorder is
available locally, and every checked recorder candidate path.

## Generic Eval Recorder

The generic recorder lives in the private `opencode-tools` repo instead of this
OpenWiki integration pack. Install it into any repo with:

```sh
npx github:joe-broadhead/opencode-tools install plugin opencode_eval_recorder --target .
```

`pnpm eval:opencode-tools` discovers the recorder from
`OPENCODE_EVAL_RECORDER_PLUGIN`, `.opencode/plugins/opencode_eval_recorder.ts`,
a sibling `../opencode-tools` checkout, or an installed
`@joe-broadhead/opencode-tools` package. Full evals fail with a setup error when
an explicit `OPENCODE_EVAL_RECORDER_PLUGIN` points at a missing file; they do
not silently fall back to a different recorder. The recorder is inert unless
`OPENCODE_EVAL_TRACE` points at a JSONL output path. During eval runs it records
`opencode.eval.*` session, subtask, tool, and permission events for deterministic
scoring.
