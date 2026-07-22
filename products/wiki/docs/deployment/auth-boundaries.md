# SSO And Reverse Proxy Auth

OpenWiki does not implement native username/password login, sessions, or OIDC
flows. Hosted human login is provided by an external identity boundary such as
SSO, IAP, an authenticating load balancer, or a reverse proxy. That boundary
authenticates the user, strips untrusted client identity headers, and writes the
trusted OpenWiki headers before forwarding the request to OpenWiki.

See the [identity mapping guide](identity-mapping.md) for actor, group,
principal, role, scope, service-account, and `group:all-users` semantics.
For an apply-ready starting point, see
`deploy/proxy/nginx-oauth2-proxy.conf` in the repository.

## Trusted Header Contract

Enable trusted headers only between the proxy and OpenWiki:

```sh
OPENWIKI_TRUST_AUTH_HEADERS=1
OPENWIKI_TRUST_AUTH_HEADERS_SECRET=<long-random-shared-secret>
OPENWIKI_PUBLIC_ORIGIN=https://wiki.example.com
```

Set `OPENWIKI_TRUST_PROXY_ORIGIN=1` only when the same proxy also strips
untrusted `X-Forwarded-*` headers and rewrites `X-Forwarded-Proto` and
`X-Forwarded-Host` from the external request. Forwarded origin and client-IP
trust also requires `x-openwiki-proxy-secret`; OpenWiki verifies it against
`OPENWIKI_TRUST_PROXY_ORIGIN_SECRET` or, when that is unset,
`OPENWIKI_TRUST_AUTH_HEADERS_SECRET`.

| Header | Required | Meaning |
| --- | --- | --- |
| `x-openwiki-proxy-secret` | yes | Shared proxy-to-app secret. OpenWiki ignores trusted identity headers unless this matches `OPENWIKI_TRUST_AUTH_HEADERS_SECRET`; forwarded origin/IP trust uses `OPENWIKI_TRUST_PROXY_ORIGIN_SECRET` or the same auth-header secret. |
| `x-openwiki-actor` | recommended | Canonical actor id, for example `actor:user:alice` or `actor:agent:internal-researcher`. Use a stable slug, subject, or directory username that matches OpenWiki ID segments. |
| `x-openwiki-role` | optional | One OpenWiki role: `viewer`, `contributor`, `researcher`, `reviewer`, `maintainer`, or `admin`. |
| `x-openwiki-scopes` | optional | Comma-separated scopes such as `wiki:read,wiki:search,wiki:ask,wiki:propose`. Prefer roles for humans and narrow scopes for managed agents. |
| `x-openwiki-principals` | optional | Comma-separated principals such as `group:finance,role:reviewer`. |
| `x-openwiki-groups` | optional | Comma-separated group names. Values without `group:` are normalized to groups by the proxy convention in these examples. |

The proxy must remove all inbound client-supplied `x-openwiki-*` headers before
adding trusted values:

```nginx
proxy_set_header X-OpenWiki-Actor "";
proxy_set_header X-OpenWiki-Role "";
proxy_set_header X-OpenWiki-Scopes "";
proxy_set_header X-OpenWiki-Principals "";
proxy_set_header X-OpenWiki-Groups "";
proxy_set_header X-OpenWiki-Proxy-Secret "";
```

Then set the trusted values from verified identity claims. Never expose the
shared proxy secret to browsers, agents, logs, or static config committed to Git.

`group:all-users` means authenticated users behind this trusted boundary in a
private team deployment. It does not mean anonymous public internet users.

## Browser Behavior

Server-rendered write forms require a same-origin browser `Origin` that matches
the request host or `OPENWIKI_PUBLIC_ORIGIN`. Set:

```sh
OPENWIKI_PUBLIC_ORIGIN=https://wiki.example.com
```

when TLS terminates at a proxy or the browser origin differs from the internal
OpenWiki URL. Keep `OPENWIKI_TRUST_PROXY_ORIGIN` disabled unless the proxy owns
and rewrites forwarded origin headers and injects `x-openwiki-proxy-secret`.

The web UI displays an identity chip when OpenWiki receives trusted actor, role,
scope, principal, or service-account data. If no trusted identity is present, the
UI shows a neutral local or anonymous state.

## Scope-list bearer tokens (local only)

A Bearer value that is **only** a comma/space-separated scope list
(for example `wiki:read,wiki:write`) is treated as a **scope-token**: it elevates
scopes without a registered principal. That is a local/dev convenience.

| Client remote address | Default behavior |
| --- | --- |
| Loopback (`127.0.0.1`, `::1`) or in-process (no socket) | Scope-tokens accepted |
| Non-loopback | Scope-tokens **ignored** (no elevation); use service-account or OAuth |

