---
title: Skills & MCPs
description: How Open Cowork uses OpenCode skill bundles and Model Context Protocol servers, plus how to author your own.
---

# Skills & MCPs

Skills and MCPs are the two primary ways to extend what an agent can do
inside Open Cowork. Both are config-driven, both are downstream-overridable,
and both flow through OpenCode-native loading paths — Open Cowork does not
introduce a parallel execution mechanism.

<p class="subtitle">Skills teach a workflow. MCPs add tools. Together they compose
nearly every non-trivial capability in the desktop app.</p>

## At a glance

| Concept | What it does | Where it lives |
|---|---|---|
| **Skill bundle** | A `SKILL.md` (+ optional supporting files) that teaches an agent a workflow. | `skills/<name>/` |
| **MCP server** | A subprocess (stdio) or HTTP service exposing tools the model can call. | `mcps/<name>/` (bundled), or anywhere on the user's machine / network |
| **Capability** | The internal aggregation of tools + skills + agents — the permission surface. | Tools & Skills page |

## What ships in the box

Five bundled MCPs and six bundled skills, used as worked examples below.
When an agent calls a bundled MCP tool through OpenCode, the runtime tool id
uses `mcp__<server>__<tool>` form, for example
`mcp__charts__bar_chart`. Source MCP code and tests may still refer to the
short tool name such as `bar_chart`.

<div class="grid cards" markdown>

-   :material-chart-line: **`charts` MCP** <span class="status-badge stable">stable</span>

    ---

    Renders Vega-Lite charts and Mermaid diagrams entirely inside the main
    process. 18+ chart tools; runtime ids include
    `mcp__charts__bar_chart`, `mcp__charts__line_chart`,
    `mcp__charts__sankey`, `mcp__charts__mermaid`, and
    `mcp__charts__custom_spec`. Source: `mcps/charts/src/index.ts`.

-   :material-clock-outline: **`clock` MCP** <span class="status-badge stable">stable</span>

    ---

    Resolves current time, timezone conversions, date ranges, durations,
    and calendar math without network or filesystem access. Runtime ids
    include `mcp__clock__current_time`, `mcp__clock__convert_time`,
    `mcp__clock__date_math`, `mcp__clock__date_range`, and
    `mcp__clock__duration_between`. Source: `mcps/clock/src/index.ts`.

-   :material-package-variant: **`skills` MCP** <span class="status-badge stable">stable</span>

    ---

    Lets agents enumerate, read, write, and delete skill bundles from chat.
    Runtime ids include `mcp__skills__list_skill_bundles`,
    `mcp__skills__get_skill_bundle`, `mcp__skills__save_skill_bundle`,
    and `mcp__skills__delete_skill_bundle`.
    Source: `mcps/skills/src/index.ts`.

-   :material-account-cog: **`agents` MCP** <span class="status-badge stable">stable</span>

    ---

    Lets approved agents preview, read, save, and delete custom OpenCode
    agents through the same validation path as the desktop UI. Runtime ids
    include `mcp__agents__list_agents`, `mcp__agents__get_agent`,
    `mcp__agents__preview_agent`, `mcp__agents__save_agent`, and
    `mcp__agents__delete_agent`. Source: `mcps/agents/src/index.ts`.

-   :material-calendar-sync: **`workflows` MCP** <span class="status-badge stable">stable</span>

    ---

    Lets a Workflow Designer setup thread preview and save repeatable Open Cowork
    workflows with manual, scheduled, or webhook triggers. Runtime ids:
    `mcp__workflows__preview_workflow` and
    `mcp__workflows__create_workflow`. Source:
    `mcps/workflows/src/index.ts`.

-   :material-school: **`chart-creator` skill** <span class="status-badge stable">stable</span>

    ---

    Teaches the model to pick the right `charts` MCP tool for a given
    question and prepare chart-ready data. Source:
    `skills/chart-creator/SKILL.md`.

-   :material-clock-check-outline: **`clock` skill** <span class="status-badge stable">stable</span>

    ---

    Teaches agents to call the `clock` MCP before answering with current
    dates, relative ranges, timezone conversions, durations, or calendar
    math. Source: `skills/clock/SKILL.md`.

