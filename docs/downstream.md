# Downstream Customization

Open Cowork is designed to be repackaged as an internal build without forking
the code. Branding, providers, agents, skills, MCPs, and bundled prompts are
all expressed in files the app reads at runtime, and a small set of environment
variables lets a downstream distribution point the app at its own copy of those
files.

This page is the reference for that model.

The workspace ownership, sync, status/reason, and non-sync guarantees that
downstream builds must preserve are defined in
[Product Contract](product-contract.md).
The public product names, package/image names, release-channel language, and
Gateway product-mode policy are defined in
[Packaging and Gateway Product Modes](packaging-and-product-modes.md).
The versioned downstream configuration, branding, packaging, template hygiene,
and extension contract is defined in
[Downstream Contract](downstream-contract.md). Current public config files use
`contractVersion: 1`.

## Distribution modes

Downstream operators should choose the product surface intentionally:

- **Local-only desktop** sets `cloudDesktop.enabled=false`. Users get the
  current private desktop behavior with local OpenCode runtime ownership,
  local project directories, local stdio MCPs, local settings, and no cloud
  dependency.
- **Cloud-enabled desktop** sets `cloudDesktop.enabled=true` and can allow
  user-added cloud connections. Local and cloud workspaces appear side by side,
  but local threads remain local and cloud threads sync through Open Cowork
  Cloud.
- **Managed-org-only desktop** sets `cloudDesktop.enabled=true`,
  `allowUserAddedConnections=false`, `requireManagedOrg=true`, and
  `preconfiguredConnections[]`. This is the right mode for internal company
  builds that must pin users to approved cloud orgs.
- **Gateway-enabled deployment** runs Open Cowork Gateway next to a cloud org.
  The gateway is a headless client for approved channels; it uses cloud service
  tokens and channel bindings but does not spawn OpenCode or own a second
  control plane.

Open Cowork also supports two commercial/operational packaging modes without
changing the OSS boundary:

- **Internal enterprise distribution** ships a branded desktop config, pins
  `cloudDesktop.preconfiguredConnections` to the company's cloud, runs cloud
  behind company OIDC, and deploys gateway inside the company's infrastructure.
- **Managed BYOK SaaS distribution** ships the same open desktop/cloud/gateway
  code while the operator hosts cloud, billing, BYOK, object storage, and
  managed channel bindings for paying orgs.

Branding, providers, skills, MCPs, agents, cloud connections, gateway
credentials, and telemetry are configurable, but the workspace contract is not:
no build should implicitly upload local threads, local project files, provider
keys, local stdio MCP commands, or machine runtime config into cloud. Use
cloud-safe remote MCPs, explicit artifact upload, or admin-managed profiles
when a capability must be available in cloud.

For a complete placeholder deployment that covers desktop config, cloud Helm
values, gateway Helm values, OIDC, branding, and profile/tool/agent allowlists,
see `examples/downstream/example-org/`.

## Mental model

Everything downstream-customizable goes through two layers:

1. **Configuration** — a JSON file validated against
   `open-cowork.config.schema.json` and the versioned
   `contractVersion: 1` downstream contract. The app merges the bundled config
   with up to three additional layers in a fixed order.
2. **Content** — skill bundles (`skills/<name>/SKILL.md`) and MCP packages
   (`mcps/<name>/dist/index.js`) that the config can reference. The app
   resolves these from a stack of roots, with the downstream root winning over
   the bundled one.

A downstream distribution typically ships a directory with this layout:

```text
example-cowork/
├── config.json           # or open-cowork.config.json
├── skills/
│   ├── example-reports/
│   │   └── SKILL.md
│   └── example-tickets/
│       └── SKILL.md
└── mcps/
    └── example-crm/
        └── dist/
            └── index.js
```

Then launches the app with `OPEN_COWORK_DOWNSTREAM_ROOT=/etc/example-cowork`.

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