Override with `OPENWIKI_ALLOW_SCOPE_TOKEN=1` only when you intentionally accept
scope-list bearers off loopback (not recommended for hosted). Set
`OPENWIKI_ALLOW_SCOPE_TOKEN=0` to disable even on loopback.

Hosted deployments that require authentication still need an actor/principal
(`requireAuthenticatedHttpPolicy`); a scope-token alone never satisfies that
gate.

## Agent Behavior

Use service-account bearer tokens for HTTP MCP when agents connect directly to
OpenWiki:

```sh
openwiki --root /data/wiki auth token create \
  --profile proposal-agent \
  --id service:proposal-agent \
  --expires-in-days 30
```

Then call MCP with:

```sh
curl https://wiki.example.com/mcp?tools=proposal \
  -H 'authorization: Bearer <service-account-token>' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"tools","method":"tools/list"}'
```

Use trusted proxy identity for managed internal agents only when your gateway can
authenticate the agent workload and assign narrow identity headers. Recommended
least-privilege defaults:

| Agent kind | Auth mode | Recommended access |
| --- | --- | --- |
| Local desktop agent | stdio MCP or `local-agent` service token | `proposal` tools, contributor role |
| Hosted read-only agent | `hosted-readonly-agent` token | read/search/ask only |
| Hosted inbox submitter | `inbox-submitter` token | submit/read owned inbox items only |
| Hosted inbox curator | `inbox-curator` token | process authorized Space inbox items without apply/publish scopes |
| Hosted editing assistant | `proposal-agent` token | read/search/ask/propose only |
| CI validation bot | `ci-bot` token | maintainer role only in CI network |
| Maintainer automation | `maintainer-automation` token or trusted internal identity | write tools, short expiration, audited |

Do not give browser users or internet-facing agents broad maintainer scopes
unless the request path is protected by SSO, network policy, audit logging, and
token rotation.

## Native OAuth For Remote MCP

OpenWiki can issue OAuth 2.1 bearer tokens for hosted MCP and HTTP API clients.
This is for agent/API credentials, not human browser login. Human login still
belongs at the SSO, IAP, load balancer, or reverse-proxy boundary above.

OAuth is disabled unless `auth.oauth.enabled` is true in `openwiki.json` or
`OPENWIKI_OAUTH_ENABLED=1` is set. Hosted OAuth must have one explicit public
issuer:

```json
{
  "auth": {
    "oauth": {
      "enabled": true,
      "issuer": "https://wiki.example.com",
      "clients": [
        {
          "client_id": "openclaw-personal",
          "client_name": "OpenClaw Personal Wiki",
          "public": true,
          "redirect_uris": ["http://localhost:17654/callback"],
          "actor_id": "actor:agent:openclaw",
          "role": "viewer",
          "scopes": ["wiki:read", "wiki:search", "wiki:ask"],
          "grant_types": ["authorization_code", "refresh_token"],
          "bounds": {
            "tool_modes": ["read"],
            "operations": ["wiki.search", "wiki.recall", "wiki.read_page"],
            "path_prefixes": ["wiki/"],
            "source_ids": ["source:personal-notes"]
          }
        }
      ]
    }
  }
}
```

If `auth.oauth.issuer` is omitted, OpenWiki uses `OPENWIKI_OAUTH_ISSUER` or
`OPENWIKI_PUBLIC_ORIGIN`. When none are configured, OAuth routes fail closed.
Use HTTPS issuers for hosted deployments; loopback HTTP is accepted for local
desktop clients.

Hosted HTTPS OAuth also requires shared OAuth state. Set
`OPENWIKI_OAUTH_STATE_BACKEND=postgres` or
`OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres` with `DATABASE_URL` or
`OPENWIKI_DATABASE_URL`. OpenWiki refuses hosted HTTPS OAuth with file-backed
state because clients, authorization codes, refresh tokens, and revocations
would not be consistent across replicas. File-backed OAuth state is only for
local loopback clients.

Doctor and deploy-preflight expose an `oauth-state` check (JOE-979): when OAuth
is enabled with file-backed state under hosted runtime mode, shared operational
Postgres, or `OPENWIKI_WEB_REPLICAS` / `WEB_REPLICAS` > 1, the check fails closed
and points operators at Postgres OAuth state. Helm also fails when
`replicaCount > 1` with `oauthEnabled=true` unless
`oauthStateBackend=postgres` or `operationalStateBackend=postgres` (and rejects
an explicit `oauthStateBackend=file` multi-replica combo).

Supported OAuth routes:

