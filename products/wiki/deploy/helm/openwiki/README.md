# OpenWiki Helm Chart

This chart runs the OpenWiki HTTP server with a persistent wiki volume.

```sh
helm upgrade --install openwiki deploy/helm/openwiki \
  --namespace openwiki \
  --create-namespace
```

Useful values:

- `image.repository`, `image.tag`, and `image.digest` select the OpenWiki
  image. Set `image.digest=sha256:...` for production so the rendered
  Deployment uses `repository@sha256:...`.
- `persistence.enabled`, `persistence.size`, and `persistence.storageClass`
  control the `/data/wiki` volume.
- `ingress.enabled` publishes the HTTP API and web UI through an ingress.
- `openwiki.extraEnv` and `openwiki.envFrom` attach deployment-specific
  settings and secret references.
- `openwiki.oauthEnabled`, `openwiki.oauthIssuer`,
  `openwiki.oauthStateBackend`, and
  `openwiki.oauthDynamicClientRegistration` expose the hosted OAuth MCP
  environment toggles. Multi-replica web (`replicaCount > 1`) with OAuth
  requires Postgres OAuth state (`oauthStateBackend=postgres` or
  `operationalStateBackend=postgres`); file-backed OAuth state is single-node
  only and the chart fails closed. Keep DCR disabled unless an admin-gated
  workflow fronts `/oauth/register`.
- `podDisruptionBudget.enabled` and `networkPolicy.enabled` keep production
  cluster defaults explicit.
- `postgresBackup.enabled` adds a `pg_dump` CronJob. Set
  `postgresBackup.existingSecret` to a secret containing the database URL and
  point `postgresBackup.persistence` at durable backup storage before enabling
  it.
- `workspaceBackup.enabled` adds an OpenWiki workspace backup CronJob. Use
  `workspaceBackup.destinationId` for a configured cloud/local destination, or
  keep the default `/backups` PVC path for cluster-local artifacts.
- `enterprise.enabled=true` turns missing production-grade requirements into
  Helm render failures. Start from
  `deploy/helm/openwiki/examples/enterprise-values.yaml` and replace the
  placeholder origin, Git remote, trusted-header secret, image digest, and
  egress rules.

The container initializes `/data/wiki` on first boot, rebuilds the local search
index, serves `/livez` for liveness, `/readyz` for readiness, and admin-scoped
`/metrics` for Prometheus-style scraping. Set `OPENWIKI_PUBLIC_METRICS=1` only
when an internal scrape path already protects the metrics endpoint.

If ingress exposes a write-capable OpenWiki role, place the chart behind an
authenticating ingress/proxy and set `OPENWIKI_PUBLIC_ORIGIN` through
`openwiki.extraEnv` to the external origin. Server-rendered write forms reject
missing or cross-origin browser POSTs. Only enable trusted identity headers when
the ingress strips untrusted forwarded headers and supplies the shared
`OPENWIKI_TRUST_AUTH_HEADERS_SECRET`. If you also enable
`OPENWIKI_TRUST_PROXY_ORIGIN`, the proxy must send `x-openwiki-proxy-secret`
matching `OPENWIKI_TRUST_PROXY_ORIGIN_SECRET` or the trusted-header secret.

Hosted OAuth for remote MCP clients requires the same external origin discipline:
set `openwiki.oauthEnabled=true` and `openwiki.oauthIssuer=https://wiki.example.com`
only when that issuer is the TLS origin clients use. Store OAuth client
definitions, redirect URIs, bounds, and client-secret hashes in the workspace
config or a bootstrap secret process; never put raw OAuth client secrets or
bearer tokens in Helm values.

## Digest-pinned production install

```sh
helm upgrade --install openwiki deploy/helm/openwiki \
  --namespace openwiki \
  --create-namespace \
  --set image.repository=ghcr.io/joe-broadhead/open-wiki \
  --set image.digest=sha256:<digest>
```

For the enterprise profile, render with the example values first and keep the
rendered output as deployment evidence:

```sh
helm template openwiki deploy/helm/openwiki \
  --namespace openwiki \
  --values deploy/helm/openwiki/examples/enterprise-values.yaml
```

