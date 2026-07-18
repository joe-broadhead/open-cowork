# Testing And Release

## Verification

```bash
npm run verify
```

`verify` runs:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `npm run release:check`
5. `npm run validation:check`
6. `npm run evidence:safety`

Use [`validation-gates.json`](validation-gates.json) as the source of truth when deciding which gates are required for a change. The map records each gate's command, expected runtime, required environment, failure class, evidence kind, claim effect, and CI skip semantics.

```bash
npm run validation:check
```

`npm run verify` includes `validation:check`. Run `npm run validation:check` separately when you need focused validation-map feedback before the full verify plan or whenever `validation-gates.json` or gate commands change.

Use the validation selector before final evidence to turn changed files into an exact local gate list:

```bash
npm run validation:select -- --base origin/main
npm run validation:select -- --files docs/index.md mkdocs.yml --json
```

The selector does not run gates. It reports focused commands, whether `npm run verify` is mandatory, warning-only runtime budgets, and the local-only read-only review-gate requirement. Unknown paths and shared runtime or validation infrastructure changes fail closed to the conservative set, including `npm run verify`. Record the selector output in Linear when it materially explains why focused gates were enough or why full verify was required.

Run the local-only read-only review gate (the `gateway-review-gate` skill) after validation, against
the final committed diff from the latest `origin/main`. It must return `PASS`. If it is unavailable or
non-passing, stop instead of requesting PR review or merge.

## Release Artifact Evidence

```bash
npm run release:artifacts
```

`release:artifacts` is the mandatory local package-evidence check for the current public-beta
release path. The unscoped package is intentionally `private`; this check creates a local `npm pack`
tarball in a temporary directory, records package file count,
size, and sha256 evidence, verifies required files and forbidden file classes, checks package and
lockfile alignment, confirms built CLI/MCP artifacts exist, verifies package-file allowlist,
checks dependency license posture across the package-lock package closure, and verifies install,
update, and CI documentation still name the actual local commands.

The command prints a human-readable checklist by default and supports `--json` for evidence capture.
Mandatory failures block release wording and include a safe next action. Advisory rows are explicit
but do not block the local beta release check by themselves:

- `npm_audit_high` is skipped unless `M40_RUN_NPM_AUDIT=1 npm run release:artifacts` is used,
  because registry-backed audit evidence is intentionally separated from deterministic local checks.

Signed image provenance is mandatory for tagged image releases. CI pushes an untagged digest,
smokes and scans that exact digest, signs it, and publishes and verifies its SLSA provenance
attestation. It then creates a draft GitHub release containing the signed checksum manifest,
installer, and source archive; downloads the assets and validates their exact bytes, checksums, and
signature; promotes the non-overwritable full-version and commit-SHA image tags; updates mutable
major/minor and `latest` aliases; and publishes the validated draft last. The private npm/package artifact remains local
`npm pack` sha256 evidence; no npm marketplace publication or provenance is claimed.

`release:artifacts` remains a standalone local gate; `npm run release:check` does not run it for you.
Tagged CI also runs it in the `docker-publish` path before image publication, signing, attestation,
or GitHub release creation. Do not cite package integrity, dependency posture, or
signed-distribution evidence unless this check has run locally or in the relevant tagged CI evidence
with the mandatory/advisory rows captured.

## Performance Budget Evidence

```bash
npm run performance:budgets
opencode-gateway performance budgets --json --fail-blocked
```

The performance budget report verifies bounded local operator surfaces with deterministic
fixtures: Mission Control windows, queue/run windows, channel status, readiness queue state,
proof/evidence export windows, and incident/support bundle windows. Failures name the budget
and safe next action.

