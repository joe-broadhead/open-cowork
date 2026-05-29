# Open Cowork Cloud Deploy Recipes

These recipes are thin provider-specific compositions of the same
`open-cowork-cloud` and `open-cowork-gateway` images, roles, and adapters.
Provider behavior should stay in deployment configuration, cloud services, and
adapter wiring rather than in core runtime/session logic.

Use these invariants across every provider:

- Run `web`, `worker`, and `scheduler` as separate roles for production.
- Run the gateway as a separate deployment or service. It owns channel
  credentials and long-poll/webhook connections, not OpenCode execution.
- Use Postgres for the control plane.
- Use object storage for artifacts and runtime/workspace checkpoints.
- Use OIDC or explicit `OPEN_COWORK_CLOUD_AUTH_MODE=header` behind a trusted
  reverse-proxy identity layer before exposing the web role publicly;
  `OPEN_COWORK_CLOUD_AUTH_MODE=none` requires an explicit insecure local/demo
  override when the process binds beyond loopback.
- Store `OPEN_COWORK_CLOUD_SECRET_KEY`, `OPEN_COWORK_CLOUD_INTERNAL_TOKEN`,
  database URLs, object-store credentials, gateway service tokens, and channel
  credentials in the provider secret manager.
- Keep Cloud Run/App Platform/all-in-one deployments for demos or focused
  pilots unless the platform gives workers predictable long-running CPU.
- Enable `OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED=true` before scaling worker
  replicas beyond one.
- Keep billing optional for self-hosted OSS deployments. Use no billing
  provider or the stub billing provider unless you are operating managed SaaS.
- Run `pnpm deploy:validate` before release and `pnpm deploy:smoke` against a
  live deployment after rollout.
- For the GCP reference deployment, run `pnpm deploy:gcp:preflight` before
  rollout and `pnpm deploy:gcp:smoke` after traffic is routed.

The canonical scalable manifest is the provider-neutral Helm chart in
`helm/open-cowork-cloud`; the gateway chart lives in `helm/open-cowork-gateway`
and can also be enabled as the cloud chart's optional gateway dependency.

## Required Production Inputs

Provider recipes are deployment wiring documents. They should resolve the same
runtime inputs through provider-native services without changing core code.

Every provider recipe should resolve the same inputs through provider-native
infrastructure:

| Input | Expected source |
| --- | --- |
| Images | `open-cowork-cloud` and `open-cowork-gateway` OCI images |
| Public origins | HTTPS cloud URL and optional HTTPS gateway URL |
| Auth | OIDC or trusted header auth with signed proxy headers |
| Control plane | Managed Postgres connection string |
| Object store | Bucket/container plus adapter-specific endpoint/region |
| Secrets | Provider secret manager or KMS-backed secret adapter |
| Runtime keys | BYOK status APIs plus worker-only plaintext reveal |
| Gateway | Scoped service token and provider signing secrets |
| Scaling | Split web/worker/scheduler roles and checkpoint-enabled workers |
| Observability | JSON logs, OTLP endpoint, metrics, and redaction policy |
| Recovery | Postgres and object-store backup/restore process |

See `docs/deployment-readiness.md` for the production checklist and
`docs/runbooks/managed-byok-saas.md` for hosted BYOK operations.

## Validation

Validate local manifests and Helm guardrails:

```bash
pnpm deploy:validate
```

Smoke a running deployment:

```bash
OPEN_COWORK_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_SMOKE_GATEWAY_URL=https://gateway.example.com \
pnpm deploy:smoke
```

The same smoke command works for local Compose, Kubernetes/Helm, and the cloud
provider recipes once traffic is routed to the chosen endpoints.

GCP adds a provider-specific infra smoke:

```bash
OPEN_COWORK_GCP_PROJECT=PROJECT \
OPEN_COWORK_GCP_BUCKET=OPEN_COWORK_BUCKET \
OPEN_COWORK_GCP_SECRET_REF=gcp-sm://projects/PROJECT/secrets/open-cowork-cloud-secret-key/versions/latest \
OPEN_COWORK_SMOKE_CLOUD_URL=https://cowork.example.com \
pnpm deploy:gcp:smoke
```