## SSO ingress example

Keep the SSO implementation in the ingress controller or a reverse proxy. The
OpenWiki pod should receive only sanitized identity headers plus a shared
proxy-to-app secret:

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/auth-url: "https://sso.example.com/oauth2/auth"
    nginx.ingress.kubernetes.io/auth-signin: "https://sso.example.com/oauth2/start?rd=$escaped_request_uri"
  hosts:
    - host: wiki.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: openwiki-tls
      hosts:
        - wiki.example.com
openwiki:
  trustedAuthHeaders: true
  trustedAuthHeadersSecret:
    existingSecret: openwiki-trusted-headers
    key: proxy-secret
  extraEnv:
    - name: OPENWIKI_PUBLIC_ORIGIN
      value: https://wiki.example.com
networkPolicy:
  ingress:
    from:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: ingress-nginx
        podSelector:
          matchLabels:
            app.kubernetes.io/name: ingress-nginx
```

Adjust `networkPolicy.ingress.from` to match the labels on your ingress
controller namespace and pods. When it is left empty, the chart intentionally
only allows traffic from OpenWiki pods.

## Web, worker, and Postgres queue

For a split web/worker deployment, enable the built-in `openwiki-worker`
Deployment and queue reaper CronJob. Hosted and enterprise deployments should
use Postgres for queue claims, the Postgres write coordinator, read/search
serving, and operational state:

```yaml
worker:
  enabled: true
queueReaper:
  enabled: true
openwiki:
  runtimeMode: enterprise
  bootstrapMode: skip
  requireAuth: true
  runtimeBackend: postgres
  readBackend: postgres
  searchBackend: postgres
  queueBackend: postgres
  writeCoordinatorBackend: postgres
  operationalStateBackend: postgres
  envFrom:
    - secretRef:
        name: openwiki-postgres
```

## NetworkPolicy

The default NetworkPolicy allows ingress only from pods selected by this chart
and denies egress until destinations are declared. For production, replace
`networkPolicy.ingress.from` with the specific ingress controller namespace/pod
selectors used by your cluster and set `networkPolicy.egress` to the exact DNS,
Postgres, Git, object-storage, and identity-provider destinations required by
the deployment.

## Backup CronJob

Enable `postgresBackup.enabled=true` only after `openwiki-postgres` contains a
`database-url` key and the backup PVC or existing claim points at durable
storage. Treat the CronJob as one layer of backup evidence; still back up Git,
object storage, and secrets.

Enable `workspaceBackup.enabled=true` to create and immediately verify
OpenWiki workspace backup artifacts on a schedule:

```sh
helm upgrade --install openwiki deploy/helm/openwiki \
  --namespace openwiki \
  --set image.digest=sha256:<digest> \
  --set workspaceBackup.enabled=true \
  --set workspaceBackup.schedule="23 2 * * *"
```

For cloud destinations, configure `runtime.backups.destinations` in the wiki
workspace and set `workspaceBackup.destinationId` to that destination ID. Put
provider credentials in `workspaceBackup.existingSecret`,
`workspaceBackup.envFrom`, or `workspaceBackup.extraEnv` as environment
variable names only. The chart must never contain raw access keys, connection
strings, private keys, or service-account tokens.

Restore order for hosted installs is:

1. Restore or reclone the Git workspace/PV.
2. Restore external object storage if `runtime.storage.backend` is not local.
3. Restore Postgres from `pg_dump`, PITR, or provider backup.
4. Restore service secrets and Git/cloud credentials.
5. Run `openwiki db migrate`, `openwiki index`, `openwiki db rebuild`,
   `openwiki db sync-postgres --full`, and readiness smoke checks before
   reopening writes.

The chart defaults `openwiki.bootstrapMode` to `inline`, which preserves the
single-pod startup path by running migrations, indexing, local index rebuild,
and Postgres sync before serving. For rolling upgrades, multiple web replicas,
or split web/worker deployments, run those commands once from a Helm hook or
deployment Job and set `openwiki.bootstrapMode=skip` on serving pods.
