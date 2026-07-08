---
title: Open Cowork
description: OpenCode product layer for Desktop, Cloud, Gateway, and branded downstream deployments.
hide:
  - navigation
  - toc
---

# Open Cowork

<p class="subtitle">An OpenCode product layer for Desktop, Cloud, Gateway, and branded downstream deployments. Configurable, sync-aware, and engineered like a public product, not a demo.</p>

[Get started :material-arrow-right:](getting-started.md){ .md-button .md-button--primary }
[Why this exists :material-arrow-right:](architecture.md){ .md-button }

<div class="cowork-stats" markdown>

<div class="stat" markdown>
  <div class="stat-value">7 MCPs · 11 skills</div>
  <div class="stat-label">Bundled capabilities</div>
</div>

<div class="stat" markdown>
  <div class="stat-value">18+</div>
  <div class="stat-label">Built-in chart tools</div>
</div>

<div class="stat" markdown>
  <div class="stat-value">macOS · Linux · Windows</div>
  <div class="stat-label">Release targets</div>
</div>

<div class="stat" markdown>
  <div class="stat-value">SDK-pinned</div>
  <div class="stat-label">OpenCode runtime</div>
</div>

</div>

## What it is

Open Cowork is the **product layer** built on top of OpenCode.

The split is deliberate and load-bearing:

- :material-engine: **OpenCode executes** — sessions, agents, approvals, MCP calls, tool semantics, event streams.
- :material-palette: **Open Cowork composes** — Desktop, Cloud, Gateway, UI, branding, packaging, workflows, sync, policy, and downstream config.

That boundary is what lets you embed the same battle-tested runtime that
the OpenCode CLI uses, while still shipping a distinct product with your
own branding, providers, skills, and workflows.

## Core capabilities

<div class="grid cards" markdown>

-   :material-source-branch:{ .lg } **Project & sandbox threads**

    ---

    Real-filesystem project threads for code work. Private,
    Cowork-managed sandbox threads for reports, drafts, and artifacts —
    no risk of polluting your repo.

    [:octicons-arrow-right-24: Desktop App Guide](desktop-app.md)

-   :material-text-search:{ .lg } **Searchable thread history**

    ---

    A dedicated Threads workspace for indexed history search, metadata
    facets, user tags, saved filters, and suggestion-only categorization.
    The compact sidebar list stays focused on quick switching.

    [:octicons-arrow-right-24: Threads](threads.md)

-   :material-clock-outline:{ .lg } **Review-first workflows**

    ---

    Repeatable tasks created from a Workflow Designer setup thread, then run
    manually, on a schedule, or from a webhook through the same OpenCode agents
    you already trust.

    [:octicons-arrow-right-24: Workflows](workflows.md)

-   :material-toolbox:{ .lg } **Built-in & custom MCPs**

    ---

    Ships with `agents`, `charts`, `clock`, `knowledge`, `semantic-ui`, `skills`, and `workflows` MCPs for agent authoring,
    visuals, time-aware reasoning, knowledge-wiki proposals, approval-gated UI actions, skill-bundle management, and repeatable workflow setup. Add your own
    stdio or HTTP MCPs from Settings, with SSRF and shell-metacharacter
    policies enforced at save time.

    [:octicons-arrow-right-24: Skills & MCPs](skills-and-mcps.md)

-   :material-school:{ .lg } **Reusable skill bundles**

    ---

    Skills are folders with a `SKILL.md` entry point. Use bundled ones
    like `agent-creator`, `chart-creator`, `clock`, `workflow-creator`, `skill-creator`, and `autoresearch`, ship
    your own as part of a downstream distribution, or author them from
    chat with `skill-creator`.

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
    permissions. Same source, distinct product.

    [:octicons-arrow-right-24: Downstream Customization](downstream.md)

