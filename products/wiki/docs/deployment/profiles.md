# Deployment Profiles

OpenWiki supports one runtime model across every deployment: Git is canonical,
SQLite/Postgres/search/object storage are derived serving layers, humans use the
web UI and HTTP API, and agents use stdio MCP or HTTP MCP. The profiles below
are product-supported paths that explain the intended trust boundary,
persistence model, scaling shape, and operational checks.

## Decision Table

| Profile | Status | Best For | Trust Boundary | Persistence | Backup Model | Scale Path |
| --- | --- | --- | --- | --- | --- | --- |
| [`local-personal`](profiles/local-personal.md) | Supported | One human with local agents | Local machine only | Local Git workspace | Workspace backup or private Git remote | Move to Docker or Kubernetes when shared |
| [`public-static`](profiles/public-static.md) | Supported | Public read-only knowledge | Static host; no server writes | Generated static artifacts from Git | Source Git repository; regenerate artifacts | Re-export from CI |
| [`docker-private`](profiles/docker-compose.md) | Supported private profile | Startup/team private wiki | Private network, trusted host, or SSO proxy | Docker volume or host path; optional Postgres/object storage | Wiki volume, Git remote, Postgres, and object storage when enabled | Move to Kubernetes when workers/backends split |
| [`hosted-enterprise`](hosted-human-agent.md) | Supported hosted profile | Provider-neutral hosted humans and agents | Authenticated SSO, reverse proxy, or private gateway | Persistent POSIX Git workspace, Postgres, object storage | Git remote, workspace snapshots, Postgres backups, object storage, and secrets | Separate web replicas, worker replicas, Postgres, and shared operational state |
| [`kubernetes-enterprise`](profiles/kubernetes-helm.md) | Supported enterprise profile | Large teams and sensitive spaces | Authenticated ingress/SSO | Persistent volume, Postgres, object storage | PV/Git remote, Postgres backups, object storage, and secrets | Separate web/worker/read/search/queue backends |
| [`aws-ecs-efs`](profiles/aws.md) | Supported cloud reference | AWS teams standardizing on ECS | ALB plus optional OIDC | EFS for Git workspace, managed Postgres/object storage | EFS backups, Git remote, Terraform state, Postgres/object storage, and secrets | ECS service plus workers and external stores |
| [`gcp-gke`](profiles/gcp.md) | Supported cloud reference | Google Cloud enterprise wiki | GKE Ingress plus optional IAP | Kubernetes persistent volume, Cloud SQL, object storage | PV/disk snapshots, Git remote, Cloud SQL, object storage, and secrets | Helm/Kustomize on GKE |
| [`cloud-run-readmostly`](profiles/cloud-run.md) | Preview/demo | Small hosted demos and read-mostly reviews | Cloud Run/IAP or private ingress | Only safe for writes with a proper POSIX Git workspace | Git remote plus platform state; do not rely on Cloud Storage FUSE alone | Graduate to GKE/VM/POSIX storage for production writes |

Unsupported or preview behavior is explicit in the profile notes. In
particular, Cloud Storage FUSE is not POSIX Git storage and Cloud Run needs a
proper POSIX filesystem before it can be treated as an enterprise writable Git
path.

## Runtime Assumptions

`runtime.profile` records the workspace or package profile. Deployments may
override the safety posture with `OPENWIKI_RUNTIME_MODE=local|team|hosted|enterprise`.
Hosted and enterprise modes require Postgres-backed read, search, queue, and
operational-state stores before readiness passes; local and team modes keep
SQLite/local fallbacks for personal and trusted single-node use.

All hosted write-capable profiles share these assumptions:

- `OPENWIKI_ROOT` points to persistent storage with normal filesystem semantics
  for the Git workspace.
- Browser writes sit behind SSO/reverse-proxy auth or a private network.
- `OPENWIKI_PUBLIC_ORIGIN` matches the browser-visible HTTPS origin.
- Trusted identity headers require `OPENWIKI_TRUST_AUTH_HEADERS_SECRET`.
- HTTP MCP uses service-account bearer tokens unless an internal gateway
  authenticates managed agents and injects trusted identity headers.
- Multi-container write-capable deployments set
  `OPENWIKI_WRITE_COORDINATOR_BACKEND=postgres` so web and worker Git mutations
  contend on the same durable lease.
- Multi-replica web deployments set `OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres`
  so Streamable HTTP MCP sessions and rate-limit windows are shared across
  replicas. The default `memory` backend is safe for local and single-node
  hosted profiles only.
- Prometheus metrics are process-local by design; scrape every replica and
  aggregate bounded labels in Prometheus.
- Production images are pinned by digest, not mutable tags.
- Backups include Git, object storage, Postgres when enabled, and deployment
  secrets.
- Local SQLite search is the supported 1k-page v0.1 path. Hosted deployments
  that need 10k+ records should enable Postgres read/search backends and retain
  the weekly scale benchmark reports as operating evidence.

## Focused Profile Pages

| User path | Page |
| --- | --- |
| Personal local wiki and stdio MCP | [Local Personal](profiles/local-personal.md) |
| Small trusted team wiki | [Local Team](profiles/local-team.md) |
| Public read-only publishing | [Public Static](profiles/public-static.md) |
| Docker and Compose private server | [Docker And Compose](profiles/docker-compose.md) |
| Provider-neutral hosted humans and agents | [Hosted Humans And Agents](hosted-human-agent.md) |
| Kubernetes and Helm enterprise deployment | [Kubernetes And Helm](profiles/kubernetes-helm.md) |
| AWS ECS/EFS reference | [AWS](profiles/aws.md) |
| GCP GKE reference | [GCP](profiles/gcp.md) |
| Cloud Run read-mostly preview | [Cloud Run](profiles/cloud-run.md) |
| Umbrel appliance packaging | [Umbrel](profiles/umbrel.md) |

Each focused page includes quickstart, preflight, security notes, readiness,
backup, Rollback, and MCP guidance where the profile supports that surface.

Use these pages with the deployment preflight command, for example
`openwiki deploy preflight --deploy-profile local-personal`,
`openwiki deploy preflight --deploy-profile public-static`,
`openwiki deploy preflight --deploy-profile docker-private`,
`openwiki deploy preflight --deploy-profile hosted-enterprise`,
`openwiki deploy preflight --deploy-profile kubernetes-enterprise`,
`openwiki deploy preflight --deploy-profile aws-ecs-efs`,
`openwiki deploy preflight --deploy-profile gcp-gke`,
and `openwiki deploy preflight --deploy-profile cloud-run-readmostly`.

## local-personal

See [Local Personal](profiles/local-personal.md).

## public-static

See [Public Static](profiles/public-static.md).

## docker-private

See [Docker And Compose](profiles/docker-compose.md).

## hosted-enterprise

See [Hosted Humans And Agents](hosted-human-agent.md).

## kubernetes-enterprise

See [Kubernetes And Helm](profiles/kubernetes-helm.md).

## aws-ecs-efs

See [AWS](profiles/aws.md).

## gcp-gke

See [GCP](profiles/gcp.md).

## cloud-run-readmostly

See [Cloud Run](profiles/cloud-run.md).