| Route | Purpose |
| --- | --- |
| `/.well-known/oauth-authorization-server` | OAuth metadata for MCP/API clients. |
| `/.well-known/oauth-protected-resource` | Protected-resource metadata for clients that discover authorization servers. |
| `/oauth/authorize` | Authorization code with PKCE. Runs behind the normal OpenWiki hosted auth boundary. |
| `/oauth/token` | Authorization-code, refresh-token, and client-credentials token exchange. |
| `/oauth/revoke` | Token revocation. |
| `/oauth/introspect` | Server-side token lookup for active/inactive state. |
| `/oauth/register` | Dynamic client registration. Disabled by default. |

Client secrets, authorization codes, access tokens, and refresh tokens are
stored as hashes or metadata. The raw token is returned only to the client at
issuance time. Do not log bearer tokens, authorization headers, OAuth form
bodies, prompt payloads, or private snippets.

Use authorization code with PKCE for desktop agents such as OpenClaw or
OpenCode. Use client credentials only for trusted automation with a secret kept
in a platform secret store. Keep dynamic client registration disabled unless an
admin-controlled registration service or initial-access-token process fronts it.

Clients created through dynamic registration are pending by default and cannot
receive authorization codes until an administrator approval workflow marks the
client approved.

OAuth tokens, service-account tokens, and trusted headers all resolve into the
same OpenWiki policy context. Bounds narrow that context further:

| Bound | Effect |
| --- | --- |
| `operations` | Allows only listed OpenWiki operations. |
| `tool_modes` | Intersects operations with read/proposal/write MCP tool tiers. |
| `path_prefixes` | Restricts page/path reads to matching repository paths. |
| `section_ids` | Restricts access to matching policy sections. |
| `source_ids` | Restricts source-linked pages, claims, facts, takes, graph/search results, and citations. |
| `inbox_providers` | Restricts inbox reads by provider. |
| `expires_at` | Fails authorization after the timestamp. |

For OpenClaw, configure the MCP server URL as:

```json
{
  "mcp": {
    "openwiki": {
      "type": "http",
      "url": "https://wiki.example.com/mcp?tools=read",
      "headers": {
        "MCP-Protocol-Version": "2025-11-25"
      },
      "oauth": {
        "issuer": "https://wiki.example.com"
      }
    }
  }
}
```

Use the OpenCode/OpenWiki pack for skills and operating guidance, but point its
credential flow at the OAuth issuer above when the client supports OAuth. When a
client does not support OAuth yet, use a short-lived service-account token with
equivalent bounds.

## oauth2-proxy + nginx

The oauth2-proxy deployment authenticates users and exposes verified identity to
nginx through `auth_request` headers. nginx strips all inbound OpenWiki identity
headers and rewrites them from oauth2-proxy output.

```nginx
location /oauth2/ {
  proxy_pass http://oauth2-proxy:4180;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Scheme $scheme;
}

location = /oauth2/auth {
  proxy_pass http://oauth2-proxy:4180;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Scheme $scheme;
  proxy_pass_request_body off;
  proxy_set_header Content-Length "";
}

location / {
  auth_request /oauth2/auth;
  error_page 401 = /oauth2/sign_in;

  auth_request_set $ow_user $upstream_http_x_auth_request_user;
  auth_request_set $ow_email $upstream_http_x_auth_request_email;
  auth_request_set $ow_groups $upstream_http_x_auth_request_groups;

  proxy_set_header X-OpenWiki-Actor "";
  proxy_set_header X-OpenWiki-Role "";
  proxy_set_header X-OpenWiki-Scopes "";
  proxy_set_header X-OpenWiki-Principals "";
  proxy_set_header X-OpenWiki-Groups "";
  proxy_set_header X-OpenWiki-Proxy-Secret "";

  # Use a stable slug-style username for the actor id; keep email in metadata headers when needed.
  proxy_set_header X-OpenWiki-Actor "actor:user:$ow_user";
  proxy_set_header X-OpenWiki-Role "contributor";
  proxy_set_header X-OpenWiki-Groups "$ow_groups";
  proxy_set_header X-OpenWiki-Proxy-Secret "$openwiki_proxy_secret";
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-Host $host;
  proxy_pass http://openwiki:3030;
}
```

OpenWiki env:

```sh
OPENWIKI_TRUST_AUTH_HEADERS=1
OPENWIKI_TRUST_AUTH_HEADERS_SECRET=<same-value-as-openwiki_proxy_secret>
OPENWIKI_PUBLIC_ORIGIN=https://wiki.example.com
OPENWIKI_TRUST_PROXY_ORIGIN=1
```

## Envoy

Use Envoy `ext_authz` with an OIDC-aware authorization service. Remove all
client-supplied OpenWiki identity headers before routing, then let the auth
service inject verified OpenWiki headers into the upstream request.

