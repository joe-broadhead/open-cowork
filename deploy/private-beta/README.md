# Private Beta Deployment Package

This directory contains launch-package examples for managed BYOK private beta
and OSS self-host deployment.

## Package completeness (public vs private)

| Layer | Status | Notes |
| --- | --- | --- |
| **Public package** | **COMPLETE** | Templates, configs, validators, public go/no-go summary, and ops evidence package are in-repo and CI-checked (`pnpm deploy:private-beta:validate`) |
| **Private campaign items** | **Still required for go** | Deployed load/soak, restore, failover, live BYOK, support roster, cost/SLO, rollback, and redacted summaries + checksums (see `launch-evidence-record.template.json`) |
| **Go / no-go** | **`no-go`** until private evidence | `private-beta-go-no-go.public.md` must stay `no-go` until a private ops record passes every blocking item |

Do **not** invent or attach fake private-beta go evidence in this repo. Public
templates alone never promote hosted private-beta claims.

Public campaign package (validators + explicit private gaps with owners):
`deploy/private-beta/ops-evidence-package.md` (JOE-922).

**Private campaign path (JOE-993):** operator checklist
`private-campaign-evidence-checklist.md` + redacted summary template
`redacted-evidence-summary.template.md`. Completing the checklist offline does
not alone flip hosted go.

Files:

- `hosted-byok.config.example.json`: managed BYOK SaaS-style config with OIDC,
  disabled/invite signup posture, Desktop cloud connection, managed Gateway, stub
  private beta billing, quotas, and placeholder secret refs.
- `self-host-oss.config.example.json`: OSS self-host config with optional stub
  billing, self-host Gateway, and placeholder secret refs.
- `private-beta-plans.json`: plan and entitlement placeholders for private
  beta. It intentionally carries no prices or commercial assumptions.
- `private-beta-launch-profile.template.json`: launch-profile template covering
  entitlements, allowed provider policy, gateway availability, support owners,
  RPO/RTO, required launch evidence, and go/no-go placeholders.
- `launch-evidence-record.template.json`: machine-readable evidence register
  for deployed continuation, load, soak, failover, restore, BYOK redaction,
  gateway replay, quota/billing gates, support ownership, cost/SLO notes, and
  release rollback evidence.
- `managed-byok-readiness-contract.template.json`: machine-readable
  public/private boundary, onboarding status/reason-code, billing, BYOK,
  diagnostics, and validation contract.
- `design-partner-onboarding.template.md`: repeatable 10-step onboarding
  evidence template for invite, BYOK, Desktop, Web, Gateway, token lifecycle,
  and redaction proof.
- `go-no-go-report.template.md`: final managed BYOK launch decision template
  for exact commit/artifacts, validation commands, load/soak, failover/restore,
  security boundaries, risks, and sign-off.
- `private-beta-go-no-go.public.md`: current public-safe go/no-go summary. It
  remains `no-go` for managed private beta until private evidence is attached
  and redacted summaries are approved.
- `private-campaign-evidence-checklist.md`: JOE-993 operator path for private
  campaign items (load/soak, restore, failover, BYOK, support, cost/SLO,
  rollback) without inventing public go evidence.
- `redacted-evidence-summary.template.md`: public-safe summary shape per
  evidence id (checksum + roles; no secrets).

These examples are provider-neutral. They use placeholder domains such as
`cowork.example.com`, placeholder secret refs such as
`env:OPEN_COWORK_CLOUD_DATABASE_URL`, and placeholder plan keys. Do not replace
them with real provider project ids or customer values in the repository.
The public/private split is defined in
`docs/runbooks/managed-byok-saas-boundary.md` and enforced by
`managed-byok-readiness-contract.template.json`.

## Hosted Managed BYOK

The hosted path is for an operator-managed private beta:

1. Deploy Cloud Web, worker, scheduler, Postgres, object storage, secret
   adapter/KMS, observability, backups, and Gateway.
2. Set Cloud role selection in Compose, Helm, or role-specific environment
   variables. Keep the shared config examples focused on product policy and
   launch posture.
3. Set `cloud.auth.signupMode` to `disabled` or `invite`.
4. Keep `cloud.billing.provider` as `stub` or manual operational state until
   self-serve billing is intentionally enabled.
5. Configure BYOK and quotas per org.
6. Preconfigure Desktop with the managed cloud URL.
7. Store Gateway service tokens and channel credentials in platform secrets.
8. Copy the onboarding, launch-profile, and go/no-go templates into a private
   operations tracker and fill them with real evidence there, not in this repo.
9. Validate the private evidence record with
   `pnpm deploy:launch:evidence:validate -- --manifest <private-record> --require-private-pass`
   and promote it with `pnpm deploy:promotion:validate -- --tier
   private-hosted-beta --manifest <private-record>` before changing the public
   decision summary.

## OSS Self-Host

The self-host path must remain usable without managed-only services:

1. Deploy Compose or Helm from this repo.
2. Use `cloud.billing.provider=none` or `stub`.
3. Bring your own Postgres, object storage, and secret manager/KMS.
4. Run Gateway with a scoped cloud service token.
5. Configure branding, OIDC, profiles, quotas, and providers without code
   changes.

Run:

```bash
pnpm deploy:private-beta:validate
pnpm deploy:launch:evidence:validate
pnpm deploy:promotion:validate -- --tier local-self-host-beta
pnpm deploy:validate
pnpm deploy:launch:validate
pnpm ops:validate
```

before inviting design partners.
