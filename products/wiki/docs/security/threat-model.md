# OpenWiki Threat Model

Status: public preview baseline for OpenWiki v0.1.x.

This document defines the security boundaries OpenWiki relies on before a
deployment is treated as production-like. It covers personal local use, hosted
human access, hosted HTTP MCP access for agents, source fetching, and the
derived serving layers around Git.

## Goals

- Keep Git-backed wiki content and proposal history trustworthy.
- Prevent unauthenticated public writes in every default deployment path.
- Keep private space content out of public static exports and unauthorized
  search, graph, MCP, and HTTP responses.
- Treat external source content as untrusted evidence, not executable
  instructions.
- Keep service-account tokens, connector credentials, storage credentials, Git
  credentials, and proxy shared secrets out of repository files, logs, static
  exports, and generated manifests.
- Make security regressions visible in CI before public preview releases.

## Non-Goals

- Native username/password login, browser sessions, or a general IdP product.
  Hosted human access uses a trusted SSO or reverse-proxy boundary. The hosted
  OAuth provider is limited to remote MCP/API bearer-token issuance.
- Formal SOC 2, ISO 27001, or FedRAMP compliance. This preview defines the
  controls and evidence needed to move toward those programs.
- Multi-writer Git safety across arbitrary network filesystems without a
  coordinator. Hosted writes should use the Postgres write coordinator.

## Assets

| Asset | Security property |
| --- | --- |
| Git repository | Canonical records, proposal history, policy, and audit events must not be corrupted by untrusted input. |
| Spaces and policy | Private/internal/public visibility must be enforced consistently across CLI, HTTP, MCP, search, graph, and static export. |
| Service-account and OAuth tokens | Raw tokens are one-time bearer secrets. Only hashes and redacted token metadata may persist. |
| Trusted identity headers | `x-openwiki-*` identity headers are trusted only when the proxy shared secret is valid. |
| Source connector credentials | `credential_ref` values may persist; raw secrets must remain in env, platform secrets, or secret stores. |
| Object storage | Captured large source content must stay content-addressed and must not expose storage access keys. |
| Postgres | Derived serving data, queues, and write leases must be rebuildable from Git and protected from direct public access. |
| MCP tool access | Agents get human-equivalent scoped abilities, not a bypass around policy. |

## Trust Boundaries

### Local Personal Mode

Default local use binds to loopback and is intended for one user and local
agents. The user controls the filesystem, Git checkout, and local agent
configuration. The main risks are accidentally exposing a write-capable server
on a public interface, granting agents write mode too early, and leaking raw
tokens through shell history or process lists.

Controls:

- `openwiki serve` defaults to `127.0.0.1`.
- Local agent setup starts from stdio MCP and proposal mode.
- CLI token flows reject raw token input on command lines and prefer env/file
  handoff.
- Write mode remains explicit.

### Hosted Web And HTTP API

OpenWiki does not authenticate humans directly. A hosted deployment must sit
behind SSO, an identity-aware proxy, or an equivalent boundary. Browser writes
are only safe when `OPENWIKI_PUBLIC_ORIGIN` matches the external HTTPS origin
and the proxy strips inbound spoofed identity headers.

Controls:

- Trusted auth headers are disabled by default.
- `OPENWIKI_TRUST_AUTH_HEADERS=1` requires
  `OPENWIKI_TRUST_AUTH_HEADERS_SECRET`.
- `OPENWIKI_TRUST_PROXY_ORIGIN=1` requires
  `OPENWIKI_TRUST_PROXY_ORIGIN_SECRET` or the trusted-header secret.
- Server-rendered write forms require same-origin browser POSTs.
- CORS does not default to `*`.
- Hosted deployments should enable rate limits and structured request logs.

### HTTP MCP For Agents

Hosted HTTP MCP is an API boundary for agents. Agents authenticate with
service-account bearer tokens or OAuth bearer tokens and select tool modes
(`read`, `proposal`, or `write`). Tool mode alone is not authorization; it is
combined with role, scope, actor, policy checks, and optional policy bounds.