```yaml
request_headers_to_remove:
  - x-openwiki-actor
  - x-openwiki-role
  - x-openwiki-scopes
  - x-openwiki-principals
  - x-openwiki-groups
  - x-openwiki-proxy-secret
request_headers_to_add:
  - header:
      key: x-openwiki-proxy-secret
      value: "%OPENWIKI_PROXY_SECRET%"
    append_action: OVERWRITE_IF_EXISTS_OR_ADD
```

Map IdP claims in the auth service, not in browser-controlled headers:

- email or subject -> `x-openwiki-actor`
- directory groups -> `x-openwiki-groups`
- admin group membership -> `x-openwiki-role: admin`
- normal authenticated users -> `x-openwiki-role: contributor` or `viewer`

## Cloudflare Access

Cloudflare Access can authenticate users at the edge. Keep the OpenWiki origin
reachable only through Cloudflare, then map Access identity headers to OpenWiki
headers in a Worker, sidecar, or origin proxy.

Reference mapping:

| Cloudflare signal | OpenWiki header |
| --- | --- |
| `Cf-Access-Authenticated-User-Email` | `x-openwiki-actor: actor:user:<email>` |
| verified Access group or policy | `x-openwiki-groups` |
| admin Access policy | `x-openwiki-role: admin` |
| default Access policy | `x-openwiki-role: contributor` or `viewer` |

The origin proxy still must strip inbound `x-openwiki-*` headers and add
`x-openwiki-proxy-secret`. For higher assurance, verify `Cf-Access-Jwt-Assertion`
before deriving OpenWiki identity. Do not trust Cloudflare identity headers if
clients can reach the origin directly.

## Google IAP And Cloud Run

For Google Cloud, put OpenWiki behind HTTPS Load Balancing with IAP or an
equivalent Cloud Run/IAP boundary. IAP authenticates the user and forwards
identity headers such as `x-goog-authenticated-user-email`.

Reference mapping:

| Google IAP signal | OpenWiki header |
| --- | --- |
| `x-goog-authenticated-user-email` | `x-openwiki-actor` |
| group claims from an internal auth sidecar | `x-openwiki-groups` |
| privileged group membership | `x-openwiki-role: maintainer` or `admin` |
| default authenticated users | `x-openwiki-role: contributor` or `viewer` |

Cloud Run should receive traffic only from the trusted load balancer or internal
gateway that strips and rewrites OpenWiki headers. Set `OPENWIKI_PUBLIC_ORIGIN`
to the external HTTPS URL, not the internal service URL.

## AWS ALB OIDC

AWS Application Load Balancer can perform OIDC authentication before forwarding
to targets. ALB injects OIDC headers after authentication, including
`x-amzn-oidc-identity` and token headers.

Reference mapping in a target-side nginx or Envoy proxy:

| ALB OIDC signal | OpenWiki header |
| --- | --- |
| `x-amzn-oidc-identity` or verified claims token subject | `x-openwiki-actor` |
| verified IdP group claim | `x-openwiki-groups` |
| privileged IdP group claim | `x-openwiki-role: maintainer` or `admin` |
| default authenticated users | `x-openwiki-role: contributor` or `viewer` |

Restrict the target security group so only the ALB can reach OpenWiki. Strip
inbound `x-openwiki-*` headers at the target proxy even though ALB authenticated
the browser request.

## Generic OIDC Reverse Proxy

Any OIDC reverse proxy can work if it provides the same contract:

1. Authenticate the browser or managed internal agent with OIDC.
2. Verify the token signature, issuer, audience, expiration, and nonce/session.
3. Strip all inbound `x-openwiki-*` headers.
4. Map stable IdP subject/email to `x-openwiki-actor`.
5. Map directory groups to `x-openwiki-groups` or `x-openwiki-principals`.
6. Assign the least privileged `x-openwiki-role` or `x-openwiki-scopes`.
7. Add `x-openwiki-proxy-secret` from a server-side secret store.
8. Forward only to an OpenWiki origin that is not directly public.

## Threat Model

Trusted-header mode is safe only when the proxy boundary is real. Treat these as
release blockers for hosted write deployments:

- clients can reach OpenWiki without passing through the auth proxy
- the proxy forwards inbound client-supplied `x-openwiki-*` headers
- the shared proxy secret is missing, weak, logged, or exposed to browsers
- `OPENWIKI_TRUST_PROXY_ORIGIN=1` is set while forwarded headers are not stripped
- `OPENWIKI_PUBLIC_ORIGIN` does not match the browser-visible HTTPS origin
- `group:all-users` is interpreted as anonymous internet access
- service-account tokens have maintainer scopes without expiration or rotation

When in doubt, run OpenWiki read-only, publish a static export, or keep write
access on a private network until the auth boundary is verified.