When the app starts, the config core in
`packages/runtime-host/src/config-loader-core.ts` (re-exported through
`apps/desktop/src/main/config-loader.ts`) builds the active config by merging
these sources in order (later entries override earlier ones):

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

## Cloud, desktop, and gateway knobs

Downstream deployments should keep one deployer-facing config file as the
source of product policy and then let infrastructure manifests inject secrets.
The public schema now covers the three product surfaces:

| Surface | Config keys | What belongs here |
|---|---|---|
| Desktop | `branding`, `cloudDesktop` | App name, sidebar/home copy, managed cloud URLs, cache mode, and whether users may add their own cloud orgs. |
| Cloud Web/control plane | `cloud.publicBranding`, `cloud.auth`, `cloud.storage`, `cloud.features`, `cloud.profiles`, `cloud.projectSources`, `cloud.abuse`, `cloud.billing` | Public dashboard name/logo/legal links, OIDC metadata, database/object-store/secret refs, profile allowlists, project-source policy, quotas, and self-host or managed billing mode. |
| Gateway | `gateway.branding`, `gateway.server`, `gateway.providers`, `gateway.metrics`, `gateway.diagnostics` | Headless channel branding, public gateway URL, provider bindings, and operator endpoints. Cloud URL and gateway service token belong in env or deployment secrets. |

Use [Downstream Contract](downstream-contract.md) for the full field inventory
and to distinguish runtime config, packaging-time config, infrastructure
config, and private downstream config.

Gateway can load the same central file as Desktop and Cloud through
`OPEN_COWORK_CONFIG_PATH`, `OPEN_COWORK_CONFIG_DIR`, or
`OPEN_COWORK_DOWNSTREAM_ROOT`. Gateway-specific env and
`OPEN_COWORK_GATEWAY_CONFIG` / `OPEN_COWORK_GATEWAY_CONFIG_JSON` remain
available as overrides. Gateway cloud connection settings are not part of the
file-backed product config; use
`OPEN_COWORK_CLOUD_BASE_URL`, `OPEN_COWORK_GATEWAY_SERVICE_TOKEN`,
`OPEN_COWORK_GATEWAY_ALLOW_INSECURE_HTTP`, and
`OPEN_COWORK_GATEWAY_CLOUD_REQUEST_TIMEOUT_MS` from your deployment secret
manager instead. This lets an internal deployment keep `branding`,
`cloud.publicBranding`, `cloudDesktop`, and `gateway.branding` in one audited
file while Kubernetes, Compose, or a VPS process manager supplies endpoint
bindings and secrets from the local secret manager.

Production safety rules are enforced in config validation:

- public cloud, desktop, gateway, telemetry, update, and logo/legal URLs must
  be HTTPS, except loopback/local development URLs
- `cloud.billing.provider=none` or `stub` keeps self-host deployments free of
  commercial billing dependencies
- gateway provider enablement is explicit; no provider is started unless it is
  configured through `gateway.providers`, gateway provider env, or the local
  fake-provider development flag
- public gateway metrics or diagnostics require `gateway.server.adminToken`
- webhook gateway ingress requires a shared secret
- the fake gateway provider cannot be exposed from a public bind unless
  `OPEN_COWORK_GATEWAY_ALLOW_PUBLIC_FAKE_PROVIDER=true` is set deliberately for
  a self-hosted demo
- public `cloud.auth.mode=header` deployments require a header auth secret and
  signed timestamped identity headers from the trusted proxy
- environment placeholders such as `{env:OPEN_COWORK_GATEWAY_ADMIN_TOKEN}`
  only resolve when listed in `allowedEnvPlaceholders`

Managed BYOK SaaS deployments should keep downstream-specific prices, project
ids, legal URLs, and brand assets outside this public repository. The public
repo should contain only generic examples and these portable supply points:

