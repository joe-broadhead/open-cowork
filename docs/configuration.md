# Configuration

Open Cowork is configured through `open-cowork.config.json`.

The file is validated against `open-cowork.config.schema.json` at runtime.

## Top-level sections

The default upstream config is organized into:
- `allowedEnvPlaceholders`
- `branding`
- `auth`
- `providers`
- `tools`
- `skills`
- `mcps`
- `agents`
- `permissions`

## Branding

`branding` controls app-level identity:

```json
{
  "branding": {
    "name": "Open Cowork",
    "appId": "com.opencowork.desktop",
    "dataDirName": "open-cowork",
    "helpUrl": "https://github.com/joe-broadhead/opencowork"
  }
}
```

Typical downstream changes:
- app name
- app id
- help URL
- data directory name

## Environment placeholders

Config strings may reference environment variables using `{env:NAME}`.

For safety, placeholders only work when the variable name is explicitly listed in
`allowedEnvPlaceholders`:

```json
{
  "allowedEnvPlaceholders": ["OPENROUTER_BASE_URL"],
  "providers": {
    "custom": {
      "internal-router": {
        "options": {
          "baseURL": "{env:OPENROUTER_BASE_URL}"
        }
      }
    }
  }
}
```

Unknown placeholders fail config loading with a clear error. This is intentional:
Open Cowork does not implicitly pull arbitrary secrets from the host environment.

## Auth

`auth.mode` controls whether the app uses an external authentication flow.

The upstream default is:

```json
{
  "auth": {
    "mode": "none"
  }
}
```

## Providers

`providers` defines:
- available provider ids
- provider descriptors shown in the UI
- default provider and model
- optional custom provider wiring

This is where downstream distributions usually customize:
- model menus
- default provider/model
- provider descriptions
- provider-specific options

### Dynamic model catalogs

Any provider descriptor may declare a `dynamicCatalog` block to pull its
model list from an HTTP endpoint at runtime. The hardcoded `models[]`
entries stay pinned at the top of the picker as **Featured** models; the
dynamic list is overlaid beneath them, deduplicated by id.

```json
{
  "providers": {
    "descriptors": {
      "openrouter": {
        "name": "OpenRouter",
        "credentials": [ ... ],
        "models": [
          { "id": "anthropic/claude-sonnet-4", "name": "Claude Sonnet 4" }
        ],
        "dynamicCatalog": {
          "url": "https://openrouter.ai/api/v1/models",
          "responsePath": "data",
          "idField": "id",
          "nameField": "name",
          "descriptionField": "description",
          "contextLengthField": "context_length",
          "cacheTtlMinutes": 60
        }
      }
    }
  }
}
```

- `url` — JSON endpoint to fetch.
- `responsePath` — dotted path to the model array in the response body
  (`"data"` for OpenRouter, omit if the body itself is an array).
- `idField` / `nameField` / `descriptionField` / `contextLengthField` —
  field names on each model record. Defaults: `id`, `name`,
  `description`, `context_length`.
- `authHeader` — optional `Authorization` header value (use config
  placeholders if you need to reference a secret via `{env:NAME}`).
- `cacheTtlMinutes` — refresh window for the disk cache. Defaults to 60.

Fetches are best-effort: network failures fall back to the last cached
catalog, and cache misses fall back to the hardcoded `models[]` alone, so
the app never blocks on an unreachable endpoint. A manual *Refresh*
button on the Models tab lets users force a refetch.

Any provider with a public "list models" endpoint can be wired up the
same way — OpenRouter is just an example. Downstream distributions can
keep `models[]` only (strict static behavior) or add a `dynamicCatalog`
for discovery, without touching code.

## Tools

`tools` defines the curated tool catalog shown in the app.

Each entry can describe:
- id
- name
- icon
- description
- runtime namespace/patterns
- allow/ask patterns

## Skills

`skills` defines bundled, app-visible skills.

Each skill entry can map to:
- a source skill directory
- linked tool ids
- description and badge text

## MCPs

`mcps` defines bundled MCP servers shipped by the app.

The upstream core ships:
- `charts`
- `skills`

User-added MCPs are stored separately from the shipped config.

## Agents

`agents` defines built-in product agents.

Each agent can specify:
- `label`, `description`, `instructions`
- linked skills (`skillNames`) and tool ids (`toolIds`)
- allow/ask tool patterns (`allowTools`, `askTools`)
- UI `color`, `hidden`, `mode` (`primary` or `subagent`)
- **inference overrides**: `model`, `variant`, `temperature`, `top_p`, `steps`, `options`

Inference overrides map directly to the SDK's `AgentConfig` fields. Any
unset field inherits session defaults. Use these to route an agent to a
different model, tune temperature per agent, or cap runaway tool loops
with `steps`.

```json
{
  "agents": [
    {
      "name": "market-research",
      "description": "Research analyst focused on market sizing.",
      "instructions": "Use web search…",
      "model": "openrouter/anthropic/claude-sonnet-4",
      "temperature": 0.3,
      "steps": 20
    }
  ]
}
```

### Overriding built-in agents

The four Cowork built-ins (`build`, `plan`, `general`, `explore`) can be
tuned or silenced via `builtInAgents`:

```json
{
  "builtInAgents": {
    "explore": {
      "model": "openrouter/anthropic/claude-haiku-4-5",
      "temperature": 0.2,
      "steps": 30
    },
    "general": {
      "disable": true
    }
  }
}
```

`disable: true` removes the agent from the runtime entirely — it will
no longer appear in the UI or accept delegations. Any inference field
can be set independently; unset fields keep Cowork's defaults.

## Compaction

`compaction` controls how OpenCode handles long conversations. When the
context window is close to full, OpenCode runs a summarizer agent that
rewrites older turns into a shorter form so the session can continue.

```json
{
  "compaction": {
    "auto": true,
    "prune": true,
    "reserved": 10000,
    "agent": {
      "model": "openrouter/anthropic/claude-sonnet-4",
      "prompt": "You are a session summarizer. Keep technical details…",
      "temperature": 0.2
    }
  }
}
```

- `auto` — fire compaction automatically when the context fills. Set
  `false` to disable and rely on the manual *Summarize now* action in the
  context panel.
- `prune` — drop stale tool outputs during compaction so the summary stays
  focused on conversational turns.
- `reserved` — token budget kept free so compaction can still run near the
  context limit. Raise this for models with very large context windows.
- `agent` — optional overrides for the compaction agent itself. Use this
  to point summarization at a cheaper model, or to provide a custom
  system prompt. Maps to SDK `Config.agent.compaction`.

Users can also trigger compaction manually from the *Context* tab in the
app — useful when you want to preempt an imminent auto-compaction or
trim a long exploratory session.

## Permissions

`permissions` defines app-level default runtime policy:

```json
{
  "permissions": {
    "bash": "deny",
    "fileWrite": "deny",
    "task": "allow",
    "web": "allow"
  }
}
```

## Downstream customization model

If you are preparing a custom internal build, the normal path is:

1. copy and edit `open-cowork.config.json`
2. ship your own branding
3. add bundled MCPs or skills
4. adjust provider and agent definitions

The goal is to keep product customization in config and content, not buried in code.

See [Downstream Customization](downstream.md) for the full reference —
merge order, environment variables, skill/MCP overlay resolution, and a
worked example of a branded internal distribution.
