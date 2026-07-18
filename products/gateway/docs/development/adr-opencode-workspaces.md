# ADR: OpenCode workspaces vs Gateway environments (Phase 4)

**Status:** Accepted (defer product ship)  
**Date:** 2026-07-09  
**Roadmap:** #217 / #212

## Context

Claw-style workloads may need isolated workdirs beyond the host project tree.
Gateway already has:

- `local-process` (default)
- `local-container` (optional Docker-compatible isolation)
- `remote-crabbox` (experimental remote lease)

OpenCode SDK **v2** exposes experimental workspace APIs (see
`docs/development/opencode-sdk-surface.md`). Promoting them without an ADR risks
a second isolation product diverging from `environments.ts`.

## Decision

1. **Defer** first-class Gateway OpenCode “workspace” product APIs.
2. **Map isolation needs to EnvironmentSpec** backends first
   (`docs/configuration/environments.md`).
3. Keep experimental OpenCode workspace methods behind the session runtime only
   if a future spike proves Environments cannot express the use case.
4. Feature-flag any future workspace glue; default off; no release-claim change
   (not multi-host production, not unattended multi-tenant).

## Consequences

- Phase 4 ships this ADR + inventory pointer only (no schema growth).
- Operators seek isolation via `environment` on tasks/profiles today.
- A later ADR is required before binding AgentPresence to OpenCode workspaces.

## Alternatives considered

| Option | Why not now |
| --- | --- |
| Always create OpenCode experimental workspaces | Unstable surface; dual lifecycle with environments |
| Remote workers multi-daemon | Blocked by multi-daemon design + claim registry |
