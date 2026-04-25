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
    "helpUrl": "https://github.com/joe-broadhead/open-cowork",
    "projectNamespace": "opencowork"
  }
}
```

Typical downstream changes:
- app name
- app id
- help URL
- data directory name
- project namespace, if you intentionally want a different
  on-disk overlay directory than the upstream `.opencowork/`

> **Compatibility note:** the public GitHub repo is `open-cowork`, but
> the upstream `appId` and `projectNamespace` intentionally keep the
> historical `opencowork` form for bundle-ID and on-disk back-compat.
> Change those only when you are deliberately creating a distinct
> downstream distribution and are prepared to migrate app state.

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

The upstream default is no sign-in:

```json
{
  "auth": {
    "mode": "none"
  }
}
```

### Enabling Google OAuth (downstream)

Upstream ships with no OAuth credentials. A downstream distribution that
wants to gate access behind Google sign-in registers its **own** OAuth
client in Google Cloud Console and wires it through config — nothing in
the upstream repo is shared or reused. The consent screen the end user
sees shows the downstream's branding (e.g. "Acme Agent wants to access
your Google account"), not Open Cowork's.

**1. Register an OAuth client in Google Cloud Console**

- Create (or reuse) a GCP project for your distribution.
- Configure the OAuth consent screen with your branding, publisher info,
  and the scopes you want to request.
- Create an **OAuth 2.0 Client ID** of type **Desktop app**. Google
  provides a client ID and a "client secret". Desktop OAuth secrets
  are not truly confidential (they can't be, in a public binary), but
  they're still sensitive — treat them like a moderate secret.

**2. Wire the credentials into your downstream config**

Use env placeholders so the secret never lands in a committed config
file:

```jsonc
{
  "allowedEnvPlaceholders": [
    "ACME_GOOGLE_OAUTH_CLIENT_ID",
    "ACME_GOOGLE_OAUTH_CLIENT_SECRET"
  ],
  "auth": {
    "mode": "google-oauth",
    "googleOAuth": {
      "clientId":     "{env:ACME_GOOGLE_OAUTH_CLIENT_ID}",
      "clientSecret": "{env:ACME_GOOGLE_OAUTH_CLIENT_SECRET}",
      "scopes": [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email"
      ]
    }
  }
}
```

Ship the config in your downstream root, and set
`ACME_GOOGLE_OAUTH_CLIENT_ID` / `ACME_GOOGLE_OAUTH_CLIENT_SECRET`
through your MDM / packaging pipeline. Unset vars resolve to empty
strings (which will fail the login flow cleanly) — the app never
silently falls back to an upstream client.

**3. Default scopes**

If you don't set `googleOAuth.scopes`, the app requests:

```
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/cloud-platform
```

The third one is broad — it gives the app a GCP access token the
OpenCode runtime can write into an ADC file for Vertex AI / BigQuery
MCPs. If your downstream only needs identity verification (not GCP
API access), drop it:

```json
"scopes": [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email"
]
```

**4. Token storage**

After a successful login, refresh + access tokens are encrypted via
Electron's `safeStorage` and stored in the app's userData directory.
On platforms where `safeStorage` is unavailable, the app logs an
error and fails the save in production — it will not fall back to
plaintext. Dev/test contexts may still use plaintext for local
iteration.

**Open Cowork never commits OAuth credentials to the repo.** The
`googleOAuth.clientId` and `googleOAuth.clientSecret` fields are
downstream configuration, not upstream constants.

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

For upstream releases, the featured OpenRouter model ids in
`open-cowork.config.json` are checked during the release audit. If a
provider renames or retires a featured id between releases, the dynamic
catalog can still surface the live provider list, but `defaultModel`
should be updated before the next tagged release.

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

### Reusing the app's Google OAuth session for Google MCPs

When `auth.mode` is `google-oauth` and the user has signed in, the app
writes a standard `application_default_credentials.json` file in its
userData directory. Any MCP that sets `googleAuth: true` gets that
file wired into its subprocess via the `GOOGLE_APPLICATION_CREDENTIALS`
env var, so libraries like `googleapis` (Node), `google-auth` (Python),
or the gcloud CLI authenticate without a second prompt:

```jsonc
{
  "mcps": [
    {
      "name": "sheets",
      "type": "local",
      "description": "Google Sheets MCP",
      "authMode": "none",
      "packageName": "sheets",
      "googleAuth": true
    }
  ]
}
```

The same flag is available on user-added custom MCPs
(`CustomMcpConfig.googleAuth`). Key details:

- **Scopes must match.** The access token only has the scopes listed
  in `auth.googleOAuth.scopes`. A Sheets MCP needs
  `https://www.googleapis.com/auth/spreadsheets`; extend your scopes
  list to cover every API the downstream MCP set will hit.
- **No sign-in, no injection.** When `auth.mode` is `none` or no
  token has been written yet, `GOOGLE_APPLICATION_CREDENTIALS` is NOT
  set — the MCP spawns as usual and fails authenticated calls
  cleanly (rather than silently falling through to a different
  identity).
- **Trust boundary.** `googleAuth` is opt-in because any MCP that
  receives the env var can read the user's Google access token.
  Only enable it for MCPs your distribution trusts.

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
