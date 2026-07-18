# Deployment

OpenWiki currently ships local-first deployment profiles that scale into hosted
server deployments.

Choose the tier by workload. The product-supported decision table is in
`docs/deployment/profiles.md` and defines these profiles:
`local-personal`, `public-static`, `docker-private`,
`kubernetes-enterprise`, `aws-ecs-efs`, `gcp-gke`,
and `cloud-run-readmostly`.

- **GitHub Pages/static export** for public, small/medium, read-only knowledge
  bases. It publishes the human site plus complete machine-readable exports.
- **Docker, Compose, Cloud Run, ECS, or a single VM** for private
  wikis, authenticated MCP/HTTP access, proposal review, and team use.
- **Helm/Kubernetes or Terraform-managed cloud infrastructure** for large
  organizations with many departments, permission scopes, workers, and external
  databases/object storage.

In every tier, Git is the canonical ledger. Databases, search indexes, object
storage, and caches are serving layers derived from Git-backed records.

## Docker

Build and run the image directly:

```sh
docker build -t openwiki/openwiki:local .
docker run --rm -p 127.0.0.1:3030:3030 -v openwiki_data:/data/wiki openwiki/openwiki:local
```

The image uses `/data/wiki` as the OpenWiki repository root. On first boot it
initializes the wiki, builds the SQLite FTS index, rebuilds the local
index-store, and starts the HTTP API.
The image includes Git and OpenSSH so the same container can operate on a real
Git-backed workspace in Docker, Cloud Run, ECS, Kubernetes, or
any other OCI runtime.

To connect a deployment to an existing Git repository, provide a persistent
`OPENWIKI_ROOT` volume and configure the remote through environment variables:

```sh
docker run --rm -p 127.0.0.1:3030:3030 \
  -v openwiki_data:/data/wiki \
  -e OPENWIKI_GIT_REMOTE_URL=git@github.com:acme/wiki.git \
  -e OPENWIKI_GIT_BRANCH=main \
  -e OPENWIKI_GIT_PULL_ON_BOOT=1 \
  openwiki/openwiki:local
```

If the mounted root is empty and `OPENWIKI_GIT_REMOTE_URL` is set, the entrypoint
clones that repository before starting OpenWiki. Empty remotes are supported:
the container clones the empty repository, checks out `OPENWIKI_GIT_BRANCH`, and
then initializes OpenWiki. If the root already contains a wiki, the entrypoint
configures the remote metadata and can run a fast-forward pull when
`OPENWIKI_GIT_PULL_ON_BOOT=1`. Git credentials stay outside `openwiki.json`; use
SSH deploy keys, a mounted `.ssh` directory, a Git credential helper, or your
platform's secret mechanism.

Hosted containers accept HTTPS and SSH Git remotes by default. Local filesystem
or loopback HTTP remotes require `OPENWIKI_ALLOW_LOCAL_GIT_REMOTE=1` and should
only be used for local development, home-lab, NAS, or air-gapped workflows.
The Docker examples bind to loopback by default; expose `3030` on a private
network or public interface only behind VPN, firewall, SSO, or an authenticating
reverse proxy with `OPENWIKI_PUBLIC_ORIGIN` set to the HTTPS origin.

The standard container entrypoint runs migrations, local search indexing,
SQLite index-store rebuild, and Postgres sync inline before serving. Keep that
default to a single serving container for v0.1. Multi-replica, split web/worker,
or rolling deployment profiles should run those commands once from a deployment
job and set `OPENWIKI_BOOTSTRAP_MODE=skip` on serving containers.

Use storage with normal filesystem semantics for writable Git workspaces. GCS
Fuse-style object mounts are useful for static artifacts and source objects, but
they are not a good backing filesystem for a mutable Git checkout.

## Docker Compose

```sh
docker compose -f deploy/compose/docker-compose.yml up --build
```

The Compose profile publishes the OpenWiki server on `127.0.0.1:3030` by
default. Use a local override to bind another interface only after the network
path is protected by an auth boundary.

Health and metrics:

```sh
curl http://127.0.0.1:3030/livez
curl http://127.0.0.1:3030/readyz
curl -H "Authorization: Bearer $OPENWIKI_ADMIN_TOKEN" http://127.0.0.1:3030/metrics
```

`/metrics` is admin-scoped by default. Set `OPENWIKI_PUBLIC_METRICS=1` only
when an internal scrape path already protects the endpoint.

## GitHub Pages

`.github/workflows/openwiki-static.yml` runs typecheck, tests, and static export
for `examples/basic-wiki`, then publishes the generated `public` directory using
GitHub Pages.

