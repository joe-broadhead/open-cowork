# First User Path

This path is for the first person trying OpenWiki with a real personal or team
wiki. It keeps the first pass focused on the product workflow: search, read,
follow links, propose edits, inspect history, manage Spaces, and connect agents
with proposal-mode MCP.

## 1. Start Locally

Create a private personal wiki and prepare the derived stores:

```sh
pnpm pack:cli
npm install -g ./artifacts/npm/openwiki-cli-0.0.0.tgz
openwiki setup personal ~/openwiki-personal --agent opencode --tools proposal
openwiki serve ~/openwiki-personal --host 127.0.0.1 --port 3030
```

Open `http://127.0.0.1:3030`. Keep the server on loopback for personal testing.
Do not bind a write-capable personal wiki to `0.0.0.0`.

If you created the wiki with `init` instead of `setup personal`, run the derived
store commands before serving:

```sh
openwiki --root ~/openwiki-personal index
openwiki --root ~/openwiki-personal db rebuild
```

When `--agent opencode` is selected, setup also writes `opencode.json` and the
project-local `.opencode` pack into the wiki repository. Run OpenCode from that
wiki root so it picks up the bundled agents, skills, guardrails, and MCP config.

## 2. Walk The Human UI

Use this as the first smoke walkthrough. It is intentionally short enough to run
manually during a release or after a deployment.

1. Home: confirm the top navigation shows `Home`, `Pages`, `Proposals`, and
   `Admin` only when the current identity has admin scope.
2. Login boundary: behind SSO or a trusted proxy, confirm the top bar identity
   chip shows the actor, role, principal, or service-account context. On a local
   loopback server with no trusted headers, confirm it shows the neutral local
   or anonymous state.
3. Search: search for `personal knowledge` or `team knowledge`; open the first
   result and confirm highlights point to real page content.
4. Read: follow an inline wiki link from the page body and verify the target
   page keeps the same wiki navigation.
5. Propose: use the page edit/propose action for one small wording change. The
   result should create a proposal, not directly rewrite the page.
6. History: open the proposal and page history views; confirm validation,
   review state, and Git-backed changes are visible.
7. Spaces: open `Spaces & Permissions` and confirm the Team Knowledge or
   Personal Knowledge Space lists visibility, path coverage, viewers,
   contributors, reviewers, maintainers, and admins.
8. Admin: confirm advanced graph, runs, OpenAPI, MCP manifest, health, and
   metrics links are secondary under Admin, not the main wiki path.

Optional screenshot evidence can be regenerated with:

```sh
pnpm screenshots
```

The screenshots are release artifacts under `artifacts/openwiki-screenshots/`;
the maintained first-user proof is this walkthrough plus the UI smoke and
quality gates.

## 3. Connect A Local Agent

Start with proposal-mode stdio MCP. It lets an agent search, read, inspect
history, comment, and propose edits without applying them.

```sh
openwiki agent providers list
openwiki --root ~/openwiki-personal mcp install opencode --mode proposal

openwiki --root ~/openwiki-personal mcp install generic \
  --mode proposal \
  --output ~/.config/openwiki/mcp.json
```

Generic MCP client config:

```json
{
  "mcp": {
    "openwiki-personal": {
      "type": "local",
      "enabled": true,
      "command": [
        "openwiki",
        "--root",
        "/absolute/path/to/openwiki-personal",
        "mcp",
        "--stdio",
        "--tools",
        "proposal"
      ]
    }
  }
}
```

Ask the agent to run this safe first task:

1. Search for `personal knowledge`.
2. Read `page:concept:personal-knowledge-base`.
3. Propose one small edit.
4. Read the proposal detail and report the validation status.

Keep `--tools write` for short-lived trusted maintainer jobs only.

## 4. Choose Hosted Deployment

Use the profile matrix before copying commands. Every hosted private wiki should
pin the image digest, configure `OPENWIKI_PUBLIC_ORIGIN`, and put browser writes
behind SSO, a private network, or a trusted reverse proxy.

| Need | Start With | Cookbook |
| --- | --- | --- |
| Local or trusted team VM | Docker or Compose | [Docker And Compose](../deployment/profiles/docker-compose.md) |
| Kubernetes or large company deployment | Helm/Kustomize | [Kubernetes And Helm](../deployment/profiles/kubernetes-helm.md) |
| AWS standard platform | ECS/Fargate with EFS | [AWS](../deployment/profiles/aws.md) |
| Google Cloud enterprise | GKE with IAP or SSO ingress | [GCP](../deployment/profiles/gcp.md) |
| Cloud Run preview | Read-mostly Cloud Run | [Cloud Run](../deployment/profiles/cloud-run.md) |

Minimal Docker private smoke:

```sh
docker run --rm -p 127.0.0.1:3030:3030 \
  -v openwiki_data:/data/wiki \
  ghcr.io/joe-broadhead/open-wiki@sha256:<digest>
curl --fail http://127.0.0.1:3030/readyz
```

Minimal Compose private smoke:

```sh
POSTGRES_PASSWORD="$(openssl rand -base64 32)" \
docker compose -f deploy/compose/docker-compose.yml up
curl --fail http://127.0.0.1:3030/readyz
```