Controls:

- Proposal and write tools are hidden and denied in read mode.
- HTTP MCP applies the same token context and rate-limit buckets as HTTP.
- OAuth requires an explicit issuer/public origin and fails closed when the
  origin is missing or ambiguous.
- OAuth client secrets, authorization codes, access tokens, and refresh tokens
  are stored only as hashes or metadata.
- Operation, tool-mode, path, section, source, and inbox-provider bounds are
  enforced in central policy code, not only in HTTP handlers.
- MCP responses are size-bounded and return truncation guidance.
- Write-capable HTTP MCP should only be exposed behind TLS and an auth proxy or
  private service mesh.

### Inbox Payloads And Agent Orchestration

Inbox items cross the boundary between outside events and canonical wiki
records. A transcript, webhook payload, uploaded file, or remote-agent
submission is evidence or a work request; it is never trusted instruction text.
The main risks are prompt injection, filing items into another user's inbox,
leaking private payloads through static export, and giving remote agents broader
scopes than they need.

Controls:

- Inbox records are policy-filtered by owner actor and optional target Space.
- Submitting to another `owner_actor_id` requires `wiki:inbox:admin`.
- Shared Space inbox submission requires contributor access to the target
  Space; processing requires maintainer access.
- Inbox payloads remain private and are omitted from static export.
- Processing stores prompt-injection metadata on generated sources with
  `instruction_policy=never_execute_source_instructions`.
- Remote agents should use `inbox-submitter`, `proposal-agent`, or
  `inbox-curator` service-account profiles rather than maintainer tokens.
- Deterministic inbox orchestration evals exercise local transcript curation,
  hosted HTTP MCP inbox submission, permission filtering, duplicate handling,
  prompt-injection handling, and Git sync evidence.

### Source Fetching And Connectors

Source fetches cross the network and ingest untrusted content into evidence.
The fetcher must not be usable as an internal network scanner, metadata-service
reader, or credential exfiltration path.

Controls:

- Only `http` and `https` are accepted.
- Loopback, private, link-local, CGNAT, IPv4-mapped IPv6, decimal/hex IPv4,
  and cloud metadata hosts are blocked.
- DNS answers are validated before outbound fetches.
- Redirects are not followed.
- Byte limits and timeouts are enforced.
- Connector allowlists and `allowed_credential_refs` constrain authenticated
  fetches.
- Raw credential values are resolved at runtime and are not written to
  manifests.

### Git, Object Storage, And Postgres

Git is canonical. SQLite, search indexes, Postgres, queues, and object storage
are serving or backing layers that must be rebuildable or auditable. The main
risks are path traversal, Git option injection, partial writes, stale derived
state, and unsafe backup/restore.

Controls:

- Git commands use `execFile` argument arrays, `--end-of-options`, and
  revision validation.
- Static export and local object storage constrain paths to workspace children
  and guard symlink escapes.
- Content-addressed object reads verify hashes.
- Postgres queues and write leases provide hosted coordination.
- `/readyz` reports Git, derived store, queue, object storage, search, and
  config-safety state.
- Backup runbooks cover Git, Postgres, object storage, and secrets together.

## Required Security Tests

`pnpm test:security` is the focused security gate. The full `pnpm test` suite
also includes these checks, but the dedicated gate exists so CI and release
validation can prove the main boundaries directly.

| Category | Regression caught by |
| --- | --- |
| Path traversal | Static export rejects parent, absolute, reserved, and symlink-escaping output paths. |
| Git option injection | Git history/diff/commit reads reject option-looking revisions before invoking Git. |
| SSRF and DNS rebinding | Source fetch and connector tests reject private, metadata, localhost DNS, decimal/hex, and IPv4-mapped targets and avoid redirects. |
| Trusted-header spoofing | Trusted headers require a shared secret and ignore spoofed headers without it. |
| CSRF and origin checks | Browser write paths reject missing/cross-origin form posts and cross-site Fetch Metadata on JSON writes. |
| Webhook authenticity | GitHub/GitLab webhooks require the configured provider signature or token before queueing jobs. |
| Token leakage | Token create/list/inspect flows persist hashes and redacted metadata, not raw bearer tokens. |
| Oversized body/depth limits | HTTP server rejects bodies over 1 MiB and JSON bodies deeper than the configured maximum. |
| MCP auth denial | Read-mode MCP denies proposal/write tools and hosted MCP requires scoped credentials. |

