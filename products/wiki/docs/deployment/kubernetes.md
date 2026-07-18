# Kubernetes

Plain manifests live in `deploy/kubernetes/base`.

```sh
kubectl apply -k deploy/kubernetes/base
kubectl -n openwiki port-forward svc/openwiki 3030:3030
```

The base manifests include the OpenWiki pod, service, PVC, PDB, NetworkPolicy,
and suspended workspace/Postgres backup CronJob templates. Treat them as a
starting point for production overlays that add ingress, auth,
provider-specific backup storage, scaling, and observability.
Production overlays should pin the OpenWiki image by digest instead of relying
on mutable tags. The checked-in base manifests pin the first public preview tag,
`0.0.0`, rather than `latest`.

Enable the workspace backup CronJob only after its PVC or destination points at
durable storage. Enable the Postgres backup CronJob only after the database URL
secret and a durable backup target exist. Cloud credentials should be attached
through Kubernetes secrets or workload identity, never stored directly in
manifests.
