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

The canonical scalable manifest is the provider-neutral Helm chart in
`helm/open-cowork-cloud`; the gateway chart lives in `helm/open-cowork-gateway`
and can also be enabled as the cloud chart's optional gateway dependency.