-   :material-server-network:{ .lg } **Cloud and Gateway surfaces**

    ---

    Cloud is the durable source of truth for shared workspaces. Gateway is
    the headless channel client for Telegram, Slack, email, webhooks, and
    future channels. Standalone Gateway remains a separate appliance mode.

    [:octicons-arrow-right-24: OSS Packaging and Gateway Migration](oss-packaging-migration.md)

</div>

## Find your path

<div class="grid" markdown>

| Role | Goal | Start here |
|---|---|---|
| **End user** | Install the app, run my first session | [Getting Started](getting-started.md) → [Desktop App Guide](desktop-app.md) |
| **Power user** | Schedule recurring work, build skills | [Workflows](workflows.md) → [Workflow Recipes](workflow-recipes.md) |
| **Downstream distributor** | Ship a branded internal build | [Configuration](configuration.md) → [Downstream Customization](downstream.md) |
| **Contributor** | Land my first PR | [First Contribution](first-contribution.md) → [Architecture](architecture.md) |
| **Operator / release manager** | Cut a release, run the gates | [OSS Packaging and Gateway Migration](oss-packaging-migration.md) → [Packaging and Releases](packaging-and-releases.md) |
| **Security reviewer** | Confirm the threat model holds | [Security Model](security-model.md) → [Telemetry and Privacy](privacy.md) |

</div>

## Install

=== ":material-apple: macOS"

    Download the latest `.dmg` from
    [GitHub Releases](https://github.com/joe-broadhead/open-cowork/releases),
    drag to `/Applications`, and launch.

    The `v0.x` line is an unsigned public preview until signing is
    configured.

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

=== ":material-microsoft-windows: Windows"

    Download the `x64` `.exe` (NSIS installer) from
    [GitHub Releases](https://github.com/joe-broadhead/open-cowork/releases)
    and run it.

    The `v0.x` line is an unsigned public preview until Authenticode
    signing is configured; verify the checksum before running.

=== ":material-source-branch: Build from source"

    ```bash
    node -v
    # Expected: v22.12.0 or newer
    corepack enable
    corepack prepare pnpm@10.32.1 --activate
    pnpm -v
    pnpm install
    pnpm dev          # builds packages + design tokens + MCPs, then hot-reloads Electron + Vite
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

    Signed macOS artifacts once signing is configured, SHA256 checksums,
    CycloneDX + SPDX SBOMs, SHA-pinned actions. Monthly maintenance
    probes paired OpenCode SDK/runtime updates against typecheck and
    tests.

    [:octicons-arrow-right-24: Packaging and Releases](packaging-and-releases.md)

-   :material-speedometer:{ .lg } **Performance gate**

    ---

    Markdown patching, sidebar virtualization, and session indexing — all
    with a `pnpm perf:check` baseline that runs in CI on
    every PR.

    [:octicons-arrow-right-24: Performance](performance.md)

-   :material-map:{ .lg } **Roadmap, in the open**

    ---

    Focused six-phase plan, explicit non-goals, and a high bar for
    reintroducing deferred advanced workflow features. No surprises.

    [:octicons-arrow-right-24: Roadmap](roadmap.md)

</div>

## What this is — and isn't

| ✅ This is | ❌ This isn't |
|---|---|
| A polished product layer on top of OpenCode | A second AI runtime |
| A configurable, brandable source for Desktop, Cloud, and Gateway deployments | Lock-in to one hosted service |
| A durable control plane around OpenCode sessions, projections, workflows, and channels | A new agent framework |
| A fork-friendly source you can rebrand without touching the code | An implicit sync engine for local files, secrets, or host paths |

## Read next

- [Glossary](glossary.md) — every term that shows up across these docs.
- [Getting Started](getting-started.md) — install, sign in, run a session.
- [Architecture](architecture.md) — the layers, the invariants, and why they're invariants.
- [OSS Packaging and Gateway Migration](oss-packaging-migration.md) — product
  names, package boundaries, release channels, and gateway migration policy.
