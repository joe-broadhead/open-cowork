# Getting Started

## Requirements

- Node `>=22.13` (supported floor). For development and CI parity, use the
  exact version pinned in `.nvmrc`.
- pnpm `10.32.1` via Corepack
- Python `>=3.11` for documentation work

## Choose the product surface

Open Cowork has one source tree and several deployable surfaces:

- **Open Cowork Desktop** for local desktop work and optional Cloud
  workspace sync.
- **Open Cowork Cloud** for shared browser, Desktop, and Gateway cloud
  workspaces.
- **Open Cowork Gateway** for headless Telegram, Slack, email, webhook, and
  other channel access to Cloud.
- **Open Cowork Standalone Gateway** for Gateway-only private appliances that
  own their own private OpenCode runtime.

Start with Desktop if you are evaluating the product personally. Start with
Cloud plus Cloud Channel Gateway if you need synced Desktop/Web/chat sessions.
Start with Standalone Gateway only when you intentionally want a chat-first
private appliance with no Cloud dependency.

The naming, package, image, release-channel, and Gateway product-mode contract
is in [Packaging and Gateway Product Modes](packaging-and-product-modes.md).

## Verify toolchain first

Before installing dependencies, verify Node and install `pnpm` via Corepack:

```bash
node -v
# Supported: v22.13.0 or newer; CI uses the exact .nvmrc version

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

The root `pnpm dev` command builds all workspace packages, the design
tokens, and the bundled MCP servers before launching the desktop app. If you launch the desktop
workspace directly and see missing `packages/shared/dist/` or
`mcps/*/dist/` errors, run `pnpm build:shared` and `pnpm build:mcps`
from the repo root first.

## Install from a release artifact

Download a release artifact for your platform from GitHub Releases.

Current targets:
- macOS: `.zip`, `.dmg`
- Linux: `.AppImage`, `.deb`
- Windows: `.exe` (NSIS installer, `x64`)

Release assets include checksums, SBOMs, and provenance. The `v0.x`
preview line is intentionally unsigned until Apple Developer validation
is configured. Verify any downloaded
artifact against `SHA256SUMS.txt`, and use GitHub's provenance
attestation when available:

```bash
shasum -a 256 -c SHA256SUMS.txt
gh attestation verify ./Open-Cowork-<version>-arm64.dmg --repo joe-broadhead/open-cowork
```

## First run

On first launch, Open Cowork asks you to choose:
- a setup path: local Desktop, standalone Gateway, Cloud connection, Desktop
  pairing, or a full hybrid deployment
- a provider
- a model
- any required provider credentials
- whether the managed runtime can reuse standard developer config
  such as Git, SSH, package-manager, cloud, Docker, and Kubernetes
  settings

The app then boots the OpenCode runtime with your selected configuration.
The path selector is informational and authority-aware: it does not upload local
threads, local files, or secrets. Use the Desktop
[Health Center](setup-and-health-center.md) after setup to verify runtime,
workspace, Cloud, Gateway, and pairing readiness.
By default this is an isolated in-app OpenCode config: Cowork-managed
agents, skills, MCPs, provider auth, and runtime state live under the
app runtime home, not your normal machine OpenCode install. The
developer config bridge is enabled by default for normal project
workflows, but it only links standard developer-tool config such as Git,
SSH, package managers, and cloud CLIs. It does not link OpenCode agents,
skills, MCPs, or provider auth.

Advanced users can switch Settings -> Permissions -> OpenCode config
source to **Machine OpenCode**. That makes the managed server read your
normal machine OpenCode config, skills, agents, tools, and provider auth
instead of Cowork's generated in-app config.

### Default providers

The upstream build ships with **OpenRouter** as the default provider, plus
direct **OpenAI Codex** and **GitHub Copilot** entries for users who prefer
OpenCode-native provider login.

OpenRouter routes requests to many model backends (DeepSeek, Anthropic,
OpenAI, others) through a single credential. The upstream default model is the
free `deepseek/deepseek-v4-flash:free` OpenRouter model. To use the default
path you need an OpenRouter API key:

1. Sign up at [openrouter.ai](https://openrouter.ai/).
2. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
   The key looks like `sk-or-...`.
3. Paste the key into the provider-credentials dialog on first run.

OpenAI can be used either by entering an API key in the same
provider-credentials dialog or by using OpenCode's provider auth flow from
first-run setup or Settings -> Models. OpenCode stores those provider-auth
credentials inside Open Cowork's managed OpenCode runtime home in the
default app-isolated mode, not in the repository or config file. If you
switch to Machine OpenCode config source, provider auth is read and
written through your normal machine OpenCode auth store instead.

The direct OpenAI model list comes from the running OpenCode runtime. If you
choose OpenAI before the runtime has started, type the model id you want to
start with; once the runtime is connected, Settings -> Models shows the live
provider catalog from OpenCode.

GitHub Copilot uses OpenCode's native Copilot auth flow. Open Cowork does not
ask for, store, or broker a Copilot token. Select GitHub Copilot in Settings
-> Models and use the OpenCode login card; Open Cowork saves the provider
choice and restarts the managed runtime as needed so OpenCode can expose its
Copilot catalog and login prompts. If you use GitHub Enterprise, OpenCode may
ask for the enterprise URL as part of that provider-owned flow.

The same mechanism works for downstream builds that enable another dormant
OpenCode-native provider: declare the provider in config, keep `models: []`
when you want OpenCode's catalog, set `runtimeActivation: "config"` only when
the pinned OpenCode runtime requires a minimal provider config entry, and use
the OpenCode login card if that provider exposes OAuth/auth methods.

API keys typed into Open Cowork are stored in the app's local settings
(encrypted via Electron's `safeStorage` when the OS supports it) and are never
written to the config file or to `process.env`.

### Using a different provider

If you want a different provider (Anthropic direct, a local gateway, an
internal proxy), you have two paths:

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
  `~/Library/Application Support/<app name>/logs` on macOS and
  `~/.config/<app name>/logs` on Linux. A `"Shell environment unavailable; using fallback PATH entries"`
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
2. Open `Tools & Skills` and inspect built-in tools and skills.
3. Add a custom MCP from the UI.
4. Create a custom agent with a narrow tool set.
5. Create a workflow if you want recurring work to start from a saved
   Workflow Designer setup thread and run manually, on a schedule, or from a
   webhook.

## Next

- [Configuration](configuration.md)
- [Desktop App Guide](desktop-app.md)
- [Workflows](workflows.md)