| Area | Public config/env surface | Secret source |
|---|---|---|
| Billing mode | `cloud.billing.enabled`, `cloud.billing.provider`, `OPEN_COWORK_CLOUD_BILLING_ENABLED`, `OPEN_COWORK_CLOUD_BILLING_PROVIDER`, `OPEN_COWORK_CLOUD_BILLING_DEFAULT_PLAN` | None for `none`/`stub`; provider credentials through refs for managed SaaS. |
| Stripe | `cloud.billing.stripe.*`, `OPEN_COWORK_CLOUD_STRIPE_API_KEY_REF`, `OPEN_COWORK_CLOUD_STRIPE_WEBHOOK_SECRET_REF`, `OPEN_COWORK_CLOUD_STRIPE_PRICE_ID`, `OPEN_COWORK_CLOUD_STRIPE_SUCCESS_URL`, `OPEN_COWORK_CLOUD_STRIPE_CANCEL_URL`, `OPEN_COWORK_CLOUD_STRIPE_PORTAL_RETURN_URL` | Platform secret manager or env refs for API key and webhook secret. |
| BYOK | `cloud.profiles`, `cloud.billing.plans.*.entitlements.allowedProviders`, provider validators in cloud process wiring | Provider keys enter only through `/api/byok`; plaintext is never stored in config. |
| Quotas | `cloud.abuse.*`, `OPEN_COWORK_CLOUD_MAX_*` env overrides | No secrets. |
| Public URLs | `cloud.publicBranding`, `cloudDesktop.preconfiguredConnections`, Gateway `publicUrl` | Use generic URLs here; downstream managed repo owns real domains. |

Self-host OSS deployments can leave `cloud.billing.enabled=false` and
`cloud.billing.provider=none`; hosted SaaS deployments should require signed
billing webhooks, BYOK validator/override evidence, quotas, and launch
readiness gates before public traffic.

Managed BYOK SaaS can live in a separate managed/private repo that supplies
config overlays, billing adapters, object-store and secret refs, and operations
evidence. That repo should not fork Open Cowork runtime behavior or require
billing for the OSS self-host path.

Cloud Web theming is intentionally narrow. Downstream overlays can change
`cloud.publicBranding` names, logo/legal/support URLs, dashboard copy, token
labels, and public theme colors, including the expanded dark-token keys
documented in [Design Tokens](design-tokens.md). They should not fork Cloud Web
layout CSS, add a separate build pipeline, replace Mona/Schibsted font serving, or
change the Cloud Web cloud-client-only architecture. The shared structural
tokens in `packages/shared/src/design-tokens.ts` keep Desktop and Cloud Web
aligned across spacing, radius, typography scale, shadows, and control density.

Downstream deployment recipes must also preserve these production contracts:

- images are pinned by immutable release tag or digest; `latest`, `stable`,
  and other mutable aliases are not acceptable defaults
- local/demo Compose defaults are replaced before shared use: auth, public
  URLs, cookie/internal/service tokens, object-store credentials, and fake
  providers
- multi-worker Cloud requires checkpointing plus a shared object store for
  artifacts, uploaded snapshots, workspace snapshots, and runtime checkpoints
- Kubernetes overlays own HPA/KEDA policy, PodDisruptionBudgets, and
  topology spread constraints; they should not change cloud runtime or gateway
  code
- self-host OSS keeps a billing-free path with `cloud.billing.provider=none`
  or the stub provider

## Extension Points And Ownership

Downstream deployments should extend Open Cowork through the surface that owns
the product concept. Do not patch core execution code to add deployer-specific
behavior. OpenCode owns execution; Open Cowork owns composition, policy,
projection, channel adapters, and deployment ergonomics.

