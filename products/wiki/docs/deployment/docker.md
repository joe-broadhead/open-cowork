# Docker

Build locally:

```sh
docker build -t openwiki/openwiki:local .
docker run --rm -p 127.0.0.1:3030:3030 -v openwiki_data:/data/wiki openwiki/openwiki:local
```

The image initializes `/data/wiki` on first boot and starts the HTTP server. It
uses explicit Dockerfile copy rules and `.dockerignore` to avoid shipping local
generated artifacts. The runtime base image is pinned by digest, runs the
application as the non-root `node` user, and exposes a `/readyz` Docker
`HEALTHCHECK`.

Release images are published to GHCR by digest. The image workflow smoke-tests
the container, scans it with Trivy, publishes BuildKit provenance and SBOM
attestations, signs the pushed digest with keyless Cosign, and uploads a GitHub
build provenance attestation.

Use tags for discovery and immutable digests for production deployment:

```sh
docker pull ghcr.io/joe-broadhead/open-wiki@sha256:<digest>
```

The Docker quickstart binds to loopback. Bind to a private address or all
interfaces only when a VPN, firewall, trusted reverse proxy, or SSO boundary
protects the route and `OPENWIKI_PUBLIC_ORIGIN` matches the external HTTPS
origin.

For Git-backed hosted use, mount persistent storage and configure the remote
with environment variables such as `OPENWIKI_GIT_REMOTE_URL` and
`OPENWIKI_GIT_BRANCH`. The entrypoint validates those values and runs boot-time
Git probes/clones with OpenWiki's hardened Git transport flags.

Use HTTPS or SSH remotes for hosted containers. Local filesystem and loopback
HTTP remotes require `OPENWIKI_ALLOW_LOCAL_GIT_REMOTE=1`; keep that setting to
local development, home-lab, NAS, or air-gapped deployments only.

By default the container runs `openwiki db migrate`, `openwiki index`,
`openwiki db rebuild`, and `openwiki db sync-postgres` inline before serving.
That default is intended for one container against one writable workspace. For
multi-replica or web/worker deployments, run those commands once from a
deployment job or maintenance pod, then set `OPENWIKI_BOOTSTRAP_MODE=skip` on
serving containers.
