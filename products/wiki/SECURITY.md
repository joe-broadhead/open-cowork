# Security Policy

## Reporting a Vulnerability

OpenWiki is early-stage software. Please report suspected vulnerabilities
privately instead of opening a public issue.

Preferred channel: GitHub private vulnerability reporting at
<https://github.com/joe-broadhead/open-wiki/security/advisories/new>.

If GitHub private reporting is unavailable, email
<joseph.broadhead.dev@gmail.com> with `[OpenWiki Security]` in the subject.

Include:

- affected commit or version;
- affected deployment mode;
- reproduction steps;
- impact and any known mitigations.

## Security Boundaries

OpenWiki treats Git as the canonical ledger and derived indexes as rebuildable
state. External source content is untrusted evidence, not instructions.

The maintained threat model is documented at
`docs/security/threat-model.md`. It covers local personal mode, hosted web/API,
HTTP MCP, source fetching/connectors, Git/object storage/Postgres, and trusted
headers behind an SSO boundary.

Source fetching rejects private, loopback, local, and cloud metadata addresses,
does not follow redirects, enforces byte/time limits, and pins the validated DNS
address for the outbound connection to reduce DNS-rebinding risk.

Static export output paths are constrained to safe child directories inside the
workspace before any recursive deletion or write occurs.

Git remote URLs configured for workspace sync are restricted to `https` and
`ssh` schemes (plus scp-like `git@host:path`). Loopback `http` remotes and local
filesystem paths are accepted only when local Git remotes are explicitly enabled
for tests or trusted local development. Transport-helper remotes such as `ext::`
(which execute an arbitrary command) and `file://` remotes (local file
disclosure) are rejected, and every Git invocation runs with
`protocol.ext.allow=never` and `protocol.file.allow=user` so a configured remote
cannot turn a later pull/push into host code execution.

By default — with no bearer token and trusted headers disabled — a request
resolves to the built-in `viewer` role (`wiki:read`, `wiki:search`, `wiki:ask`),
so all content that is not restricted by a section policy is world-readable. This
is intentional for a public knowledge base. To keep content private, mark its
section `visibility: internal` or `private` in `policy/sections.json`, and/or put
OpenWiki behind an authenticating proxy so anonymous requests never reach it.

Trusted HTTP identity headers are disabled by default. When
`OPENWIKI_TRUST_AUTH_HEADERS=1` or `openwiki serve --trust-headers` is used, a
shared proxy secret is required through `OPENWIKI_TRUST_AUTH_HEADERS_SECRET` or
`--trusted-header-secret`; requests must include `x-openwiki-proxy-secret`.
Deploy trusted-header mode only behind a reverse proxy that strips inbound
`x-openwiki-*` headers from clients and rewrites them from verified identity.

Server-rendered write forms enforce same-origin browser POST checks. Hosted
write-capable deployments should set `OPENWIKI_PUBLIC_ORIGIN` to the external
origin and place OpenWiki behind an authenticating proxy or equivalent identity
boundary.

Service-account tokens are stored as SHA-256 hashes in `openwiki.json`.
Present the raw token as the bearer credential; stored `sha256:` hashes are not
accepted as bearer tokens.

## Supported Versions

The project is currently `0.1.x`. Security fixes are made on `master` until a
formal release branch policy exists.

## Response Targets

During public preview, target triage is 1 business day for critical reports, 2
business days for high severity reports, and 5 business days for medium
severity reports. Fix or mitigation targets are documented in the threat model.