| Extension point | Owning modules | Contract |
|---|---|---|
| Gateway providers | `packages/gateway-provider-*`, `packages/gateway-channel`, `apps/gateway/src/provider-registry.ts` | Implement the provider contract and register capabilities. Gateway providers send/receive channel messages only; they do not spawn OpenCode, import Cloud stores, or own execution state. |
| Deployment recipes | `deploy/`, `helm/`, `docker-compose*.yml`, `scripts/validate-deployment-configs.mjs` | Compose public templates from config/env refs. Keep real project ids, domains, account ids, customer values, prices, and secrets in private deployment repos. |
| Billing adapters | `packages/cloud-server/src/billing-adapter.ts`, `stripe-billing-adapter.ts`, `stub-billing-adapter.ts` | Add provider-specific billing behind the adapter. Core entitlement and quota logic consumes provider-neutral subscription records. |
| Object-store adapters | `packages/cloud-server/src/object-store.ts`, deployment object-store config | Add storage providers behind the object-store interface. Artifact, upload, snapshot, and checkpoint callers should not branch on cloud provider names. |
| Secret adapters | `packages/cloud-server/src/secret-adapter.ts`, BYOK secret store, config refs | Resolve or protect secrets behind refs. Raw provider keys, OAuth tokens, cookies, channel secrets, and signed URLs must never enter renderer state, cache, diagnostics, or public templates. |
| Worker pool modes | `docs/managed-workers.md`, `managed-worker-types.ts`, `services/managed-worker-service.ts` | Add worker modes only after the trust model is documented. Customer-hosted workers remain deferred until a separate review covers updates, liability, networking, and data residency. |
| Runtime profiles and policy packs | `cloud.profiles`, `cloud.runtime`, `cloud-config.ts`, `packages/runtime-host/src/runtime-config-builder.ts` | Cloud profiles own feature flags and allowlists. Machine runtime config, arbitrary local stdio MCPs, and host project directories stay disabled unless explicitly reviewed and allowlisted. |
| Cloud Web feature modules and admin panels | `packages/app/src`, `packages/app/src/browser/cowork-api.ts`, `docs/cloud-web-workbench.md` | Cloud Web is the unified renderer running in the browser over the cloud HTTP/SSE shim. It must not import server-only stores, runtime adapters, secret adapters, or provider-specific internals. |
| BYOK validation and injection hooks | `byok-secret-store.ts`, `packages/runtime-host/src/runtime-config-builder.ts`, `opencode-runtime-adapter.ts`, `cloud-config.ts` | Provider keys enter OpenCode through runtime config provider options. They never enter process env, logs, renderer state, diagnostics, cache, or read APIs. |
| Cloud event and projection contract | `packages/shared/src/cloud-session-projection.ts`, `opencode-runtime-adapter.ts`, `session-projection-service.ts`, gateway renderers | Runtime translation happens once at the worker/runtime boundary. Desktop, Web, and Gateway consume canonical Cloud events/projections rather than raw SDK events. |

Module changes should stay narrow:

- route modules validate/auth/parse and delegate to services
- services own orchestration and policy decisions
- store/domain modules persist atomically and do not own channel or renderer
  behavior
- package-boundary tests guard against clients importing server-only Cloud
  internals
- source-size budgets are regressions gates, not targets to grow into

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `OPEN_COWORK_DOWNSTREAM_ROOT` | Root directory for a downstream distribution. Supplies config, skills, and MCPs. | unset |
| `OPEN_COWORK_CONFIG_PATH` | Absolute path to a single override config file. Takes priority over `CONFIG_DIR` / `DOWNSTREAM_ROOT` config discovery. | unset |
| `OPEN_COWORK_CONFIG_DIR` | Directory containing `config.json` or `open-cowork.config.json`. Merged after the single-file override. | unset |
| `OPEN_COWORK_GATEWAY_CONFIG` | Gateway-only JSON config file. Overrides the shared `gateway` section when running `apps/gateway`. | unset |
| `OPEN_COWORK_GATEWAY_CONFIG_JSON` | Inline gateway-only JSON config. Highest-priority gateway override for process managers and tests. | unset |
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

See `packages/runtime-host/src/runtime-content.ts` and
`packages/runtime-host/src/effective-skills.ts` for the resolution code.