-   :material-flask: **`autoresearch` skill** <span class="status-badge stable">stable</span>

    ---

    Runs Karpathy-style improvement loops: baseline, mutate one thing,
    verify, keep or discard, log results, and chart progress. It can use
    the `skills` MCP to read and update custom skills after approval and
    the `agents` MCP to preview and apply approved custom-agent improvements.
    Source: `skills/autoresearch/SKILL.md`. The bundled `autoresearch`
    agent loads this skill automatically and adds the Charts, Skills, and
    Agents tools needed for measured improvement runs.

-   :material-school-outline: **`skill-creator` skill** <span class="status-badge stable">stable</span>

    ---

    Walks the model through authoring a clean new skill bundle, including
    when to add `references/`, `examples/`, or `templates/` files. Source:
    `skills/skill-creator/SKILL.md`.

-   :material-account-edit: **`agent-creator` skill** <span class="status-badge stable">stable</span>

    ---

    Walks the model through authoring a focused custom agent with clear
    routing, skills, tools, permissions, preview, and save confirmation.
    Source: `skills/agent-creator/SKILL.md`.

-   :material-clipboard-check-outline: **`workflow-creator` skill** <span class="status-badge stable">stable</span>

    ---

    Teaches the Workflow Designer agent how to clarify repeatable work,
    choose manual/scheduled/webhook triggers, preview the draft, and save it
    only after explicit user confirmation. Source:
    `skills/workflow-creator/SKILL.md`.

</div>

---

## Skills

A skill bundle is a folder. It must contain a `SKILL.md` with frontmatter
and may contain supporting files. OpenCode loads it; Open Cowork only
decides which bundles are available.

Custom skill bundles are code-adjacent trust decisions: they change agent
behavior and can request tool access through frontmatter. Open Cowork validates
bundle shape, caps supporting files, warns before importing a directory, and
writes a SHA-256 digest to the audit log for every user-saved bundle, but v0.x
does not require detached signatures. Only import skills from sources you trust.

### Anatomy

```text
skills/my-skill/
├── SKILL.md                  # required entry point
├── references/usage.md       # optional — longer notes, retrieval-friendly
├── examples/case-study.md    # optional — worked examples
└── templates/output.md       # optional — output scaffolds
```

`SKILL.md` frontmatter (the bundled `chart-creator` skill is a good
template):

```markdown
---
name: my-skill
description: One-line description that helps the model decide when to invoke this skill.
---

# My Skill

Use this skill when …

## Purpose
…

## Workflow
1. …

## Guardrails
- …
```

### How skills are resolved

Skill folders are looked up in this order, first match wins:

1. `$OPEN_COWORK_DOWNSTREAM_ROOT/skills/<name>/`
2. `<repo>/skills/<name>/` (during `pnpm dev`)
3. Resources bundled inside the packaged app

