# OpenWiki Kubernetes Base

This directory contains a plain Kubernetes base for environments that do not use
Helm.

```sh
kubectl apply -k deploy/kubernetes/base
kubectl -n openwiki port-forward svc/openwiki 3030:3030
```

The base deploys:

- `Namespace/openwiki`
- `ServiceAccount/openwiki`
- `PersistentVolumeClaim/openwiki-data`
- `Deployment/openwiki`
- `Service/openwiki`
- `PodDisruptionBudget/openwiki`
- `NetworkPolicy/openwiki`
- `PersistentVolumeClaim/openwiki-workspace-backups`
- `CronJob/openwiki-workspace-backup` suspended by default until a durable
  workspace backup target is configured
- `PersistentVolumeClaim/openwiki-postgres-backups`
- `CronJob/openwiki-postgres-backup` suspended by default until a Postgres
  secret and durable backup target are configured

The pod uses the standard OpenWiki container entrypoint, initializes `/data/wiki`
on first boot, rebuilds the local search index, exposes `/livez` for liveness,
`/readyz` for readiness, and admin-scoped `/metrics` for Prometheus-style
scraping. Set `OPENWIKI_PUBLIC_METRICS=1` only when an internal scrape path
already protects the metrics endpoint.

The base manifest is a single-writer profile. If an overlay adds rolling web
replicas or separate worker pods, run `openwiki db migrate`, `openwiki index`,
`openwiki db rebuild`, and `openwiki db sync-postgres` once from a deployment
Job or maintenance pod, then set `OPENWIKI_BOOTSTRAP_MODE=skip` on serving
containers.

The base NetworkPolicy allows ingress only from pods in the same namespace. Add
an overlay for your ingress controller namespace and pod labels instead of
changing it to `namespaceSelector: {}`, which would allow every namespace.

For split web/worker deployments, keep this base as the web/API/MCP service and
add a worker Deployment in an overlay:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: openwiki-worker
  namespace: openwiki
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: openwiki-worker
  template:
    metadata:
      labels:
        app.kubernetes.io/name: openwiki-worker
    spec:
      automountServiceAccountToken: false
      containers:
        - name: worker
          image: ghcr.io/joe-broadhead/open-wiki@sha256:<digest>
          command: ["pnpm", "openwiki", "--", "--root", "/data/wiki", "worker", "--poll-ms", "1000"]
          env:
            - name: OPENWIKI_QUEUE_BACKEND
              value: postgres
            - name: OPENWIKI_WRITE_COORDINATOR_BACKEND
              value: postgres
          envFrom:
            - secretRef:
                name: openwiki-postgres
          volumeMounts:
            - name: wiki-data
              mountPath: /data/wiki
      volumes:
        - name: wiki-data
          persistentVolumeClaim:
            claimName: openwiki-data
```

## Backup Jobs

The workspace backup CronJob runs `openwiki backup create`, immediately verifies
the latest artifact, and then prunes according to the checked-in retention
example. It is suspended by default because operators must first point
`openwiki-workspace-backups` at durable storage or replace the command with a
configured `runtime.backups` destination.

The Postgres backup CronJob is also suspended by default. Enable it only after
the `openwiki-postgres` secret contains `database-url` and the backup PVC or
provider storage is durable. Restore a hosted deployment in this order: Git
workspace/PV, external object storage, Postgres, service secrets, derived
indexes and Postgres sync, then readiness smoke checks.
