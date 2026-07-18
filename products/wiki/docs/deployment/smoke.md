# Deployment Smoke Checks

Use these checks in disposable clusters, cloud projects, or scratch hosts before
copying a profile into a long-lived environment. They are intentionally
provider-neutral: prove the OpenWiki contract first, then add provider-specific
DNS, certificates, and identity.

## Common sequence

1. Create a disposable wiki or clone a non-sensitive fixture repository.
2. Pin the image by digest.
3. Configure the profile's auth boundary, public origin, and persistent storage.
4. Run the profile preflight command.
5. Start the service and check `/livez`, `/readyz`, and `/metrics`.
6. Create a proposal with a test actor or service-account token.
7. Run one worker job, such as `run lint` or `run index`.
8. Create a backup, restore it into a second disposable target, and rebuild
   derived stores.
9. Destroy the disposable infrastructure and confirm no public write surface,
   secret, or storage bucket remains.

## Local and Docker

```sh
openwiki init /tmp/openwiki-smoke --template team-wiki
openwiki --root /tmp/openwiki-smoke index
openwiki --root /tmp/openwiki-smoke db rebuild
openwiki --root /tmp/openwiki-smoke deploy preflight --deploy-profile local-personal
```

For Compose:

```sh
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
docker compose -f deploy/compose/docker-compose.yml config --quiet
docker compose -f deploy/compose/docker-compose.yml up --build --detach
curl --fail http://127.0.0.1:3030/readyz
docker compose -f deploy/compose/docker-compose.yml down
```

## Kubernetes or Helm

For the base Kubernetes manifests, start with the kind helper:

```sh
pnpm smoke:kubernetes
OPENWIKI_KIND_SMOKE=1 pnpm smoke:kubernetes
```

The first command records the exact kind/kubectl plan. The second command
creates or reuses the `openwiki-smoke` kind cluster, applies
`deploy/kubernetes/base`, waits for the OpenWiki deployment, and writes
`artifacts/openwiki-kind-smoke.json`.

Use a throwaway namespace:

```sh
kubectl create namespace openwiki-smoke
helm upgrade --install openwiki deploy/helm/openwiki \
  --namespace openwiki-smoke \
  --set image.repository=ghcr.io/joe-broadhead/open-wiki \
  --set image.digest=sha256:<digest>
kubectl -n openwiki-smoke rollout status deploy/openwiki
kubectl -n openwiki-smoke port-forward svc/openwiki 3030:3030
curl --fail http://127.0.0.1:3030/readyz
```

Before exposing ingress, run:

```sh
openwiki --root /data/wiki deploy preflight \
  --deploy-profile kubernetes-enterprise \
  --public-origin https://wiki.example.com \
  --image ghcr.io/joe-broadhead/open-wiki@sha256:<digest>
```

## Terraform clouds

For AWS and GCP examples:

- copy `backend.tf.example` to `backend.tf` only in disposable state storage;
- use a non-production DNS name or private ingress first;
- keep `allow_unauthenticated=false` on Cloud Run unless the deployment is a
  static/read-only demo;
- set `production_mode=false` only when intentionally testing unsafe shortcuts;
- destroy the stack after the smoke run.

Provider smoke commands:

```sh
terraform init
terraform plan
terraform apply
curl --fail https://<temporary-origin>/readyz
terraform destroy
```

Record the profile name, image digest, public origin, backup artifact location,
restore result, and teardown result in release notes before tagging.
