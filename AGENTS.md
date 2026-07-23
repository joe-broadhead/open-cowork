# AGENTS.md

Open Cowork is an Electron + TypeScript monorepo: desktop product layer on **OpenCode** (execution engine), plus Durable Gateway, Cloud, and Wiki. Package manager: **pnpm@10.32.1**. Node: see `.nvmrc` (**≥22.13**). Default branch: `master`.

**OpenCode owns execution** (sessions, MCP, approvals, tools, streaming). **Open Cowork owns composition** (desktop UI, packaging, config, workflows, branding). Do not invent a second agent runtime.

## Commands

```bash
pnpm install                          # install (frozen lockfile in CI)
pnpm dev                              # desktop dev
pnpm lint                             # eslint + design tokens + cycles + knip + boundaries
pnpm typecheck                        # packages + desktop (slow; prefer scoped below)
pnpm test                             # monorepo unit/integration (excludes full gateway suite path in some flows)
pnpm test:gateway                     # Durable Gateway (cowork-gateway) vitest
pnpm test:renderer                    # packages/app renderer tests
pnpm test:e2e                         # desktop e2e (needs display)
pnpm docs:build                       # MkDocs strict
pnpm build                            # full monorepo build (ask first unless release)
git diff --check                      # no trailing whitespace
```

**Scoped / fast loops**

```bash
pnpm --filter @open-cowork/desktop typecheck
pnpm --filter cowork-gateway exec vitest run src/__tests__/some.test.ts
pnpm --filter @open-cowork/app exec vitest run path/to/file.test.ts
pnpm eslint --fix path/to/file.ts
pnpm exec tsc -p products/gateway/tsconfig.json --noEmit
```

Extra when relevant: `pnpm audit:prod` / `pnpm audit:full` (dependency security), `pnpm perf:check`, `pnpm boundaries:check`, `pnpm --dir apps/desktop dist:ci`.

## Boundaries

**Always**
- Read files, list dirs, search the repo
- Run scoped lint / typecheck / unit tests for files you touch
- Preserve OpenCode-vs-composition ownership; change behavior in code/config, not prompt-only patches
- Prefer MCP tools over shell when a target system has an MCP
- Use design tokens / `@open-cowork/ui` for UI (no raw palette hard-codes)

**Ask first**
- Add/remove packages or change lockfile
- Full monorepo `pnpm build`, e2e, packaging, or release workflows
- Edit CI (`.github/workflows/**`), branch protection, or Helm/deploy topology
- Destructive git (`reset --hard`, force-push) or push without confirmation
- Flip private-beta go/no-go or marketing HA claims

**Never**
- Commit secrets, `.env*`, API keys, or real customer data
- Commit **audit artifacts** (dated “full audit”, surface audits, PR audit dumps under `docs/`, `docs/evidence/`, or similar). Audits are throwaway — leave them local or outside the repo
- Edit `node_modules/`, `dist/`, packaged `release/`, or generated design-token CSS by hand
- Mirror OpenCode runtime behavior in app code instead of composing the SDK
- Hard-code machine-local paths or silently rename public `open-cowork` back to `opencowork` outside back-compat IDs

## Project structure

| Path | Purpose |
| --- | --- |
| `apps/desktop/` | Electron shell, IPC, packaging |
| `packages/app/` | Renderer UI (React) |
| `packages/runtime-host/` | Runtime composition, session engine, workflows |
| `packages/shared/`, `packages/ui/` | Shared types/tokens and design system |
| `products/gateway/` | Durable Gateway (daemon, MCP, channels) — package `cowork-gateway` |
| `products/wiki/` | Wiki product |
| `packages/cloud-server/`, cloud scripts | Cloud control plane |
| `mcps/` | Bundled MCP servers |
| `docs/` | Product docs (MkDocs) — **not** audit dumps |
| `deploy/`, `helm/` | Deploy configs and private-beta package |
| `scripts/` | CI validators and repo tooling |
| `apps/desktop/runtime-config/AGENTS.md` | **Runtime agent** persona (shipped with app; not repo contributor rules) |

Entry points: `packages/runtime-host/src/runtime.ts`, `packages/runtime-host/src/session-engine.ts`, `packages/app/src/App.tsx`, `products/gateway/src/daemon.ts`.

## Code style

- TypeScript strict; match neighboring file style (quotes/semicolons)
- Prefer small, testable modules; respect module LOC budgets (`products/gateway/docs/development/module-boundary-budget.json`)
- Product UI language: **Projects / Team / Playbooks / Tools & Skills** (see `docs/glossary.md`); keep code ids (`workflows`, `agents`) when they are the API
- Import UI from `@open-cowork/ui`; icons via `Icon` / `docs/iconography.md`
- Prefer SDK-native OpenCode config over app-side reinvention

### Good

```ts
// Compose OpenCode; keep dual-intent explicit for unredacted dumps
return fetchJSON('GET', '/storage/export?localAdmin=true')
```

### Bad

```ts
// Parallel runtime or silent unredacted export
return fetchJSON('GET', '/storage/export')
```

## Testing & PR

- Add/update the **narrowest** test that proves the change (`*.test.ts` next to code or under `tests/`)
- Before commit: scoped tests green; for release-sensitive work: `pnpm lint && pnpm typecheck && pnpm test` (and `pnpm test:gateway` if gateway-touched)
- Commits: conventional, descriptive (`fix(gateway): …`, `docs: …`). PR titles: plain description — **no** `[codex]` / tool prefixes
- Diffs: small and focused; do not land throwaway audit markdown
- Required CI on `master` PRs: validate, cloud-gates, OS packages, docs, coverage — **not** CodeQL (monthly-only)

## Security

- Never log secrets, tokens, or PII; prefer redacted export defaults
- JOE-952 dual-intent: unredacted dumps need explicit `localAdmin=true` (or documented equivalent)
- Do not claim multi-AZ HA / private-beta **go** unless proving registry + private campaign evidence say so (`deploy/private-beta/`, gateway multi-writer hazards)

## When stuck

Ask a clarifying question or propose a short plan. Do not guess at release claims, OpenCode pin bumps, or HA posture.
