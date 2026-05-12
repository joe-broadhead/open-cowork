# Operations and CI

This page is the operator-facing map of the repository automation:
what runs, when it runs, and what each workflow is expected to prove.

## Workflow summary

| Workflow | Trigger | What it proves |
|---|---|---|
| `ci.yml` | push to `master`, pull requests | lint, tests, typecheck, perf gate, docs build, unpackaged + packaged macOS smoke tests, macOS and Linux packaging sanity |
| `codeql.yml` | push to `master`, pull requests, weekly schedule | static analysis over the TypeScript / Electron codebase using CodeQL security + quality queries |
| `docs.yml` | push to `master`, manual dispatch | MkDocs builds cleanly and the published docs site can be deployed to GitHub Pages |
| `release.yml` | version tags (`v*`) | release artifacts build, macOS packaged smoke passes, signing policy is enforced, checksums are generated, SBOMs are attached, provenance is published |
| `monthly-maintenance.yml` | first day of each month, manual dispatch | dependency audit state, outdated packages, pinned-SDK health, advisory latest-SDK compatibility |

## CI quality bar

The main CI workflow is the public merge gate. A pull request is not
ready to merge unless it survives:

- `pnpm audit --prod --audit-level high`
- CodeQL on `master`, pull requests, and the weekly schedule
- `pnpm lint`
- `pnpm lint:a11y --max-warnings=0`
- `git diff --check`
- `pnpm test`
- `pnpm test:renderer`
- `pnpm typecheck`
- `pnpm perf:check`
- `mkdocs build --strict`
- `pnpm test:e2e` on macOS
- `pnpm --dir apps/desktop dist:ci:mac`
- `pnpm --dir apps/desktop test:e2e:packaged` on macOS
- `pnpm --dir apps/desktop dist:ci:linux`

That combination is intentional: it covers code quality, docs quality,
desktop boot health, and packaging sanity in one place.

## Docs deployment

The docs site is built from `docs/` with MkDocs Material and deployed to
GitHub Pages.

Key characteristics of the docs deploy:

- the build is strict, so stale nav entries and malformed Markdown fail fast
- the workflow uploads the generated `site/` directory as a Pages artifact
- deployment happens from GitHub Actions rather than a generated commit pushed back into the repo

Local equivalent:

```bash
python -m pip install -r docs/requirements.txt
mkdocs build --strict
```

## Release automation

Release tags (`vX.Y.Z`) trigger the release workflow.

The release pipeline currently guarantees:

- macOS zip + dmg artifacts
- Linux AppImage + deb artifacts
- packaged macOS smoke validation against the built `.app`
- `SHA256SUMS.txt`
- CycloneDX and SPDX SBOMs
- GitHub build provenance attestation

The release workflow now enforces one of two explicit modes:

- signed macOS artifacts when the required signing/notarization secrets are present
- unsigned preview artifacts only when the `OPEN_COWORK_ALLOW_UNSIGNED_RELEASES`
  repository variable is deliberately enabled

For a truly public production release, keep the signed path configured
and treat the unsigned override as preview-only:

- macOS signing
- macOS notarization
- any Linux package-signing or mirror steps your distribution requires

## Monthly maintenance

The repository no longer uses a nightly maintenance cadence. Scheduled
automation runs monthly so the project gets a predictable maintenance
window without constant background churn.

That monthly window includes:

- Dependabot PRs for npm dependencies
- Dependabot PRs for GitHub Actions SHA bumps
- the monthly maintenance workflow's audit and paired OpenCode package
  drift checks

This keeps the repository healthy while leaving day-to-day CI focused on
real product changes.

OpenCode runtime drift is checked by probing the latest paired
`@opencode-ai/sdk` and `opencode-ai` packages together. Treat a failure
there as an upstream compatibility signal: either bump both packages in
one release branch and rerun the full suite, or keep the current pins
with an explicit release note.

## Product Operations Registry

The desktop operations namespace exposes a read-only governance registry for
admin surfaces. It projects existing Open Cowork metadata into one dependency
map without changing OpenCode execution:

- the local organization/tenant identity plus the local user principal, group
  membership, and role grants that policy decisions use today
- agents and crews with owner, lifecycle, scope, memory boundary, and
  offboarding path
- credential bindings derived from integration credential dependencies, without
  exposing secret names or values
- governed memory entries as registry subjects, with quarantine controls for
  approved memory
- direct dependencies on member agents, tools, skills, memory entries,
  workspace profiles, SOPs, channel routes, integration credentials, and eval
  suites
- transitive dependencies such as skill-linked tools, integration credentials
  needed by those tools, SOP/channel exposure for workflow agents, and crew
  member capabilities
- eval-suite dependencies use the stored suite name and lifecycle state when
  available, so admin views can distinguish active certification gates from
  draft or retired suites
- memory dependencies use the governed memory lifecycle, so quarantined memory
  remains visible in the map without being treated as an active requirement
- execution-node readiness for the local desktop runtime, including which
  scheduling, queue recovery, trigger, cost-governance, and background
  execution capabilities are available today
- incident-control metadata that distinguishes actions available today from
  controls planned in later governance slices

The first active incident controls are crew lifecycle controls, custom-agent
pause/retire controls, tool revocation, and governed-memory quarantine. Each
control is checked by a local governance policy before any mutation. The default
desktop actor is the local admin principal, while the registry also exposes
owner, approver, and viewer role requirements so future organization surfaces
can render the same policy. The local admin principal belongs to the local
administrators group, and group owners/approvers authorize matching members in
the same way direct user owners/approvers do. Denied controls write a failed
governance audit event and leave the subject unchanged.

Admin surfaces can pause or retire a crew through the operations namespace;
paused or retired crews keep their history and registry entry but cannot start
new runs. The older `crews` namespace remains available for crew-page
compatibility, but governance surfaces should use `operations` so incident
controls share one policy and audit boundary. Admin surfaces can pause or retire
a custom agent through the operations namespace; pausing disables the generated
OpenCode agent config, while retiring removes the custom agent from user-managed
runtime content. Admin surfaces can revoke a tool through the operations
namespace; Open Cowork records the revocation as governance policy, feeds deny
patterns into the generated OpenCode permission config, reboots the managed
runtime so the SDK sees the new policy, and marks matching tool dependencies as
revoked in the registry. Project-scoped custom MCP revocations keep their
project directory identity, so the deny policy only applies when building that
project's runtime config. Admin surfaces can also quarantine an approved memory
entry through the operations namespace; quarantined memory stays inspectable and
auditable but is excluded from future memory injection.

Each control writes a durable governance audit event with actor, action,
before/after lifecycle state, subject id, bounded metadata, and the policy
decision that allowed or denied the action. Admin surfaces can query those
events through the operations namespace. The export path emits a typed audit
stream as deterministic NDJSON or OpenTelemetry-shaped JSON and covers
governance incidents, crew traces, approvals, policy decisions, tool-call trace
records, channel/automation deliveries, and outcome evaluations.

Pulse summarizes this registry in its Operations card, including the active
local organization, governed agent and crew counts, dependency breadth, eval
gates, execution-node readiness, and available incident controls. It also lists
the highest-impact dependency links with the affected governed subjects, so an
operator can see which agents or crews rely on a tool, memory, credential,
channel, SOP, or eval gate without exporting the raw registry first. Available
incident controls can be run from Pulse with confirmation, using the same
operations IPC methods and audit trail as the lower-level admin APIs. Operators
can review the most recent incident outcomes in Pulse, or copy the full audit
stream as NDJSON for review or OTel-shaped JSON for telemetry pipelines.

Use the registry as the control-plane inventory for Pulse and future admin
views. Execution still flows through OpenCode sessions, tools, skills, and MCPs.

## Recommended operator routine

If you are responsible for keeping the repository release-ready:

1. Keep `master` green in CI.
2. Review monthly maintenance output and dependency PRs promptly.
3. Make sure the GitHub Pages docs site matches the current repo state.
4. Before tagging, run the full [Release Checklist](release-checklist.md).
5. Treat any unsigned release override as preview-quality until signing and notarization are configured.
