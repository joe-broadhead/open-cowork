# kubernetes-enterprise

Use Helm or Kustomize for large companies, many teams, sensitive spaces, and
separate web/worker/runtime backends.

## Quickstart

```sh
helm upgrade --install openwiki deploy/helm/openwiki \
  --namespace openwiki \
  --create-namespace \
  --values deploy/helm/openwiki/examples/enterprise-values.yaml \
  --set image.repository=ghcr.io/joe-broadhead/open-wiki \
  --set image.digest=sha256:<digest>
kubectl -n openwiki rollout status deploy/openwiki
kubectl -n openwiki port-forward svc/openwiki 3030:3030
```

## Authenticated Ingress

Enable ingress only after SSO, IAP, VPN, or an authenticating reverse proxy is
configured for the host:

```sh
helm upgrade --install openwiki deploy/helm/openwiki \
  --namespace openwiki \
  --set ingress.enabled=true \
  --set-string 'openwiki.extraEnv[0].name=OPENWIKI_PUBLIC_ORIGIN' \
  --set-string 'openwiki.extraEnv[0].value=https://wiki.example.com'
```

Kustomize base:

```sh
kubectl apply -k deploy/kubernetes/base
```

## Preflight

```sh
OPENWIKI_WRITE_COORDINATOR_BACKEND=postgres \
OPENWIKI_RATE_LIMIT_ENABLED=1 \
openwiki --root /data/wiki deploy preflight \
  --deploy-profile kubernetes-enterprise \
  --public-origin https://wiki.example.com \
  --image ghcr.io/joe-broadhead/open-wiki@sha256:<digest>
```

## Security Notes

- Put ingress behind SSO or an authenticating reverse proxy.
- Disable unauthenticated public writes.
- Keep `automountServiceAccountToken: false` unless a future integration needs
  Kubernetes API access.
- Use read-only root filesystem, dropped capabilities, resource requests, and
  digest-pinned images.

## Readiness Checks

```sh
kubectl -n openwiki rollout status deploy/openwiki
kubectl -n openwiki exec deploy/openwiki -- openwiki --root /data/wiki run lint --json
kubectl -n openwiki exec deploy/openwiki -- env | grep OPENWIKI_WRITE_COORDINATOR_BACKEND=postgres
kubectl -n openwiki port-forward svc/openwiki 3030:3030
curl --fail http://127.0.0.1:3030/readyz
```

## Backup And Restore

Back up the persistent volume, Git remote, Postgres, object storage, and
secrets. For enterprise deployments, prefer managed Postgres for read/search and
queue backends, and provider object storage for large captures.

The Helm chart exposes two separate backup jobs:

- `workspaceBackup.enabled=true` creates and verifies OpenWiki workspace
  backup artifacts on a schedule.
- `postgresBackup.enabled=true` runs `pg_dump` to a durable backup PVC or
  existing claim.

For cloud backup destinations, keep only destination metadata in
`openwiki.json` and mount credentials through Kubernetes secrets,
`workspaceBackup.existingSecret`, `workspaceBackup.envFrom`, workload identity,
or an equivalent provider secret mechanism.

Rehearse restore into a scratch PVC or an isolated operator pod before replacing
production state:

```sh
kubectl -n openwiki run openwiki-restore-rehearsal --rm -it --restart=Never \
  --image=ghcr.io/joe-broadhead/open-wiki@sha256:<digest> \
  --overrides='{"spec":{"containers":[{"name":"openwiki-restore-rehearsal","image":"ghcr.io/joe-broadhead/open-wiki@sha256:<digest>","command":["openwiki","--root","/data/wiki","backup","rehearse","--out-dir","/backups","--target-root","/tmp/openwiki-restore","--json"],"volumeMounts":[{"name":"wiki","mountPath":"/data/wiki"},{"name":"backups","mountPath":"/backups"}]}],"volumes":[{"name":"wiki","persistentVolumeClaim":{"claimName":"openwiki"}},{"name":"backups","persistentVolumeClaim":{"claimName":"openwiki-workspace-backups"}}]}}'
kubectl -n openwiki exec deploy/openwiki -- \
  openwiki --root /data/wiki doctor --profile kubernetes --json
```

Use the PVC names created by your Helm release or overlay. The main Deployment
mounts the wiki PVC only; the backup CronJob/operator pod must mount both the
wiki and backup PVCs to rehearse a filesystem restore.

## Rollback

Scale workers to zero, pause ingress writes, restore Postgres/object storage/PV
or fast-forward Git back to the previous accepted commit, restore trusted proxy
and MCP token material from Kubernetes or provider secrets, roll the Deployment
back to the previous image digest, rebuild derived stores, verify `/readyz`, run
an MCP read smoke, and only then resume workers.

## MCP

Expose `/mcp` through the same authenticated ingress. Use service-account bearer
tokens for external agents and trusted proxy identity headers only for managed
internal agents authenticated by the gateway.
For hosted inbox submitters and Space curators, follow
[Hosted Inbox Agents](../../guides/hosted-inbox-agents.md), use separate token
profiles per integration, and keep Postgres operational state enabled for
multi-replica deployments.