A skill folder that nobody references in the active config is ignored —
listing skills under `skills` in `open-cowork.config.json` is what actually
turns them on. See [Downstream Customization](downstream.md#skills-overlay).

### Authoring tips (from the bundled `skill-creator`)

- One job per skill. Resist building a catch-all.
- Always answer "when should this skill fire?" in the description.
- Add `references/` only when the workflow really benefits from external
  retrieval — they cost context.
- If the skill depends on a particular MCP or tool, name it explicitly in
  the workflow section so the model can route correctly.
- For optimization loops, use `autoresearch`: define a fixed metric,
  mutate one thing per iteration, and keep only measured improvements.

The `skill-creator` skill itself can be invoked from chat to scaffold a
new bundle: `@build use skill-creator to author a "weekly-status-report"
skill`.

---

## MCPs

An MCP is an out-of-process server that exposes tools through the Model
Context Protocol. OpenCode spawns each MCP as its own subprocess (for
stdio MCPs) or holds an HTTP client (for HTTP MCPs).

### How MCPs are resolved

Bundled MCPs are looked up at:

1. `$OPEN_COWORK_DOWNSTREAM_ROOT/mcps/<name>/dist/index.js`
2. Resources bundled inside the packaged app (`mcps/agents`, `mcps/charts`, `mcps/clock`, `mcps/skills`, `mcps/workflows`)

User-added MCPs live under `mcps.user.*` in `settings.enc` and are added
through Tools & Skills. They are validated by:

- `mcp-url-policy.ts` — for HTTP MCPs (rejects loopback, link-local, and
  private network ranges by default; `allowPrivateNetwork: true` is a
  flagged opt-in).
- `mcp-stdio-policy.ts` — for stdio MCPs (rejects shell metacharacters,
  `..` segments, and redirection operators in the command).

Custom MCPs default to approval prompts when an agent uses their tools.
For MCPs you control or otherwise trust, Tools & Skills can mark
the MCP as **Trusted, auto-approve**. That stores
`permissionMode: "allow"` in the Open Cowork sidecar metadata, which
generates OpenCode-native allow permissions for agents that have been
assigned the MCP. Agent-specific denied method patterns still override
that trust setting.

See [Security Model](security-model.md#mcp-sandbox-boundaries) for the
full policy.

### Authoring an MCP

The bundled MCPs use [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
and esbuild. The minimum shape is:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "my-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo a string back to the caller.",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: String(req.params.arguments?.value ?? "") }],
}));

await server.connect(new StdioServerTransport());
```

Bundle it (esbuild → single file) and reference it from config:

```jsonc
{
  "mcps": [
    {
      "name": "my-mcp",
      "type": "local",
      "description": "Echo values back to the caller.",
      "authMode": "none",
      "command": ["node", "/etc/acme-cowork/mcps/my-mcp/dist/index.js"]
    }
  ]
}
```

For HTTP MCPs, prefer pinned hostnames you control. Loopback and private
network ranges are blocked unless you explicitly opt in with
`allowPrivateNetwork: true`. See [Custom MCPs](custom-mcps.md) for the
app walkthrough, trust model, and approval-mode guidance.

### Recommendations

- Pin runtime versions. `npx my-mcp` resolves to whatever `latest` happens
  to be at the time of save; `npx my-mcp@1.2.3` is reproducible. The
  Settings UI surfaces this trade-off when you save.
- Surface clear input schemas. Tools without descriptions or input
  schemas are harder for the model to use correctly.
- Treat tool errors as data. Return structured `isError: true` content
  rather than throwing — it lets the agent recover or ask the user.

## When to choose which

| If you need to … | Reach for … |
|---|---|
| Teach the model a workflow it should follow | A **skill** |
| Give the model a new function to call | An **MCP tool** |
| Bundle templates, references, or examples that travel with the workflow | A **skill** with supporting files |
| Wrap an internal API (CRM, ticketing, dashboards) | An **MCP** |
| Both — a workflow that uses a custom tool you also need to ship | One MCP + one skill, with the skill instructing the model how to use the MCP's tools |

The bundled `agent-creator` + `agents` MCP pair lets an approved setup thread
create custom agents through the same validation path as the UI. The bundled
`chart-creator` + `charts` MCP pair is the canonical "skill
that teaches the model how to use a paired MCP" pattern. The `clock` skill +
`clock` MCP pair uses the same pattern for calendar reasoning. The
`workflow-creator` + `workflows` MCP pair applies it to workflow setup: the
skill teaches the conversational checklist, while the MCP previews and saves
the confirmed workflow. The `autoresearch` skill extends the pattern by
composing `charts`, `skills`, and `agents`: charts show experiment progress,
while the Skills and Agents MCPs can apply approved custom improvements.

## Read next

- [Custom MCPs](custom-mcps.md) — app workflow and trust model for user-added MCPs.
- [Agent Authoring](agent-authoring.md) — UI and chat-based flows for custom agents.
- [Configuration](configuration.md) — full config reference for `skills` and `mcps`.
- [Downstream Customization](downstream.md) — overlay model for shipping bundles in a fork.
- [Security Model](security-model.md#mcp-sandbox-boundaries) — what the MCP policies actually do.