Minimal Kubernetes private smoke:

```sh
helm upgrade --install openwiki deploy/helm/openwiki \
  --namespace openwiki \
  --create-namespace \
  --set image.repository=ghcr.io/joe-broadhead/open-wiki \
  --set image.digest=sha256:<digest>
kubectl -n openwiki rollout status deploy/openwiki
kubectl -n openwiki port-forward svc/openwiki 3030:3030
```

Run the same preflight shape for every hosted profile:

```sh
OPENWIKI_RATE_LIMIT_ENABLED=1 \
OPENWIKI_WRITE_COORDINATOR_BACKEND=postgres \
openwiki --root /data/wiki deploy preflight \
  --deploy-profile kubernetes-enterprise \
  --public-origin https://wiki.example.com \
  --image ghcr.io/joe-broadhead/open-wiki@sha256:<digest>
```

Use the deployment profile name that matches the cookbook you chose.

## 5. Add The Auth Boundary

OpenWiki does not implement native login. Humans sign in through SSO, IAP, an
authenticating load balancer, or a reverse proxy. OpenWiki receives trusted
identity headers only after the proxy strips client-supplied `x-openwiki-*`
headers and injects `x-openwiki-proxy-secret`.

App environment:

```sh
OPENWIKI_TRUST_AUTH_HEADERS=1
OPENWIKI_TRUST_AUTH_HEADERS_SECRET=<long-random-shared-secret>
OPENWIKI_PUBLIC_ORIGIN=https://wiki.example.com
OPENWIKI_TRUST_PROXY_ORIGIN=1
```

Use one of these boundary starters:

| Boundary | Copy-Paste Starting Point |
| --- | --- |
| oauth2-proxy + nginx | `deploy/proxy/nginx-oauth2-proxy.conf` and [SSO And Reverse Proxy Auth](../deployment/auth-boundaries.md#oauth2-proxy-nginx) |
| Envoy or service mesh | [Envoy header removal and injection](../deployment/auth-boundaries.md#envoy) |
| Cloudflare Access | [Cloudflare Access mapping](../deployment/auth-boundaries.md#cloudflare-access) |
| Google IAP or Cloud Run | [Google IAP And Cloud Run](../deployment/auth-boundaries.md#google-iap-and-cloud-run) |
| AWS ALB OIDC | [AWS ALB OIDC](../deployment/auth-boundaries.md#aws-alb-oidc) |
| Generic OIDC proxy | [Generic OIDC Reverse Proxy](../deployment/auth-boundaries.md#generic-oidc-reverse-proxy) |

Do not expose a write-capable hosted server until the proxy blocks direct origin
access, strips inbound OpenWiki headers, sets the shared proxy secret, and makes
`OPENWIKI_PUBLIC_ORIGIN` match the browser-visible HTTPS URL.

## 6. Configure Hosted Agents

For hosted agents, use service-account bearer tokens and Streamable HTTP MCP.
Proposal mode is the default safe editing posture:

```sh
openwiki --root /data/wiki auth token create \
  --profile proposal-agent \
  --id service:proposal-agent \
  --description "Hosted proposal-mode agents" \
  --expires-in-days 30

openwiki --root /data/wiki agent configure \
  --client generic \
  --transport http \
  --server-url https://wiki.example.com \
  --tools proposal \
  --token-env OPENWIKI_PROPOSAL_TOKEN \
  --config-out ./openwiki.remote-mcp.json
```

Store the raw token in the named environment secret. The generated config points
at `https://wiki.example.com/mcp?tools=proposal` and sends the MCP protocol
version header.

## 7. Set Rate Limits By Profile

| Profile | Recommendation |
| --- | --- |
| Local personal | Keep limits disabled unless you are testing abuse controls. |
| Single private team process | Enable OpenWiki app limits and keep operational state in memory. |
| Multi-replica HTTP or MCP | Use Postgres operational state plus an edge limiter. |
| Cloud Run, AWS, GCP | Put a load balancer, gateway, WAF, ingress, or proxy limiter in front of OpenWiki. |

Useful starting env:

```sh
OPENWIKI_RATE_LIMIT_ENABLED=1
OPENWIKI_RATE_LIMIT_SEARCH=120
OPENWIKI_RATE_LIMIT_MCP=120
OPENWIKI_RATE_LIMIT_PROPOSAL=60
OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres
```

See [Rate Limiting](../deployment/rate-limiting.md) and
[Monitoring And Abuse Controls](../deployment/operations/monitoring.md) for the
edge-layer recommendations by platform.

## Done Checklist

- Local server answers `/readyz`.
- You can search, read, follow links, propose an edit, inspect history, and view
  Spaces without opening protocol internals.
- A local agent can connect through stdio MCP in proposal mode and create a
  governed proposal.
- Hosted profile preflight passes for the deployment target.
- Browser writes are behind SSO or a trusted proxy boundary.
- Hosted HTTP MCP uses scoped service-account tokens or managed trusted
  identity headers.
- Rate limiting and operational state match the deployment profile.
