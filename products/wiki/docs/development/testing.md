# Testing

Core checks:

```sh
pnpm typecheck
pnpm test
pnpm test:security
pnpm lint
pnpm coverage
pnpm docs:build
pnpm docs:reference -- --check
pnpm validate
pnpm test:ui
pnpm test:ui-quality
pnpm check:bundle
pnpm eval:enterprise-demo -- --json
pnpm release:evidence
```

`pnpm test:security` is the focused boundary suite. It covers path traversal,
Git option injection, SSRF/source-fetch redirects, trusted-header spoofing,
CSRF/origin checks, token leakage, oversized body/depth limits, and MCP auth
denial. The full `pnpm test` command also runs this file.

`pnpm docs:reference -- --check` regenerates the CLI, MCP, operation, schema,
package API, error model, and compatibility references in memory and fails when
checked-in docs have drifted from the current command/tool/schema definitions.

`pnpm docs:build` runs the strict MkDocs build through `python3 -m mkdocs`, so
it does not depend on a Python scripts directory being on `PATH`.

`pnpm lint` is the low-churn contributor lint gate. It intentionally uses the
strict TypeScript compiler, the module-size budget, and Knip's unused-file and
dependency scanner instead of a broad formatter or style linter. That keeps PRs
focused on semantic issues while still catching compiler-visible dead code,
orphaned files, and stale package dependencies. Knip is configured to ignore
runtime-copied browser client assets and OpenCode integration-pack files because
those are installed or copied by OpenWiki rather than imported by Node.

Root production dependencies are intentionally limited to source-run launcher
requirements that must survive Docker `pnpm prune --prod`; today that is
`tsx`. Runtime dependencies for OpenWiki packages belong in the workspace
package that imports them, and `tests/package-dependencies.test.ts` fails when a
new root runtime dependency is added without changing that policy.

`pnpm coverage` runs the same Node test inventory with Node's built-in V8 test
coverage enabled. It writes `artifacts/coverage/openwiki-coverage.txt` and raw
V8 coverage JSON under `artifacts/coverage/v8/`. The current pre-1.0 thresholds
are 80% lines, 75% functions, and 65% branches across `packages/**/*.ts`; raise
them when low-coverage adapter seams are replaced with focused unit tests.

`pnpm validate` remains the fast local correctness gate (`typecheck` + `test`).
Before opening a production hardening PR, run `pnpm lint`, `pnpm coverage`,
`pnpm docs:reference -- --check`, `pnpm test:ui`, `pnpm test:ui-quality`, and
`pnpm check:bundle` as well.

`pnpm eval:enterprise-demo` generates a deterministic enterprise wiki and checks
the personal-release risk areas together: Spaces and permission filtering, MCP
read/proposal modes, server UI routes, public static export filtering, and
backup/restore. Use it before release candidates and whenever agent workflows or
permission behavior changes.

## Heavyweight Evals

Run heavyweight evals serially on local machines. `pnpm validate` already runs
the full test suite, so avoid starting another `pnpm test`, UI smoke,
screenshot, dogfood, or eval command against the same checkout at the same time.
Those gates use temporary Git workspaces, derived stores, and write leases; CI
runs them in ordered jobs, but overlapping local runs on constrained machines
can turn a real contention guard into noisy `runtime_busy` failures.

Use setup-only provider evals in ordinary PR validation:

```sh
pnpm eval:mcp-conformance
pnpm eval:inbox-agents
pnpm eval:opencode-tools -- --setup-only
```

The OpenCode setup-only eval writes
`evals/opencode-tool-coverage/latest.json` without requiring provider
credentials or the private/local `opencode-tools` recorder plugin. The JSON
report includes `seed.recorder_plugin.skipped: true`,
`seed.recorder_plugin.skip_category: "setup_only"`, recorder availability, and
the checked recorder candidate paths so CI can prove the integration pack,
temporary wiki, MCP config, and seed fixtures still assemble cleanly.

Run full provider-backed OpenCode evals only when credentials and model budget
are intentionally configured, and keep their JSON artifacts with release
evidence rather than treating them as required for every small PR. Full
OpenCode evals resolve the generic recorder in this order:
`OPENCODE_EVAL_RECORDER_PLUGIN`, repo-local
`.opencode/plugins/opencode_eval_recorder.ts`, sibling
`../opencode-tools/plugins/opencode_eval_recorder.ts`, then installed
`@joe-broadhead/opencode-tools/plugins/opencode_eval_recorder.ts`. A missing
explicit `OPENCODE_EVAL_RECORDER_PLUGIN` is a setup error, not a silent
fallback.

Unit tests can live beside the package they cover under
`packages/<name>/test/*.test.ts`. Cross-package and integration tests continue
to live in `tests/*.test.ts`. The root `pnpm test` command runs both layouts so
new package-level coverage does not require a separate command.

The UI scripts can also run against that corpus:

```sh
OPENWIKI_UI_FIXTURE=enterprise-demo pnpm test:ui
OPENWIKI_UI_FIXTURE=enterprise-demo pnpm test:ui-quality
```

Postgres integration tests require `DATABASE_URL`:

```sh
DATABASE_URL=postgres://... pnpm test:postgres
```

Deployment changes should render and smoke-test the relevant Docker, Compose,
Kubernetes, Helm, or Terraform artifacts.

For Kubernetes changes, use the kind smoke helper:

```sh
pnpm smoke:kubernetes
OPENWIKI_KIND_SMOKE=1 pnpm smoke:kubernetes
```

The default command records the planned kind/kubectl commands without touching a
cluster. Setting `OPENWIKI_KIND_SMOKE=1` creates or reuses a kind cluster,
applies `deploy/kubernetes/base`, waits for the OpenWiki deployment rollout, and
writes `artifacts/openwiki-kind-smoke.json`.

Performance checks:

```sh
pnpm perf:check
pnpm perf:scale:10k
pnpm perf:scale:100k
```

`perf:check` is the blocking 1k smoke gate. The 10k and 100k commands run in
benchmark mode and write JSON reports under `artifacts/`; set
`OPENWIKI_SCALE_ENFORCE=1` when a benchmark should fail the local command on a
budget miss.

Release evidence:

```sh
pnpm release:evidence
```

This writes `artifacts/openwiki-release-evidence.json` with the current commit,
local gate list, CI workflow inventory, generated perf/UI artifacts, deployment
render or validation evidence under `artifacts/deployment/`, and the explicit
note that tag creation and release workflow execution are separate release-time
actions.