This is configured local budget evidence only. It does not prove arbitrary scale, hosted/team
performance, live hundreds-agent operation, universal-channel parity, managed support, compliance,
or unattended production operation. See the canonical
[Release Claim Boundary](../operations/public-threat-model.md#release-claim-boundary).

## Release Check

`scripts/check-release.mjs` verifies:

- `package.json`, the package-lock root, and one exact `## vX.Y.Z` changelog heading match.
- Tagged mode requires the workflow tag to equal `v${package.version}`, resolve to workflow `HEAD`, and be an ancestor of fetched `origin/main`.
- The claim registry (`src/claim-registry.ts`, via `opencode-gateway release claims --json`) passes its own invariants.
- Public copy (README, every `docs/**/*.md` file, and CLI help when obtainable) contains no wording that exceeds the current claim boundary.
- The built CLI (`dist/cli.js`) exists and reports the aligned version.

Validation-map and evidence-safety checks run through `npm run verify` and can also be run directly
as `validation:check` and `evidence:safety`. Module-boundary, release-artifact, and
performance-budget checks remain standalone gates (`boundaries:check`, `release:artifacts`,
`performance:budgets`) unless a focused test or CI path explicitly names them.

## CI Gates

The GitHub Actions workflow in `.github/workflows/ci.yml` is part of the release contract:

- `test` runs `npm ci --ignore-scripts`, explicitly rebuilds the audited native helper, and runs `npm run verify`.
- `docs` installs `docs/requirements.txt` and runs `mkdocs build --strict`.
- `security-scan` runs Trivy filesystem vulnerability, secret, and misconfiguration scans once per workflow.
- `docker-pr` depends on `test`, `docs`, and `security-scan`, then reruns `npm run release:check` before building, smoking, and scanning the image.
- `required` always fans in `workflow-lint`, the full test matrix, docs, security scan, and `docker-pr`; it requires Docker success on pull requests and permits only the intentional `docker-pr` skip on non-PR pushes/tags. Main branch protection requires this stable check name.
- `docker-publish` is tag-only and uses the `production-release` environment. It binds the exact tag to package/changelog/main, runs release artifacts, stages an untagged digest, then smokes, scans, signs, attests, and verifies it without creating public image tags.
- `release` is tag-only, uses the same environment, creates and revalidates a draft signed release bundle, promotes immutable full-version and commit-SHA image tags before mutable aliases, and publishes the GitHub release last. Tag workflows share a non-canceling concurrency group, so a newer run cannot interrupt publication halfway through.

CI status is not a single proof class:

| Gate | Pull Request Meaning | Release-Claim Meaning |
| --- | --- | --- |
| `workflow-lint` | Required CI gate. | Proves workflow syntax only. |
| `test` / `npm run verify` | Required CI gate for typecheck, tests, build, release contract. | Supports merge readiness for covered local behavior; does not prove live channels, elapsed soak, hosted/team, or production readiness. |
| `docs` | Required CI gate for strict MkDocs. | Proves docs render and links/navigation are consistent. |
| `security-scan` | Required CI gate for filesystem vulnerability, secret, and misconfiguration scanning. | Supports source/config hygiene; it is not image-publication proof. |
| `docker-pr` | Required PR build/smoke/scan without publishing. | PR Docker success is container-smoke evidence, not image-publication proof. |
| `required` | Stable required status for branch protection; matrix job names may evolve behind it. | A fan-in result, not additional runtime evidence. |
| `docker-publish` | Skipped on pull requests and branch pushes; tag-only. | Publishes only an untagged digest after smoke, scan, signature, attestation, and verification; it creates no public aliases. |
| `release` | Skipped on pull requests and branch pushes; tag-only. | Validates the signed draft bundle before immutable/mutable image promotion and publishes the release only after alias verification. |
| `local-readonly-review-gate` | Manual/local hard gate before PR review or merge. | Required coordinator evidence; not a GitHub CI job. |
| `elapsed-soak` | Manual/local elapsed evidence. | Synthetic CI cannot replace real elapsed soak time. |

Quick-mode synthetic scale timings are recorded as evidence, but their runtime budgets are advisory under shared-suite load. Use hundreds or extended mode when the change needs stricter benchmark evidence.

## Tests

Tests are in `src/__tests__/` and use Vitest.

```bash
npm test
npm run test:watch
```

## Interface-Level Fakes

Prefer fakes at stable module seams when a behavior is otherwise only testable by constructing a
large work-store history, live provider adapter, filesystem layout, or OpenCode session. A useful
fake should keep the production domain language visible and preserve the constraints the caller
depends on: ordering, limits, dedupe/idempotency, redaction posture, failure shape, and capability
boundaries.

Current examples:

- `src/__tests__/helpers/fake-delegation-progress-read-model.ts` implements the
  `DelegationProgressReadModel` seam for progress route tests. It can model pruned event windows,
  duplicate progress keys, delivery receipts, timeout retry cooldowns, stale parent sessions,
  orphaned parent anchors, and retried route receipts without live channels or hand-built SQLite
  histories.
- `src/__tests__/helpers/adapter-fixtures.ts` keeps channel adapter rendering fixtures shared
  across provider tests.

Do not add a fake for a one-off assertion. Add one when at least two tests or future workers need
the same behavior and the fake makes the production seam clearer.

## Team Orchestration Coverage

Team assembly, assignment, orchestration-kernel, and progress behavior are covered by the standard
Vitest suite:

```bash
npm test
```

The relevant deterministic tests are `src/__tests__/team-assembly.test.ts`,
`src/__tests__/team-assignment.test.ts`, `src/__tests__/team-progress.test.ts`, and
`src/__tests__/orchestration-kernel.test.ts`. They run as part of `npm run verify`, so a regression in
team orchestration fails the standard gate before any release copy can expand agent-quality claims.

## Docs Build

```bash
uv venv
uv pip install --require-hashes -r docs/requirements.txt
uv run mkdocs build --strict
```

`docs/requirements.in` contains direct pins. `docs/requirements.txt` is the complete Python 3.12 transitive lock with hashes. Regenerate it only with the command recorded at the top of that file, review the resolved diff, and keep CI in `--require-hashes` mode.

## Release Flow

This repository uses protected `main` as the release branch. Repository rules require pull requests, the stable `required` check, linear history, resolved conversations, and prohibit force-push/delete. An active ruleset makes `v*` tags immutable. The `production-release` environment permits only `v*` refs.

The private-repository plan does not provide environment required reviewers or wait timers. Creating and pushing an immutable `v*` tag is therefore the **manual release authorization**. Create it only from a reviewed protected-main commit after package, lockfile, and exact changelog heading are merged:

```bash
git switch main
git pull --ff-only
VERSION="$(node -p "require('./package.json').version")"
npm run build
npm run release:check
git tag -a "v$VERSION" -m "Release v$VERSION"
git push origin "v$VERSION"
```

Tagged CI still fails closed unless the tag is exactly `v${package.version}`, the changelog has one exact release heading, tag commit equals workflow `HEAD`, that commit is on fetched protected `origin/main`, and digest/release assets pass checksum, smoke, Trivy, signature, and attestation gates. The named environment scopes deployment but is not a second human approval under the current plan.