Static export is the small/medium read-only tier. It uses the shared light-first
human UI, client-side search over `search-index.json`, and a full static graph
from `graph.json` while the workspace stays under the configured HTML ceiling.
For larger exports, OpenWiki writes complete machine-readable artifacts and a
`static-export-report.json` warning instead of silently publishing a partial
HTML site. Sitemaps are emitted as a sitemap index plus shards under
`sitemaps/`, and `llms-full.txt` is reduced when it exceeds the configured byte
limit. Configure these bounds with:

```sh
openwiki export static \
  --html-page-ceiling 10000 \
  --sitemap-shard-size 45000 \
  --llms-full-max-bytes 5242880
```

Use the server tier when users need authenticated write flows, proposal review,
remote MCP over HTTP, permission-filtered search, or graph/search behavior for
very large private workspaces. The server UI uses `/api/v1/search` with cursors,
lazy `/api/v1/records?type=...&prefix=...&cursor=...` navigation, seeded graph
loads such as `/api/v1/graph?seed=top&limit=1500`, and record-neighborhood graph
endpoints so browser pages do not need to download the full corpus.

## Hosted write-mode safety

Anonymous requests receive viewer-style read scopes unless the deployment
overrides policy. That is appropriate for public read-only content and static
exports, but it is not an authentication model for hosted write workflows.

Write-capable browser deployments must sit behind a trusted auth boundary, such
as a reverse proxy that authenticates users and forwards OpenWiki identity
headers with `OPENWIKI_TRUST_AUTH_HEADERS_SECRET`, or service-account bearer
tokens for API clients. Server-rendered write forms enforce strict same-origin
POST checks: browser POSTs to `/pages/*/propose`, `/proposals/*/...`, and policy
proposal routes must include an `Origin` matching the request host or a value in
`OPENWIKI_PUBLIC_ORIGIN`. Any POST that does include an `Origin` is rejected
when the origin is not allowed, including JSON API writes from browsers. When
OpenWiki is behind TLS termination or a public proxy, set
`OPENWIKI_PUBLIC_ORIGIN=https://wiki.example.com`. Only set
`OPENWIKI_TRUST_PROXY_ORIGIN=1` when the proxy strips untrusted forwarded
headers, supplies trusted `X-Forwarded-Proto` and `X-Forwarded-Host` values,
and injects `x-openwiki-proxy-secret` matching
`OPENWIKI_TRUST_PROXY_ORIGIN_SECRET` or `OPENWIKI_TRUST_AUTH_HEADERS_SECRET`.

For internet-facing deployments, prefer one of these modes:

- public static export or read-only server with viewer scopes
- trusted internal write server behind SSO/reverse proxy
- API-only write access with scoped service-account tokens

Reference SSO and reverse-proxy profiles for oauth2-proxy, Envoy, Cloudflare
Access, Google IAP, AWS ALB OIDC, and generic OIDC proxies are in
`docs/deployment/auth-boundaries.md`.

## GitHub Actions

OpenWiki ships workflow entry points for repo-hosted automation:

- `.github/workflows/openwiki-build-site.yml` builds and uploads a static site
  artifact without deploying it.
- `.github/workflows/openwiki-lint.yml` runs typecheck, tests, and
  `openwiki run lint`.
- `.github/workflows/openwiki-review-proposal.yml` inspects a proposal and
  uploads detail, diff, and validation artifacts for human review.
- `.github/workflows/openwiki-image.yml` smoke-tests the container and publishes
  `ghcr.io/joe-broadhead/open-wiki` tags for default-branch and versioned releases.

## Umbrel

`deploy/umbrel/` contains the initial Umbrel app skeleton. It uses the published
preview image at `ghcr.io/joe-broadhead/open-wiki:0.0.0`.

## Helm

The initial Kubernetes chart lives in `deploy/helm/openwiki/`:

```sh
helm upgrade --install openwiki deploy/helm/openwiki \
  --namespace openwiki \
  --create-namespace
```

The chart deploys the same OpenWiki container, a ClusterIP service, health
probes, and a persistent `/data/wiki` volume. Ingress is opt-in through
`ingress.enabled=true`.

## Kubernetes Base

Plain Kubernetes manifests live in `deploy/kubernetes/base/` for teams that
prefer Kustomize or direct `kubectl` workflows:

```sh
kubectl apply -k deploy/kubernetes/base
kubectl -n openwiki port-forward svc/openwiki 3030:3030
```

The base includes a namespace, service account, persistent volume claim,
deployment, and ClusterIP service.

## Terraform

Provider-native Terraform examples live in `deploy/terraform/`:

- `aws/` deploys ECS Fargate, an Application Load Balancer, and EFS.
- `gcp/` deploys Cloud Run with a Cloud Storage volume.

These examples are starting points for small hosted deployments. Review network,
identity, ingress, and persistence settings before production use.
