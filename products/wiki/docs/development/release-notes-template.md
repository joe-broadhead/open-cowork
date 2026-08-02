# Release Notes Template

Use this template only for the active monorepo Wiki release path.

## OpenWiki vX.Y.Z

Release date: YYYY-MM-DD

Git tag: `wiki@vX.Y.Z`

Candidate commit: `<full SHA>`

`Release Wiki` run: `<workflow URL>`

CLI artifact: `openwiki-cli-X.Y.Z.tgz` (`sha256:<tarball-sha256>`)

## Supported Surfaces

- Source checkout at the candidate commit.
- Generated CLI tarball attached to this GitHub release.
- Static-export output produced by that CLI.

Other package channels, hosted deployment artifacts, and hosted capacity are
not part of this release.

## Highlights

- <human-facing product or release highlight>
- <agent/MCP capability highlight>
- <security, reliability, or operations highlight>

## Compatibility

- Node.js: `>=22.22.3`; CI uses the exact root `.nvmrc` version.
- Package manager for source checkouts: pnpm `10.32.1`.
- npm library packages: not released.

## Verification Checklist

- [ ] Root `CI Wiki` passed on the candidate commit.
- [ ] Root `Release Wiki` passed without `skip_tests`.
- [ ] The attached tarball and `SHA256SUMS` came from that run.
- [ ] The checksum verifies after downloading the GitHub release assets.
- [ ] A clean temporary npm project installed the tarball and passed
      `openwiki --version`, `openwiki self-check`, and the standalone smoke.
- [ ] Wiki typecheck, tests, docs build, security tests, and the root production
      dependency audit passed.
- [ ] Static export produced HTML plus `openapi.json`, `mcp-manifest.json`,
      `search-index.json`, and JSONL artifacts without private content.
- [ ] Release copy contains no registry, container, hosted-capacity, or
      external-provider claim without separate immutable evidence.

## Security Posture

- Threat model: `docs/security/threat-model.md`.
- Human auth: trusted SSO/reverse-proxy boundary; no native login in this
  release.
- Agent auth: service-account bearer tokens with read/proposal/write tool modes
  and policy scopes.
- Browser writes: same-origin protection with `OPENWIKI_PUBLIC_ORIGIN`.
- Source fetches: SSRF controls, redirect blocking, timeouts, byte limits, and
  connector credential refs.

## Known Limitations

- Local filesystem mode is not a clustered multi-writer store.
- Write-capable HTTP and MCP endpoints must not be exposed publicly without an
  authenticated ingress boundary.

## Upgrade Notes

- <required operator action, if any>
