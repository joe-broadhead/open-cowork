# Release

OpenWiki is pre-release inside the open-cowork monorepo. Release claims must
describe the root workflows and executable validation that actually run.

## Active Monorepo Release Contract

| Surface | Status | Evidence |
| --- | --- | --- |
| Source checkout | Supported for evaluation | Root `.nvmrc`, pnpm `10.32.1`, Wiki typecheck and tests. |
| Personal wiki with local agents | Ready for private testing | Local stdio MCP in `read` or `proposal` mode. |
| Generated CLI tarball | Release candidate | Root `CI Wiki` packs and installs the tarball in a clean temporary npm project. |
| Tagged GitHub release asset | Supported release path | Root `Release Wiki` attaches the CLI tarball and `SHA256SUMS` for `wiki@v*` or `wiki-v*` tags. |
| Static export | Supported output | Generated public HTML and machine-readable artifacts; private content is filtered. |
| npm registry package | Not published | `@openwiki/cli` is only the identity inside the generated tarball today. |
| Other packaged deployment channels | Not supported | No container or provider-platform artifact is released. |
| npm library packages | Not released | Workspace libraries remain private. |

Do not claim an npm release, container image, hosted capacity, or provider
validation until a root workflow produces immutable
evidence for the candidate revision.

## Active Validation Matrix

| Gate | Active workflow or command |
| --- | --- |
| Product boundaries | `pnpm boundaries:check` |
| Supported runtime | Root `.nvmrc`; package engine `>=22.22.3`; pnpm `10.32.1` |
| Type safety | `pnpm --filter cowork-wiki-workspace typecheck` |
| Unit and integration behavior | `pnpm --filter cowork-wiki-workspace test` |
| CLI artifact | `pnpm --filter cowork-wiki-workspace pack:cli` |
| Clean install smoke | `node products/wiki/scripts/standalone-smoke.mjs` |
| Documentation | `pnpm --filter cowork-wiki-workspace docs:build` |
| Security boundaries | `pnpm --filter cowork-wiki-workspace test:security` |
| Dependency audit | Root `pnpm audit:full` |
| Scale smoke | `pnpm --filter cowork-wiki-workspace perf:check` |
| Inbox agent orchestration | From `products/wiki`, run `pnpm eval:inbox-agents -- --json`; inspect the `openwiki.inbox_agent_evals.v1` report as private evaluation evidence. |
| PR/default-branch gate | `.github/workflows/ci-wiki.yml` (`CI Wiki`) |
| Tag artifact gate | `.github/workflows/release-wiki.yml` (`Release Wiki`) |

`Release Wiki` runs boundaries, typecheck, tests, CLI packing, and standalone
install smoke. On a supported tag it
attaches the tarball and checksum file to a GitHub release. It does not publish
to npm or build a container.

## Release And Tag Checklist

Before creating a Wiki tag:

- start from a clean checkout of the exact candidate SHA
- use the root `.nvmrc` and pnpm `10.32.1`
- run `pnpm boundaries:check`
- run Wiki typecheck, tests, docs build, and security tests
- run the root production dependency audit
- build the CLI tarball and run the standalone install smoke
- verify `CI Wiki` passed on the same SHA
- use a `wiki@v*` or `wiki-v*` tag and confirm `Release Wiki` passes
- verify the GitHub release contains exactly the expected tarball and
  `SHA256SUMS`
- install that attached tarball in a clean environment and run `openwiki
  self-check`
- keep npm-registry, container, hosted-capacity, and external-provider claims absent unless
  independently proven

The workflow's emergency `skip_tests` input weakens evidence. Do not use it for
a normal candidate or describe a skipped run as release-qualified.

## Public Announcement Checklist

Public copy must link the exact GitHub release and checksum, identify the CLI
  tarball as a release candidate, and say that npm and container distributions
  are unavailable. Hosted write paths still require an explicit authentication
  and network boundary; follow `docs/deployment/hosted-human-agent.md`.

## Dogfood And Private Validation Checklist

For a private dogfood wiki:

1. Initialize with `--template personal-wiki`.
2. Run `openwiki index` and `openwiki db rebuild`.
3. Serve on `127.0.0.1` until auth and networking are explicitly configured.
4. Connect agents through local stdio MCP in `proposal` mode.
5. Ask agents to search, read, propose, and inspect proposal detail.
6. Review and apply proposals manually before granting write mode.

Do not expose a write-capable server directly to the internet. Use static
export for public read-only content, or put the server behind an authenticated
boundary with `OPENWIKI_PUBLIC_ORIGIN` configured.

## Post-Release Verification

After `Release Wiki` completes:

1. Download the tarball and `SHA256SUMS` from the GitHub release.
2. Verify the checksum before installation.
3. Install into a clean temporary npm project and run version and self-check.
4. Confirm the release notes repeat the current support boundary.
5. Record any failed or flaky gate as a linked follow-up; do not hide it behind
   a rerun.