## MCPs overlay

MCP packages are resolved from:

1. `$OPEN_COWORK_DOWNSTREAM_ROOT/mcps/<name>/dist/index.js`
2. `<resourcesPath>/mcps/<name>/dist/index.js` — MCPs shipped with the packaged
   app (`mcps/agents`, `mcps/charts`, `mcps/clock`, `mcps/skills`, `mcps/workflows`).

As with skills, the MCP must be declared in the active config (`mcps` section)
before the runtime spawns it.

See `packages/runtime-host/src/runtime-mcp.ts`.

## Environment placeholders in config

Config strings may reference environment variables using `{env:NAME}`.

For safety, placeholders only resolve when the variable name is explicitly
listed in `allowedEnvPlaceholders`:

```json
{
  "allowedEnvPlaceholders": ["EXAMPLE_LLM_GATEWAY_URL"],
  "providers": {
    "custom": {
      "example-gateway": {
        "options": {
          "baseURL": "{env:EXAMPLE_LLM_GATEWAY_URL}"
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
(through the app settings store, `settings.enc` in production, and
`provider.options.<runtimeKey>` in the built OpenCode config) and do not
need to be listed in `allowedEnvPlaceholders`.

## Worked example

A downstream distribution that brands the app "Example Cowork", ships one custom
provider, one internal MCP, and one internal skill would look like:

```text
/etc/example-cowork/
├── config.json
├── skills/
│   └── example-tickets/
│       └── SKILL.md
└── mcps/
    └── example-crm/
        └── dist/
            └── index.js
