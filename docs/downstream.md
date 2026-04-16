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
bundled `skills` MCP and is not intended for downstream use.

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
    "helpUrl": "https://internal.acme.example/cowork"
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