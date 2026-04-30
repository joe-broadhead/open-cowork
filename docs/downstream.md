# Downstream Customization

Open Cowork is designed to be repackaged as an internal build without forking
the code. Branding, providers, agents, skills, MCPs, and bundled prompts are
all expressed in files the app reads at runtime, and a small set of environment
variables lets a downstream distribution point the app at its own copy of those
files.

This page is the reference for that model.

## Mental model

Everything downstream-customizable goes through two layers:

1. **Configuration** — a JSON file validated against
   `open-cowork.config.schema.json`. The app merges the bundled config with up
   to three additional layers in a fixed order.
2. **Content** — skill bundles (`skills/<name>/SKILL.md`) and MCP packages
   (`mcps/<name>/dist/index.js`) that the config can reference. The app
   resolves these from a stack of roots, with the downstream root winning over
   the bundled one.

A downstream distribution typically ships a directory with this layout:

```text
acme-cowork/
├── config.json           # or open-cowork.config.json
├── skills/
│   ├── acme-reports/
│   │   └── SKILL.md
│   └── acme-tickets/
│       └── SKILL.md
└── mcps/
    └── acme-crm/
        └── dist/
            └── index.js
```

Then launches the app with `OPEN_COWORK_DOWNSTREAM_ROOT=/etc/acme-cowork`.

## Config merge order

```mermaid
flowchart LR
    D["DEFAULT_CONFIG<br/>compiled-in"]
    B["bundled<br/>open-cowork.config.json"]
    P["OPEN_COWORK_CONFIG_PATH<br/>single file override"]
    R["OPEN_COWORK_DOWNSTREAM_ROOT<br/>or CONFIG_DIR"]
    U["per-user<br/>~/.config/&lt;dataDirName&gt;/config.json"]
    S["managed system<br/>/etc/&lt;dataDirName&gt;/config.json"]
    Active["Active config<br/>(deep-merged)"]

    D --> B --> P --> R --> U --> S --> Active

    style D fill:#e0e7ff,stroke:#6366f1
    style B fill:#e0e7ff,stroke:#6366f1
    style P fill:#fef3c7,stroke:#f59e0b
    style R fill:#fef3c7,stroke:#f59e0b
    style U fill:#dcfce7,stroke:#10b981
    style S fill:#dcfce7,stroke:#10b981
    style Active fill:#fae8ff,stroke:#a855f7,stroke-width:2px
```

Layers later in the chain override earlier ones via deep merge — so a
downstream layer only carries the keys it wants to change. Indigo layers
are baked in; amber layers come from environment variables; green layers
are user/admin overlays.

When the app starts, `apps/desktop/src/main/config-loader.ts` builds the active
config by merging these sources in order (later entries override earlier ones):

1. `DEFAULT_CONFIG` compiled into the app.
2. The bundled `open-cowork.config.json` shipped inside the package.
3. `OPEN_COWORK_CONFIG_PATH` — a single JSON file, if set and it exists.
4. `OPEN_COWORK_CONFIG_DIR` or `OPEN_COWORK_DOWNSTREAM_ROOT` — a directory
   containing `config.json` or `open-cowork.config.json`, if set and it exists.
5. `~/.config/<dataDirName>/config.json` — per-user config.
6. `/Library/Application Support/<dataDirName>/config.json` (macOS),
   `C:\ProgramData\<dataDirName>\config.json` (Windows), or
   `/etc/<dataDirName>/config.json` (Linux) — managed system config.

`deepMerge` runs at each step, so downstream layers only have to carry the
keys they want to change. `<dataDirName>` comes from `branding.dataDirName` in
the active config.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `OPEN_COWORK_DOWNSTREAM_ROOT` | Root directory for a downstream distribution. Supplies config, skills, and MCPs. | unset |
| `OPEN_COWORK_CONFIG_PATH` | Absolute path to a single override config file. Takes priority over `CONFIG_DIR` / `DOWNSTREAM_ROOT` config discovery. | unset |
| `OPEN_COWORK_CONFIG_DIR` | Directory containing `config.json` or `open-cowork.config.json`. Merged after the single-file override. | unset |
| `OPEN_COWORK_SANDBOX_DIR` | Root directory where sandbox threads create workspaces. | `~/Open Cowork Sandbox` |
| `OPEN_COWORK_CHART_TIMEOUT_MS` | Main-process chart render timeout. Clamped to `[250, 10000]` ms. | `1500` |

`OPEN_COWORK_CUSTOM_SKILLS_DIR` is set by the app itself when spawning the
bundled `skills` MCP and is not intended for downstream use. The skills
MCP rejects relative paths, filesystem roots, and the user's home
directory; keep custom skill storage inside the app-managed runtime home.

