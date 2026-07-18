# gcp-gke

Use this profile for Google Cloud enterprise deployments on GKE.

## Quickstart

```sh
gcloud container clusters create openwiki --workload-pool=<project>.svc.id.goog
kubectl create namespace openwiki
helm upgrade --install openwiki deploy/helm/openwiki \
  --namespace openwiki \
  --set image.digest=sha256:<digest>
kubectl -n openwiki rollout status deploy/openwiki
kubectl -n openwiki port-forward svc/openwiki 3030:3030
```

## Authenticated Ingress

Enable GKE Ingress only after IAP, SSO, VPN, or another authenticating boundary
is configured for the hostname:

```sh
helm upgrade --install openwiki deploy/helm/openwiki \
  --namespace openwiki \
  --set ingress.enabled=true \
  --set-string 'openwiki.extraEnv[0].name=OPENWIKI_PUBLIC_ORIGIN' \
  --set-string 'openwiki.extraEnv[0].value=https://wiki.example.com'
```

## Preflight

```sh
OPENWIKI_WRITE_COORDINATOR_BACKEND=postgres \
OPENWIKI_RATE_LIMIT_ENABLED=1 \
openwiki --root /data/wiki deploy preflight \
  --deploy-profile gcp-gke \
  --public-origin https://wiki.example.com \
  --image ghcr.io/joe-broadhead/open-wiki@sha256:<digest>
```

## Security Notes

- Use GKE Ingress with IAP or an equivalent SSO gateway for browser writes.
- Use Workload Identity for cloud resources such as Cloud SQL or object storage.
- Use a Kubernetes persistent volume with filesystem semantics for `/data/wiki`.
- Do not substitute Cloud Storage FUSE for a production mutable Git workspace.

## Readiness Checks

```sh
kubectl -n openwiki rollout status deploy/openwiki
kubectl -n openwiki exec deploy/openwiki -- openwiki --root /data/wiki db sync-postgres --full
curl --fail http://127.0.0.1:3030/readyz
```

## Backup And Restore

Back up the persistent disk or file share, Git remote, Cloud SQL, object storage,
and Kubernetes secrets. Validate restore in a separate namespace with
`openwiki backup rehearse`, then confirm derived-store rebuilds, `/readyz`, and
an MCP read smoke before promoting.

## Rollback

Scale workers to zero, use the previous Helm release or image digest, restore
Cloud SQL/object-storage/PV backups when data changed, rebuild indexes, verify
`/readyz`, and resume ingress and workers after the Git state is coherent.

## MCP

Use HTTP MCP behind IAP or the same SSO ingress. Prefer service-account bearer
tokens for external agents and Workload Identity plus trusted proxy headers for
managed internal agents.
