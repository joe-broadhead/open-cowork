# OpenCode SDK Surface Inventory

Source of truth for which OpenCode server/SDK APIs Gateway uses today and which
later claw-roadmap phases (#212) should adopt. Built against
`@opencode-ai/sdk@1.17.16` on mainline development.

This document is **codebase leverage only**. It does not expand product claims
beyond local beta / one trusted operator.

## Gateway session port (Phase 2)

Use `src/opencode-session-runtime.ts` for create/prompt/abort/list/get/admit.
Do not add new scattered `client.session.*` call sites. The process-wide client
holder remains `src/gateway-runtime.ts`.

## Package entrypoints

| Import | Role |
| --- | --- |
| `@opencode-ai/sdk` | Classic client used by Gateway today (`createOpencodeClient`, `OpencodeClient`) |
| `@opencode-ai/sdk/v2` | Richer generated client (`createOpencodeClient`, `Session.promptAsync`, `Session.switchAgent`, experimental workspace APIs) |
| `@opencode-ai/sdk/v2/server` | Optional: start embedded OpenCode server from process (not used by Gateway) |

Client construction (classic, used by daemon):

```ts
import { createOpencodeClient } from '@opencode-ai/sdk'
const client = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' })
```

v2 client (Phase 2 target):

```ts
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
const client = createOpencodeClient({
  baseUrl: 'http://127.0.0.1:4096',
  directory: optionalProjectDir,
  experimental_workspaceID: optionalWorkspaceId,
})
```

## Gateway usage today (classic client)

| Method | Modules (primary) | Purpose |
| --- | --- | --- |
| `createOpencodeClient` | `daemon.ts` | One process-wide client from `config.opencodeUrl` |
| `session.create` | `scheduler.ts`, `channel-commands.ts`, `daemon-routes/work.ts`, `daemon.ts` | Stage runs, channel sessions, project supervisors |
| `session.prompt` | `scheduler.ts`, `daemon.ts`, `delegation-progress.ts`, `team-progress.ts` | Dispatch stage/supervisor/progress injects |
| `session.get` | `scheduler.ts`, `channel-commands.ts`, `daemon-routes/opencode.ts`, `observability.ts`, … | Existence, attribution, recovery |
| `session.list` | `scheduler.ts`, `live.ts`, routes, readiness, hygiene | Inventory / recovery scans |
| `session.messages` | `scheduler.ts`, `channel-sync.ts`, `observability.ts` | Completion detection and outbound sync |
| `session.abort` | `scheduler.ts`, channels, work routes | Cancel unused or controlled runs |
| `session.children` | `daemon-routes/opencode.ts` (optional) | Child session inspection |

### Escape hatch fields on `session.prompt` body

Generated classic types omit some fields the OpenCode server accepts. Gateway
passes them via a deliberate cast in `scheduler.ts`:

| Field | Purpose |
| --- | --- |
| `agent` | OpenCode agent name for the turn |
| `model` | String model id (profile model) |
| `skills` | Skill name list for the stage profile |
| `permission` | Effective permission object after review-gate isolation |

When moving to SDK v2, re-validate these fields against `/doc` OpenAPI before
removing the cast.

### Client holder

`src/gateway-runtime.ts` holds the process-wide `OpencodeClient` (`setDaemonClient` /
`getDaemonClient`). It is **not** a session lifecycle port. Phase 2 session port
must be a **new** module (e.g. `opencode-session-runtime.ts`).

## OpenCode native config surface Gateway governs

| Asset | Owner module | On disk |
| --- | --- | --- |
| Agents | `opencode-assets.ts` `upsertOpenCodeAgent` | `opencode.json(c)` → `agent.<name>` (default `mode: subagent`) |
| Skills | `upsertOpenCodeSkill` | `skills/<name>/SKILL.md` |
| MCP servers | `upsertOpenCodeMcp` | `opencode.json(c)` → `mcp.<name>` |
| Custom tools | `upsertOpenCodeTool` | `tools/` |

Gateway ships default agents via `opencode-defaults.ts` (`gateway-assistant`,
stage agents, etc.). Personas for claw-style assistants should set
`mode: 'primary'` (or `all`) explicitly.

MCP tools: `opencode_agent_list|upsert|delete`, skill/tool/MCP siblings in
`src/mcp.ts` (upsert/delete are admin-tier).

## Available on OpenCode server but unused / partial in Gateway

Prefer these for claw roadmap phases after wrapping behind a session port:

| Capability | SDK / HTTP | Recommended phase |
| --- | --- | --- |
| `session.promptAsync` / `POST .../prompt_async` | v2 `Session.promptAsync` | Phase 2 (non-blocking dispatch) |
| Switch session agent mid-stream | v2 `switchAgent` | Phase 2 + AgentPresence persona change |
| Background subagents | v2 `session.background` | Phase 2 optional; use for in-session fan-out, not durable work |
| Agent list from live server | `GET /agent` / app.agents | Inventory / Persona UX |
| Structured prompt format (`json_schema`) | SDK docs `format` | Optional stage evidence parsing later |
| `opencode serve` password / CORS / hostname | Server docs + env `OPENCODE_SERVER_PASSWORD` | Phase 3 remote peer auth |
| Experimental workspaces | v2 experimentally named APIs | Phase 4 spike only |
| Event SSE (`/event`, `client.event.subscribe`) | Partial live bridge today | Keep; expand carefully |

## OpenCode server (operator)

```bash
opencode serve --port 4096 --hostname 127.0.0.1
# remote lab (Phase 3, behind Gateway peer allowlist + auth):
OPENCODE_SERVER_PASSWORD=... opencode serve --hostname 0.0.0.0 --cors https://app.example
```

OpenAPI: `http://<host>:<port>/doc`.

Gateway's default fetch host allowlist is **local-only**
(`src/opencode-url-policy.ts`). Non-local peers require Phase 3 allowlist
expansion.

## Compatibility notes

- npm package version and system `opencode` binary version can differ. Prefer
  probing `GET /global/health` when available and record operator min version
  when we've verified a pairing.
- Node engines for Gateway: `>=22.13 <23 || >=23.4`.
- Upgrade gate: `npm install @opencode-ai/sdk@latest`, `npm run typecheck`,
  `npm test`, `npm run verify`.

## Phase recommendations (claw roadmap #212)

| Phase | SDK guidance |
| --- | --- |
| 0 (this inventory + pin latest) | Classic client stays; document surface |
| 1 AgentPresence | Continue classic `session.create` + `prompt`; primary agents via assets |
| 2 Session runtime port | Introduce port; migrate callers; prefer v2 + `promptAsync` |
| 3 Trusted remote peers | Port gains peer credentials/baseUrl; keep SSRF default closed |
| 4 Workspaces | Spike against inventory experimental APIs; ADR first |

## Maintenance

When upgrading `@opencode-ai/sdk`:

1. Bump dependency and lockfile.
2. Re-run typecheck and `opencode-client-conformance` tests.
3. Diff `node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts` for new Session
   methods; update this table.
4. Note version in `CHANGELOG.md` Unreleased.
