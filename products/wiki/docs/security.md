# Security

Security posture for public preview:

- Git commands use argument arrays, `--end-of-options`, and option-looking
  revision validation.
- Service-account tokens are stored as hashes and compared with timing-safe
  equality.
- Trusted identity headers require a shared proxy secret.
- Server-rendered write forms require same-origin browser POSTs.
- JSON browser writes reject cross-site Fetch Metadata, and webhook receivers
  can require GitHub/GitLab provider secrets before queueing jobs.
- Static export output directories are constrained to safe workspace children.
- Source fetching applies SSRF controls, validates resolved addresses, and does
  not follow redirects.
- Secrets should stay in environment variables, mounted secret stores, platform
  secret managers, or credential helpers.
- Public unauthenticated content should use static export. Do not expose
  write-capable HTTP or MCP endpoints without SSO/reverse-proxy auth.

Read the [threat model](security/threat-model.md) for deployment boundaries,
test coverage, supply-chain controls, credential-ref guidance, and public
preview limitations.

Report private vulnerabilities through the root `SECURITY.md`.
