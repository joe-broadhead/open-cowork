# Getting Started

## Requirements

- Node `>=22.12`
- pnpm `>=10`
- Python `>=3.11` for documentation work

## Verify toolchain first

Before installing dependencies, verify Node and install `pnpm` via Corepack:

```bash
node -v
# Expected: v22.12.0 or newer

corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm -v
```

## Install from source

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```

The root `pnpm dev` command builds `@open-cowork/shared` before
launching the desktop app. If you launch the desktop workspace directly
and see a missing `packages/shared/dist/` error, run `pnpm build:shared`
from the repo root first.

## Install from a release artifact

Download a release artifact for your platform from GitHub Releases.

Current targets:
- macOS: `.zip`, `.dmg`
- Linux: `.AppImage`, `.deb`

Release assets include checksums, SBOMs, and provenance. Signed macOS
builds are planned from `v0.0.1`; `v0.0.0` is intentionally unsigned
while Apple Developer validation is pending.

For the `v0.0.0` public preview, macOS builds are intentionally unsigned
while Apple Developer validation is pending. Verify any downloaded
artifact against `SHA256SUMS.txt`, and use GitHub's provenance
attestation when available:

```bash
shasum -a 256 -c SHA256SUMS.txt
gh attestation verify ./Open-Cowork-0.0.0-arm64.dmg --repo joe-broadhead/open-cowork
```

## First run

On first launch, Open Cowork asks you to choose:
- a provider
- a model
- any required provider credentials

The app then boots the OpenCode runtime with your selected configuration.

### Default providers

The upstream build ships with **OpenRouter** as the default provider, plus a
direct **OpenAI Codex** entry for users who prefer provider-native credentials
or ChatGPT Plus/Pro login.

OpenRouter routes requests to many model backends (Anthropic, OpenAI, others)
through a single credential. To use the default path you need an OpenRouter API
key:

1. Sign up at [openrouter.ai](https://openrouter.ai/).
2. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
   The key looks like `sk-or-...`.
3. Paste the key into the provider-credentials dialog on first run.

OpenAI can be used either by entering an API key in the same
provider-credentials dialog or by using OpenCode's provider auth flow from
first-run setup or Settings -> Models. OpenCode stores those provider-auth
credentials inside Open Cowork's managed OpenCode runtime home, not in the
repository or config file.

The direct OpenAI model list comes from the running OpenCode runtime. If you
choose OpenAI before the runtime has started, type the model id you want to
start with; once the runtime is connected, Settings -> Models shows the live
provider catalog from OpenCode.

The same mechanism works for downstream builds that enable another
OpenCode-native provider, such as GitHub Copilot: declare the provider in
config, keep `models: []` when you want OpenCode's catalog, and use the
OpenCode login card if that provider exposes OAuth/auth methods.

API keys typed into Open Cowork are stored in the app's local settings
(encrypted via Electron's `safeStorage` when the OS supports it) and are never
written to the config file or to `process.env`.

### Using a different provider

If you want a different provider (Anthropic direct, GitHub Copilot, a local
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

- **"No provider configured" after connecting a provider** — confirm the key
  or OpenCode provider login is scoped to the models you selected. Free-tier
  provider keys can still hit rate limits that surface as auth failures.
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
5. Create an automation if you want recurring or managed work to use a
   schedule, inbox, and retry-aware control plane instead of a one-off thread.

## Next

- [Configuration](configuration.md)
- [Desktop App Guide](desktop-app.md)
- [Automations](automations.md)
