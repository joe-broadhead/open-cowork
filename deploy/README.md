# Open Cowork Cloud Deploy Recipes

These recipes are thin provider-specific compositions of the same
`open-cowork-cloud` image, roles, and adapters. Provider behavior should stay
in deployment configuration, cloud services, and adapter wiring rather than in
core runtime/session logic.

Use these invariants across every provider:

- Run `web`, `worker`, and `scheduler` as separate roles for production.
- Use Postgres for the control plane.
- Use object storage for artifacts and runtime/workspace checkpoints.
- Store `OPEN_COWORK_CLOUD_SECRET_KEY`, database URLs, and object-store
  credentials in the provider secret manager.
- Keep Cloud Run/App Platform/all-in-one deployments for demos or focused
  pilots unless the platform gives workers predictable long-running CPU.
- Enable `OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED=true` before scaling worker
  replicas beyond one.

The canonical scalable manifest is the provider-neutral Helm chart in
`helm/open-cowork-cloud`.
