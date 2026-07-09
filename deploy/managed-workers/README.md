# Managed Worker Deployment Templates

These templates make the managed worker service plane deployable without
putting provider-specific or private managed-SaaS values in the public repo.
They are reference artifacts for self-hosters and downstream operators; copy
them into a private deployment repo before replacing placeholders with real
project, account, domain, credential, or customer values.

Managed workers remain a composition layer around OpenCode. They claim work
from Open Cowork Cloud, run OpenCode with app-managed runtime config, write
lease-fenced events/projections/checkpoints, and never become a second
runtime, scheduler, session store, or gateway execution path.

## Supported Modes

| Mode | Operator | Public support | Notes |
| --- | --- | --- | --- |
| `self_hosted` | Same org that owns the Cloud control plane | Yes | Internal teams can run Cloud, workers, scheduler, and Gateway together on Kubernetes or Compose. Billing can be `none` or `stub`. |
| `saas_operated` | Managed Open Cowork Cloud operator | Yes, as a template | Use private downstream operations repos for real project ids, domains, prices, customers, and launch evidence. |
| `customer_hosted` | Customer worker connects to a separate managed control plane | Deferred | Do not enable in v1. It needs a separate trust, update, liability, and data-residency review. |

## Files

- `self-host-worker.env.example`: Compose or systemd-style worker role
  environment for an internal self-host deployment.
- `managed-operator-worker.env.template`: managed-operator environment
  shape. It deliberately uses secret-manager refs and placeholders.
- `helm-values.worker-pool.yaml.example`: Kubernetes overlay for scalable
  worker pools with image pinning, checkpointed workers, PDBs, topology spread,
  and graceful shutdown windows.
- `worker-release-evidence.template.md`: go/no-go evidence shape for image,
  compatibility, drain, rollback, and emergency revoke validation.
- `worker-restore-drill.template.md`: restore drill evidence shape for
  Postgres, object store, checkpoints, projections, workflows, and BYOK secret
  references.

## Bootstrap Sequence

1. Deploy or upgrade the Cloud web role first with Postgres, object storage,
   secret adapter/KMS, OIDC/header auth, operator token access, and metrics.
2. Create a worker pool with mode `self_hosted` or `saas_operated`; set
   `maxWorkers`, `maxConcurrentWork`, region, and capabilities.
3. Register workers in `pending`, issue scoped expiring credentials, and store
   the one-time plaintext in the platform secret manager.
4. Start one worker with `OPEN_COWORK_CLOUD_ROLE=worker`, shared control-plane
   URL, shared object store, checkpoints enabled, and a stable worker id.
5. Activate the worker after the first heartbeat is visible and redacted.
6. Run a bounded smoke prompt, then a scheduled workflow smoke, then a Gateway
   prompt smoke if Gateway is deployed.
7. Scale workers only after object-store checkpoints, worker leases, quota
   gates, and operator metrics are green.

## Required Runtime Inputs

| Input | Required for workers | Source |
| --- | --- | --- |
| Cloud image | Yes | Pinned OCI digest for production, never `latest` |
| Control plane URL | Yes | Secret manager or private env injection |
| Secret adapter key/ref | Yes | `OPEN_COWORK_CLOUD_SECRET_KEY_REF` where possible |
| Object store | Yes for scaled workers | Shared bucket/container and prefix |
| Checkpoints | Yes for multiple workers | `OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED=true` |
| Worker identity | Yes | Stable `OPEN_COWORK_CLOUD_WORKER_ID` per pod/process |
| Poll interval | Yes | `OPEN_COWORK_CLOUD_WORKER_POLL_MS` |
| Shutdown grace | Yes | `OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS` plus platform termination grace |
| BYOK/provider keys | Worker reveal only | BYOK secret store and runtime config provider options |
| Billing | Optional for self-host | `cloud.billing.provider=none` or `stub` |

## Update And Rollback Policy

Use drain before rollout:

1. Mark the worker or pool `draining`.
2. Wait for `currentLoad=0`, no active work ids, and command queue age within
   SLO.
3. Roll the image with `maxUnavailable=0`, `maxSurge=1`, and a termination
   grace at least as long as `OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS`.
4. Confirm new worker heartbeats include the expected Open Cowork version,
   service-plane protocol, runtime capability flags, and checkpoint schema.
5. Resume/activate workers and run the smoke gates.

Rollback is image-based and forward-compatible. Schema migrations must remain
additive and idempotent. Roll back the worker image first if execution is
affected; roll back web or scheduler only when their own health or API behavior
is the failing surface.

Emergency revoke skips drain when a worker image, token, host, or BYOK access
path is suspected compromised. Revoke the worker credential, mark the worker
`revoked`, leave leases to expire or reaper recovery, and preserve redacted
audit/diagnostic evidence.

## Sizing Guidance

Start conservatively:

- one scheduler replica
- two web replicas for public traffic
- one worker replica per org/profile until checkpoint restore and provider
  quota behavior is proven
- worker `maxConcurrentWork` lower than provider/model concurrency limits
- queue depth and queue age alerts before autoscaling actions

Scale workers from durable backlog age and claim latency rather than only CPU.
OpenCode work can be blocked on provider calls, tools, object store, or BYOK
reveal, so CPU alone is not a reliable pressure signal.

## Required Validation

Before external users depend on the worker path:

```bash
pnpm deploy:validate
pnpm ops:validate
pnpm test:cloud-continuation
OPEN_COWORK_TEST_POSTGRES_URL=postgres://USER:PASSWORD@HOST:PORT/DB \
  node --no-warnings --experimental-strip-types --test tests/cloud-postgres-concurrency.test.ts
```

Then run a live environment smoke:

```bash
OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN=REDACTED \
OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION=true \
pnpm deploy:continuation:smoke
```

Keep real reports in a private operations repo. Public templates must not
contain real project ids, account ids, subscription ids, domains, customer
names, prices, emails, tokens, signed URLs, provider keys, or private paths.
