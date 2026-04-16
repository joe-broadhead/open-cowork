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
- label
- description
- instructions
- linked skills
- tool ids
- allow/ask tool patterns
- UI color
- mode

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
