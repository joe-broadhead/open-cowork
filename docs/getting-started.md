# Getting Started

## Requirements

- Node `>=22`
- pnpm `>=10`
- Python `>=3.11` for documentation work

## Install from source

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```

## Install from a release artifact

Download a release artifact for your platform from GitHub Releases.

Current targets:
- macOS: `.zip`, `.dmg`
- Linux: `.AppImage`, `.deb`

Upstream release artifacts are currently unsigned. For public-facing
production distribution, plan on adding code signing and notarization
in your release repo or downstream packaging pipeline. The upstream
release process still publishes checksums, SBOMs, and provenance.

## First run

On first launch, Open Cowork asks you to choose:
- a provider
- a model
- any required provider credentials

The app then boots the OpenCode runtime with your selected configuration.

### Default provider: OpenRouter

The upstream build ships with **OpenRouter** as the only provider.
OpenRouter routes requests to many model backends (Anthropic, OpenAI,
others) through a single credential.

To finish first-run setup you need an OpenRouter API key:

1. Sign up at [openrouter.ai](https://openrouter.ai/).
2. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
   The key looks like `sk-or-...`.
3. Paste the key into the provider-credentials dialog on first run.

The key is stored in the app's local settings (encrypted via Electron's
`safeStorage` when the OS supports it) and is never written to the config file
or to `process.env`.

### Using a different provider

If you want a different provider (Anthropic direct, OpenAI direct, a local
gateway, an internal proxy), you have two paths:

- **Add a custom provider** by editing `open-cowork.config.json` — see
  [Configuration](configuration.md#providers).
- **Ship a downstream distribution** that replaces the provider list
  entirely — see [Downstream Customization](downstream.md).

### Running without a provider

If you set `auth.mode` to `none` and intend to run offline, the app will still
launch but no session can call a model until at least one provider is
configured. This is the expected mode for packaging smoke tests and for CI
images that only exercise local tooling.

### Troubleshooting first run

- **"No provider configured" after pasting the key** — confirm the key is
  scoped to the models you selected. Free-tier OpenRouter keys can still hit
  rate limits that surface as auth failures.
- **OpenCode binary not found** — the CLI ships inside the packaged app. If
  you are running from source, `pnpm dev` handles this automatically. If you
  see this in a packaged build, file an issue with your platform and version.
- **Shell environment unavailable** — the app tries to load your login
  shell's PATH on startup. On macOS/Linux it falls back to a safe default
  PATH if your shell is not on its allowlist. Open Cowork writes logs to
  `~/Library/Logs/<app name>` on macOS and `~/.config/<app name>/logs` on
  Linux. A `"Shell environment unavailable; using fallback PATH entries"`
  line there is informational, not a failure.

## Thread types

Open Cowork supports two main thread modes.

### Project thread

Use this when you want real filesystem access in a chosen working directory.

Project threads are for:
- repository work
- file editing
- code generation into a project
- structured tool work tied to a real folder

### Sandbox thread

Use this when you want Cowork-managed private work.

Sandbox threads:
- use a private Cowork workspace
- surface generated outputs as artifacts
- avoid polluting a user project by default

## First things to try

1. Create a sandbox thread and ask the model to generate a report or a chart.
2. Open `Capabilities` and inspect built-in tools and skills.
3. Add a custom MCP from the UI.
4. Create a custom agent with a narrow tool set.

## Next

- [Configuration](configuration.md)
- [Desktop App Guide](desktop-app.md)
