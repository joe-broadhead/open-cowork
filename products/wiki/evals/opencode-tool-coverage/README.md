# OpenCode Tool Coverage Evals

This directory contains the harness output location for OpenWiki OpenCode MCP tool coverage evals.

Run from the repo root:

```sh
pnpm eval:opencode-tools -- --retries 1 --timeout-ms 240000
```

The harness creates a temporary OpenWiki repo, a local bare Git remote, an isolated write-mode `openwiki-eval` MCP server, and a project-local copy of the generic `opencode_eval_recorder.ts` plugin from `opencode-tools`. It verifies completed calls across every `wiki.*` MCP tool using the OpenCode agents pinned to `opencode-go/kimi-k2.6`.

Full eval runs require the recorder plugin. The harness discovers it from
`OPENCODE_EVAL_RECORDER_PLUGIN`, `.opencode/plugins/opencode_eval_recorder.ts`,
a sibling `../opencode-tools` checkout, or an installed
`@joe-broadhead/opencode-tools` package. `--setup-only` does not require the
private/local plugin checkout.

The pinned model is the reproducible baseline, not a hard requirement for local
experiments. Override it with `OPENWIKI_OPENCODE_MODEL` when you want to run the
same scenarios against another OpenCode or OpenRouter model:

```sh
OPENWIKI_OPENCODE_MODEL="openrouter/deepseek/deepseek-chat-v3-0324:free" \
  pnpm eval:opencode-tools -- --retries 1 --timeout-ms 240000
```

`latest.json` and the printed summary separate provider failures, model
timeouts, model refusals, OpenCode process failures, and OpenWiki tool
regressions. Treat provider, timeout, and refusal categories as eval
environment noise until they reproduce on the pinned baseline; treat missing
tools, failed tool calls, or failed workflow checks as OpenWiki regressions.

The run also performs deterministic runtime checks for production surfaces that are not MCP tools:

- `/livez`, `/readyz`, and `/metrics` through the HTTP router.
- `openwiki backup create` and `openwiki backup restore`.
- Restored-wiki search/index-store rebuild behavior.

If a new `wiki.*` MCP tool is added, the harness fails until that tool is assigned to a scenario.

`latest.json` is generated locally and ignored by Git because it contains provider traces and temporary filesystem paths.
