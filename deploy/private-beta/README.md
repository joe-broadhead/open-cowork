# Private Beta Deployment Package

This directory contains launch-package examples for managed BYOK private beta
and OSS self-host deployment.

Files:

- `hosted-byok.config.example.json`: managed BYOK SaaS-style config with OIDC,
  closed/invite signup posture, Desktop cloud connection, managed Gateway, stub
  private beta billing, quotas, and placeholder secret refs.
- `self-host-oss.config.example.json`: OSS self-host config with optional stub
  billing, self-host Gateway, and placeholder secret refs.
- `private-beta-plans.json`: plan and entitlement placeholders for private
  beta. It intentionally carries no prices or commercial assumptions.

These examples are provider-neutral. They use placeholder domains such as
`cowork.example.com`, placeholder secret refs such as
`env:OPEN_COWORK_CLOUD_DATABASE_URL`, and placeholder plan keys. Do not replace
them with real provider project ids or customer values in the repository.

## Hosted Managed BYOK

The hosted path is for an operator-managed private beta:

1. Deploy Cloud Web, worker, scheduler, Postgres, object storage, secret
   adapter/KMS, observability, backups, and Gateway.
2. Set Cloud role selection in Compose, Helm, or role-specific environment
   variables. Keep the shared config examples focused on product policy and
   launch posture.
3. Set `cloud.auth.signupMode` to `closed` or `invite`.
4. Keep `cloud.billing.provider` as `stub` or manual operational state until
   self-serve billing is intentionally enabled.
5. Configure BYOK and quotas per org.
6. Preconfigure Desktop with the managed cloud URL.
7. Store Gateway service tokens and channel credentials in platform secrets.

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
pnpm deploy:validate
pnpm deploy:launch:validate
```

before inviting design partners.