## Skills overlay

Skill bundles are resolved from these roots, in order (first match wins):

1. `$OPEN_COWORK_DOWNSTREAM_ROOT/skills/<name>/`
2. `<cwd>/skills/<name>/` — the repo's own `skills/` directory during
   development.
3. `<app>/Contents/Resources/skills/<name>/` — skills shipped with the
   packaged app.

This means a downstream distribution can either **replace** a bundled skill
(by shipping a directory with the same name) or **add** new skills that the
downstream config references.

Skills only become visible to the runtime when they are listed under `skills`
in the active config — a skill directory that nobody references is ignored.

See `apps/desktop/src/main/runtime-content.ts` and
`apps/desktop/src/main/effective-skills.ts` for the resolution code.

## MCPs overlay

MCP packages are resolved from:

1. `$OPEN_COWORK_DOWNSTREAM_ROOT/mcps/<name>/dist/index.js`
2. `<resourcesPath>/mcps/<name>/dist/index.js` — MCPs shipped with the packaged
   app (`mcps/charts`, `mcps/skills`).

As with skills, the MCP must be declared in the active config (`mcps` section)
before the runtime spawns it.

See `apps/desktop/src/main/runtime-mcp.ts`.

## Environment placeholders in config

Config strings may reference environment variables using `{env:NAME}`.

For safety, placeholders only resolve when the variable name is explicitly
listed in `allowedEnvPlaceholders`:

```json
{
  "allowedEnvPlaceholders": ["ACME_LLM_GATEWAY_URL"],
  "providers": {
    "custom": {
      "acme-gateway": {
        "options": {
          "baseURL": "{env:ACME_LLM_GATEWAY_URL}"
        }
      }
    }
  }
}
```

Unknown placeholders fail config loading with a clear error. This is
deliberate: Open Cowork does not implicitly pull arbitrary secrets from the
host environment, so downstream configs have to opt each variable in.

Provider credentials the user enters in the app's UI take a separate path
(through `settings.json` and `provider.options.<runtimeKey>` in the built
OpenCode config) and do not need to be listed in `allowedEnvPlaceholders`.

## Worked example

A downstream distribution that brands the app "Acme Cowork", ships one custom
provider, one internal MCP, and one internal skill would look like:

```text
/etc/acme-cowork/
├── config.json
├── skills/
│   └── acme-tickets/
│       └── SKILL.md
└── mcps/
    └── acme-crm/
        └── dist/
            └── index.js
```

`config.json`:

```jsonc
{
  "allowedEnvPlaceholders": ["ACME_GATEWAY_URL", "ACME_GATEWAY_KEY"],
  "branding": {
    "name": "Acme Cowork",
    "appId": "com.acme.cowork",
    "dataDirName": "acme-cowork",
    "helpUrl": "https://internal.acme.example/cowork",
    "sidebar": {
      "top": {
        "variant": "logo-text",
        "logoAsset": "branding/acme-logo.svg",
        "mediaSize": 36,
        "mediaFit": "vertical",
        "mediaAlign": "center",
        "title": "Acme AI",
        "subtitle": "Private workspace"
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
  },
  "providers": {
    "available": ["acme-gateway"],
    "descriptors": {
      "acme-gateway": {
        "runtime": "custom",
        "name": "Acme Gateway",
        "description": "Internal LLM gateway.",
        "credentials": []
      }
    },
    "custom": {
      "acme-gateway": {
        "name": "Acme Gateway",
        "options": {
          "baseURL": "{env:ACME_GATEWAY_URL}",
          "apiKey": "{env:ACME_GATEWAY_KEY}"
        },
        "models": [
          { "id": "acme-large", "name": "Acme Large" }
        ]
      }
    },
    "defaultProvider": "acme-gateway",
    "defaultModel": "acme-large"
  }
  // ...tools, skills, mcps, agents, permissions as needed
}
```

Launch the packaged app with:

```bash
OPEN_COWORK_DOWNSTREAM_ROOT=/etc/acme-cowork \
  ACME_GATEWAY_URL=https://llm.internal.acme.example \
  ACME_GATEWAY_KEY="$(cat /run/secrets/acme-gateway-key)" \
  ./Acme\ Cowork
```

## Rebranding the packaged app

The build reads three env vars to set the product identity without
forking `electron-builder.yml`:

| Variable              | Default                  | What it controls              |
|-----------------------|--------------------------|-------------------------------|
| `APP_PRODUCT_NAME`    | `Open Cowork`            | macOS menu bar + Dock name      |
| `APP_ID`              | `com.opencowork.desktop` | Bundle identifier / reverse-DNS |
| `APP_ARTIFACT_PREFIX` | `Open-Cowork`            | macOS / Linux artifact filenames |

Example downstream build:

```bash
APP_PRODUCT_NAME="Acme Cowork" \
  APP_ID="com.acme.cowork" \
  APP_ARTIFACT_PREFIX="Acme-Cowork" \
  pnpm --dir apps/desktop dist:ci:mac
```

The in-app brand name (window title, first-run copy, log prefixes) is
driven separately by `branding.name` inside `open-cowork.config.json`
or the downstream config overlay — see the Configuration section
above.

Downstream builds can also configure sidebar and Home copy under
`branding.sidebar` and `branding.home`. Those fields only affect UI surfaces:
they do not change OpenCode runtime providers, agents, permissions, MCPs, or
skills. For logo-backed sidebar variants, place image files under the repo-level
`branding/` directory and reference them with `branding.sidebar.top.logoAsset`,
for example `branding/acme-logo.svg`. The app rejects absolute paths, traversal,
remote URLs, and unsupported extensions.

Sidebar top branding can also tune the rendered media with
`branding.sidebar.top.mediaSize` (`16`-`96` pixels, default `28`),
`mediaFit` (`vertical` or `horizontal`; unset keeps the legacy square bounding
box), and `mediaAlign` (`start`, `center`, or `end` for icon-only or logo-only
placement).

The repo name, bundle identifier, and project namespace are separate
concerns. Upstream now uses the public repo name `open-cowork`, but
retains `com.opencowork.desktop` and `.opencowork/` as the default
internal identifiers for back-compat. Downstreams should only change
`APP_ID` or `branding.projectNamespace` when they intentionally want a
new install identity and are prepared to migrate existing state.

## Localization (i18n)

Open Cowork ships with inline English strings. The config schema
has an optional `i18n` overlay so downstream forks can localize
without forking the codebase:

```json
{
  "i18n": {
    "locale": "de-DE",
    "strings": {
      "dashboard.threads": "Gespräche",
      "dashboard.cost": "Kosten"
    }
  }
}
```

Two things happen when this is set:

1. **`Intl` formatters** (`formatNumber`, `formatCompactNumber`,
   `formatDate`, `formatCurrency` from
   `apps/desktop/src/renderer/helpers/i18n.ts`) switch to the
   configured locale. Numbers and dates render as
   `1.234.567` / `31.12.2026` in `de-DE`, `1,234,567` /
   `12/31/2026` in `en-US`.

2. **String catalog** — `t('dashboard.threads', 'Threads')`
   looks up the configured translation and falls back to the
   inline English default when no translation exists. Partial
   catalogs are fine; untranslated keys stay in English.

The upstream source hasn't migrated every string to the catalog
yet — only the highest-visibility ones (see
`docs/roadmap.md` "Deferred Work"). Downstream forks that need
broader coverage can either:

- Submit a PR migrating more strings to `t(key, fallback)` in the
  renderer source, then translate the key in their config.
- Fork and translate inline strings directly.

`locale` flows into every Intl formatter without string-catalog
migration, so even an untranslated fork sees locale-appropriate
numbers / dates / currencies.

## Telemetry forwarding

Every in-app event tracked by `telemetry.ts` (app launch, auth
login, session creation, perf-slow, error) is written to a local
NDJSON file by default — no data leaves the user's machine.
Downstream installs that want their own telemetry collector
(PostHog, Mixpanel, an internal HTTP endpoint) set:

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

Each tracked event is POSTed to the endpoint as JSON — fire-and-
forget with a 2-second timeout. Failures are silent; the local
NDJSON file stays the source of truth. `headers` is passed to
`fetch` after normal config placeholder resolution, so auth tokens,
CSRF tokens, or routing hints go through unchanged. Use `{env:VAR}`
placeholders for secrets and list each variable in
`allowedEnvPlaceholders` so the config file itself stays safe to commit.

Upstream distributions ship with telemetry disabled by default —
no remote calls happen unless a downstream opts in.

## Signing, notarization, and distribution

This repository ships **unsigned** artifacts by default. Downstream
distributions that ship to end users should add:

- macOS code signing and notarization (via the standard `CSC_LINK`,
  `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID` environment variables that electron-builder reads)
- Linux package signing as required by the target repositories
- any internal release approval, artifact mirror, or provenance requirements

See [Packaging and Releases](packaging-and-releases.md) for the upstream
release flow those hooks plug into.