```

`config.json`:

```jsonc
{
  "contractVersion": 1,
  "allowedEnvPlaceholders": ["EXAMPLE_GATEWAY_URL", "EXAMPLE_GATEWAY_KEY"],
  "branding": {
    "name": "Example Cowork",
    "appId": "com.example.cowork",
    "dataDirName": "example-cowork",
    "helpUrl": "https://internal.example.com/cowork",
    "sidebar": {
      "top": {
        "variant": "logo-text",
        "logoAsset": "branding/example-logo.svg",
        "mediaSize": 36,
        "mediaFit": "vertical",
        "mediaAlign": "center",
        "title": "Example AI",
        "subtitle": "Private workspace"
      },
      "lower": {
        "text": "Example internal build",
        "secondaryText": "Support from Data Platform.",
        "linkLabel": "Get help",
        "linkUrl": "https://internal.example.com/cowork-help"
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
    "available": ["example-gateway"],
    "descriptors": {
      "example-gateway": {
        "runtime": "custom",
        "name": "Example Gateway",
        "description": "Internal LLM gateway.",
        "defaultModel": "example-large",
        "credentials": []
      }
    },
    "custom": {
      "example-gateway": {
        "name": "Example Gateway",
        "defaultModel": "example-large",
        "options": {
          "baseURL": "{env:EXAMPLE_GATEWAY_URL}",
          "apiKey": "{env:EXAMPLE_GATEWAY_KEY}"
        },
        "models": {
          "example-large": { "name": "Example Large" }
        }
      }
    },
    "defaultProvider": "example-gateway",
    "defaultModel": "example-large"
  }
  // ...tools, skills, mcps, agents, permissions as needed
}
```

Launch the packaged app with:

```bash
OPEN_COWORK_DOWNSTREAM_ROOT=/etc/example-cowork \
  EXAMPLE_GATEWAY_URL=https://llm.internal.example.com \
  EXAMPLE_GATEWAY_KEY="$(cat /run/secrets/example-gateway-key)" \
  ./Example\ Cowork
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
APP_PRODUCT_NAME="Example Cowork" \
  APP_ID="com.example.cowork" \
  APP_ARTIFACT_PREFIX="Example-Cowork" \
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
for example `branding/example-logo.svg`. The app rejects absolute paths, traversal,
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
      "settings.language.label": "Sprache",
      "chat.awaitingApproval": "Wartet auf Freigabe"
    }
  }
}
```

Two things happen when this is set:

1. **Date formatting** (`formatDate` from
   `packages/app/src/helpers/i18n.ts`) switches to the
   configured locale. Dates render as `31.12.2026` in `de-DE` and
   `12/31/2026` in `en-US`.

2. **String catalog** — `t('settings.language.label', 'Language')`
   looks up the configured translation and falls back to the
   inline English default when no translation exists. Partial
   catalogs are fine; untranslated keys stay in English.

### Launch posture: English-first, honestly partial elsewhere

The public build is **English-first**. The built-in non-English
catalogs (ar, de, es, fr, hi, it, ja, ko, pt, ru, zh) currently
translate roughly a third of the renderer's strings; everything
else renders its inline English fallback. That state is deliberate
policy, not drift:

- Untranslated keys are tracked in the documented allowlist
  (`tests/i18n-english-only-allowlist.json`); a new `t()` key that
  is neither translated nor allowlisted fails CI, so the backlog
  can only shrink or be made visible — never grow silently.
- Strings are **never machine-translated in bulk**; catalog entries
  are added deliberately so a native reader can trust what ships.
- The language picker shows the honest coverage figure per locale
  ("Deutsch — zu 32 % übersetzt"), generated from the live backlog
  by `node scripts/i18n-coverage.mjs --write-status` and kept in
  sync by the `i18n:check` gate.

The upstream source hasn't migrated every string to the catalog
yet — only the highest-visibility ones (see the focused roadmap in
`docs/roadmap.md`). Downstream forks that need
broader coverage can either:

- Submit a PR migrating more strings to `t(key, fallback)` in the
  renderer source, then translate the key in their config.
- Fork and translate inline strings directly.

`locale` flows into every Intl formatter without string-catalog
migration, so even an untranslated fork sees locale-appropriate
numbers / dates / currencies.

## Telemetry forwarding

Every in-app event tracked by `packages/runtime-host/src/telemetry.ts`
(app launch, auth
login, session creation, perf-slow, error) is written to a local
NDJSON file by default — no data leaves the user's machine.
Downstream installs that want their own telemetry collector
(PostHog, Mixpanel, an internal HTTP endpoint) set:

```json
{
  "allowedEnvPlaceholders": ["EXAMPLE_TELEMETRY_TOKEN"],
  "telemetry": {
    "enabled": true,
    "endpoint": "https://events.example.com/ingest",
    "headers": {
      "Authorization": "Bearer {env:EXAMPLE_TELEMETRY_TOKEN}"
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

## Team distribution and interop

Beyond a full downstream repackage, Open Cowork supports lighter-weight ways to
move a *setup* between machines and to interoperate with external MCP clients
and plugin ecosystems. These share one internal model — the **unified extension
descriptor** — so a skill, a custom MCP server, a custom agent, or a provider
can all be described, redacted, and reinstalled through one shape.

### Unified extension descriptor

`packages/shared/src/extension-descriptor.ts` defines a single typed
`ExtensionDescriptor` that represents any installable unit:

```ts
interface ExtensionDescriptor {
  schemaVersion: 1
  id: string                 // e.g. "mcp:tickets", "agent:reviewer"
  kind: 'skill' | 'mcp' | 'agent' | 'provider'
  name: string
  source: ExtensionSource    // origin, original scope, advisory reference
  secrets: ExtensionSecretRequirement[]  // what import must re-supply
  setup: ExtensionSetupStep[]            // human-readable install steps
  payload: ExtensionPayload  // the redacted per-type record, tagged by kind
}
```

Pure, browser-safe converters map each existing per-type record onto the
descriptor and back — `mcpToExtensionDescriptor` / `extensionDescriptorToMcp`,
and the equivalents for skills, agents, and providers. The converters do **not**
rebuild the per-type UIs or storage; they translate onto the same
`CustomMcpConfig` / `CustomSkillConfig` / `CustomAgentConfig` records the
existing stores already persist. This descriptor is the foundation for a future
unified "Extensions" surface and the item shape carried by the setup bundle
below.

Redaction happens inside the converters, so the same logic runs on desktop, in
the browser, and in tests:

- MCP environment values and HTTP header values → replaced with
  `__OPEN_COWORK_REDACTED__` and re-declared as `env:<KEY>` / `header:<KEY>`
  secret requirements.
- Absolute local paths in a stdio MCP's `command`/`args` → replaced and
  re-declared as `path:*` requirements (relative launchers such as `npx` stay
  intact).
- Provider credential-like option keys (`apiKey`, `*token`, `*secret`, …) →
  replaced and re-declared as `credential:<key>` requirements. Provider
  *shape* travels; provider secrets never do.

### Shareable setup export/import bundle

The setup bundle is the concrete, implemented interop artifact. It packages a
deployment's installed **skills + custom MCP servers + custom agents** as a
portable, versioned JSON document with every secret redacted:

```jsonc
{
  "format": "open-cowork-setup-bundle",
  "version": 1,
  "exportedAt": "2026-01-01T00:00:00.000Z",
  "exportedBy": "Example Cowork",
  "skills": [ /* ExtensionDescriptor (kind: skill) */ ],
  "mcps":   [ /* ExtensionDescriptor (kind: mcp)   */ ],
  "agents": [ /* ExtensionDescriptor (kind: agent) */ ]
}
```

The format, validation, redaction, and import *planning* live in the pure
`@open-cowork/shared` (`setup-bundle.ts`); the IO half
(`packages/runtime-host/src/setup-bundle-store.ts`) wires it to the **existing**
`custom-mcp-store` / `custom-skill-store` / `custom-agent-store` install code —
there is no second write path.

Export and import are exposed to both product surfaces through the
`CoworkAPI.custom` methods `exportSetupBundle` / `importSetupBundle`, keeping
desktop⇄web parity (desktop implements them over IPC; the browser build reports
them unavailable, like the other local-filesystem capability mutations).

**Import semantics.** Import validates the bundle version/shape, then reports a
per-item outcome without ever silently clobbering local state:

| Status | Meaning |
|---|---|
| `applied` | Installed (or, with `overwrite`, replaced) via the existing store. |
| `needs-secret` | Has required secrets the operator hasn't supplied; **not** installed, so no placeholder secret is ever persisted. |
| `skipped-conflict` | An item of the same name already exists; left unchanged. |
| `skipped-unsupported` | Unknown kind, or the per-type install threw. |

Import is **idempotent** — re-importing the same bundle is a no-op because every
item conflicts with the one already installed. Secrets are supplied out-of-band
at import time (`secretValues[descriptor.id][secretKey]`), so the JSON stays
safe to email, commit to an internal repo, or attach to a ticket. This is the
right mechanism for "seed every teammate's install with the approved skills,
MCPs, and agents" without shipping a whole downstream build.

### Per-org install links (design)

> Status: **design**. This section documents the contract and the minimal hook;
> it does not add download-serving infrastructure.

The goal is a single signed, byte-identical generic installer that boots as a
branded, config-stamped app depending on *which link* a user downloaded from —
so an org can hand out `https://get.example.com/acme` and have it launch already
pointed at Acme's config, without maintaining a fork or a per-org signed binary.

Open Cowork already has every runtime hook this needs; the design reuses them
rather than inventing a new bootstrap:

- **Config stamping** is the existing downstream config chain (see *Config merge
  order* above): `OPEN_COWORK_DOWNSTREAM_ROOT` / `OPEN_COWORK_CONFIG_DIR` /
  `OPEN_COWORK_CONFIG_PATH` select the active `open-cowork.config.json`, and
  `branding.*` stamps name, icons, and copy. The rebranding env vars
  (`APP_PRODUCT_NAME`, `APP_ID`, `APP_ARTIFACT_PREFIX`) are **build-time** only
  and are intentionally *not* part of this per-download flow.
- **Content stamping** is the skills/MCPs overlay resolved from the downstream
  root.

The per-org link then only has to deliver a small, signed **sidecar** next to
the unchanged binary:

```text
Example-Cowork-Setup.exe          # byte-identical signed installer
Example-Cowork-Setup.exe.acme     # filename tag identifying the org (advisory)
bootstrap.json                    # signed: { org, configUrl|configDir, downstreamRoot, mirror? }
```

The download server stamps `bootstrap.json` per deployment at download time
(the binary is never re-signed). On first run the app:

1. Verifies the `bootstrap.json` signature against a pinned org public key.
2. Resolves the referenced config + content into the downstream root (fetch
   once and cache, or point at a pre-provisioned directory).
3. Sets `OPEN_COWORK_DOWNSTREAM_ROOT` for itself and boots through the existing
   merge chain — identical to launching with the env var by hand today.

Two operating modes:

- **Online**: `bootstrap.json.configUrl` points at the org's config/content
  bundle; the app fetches and caches it.
- **Air-gapped / mirror**: `bootstrap.json.mirror` names an internal artifact
  mirror (or a `configDir` on a mounted share), so no public network egress is
  required.

Minimal hook needed to make this real: a small first-run bootstrap reader that
verifies the signed `bootstrap.json`, materializes the downstream root, and
exports `OPEN_COWORK_DOWNSTREAM_ROOT` before config load. Everything downstream
of that env var already works. The **setup bundle** above is the natural
payload for the content half of `bootstrap.json` — an org's approved skills,
MCPs, and agents travel as one redacted bundle, and secrets are still supplied
per user at first run.

### Standalone semantic-UI MCP and plugin import (design)

> Status: **design**, plus the real converter hook from the extension
> descriptor. No new server infrastructure is added.

**Publishing the semantic-UI control MCP standalone.** The app already runs a
loopback semantic-UI bridge (`packages/runtime-host/src/semantic-ui-bridge.ts`)
that binds `127.0.0.1:<random-port>` with a per-session scoped token and hands
the bundled `mcps/semantic-ui` server its coordinates through two env vars:

```text
OPEN_COWORK_SEMANTIC_UI_URL=http://127.0.0.1:<port>
OPEN_COWORK_SEMANTIC_UI_TOKEN=<base64url 256-bit token>
```

To let an **external** MCP client (Claude Desktop, an editor, another agent
runtime) drive the same read-only status/snapshot and audited action surface,
the design writes those same coordinates to a **bridge-discovery file** — the
standard "MCP endpoint + scoped token" handshake — instead of only injecting
them into the app's own child process:

```jsonc
// ~/.config/<dataDirName>/semantic-ui-bridge.json  (0600)
{
  "contractVersion": 1,
  "url": "http://127.0.0.1:<port>",
  "token": "<scoped session token>",
  "tools": ["ui_status", "ui_snapshot", "ui_list_actions", "ui_execute_action"]
}
```

The token stays session-scoped and loopback-bound; `authorizeSemanticUiTool`
already gates read-only vs. action tools, so exposing the file does not widen
authority — an external client gets exactly the same contract the bundled MCP
does. Minimal hook: emit/rotate the discovery file alongside
`ensureSemanticUiBridge()` / `stopSemanticUiBridge()`.

**Importing an external agent/plugin bundle.** A foreign plugin or agent
package becomes installable by mapping it onto the unified extension descriptor
(kind `agent`/`mcp`/`skill`, `source.origin: 'external'`). Once a converter
produces `ExtensionDescriptor`s, the *same* `importSetupBundle` planning and
install path applies — including redaction, `needs-secret` prompting, and
idempotent conflict handling. The descriptor and its converters are the small,
tested code hook that makes this real; a per-vendor adapter only has to emit
descriptors, not re-implement install or secret handling.

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