## Supply-Chain Assurance

Public pull requests run `pnpm audit --audit-level high` for dependency and
lockfile changes. Repositories that enable GitHub dependency graph and
dependency review should add dependency review as an additional blocking gate.
Release validation also runs the focused security tests and high-severity
audit.

Image publication is blocked by:

- read-only-root container smoke;
- Trivy scan for high and critical vulnerabilities;
- BuildKit SBOM generation;
- BuildKit provenance;
- keyless Cosign signing;
- GitHub build provenance attestation for public repository releases.

Production deployments should pin image digests, not mutable tags.

## Documentation JavaScript

The documentation site currently has one Mermaid architecture diagram. MkDocs
loads a local Mermaid loader, and that loader fetches the exact versioned
Mermaid CDN asset with a Subresource Integrity hash and anonymous CORS. This is
not a runtime dependency for OpenWiki itself. Operators with strict
documentation supply-chain requirements can vendor the Mermaid asset in their
docs build or block third-party JavaScript with a content security policy.

The release checklist treats any new external documentation JavaScript as a
security review item. Prefer vendored assets or an exact pinned URL with a
documented integrity review and SRI hash.

## Secret Scanning And Credential Refs

Enable GitHub secret scanning and push protection for public forks and hosted
deployment repositories. Treat the following as secrets:

- service-account bearer token values returned by `openwiki auth token create`
  or `rotate`;
- `OPENWIKI_TRUST_AUTH_HEADERS_SECRET`;
- `OPENWIKI_TRUST_PROXY_ORIGIN_SECRET`;
- `OPENWIKI_DATABASE_URL` and `DATABASE_URL`;
- object storage access keys and session tokens;
- Git deploy keys, provider tokens, and credential helper material;
- connector secret env values under `OPENWIKI_SECRET_*`.

OpenWiki connector config should persist only references:

```json
{
  "runtime": {
    "secrets": { "backend": "env" },
    "connectors": [
      {
        "id": "docs",
        "kind": "http",
        "base_url": "https://docs.example.com",
        "allowed_hosts": ["docs.example.com"],
        "allowed_credential_refs": ["cred:docs-reader"]
      }
    ]
  }
}
```

The matching environment secret is derived from the credential ref and includes
an eight-character hash suffix, for example:

```sh
OPENWIKI_SECRET_CRED_DOCS_READER_<HASH>=header:X-Api-Key=...
```

Use `credential_ref` in source fetch requests. Do not put `Bearer ...`,
private keys, passwords, or API tokens in `openwiki.json`, source manifests,
proposal bodies, static export output, or Git remote URLs.

## Vulnerability Response SLA

During public preview, OpenWiki uses this target response policy:

| Severity | Triage target | Fix or mitigation target |
| --- | --- | --- |
| Critical | 1 business day | 3 business days |
| High | 2 business days | 7 business days |
| Medium | 5 business days | Next regular patch when practical |
| Low | Best effort | Backlog or next minor release |

If exploitation is active, maintainers may ship a mitigation, disable an unsafe
feature, rotate exposed credentials, or temporarily remove a release artifact
before the full fix lands.

## Preview Limitations

- Built-in human login is intentionally out of scope. Hosted deployments must
  provide SSO or an equivalent trusted boundary.
- Kubernetes, Terraform, and cloud modules are reference starting points and
  require operator review for DNS, TLS, state, secrets, backup, and ingress.
- Local filesystem mode is not a multi-process clustered write store.
- Static export is the recommended default for public unauthenticated content.
  Do not expose write-capable HTTP or MCP endpoints publicly without auth.
