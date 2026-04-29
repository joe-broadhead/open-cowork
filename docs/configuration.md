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
- optional sidebar and Home copy surfaces for downstream distributions

> **Compatibility note:** the public GitHub repo is `open-cowork`, but
> the upstream `appId` and `projectNamespace` intentionally keep the
> historical `opencowork` form for bundle-ID and on-disk back-compat.
> Change those only when you are deliberately creating a distinct
> downstream distribution and are prepared to migrate app state.

### Sidebar and Home surfaces

Downstream builds can tune the first-run product surface without patching React
components. These fields are optional; unset fields preserve upstream Open
Cowork copy and layout.

```jsonc
{
  "branding": {
    "name": "Acme Cowork",
    "sidebar": {
      "top": {
        "variant": "logo-text",
        "logoAsset": "branding/acme-logo.svg",
        "mediaSize": 36,
        "mediaFit": "vertical",
        "mediaAlign": "center",
        "title": "Acme AI",
        "subtitle": "Private workspace",
        "ariaLabel": "Acme AI workspace"
      },
      "lower": {
        "text": "Acme internal build",
        "secondaryText": "Support from Data Platform.",
        "linkLabel": "Get help",
        "linkUrl": "https://internal.acme.example/cowork-help"
      }
    },
    "home": {
      "greeting": "What should {{brand}} work on today?",
      "subtitle": "Ask a question or delegate to an approved agent.",
      "composerPlaceholder": "Ask {{brand}} anything",
      "suggestionLabel": "Start with",
      "statusReadyLabel": "Online"
    }
  }
}
```

`branding.sidebar.top.variant` accepts `icon`, `text`, `icon-text`, `logo`, or
`logo-text`. Logo-backed variants should use `logoAsset`, a relative path to an
image bundled under the package `branding/` resource directory, such as
`branding/acme-logo.svg`. The app rejects absolute paths, traversal, remote
URLs, missing files, and non-image extensions before exposing the asset to the
renderer. Legacy `logoDataUrl` values are still accepted as a compatibility
fallback, but new downstream builds should ship image assets instead of base64
config blobs.

`branding.sidebar.top.mediaSize` controls the logo/icon media size in pixels
and defaults to `28`. Values must be between `16` and `96`. `mediaFit` accepts
`vertical` or `horizontal`: use `vertical` for square or tall marks whose height
should define the sidebar presence, and `horizontal` for wide wordmarks whose
width should be fixed. `mediaAlign` accepts `start`, `center`, or `end` and
controls icon/logo placement for icon-only or logo-only branding.

`branding.sidebar.lower.linkUrl` accepts only `https://` and `mailto:` links.
The renderer re-checks that allowlist before rendering a link.

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

Upstream Open Cowork keeps `openrouter` as the default provider and also ships
a direct `openai` descriptor. Direct OpenCode-native providers can use an
optional API key typed into Open Cowork, or provider auth methods such as
ChatGPT Plus/Pro when the bundled OpenCode runtime exposes them. Open Cowork
does not reimplement those auth flows; it opens the authorization URL returned
by OpenCode and lets OpenCode persist the credential inside the managed runtime
home.

For direct built-in providers, the model picker is runtime-backed: once the
OpenCode runtime is running, Open Cowork overlays `client.provider.list()`
models onto the static descriptor. That keeps OpenAI/Codex and downstream
OpenCode-native provider model menus current without hardcoding every upstream
model id in this repo.

Downstream builds can reuse the same path for any OpenCode-native provider. Add
the provider id to `providers.available`, add a descriptor with `"runtime":
"builtin"`, and leave `models: []` if OpenCode should own the live model
catalog. If OpenCode exposes provider auth for that id through
`client.provider.auth()`, Open Cowork will show the returned OAuth methods and
call OpenCode's `provider.oauth.authorize` / `provider.oauth.callback` APIs
directly; the app does not implement provider-specific login logic.

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
`open-cowork.config.json` are checked during the release audit. If a provider
renames or retires a featured id between releases, the dynamic catalog can still
surface the live provider list when configured, but `defaultModel` and the
featured list should be updated before the next tagged release.

Any provider with a public "list models" endpoint can be wired up the
same way — OpenRouter is just an example. Downstream distributions can
keep `models[]` only (strict static behavior) or add a `dynamicCatalog`
for discovery, without touching code.

### Model Price And Context Overrides

Open Cowork reads model pricing and context windows from OpenCode's native
provider catalog (`provider.list`) whenever the runtime exposes them. Use
config only for deliberate downstream overrides or for custom providers whose
catalog cannot report model metadata.

```json
{
  "providers": {
    "modelInfo": {
      "github-copilot/claude-sonnet-4": {
        "limit": { "context": 200000 },
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3,
          "cache_write": 3.75
        }
      }
    }
  }
}
```

The same `limit` and `cost` blocks are also accepted on entries in
`providers.descriptors[provider].models[]` and
`providers.custom[provider].models`. Values use OpenCode's units: USD per
1M tokens for `cost.*`, and tokens for `limit.context`. A configured model id
may be either `model` or `provider/model`; Open Cowork stores both aliases so
downstream bundles do not need renderer-specific glue.

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

The bundled `skills` MCP receives `OPEN_COWORK_CUSTOM_SKILLS_DIR` from
the app when it is spawned. That value must be an absolute app-managed
directory, not a filesystem root, the user's home directory, or a
downstream-controlled override.

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

### Custom MCP approval mode

User-added custom MCPs default to `permissionMode: "ask"`: agents can be
assigned the MCP, but OpenCode still asks before each tool call. For MCPs
you control or trust, the Capabilities UI can mark the MCP as trusted.
That persists `permissionMode: "allow"` in Open Cowork's
`mcp.open-cowork.json` sidecar metadata and generates OpenCode-native
allow patterns for agents that include the MCP.

Leave the default for third-party or newly-tested MCPs. `permissionMode`
does not bypass agent-specific denied method patterns, so maintainers can
still block destructive methods even on a trusted MCP.

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
    "web": "allow",
    "webSearch": true
  }
}
```

- `web` controls OpenCode's native `webfetch` and `codesearch`
  permissions.
- `webSearch` controls OpenCode's native `websearch` permission and
  enables OpenCode's Exa-backed native search integration for
  non-OpenCode providers by setting `OPENCODE_ENABLE_EXA=1` in the
  managed runtime. OpenCode does not require an Exa API key for this,
  but search queries are sent to Exa's hosted service.

## Localization and telemetry

Downstream builds can ship a partial localization overlay:

```json
{
  "i18n": {
    "locale": "de-DE",
    "strings": {
      "home.greeting": "Woran soll {{brand}} heute arbeiten?"
    }
  }
}
```

Unset strings fall back to the built-in English copy. `locale` controls
`Intl.NumberFormat` and `Intl.DateTimeFormat` output.

Upstream Open Cowork keeps telemetry local on disk. Downstream builds
that need a remote collector can enable:

```json
{
  "allowedEnvPlaceholders": ["ACME_TELEMETRY_TOKEN"],
  "telemetry": {
    "enabled": true,
    "endpoint": "https://events.acme.example/ingest",
    "headers": {
      "Authorization": "Bearer {env:ACME_TELEMETRY_TOKEN}"
    }
  }
}
```

Telemetry payloads are sanitized for secrets and home-directory paths
before local write or remote forwarding. Remote forwarding is best-effort
and uses a 2-second timeout.

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
