---
title: Open Cowork
description: Desktop AI workspace built on top of OpenCode — composable, brandable, automation-ready.
hide:
  - navigation
  - toc
---

# Open Cowork

<p class="subtitle">A desktop AI workspace built on OpenCode. Configurable, brandable, automation-ready, and engineered like a public product — not a demo.</p>

[Get started in 5 minutes :material-arrow-right:](getting-started.md){ .md-button .md-button--primary }
[Why this exists :material-arrow-right:](architecture.md){ .md-button }

<div class="cowork-stats" markdown>

<div class="stat" markdown>
  <div class="stat-value">2 / 2</div>
  <div class="stat-label">Bundled MCPs / skills</div>
</div>

<div class="stat" markdown>
  <div class="stat-value">18+</div>
  <div class="stat-label">Built-in chart tools</div>
</div>

<div class="stat" markdown>
  <div class="stat-value">macOS · Linux</div>
  <div class="stat-label">Release targets</div>
</div>

<div class="stat" markdown>
  <div class="stat-value">SDK-pinned</div>
  <div class="stat-label">OpenCode runtime</div>
</div>

</div>

## What it is

Open Cowork is the **desktop product layer** built on top of OpenCode.

The split is deliberate and load-bearing:

- :material-engine: **OpenCode executes** — sessions, agents, approvals, MCP calls, tool semantics, event streams.
- :material-palette: **Open Cowork composes** — UI, branding, packaging, automations, sandbox UX, downstream config.

That boundary is what lets you embed the same battle-tested runtime that
the OpenCode CLI uses, while still shipping a distinct product with your
own branding, providers, skills, and automations.

## Core capabilities

<div class="grid cards" markdown>

-   :material-source-branch:{ .lg } **Project & sandbox threads**

    ---

    Real-filesystem project threads for code work. Private,
    Cowork-managed sandbox threads for reports, drafts, and artifacts —
    no risk of polluting your repo.

    [:octicons-arrow-right-24: Desktop App Guide](desktop-app.md)

-   :material-clock-outline:{ .lg } **Review-first automations**

    ---

    A durable control plane for scheduled work. Inbox, work items, runs,
    deliveries, retry, and heartbeat — wrapped around the same OpenCode
    `plan` / `build` agents you already trust.

    [:octicons-arrow-right-24: Automations](automations.md)

-   :material-toolbox:{ .lg } **Built-in & custom MCPs**

    ---

    Ships with a `charts` MCP (18+ Vega-Lite + Mermaid tools) and a
    `skills` MCP. Add your own stdio or HTTP MCPs from Settings, with
    SSRF and shell-metacharacter policies enforced at save time.

    [:octicons-arrow-right-24: Skills & MCPs](skills-and-mcps.md)

-   :material-school:{ .lg } **Reusable skill bundles**

    ---

    Skills are folders with a `SKILL.md` entry point. Use bundled ones
    like `chart-creator`, ship your own as part of a downstream
    distribution, or author them from chat with `skill-creator`.

    [:octicons-arrow-right-24: Skills & MCPs](skills-and-mcps.md)

-   :material-account-multiple:{ .lg } **Sub-agent delegation**

    ---

    Use `@agent` in chat to invoke specialist sub-agents. Custom agents
    compile down to native OpenCode agent definitions — no parallel
    execution layer, no hidden indirection.

    [:octicons-arrow-right-24: Architecture](architecture.md)

-   :material-package-variant-closed:{ .lg } **Downstream-ready packaging**

    ---

    Rebrand and reconfigure without forking. Three env vars rename the
    app; a config overlay ships your providers, skills, MCPs, and
    permissions. Same binary, distinct product.

    [:octicons-arrow-right-24: Downstream Customization](downstream.md)

</div>

## Find your path

<div class="grid" markdown>

| Role | Goal | Start here |
|---|---|---|
| **End user** | Install the app, run my first session | [Getting Started](getting-started.md) → [Desktop App Guide](desktop-app.md) |
| **Power user** | Schedule recurring work, build skills | [Automations](automations.md) → [Automation Recipes](automation-recipes.md) |
| **Downstream distributor** | Ship a branded internal build | [Configuration](configuration.md) → [Downstream Customization](downstream.md) |
| **Contributor** | Land my first PR | [First Contribution](first-contribution.md) → [Architecture](architecture.md) |
| **Operator / release manager** | Cut a release, run the gates | [Operations and CI](operations.md) → [Release Checklist](release-checklist.md) |
| **Security reviewer** | Confirm the threat model holds | [Security Model](security-model.md) → [Telemetry and Privacy](privacy.md) |

</div>

## Install

=== ":material-apple: macOS"

    Download the latest signed `.dmg` from
    [GitHub Releases](https://github.com/joe-broadhead/open-cowork/releases),
    drag to `/Applications`, and launch.

    ```bash
    # Verify the checksum before opening
    shasum -a 256 -c SHA256SUMS.txt
    ```

=== ":material-linux: Linux"

    Download the `.AppImage` (portable) or `.deb` (Debian / Ubuntu).

    ```bash
    chmod +x Open-Cowork-*.AppImage
    ./Open-Cowork-*.AppImage
    ```

=== ":material-source-branch: Build from source"

    ```bash
    pnpm install
    pnpm dev          # hot-reload Electron + Vite
    pnpm build        # full build (shared + MCPs + desktop)
    ```

    See [Getting Started](getting-started.md#requirements) for prerequisites.

## Engineered like a public project

<div class="grid cards" markdown>

-   :material-shield-check:{ .lg } **Security model**

    ---

    Three-process Electron split, hand-audited preload bridge, fail-closed
    credential storage, MCP URL/stdio policies, sandboxed chart frame,
    SLSA provenance + SBOMs on every release.

    [:octicons-arrow-right-24: Read the security model](security-model.md)

-   :material-rocket-launch:{ .lg } **Releases & supply chain**

    ---

    Signed macOS artifacts, SHA256 checksums, CycloneDX + SPDX SBOMs,
    SHA-pinned actions. Monthly maintenance probes the OpenCode SDK
    against typecheck and tests.

    [:octicons-arrow-right-24: Packaging and Releases](packaging-and-releases.md)

-   :material-speedometer:{ .lg } **Performance gate**

    ---

    Markdown patching, sidebar virtualization, session eviction, dashboard
    backfill — all with a `pnpm perf:check` baseline that runs in CI on
    every PR.

    [:octicons-arrow-right-24: Performance](performance.md)

-   :material-map:{ .lg } **Roadmap, in the open**

    ---

    Three-phase plan, explicit non-goals, transparent list of deferred
    work (a11y, i18n, versioned docs, in-app updates). No surprises.

    [:octicons-arrow-right-24: Roadmap](roadmap.md)

</div>

## What this is — and isn't

| ✅ This is | ❌ This isn't |
|---|---|
| A polished desktop product layer on top of OpenCode | A second AI runtime |
| A configurable, brandable shell for internal builds | A SaaS — everything runs locally |
| A durable scheduler around OpenCode `plan` / `build` | A new agent framework |
| A fork-friendly source you can rebrand without touching the code | A black box |

## Read next

- [Glossary](glossary.md) — every term that shows up across these docs.
- [Getting Started](getting-started.md) — install, sign in, run a session.
- [Architecture](architecture.md) — the layers, the invariants, and why they're invariants.
