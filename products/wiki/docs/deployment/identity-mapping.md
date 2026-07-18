# Identity Mapping

OpenWiki keeps identity outside the app. Humans sign in through SSO or a trusted
reverse proxy, and agents authenticate with stdio MCP or service-account bearer
tokens. OpenWiki then evaluates policy from a small set of normalized identity
claims.

## Identity Model

| Term | Example | Purpose |
| --- | --- | --- |
| Actor | `actor:user:alice@example.com` | The concrete human or agent recorded in proposals, decisions, runs, and audit events. |
| Group | `group:finance` | A team or directory group used in Space grants. |
| Principal | `group:finance`, `role:reviewer`, `service:proposal-agent` | Any string that can receive a Space grant. |
| Role | `viewer`, `contributor`, `reviewer`, `maintainer`, `admin` | Human-friendly bundle of scopes plus Space access level. |
| Scope | `wiki:read`, `wiki:propose`, `wiki:admin` | Operation-level capability checked before route/tool execution. |
| Service account | `service:proposal-agent` | Token-backed non-human identity for agents and automation. |

The authorization decision is the intersection of operation scopes and Space
grants. A caller needs the required operation scope and the required Space role
for the target path.

## Header Mapping

Trusted proxies should map stable IdP claims into OpenWiki headers:

| IdP claim | OpenWiki header |
| --- | --- |
| Subject or email | `x-openwiki-actor: actor:user:<stable-id>` |
| Directory groups | `x-openwiki-groups: finance,platform` |
| Admin group membership | `x-openwiki-role: admin` |
| Normal authenticated user | `x-openwiki-role: contributor` or `viewer` |
| Special app roles | `x-openwiki-principals: role:reviewer,group:knowledge-reviewers` |

`x-openwiki-groups` values are normalized by prefixing `group:` when the proxy
sends bare names. For example, `finance platform` becomes
`group:finance, group:platform`. Values that already include a prefix are kept
as-is.

Use lower-case, stable, URL-safe group names where possible. Normalize IdP
display names at the proxy boundary instead of granting policy to changing names
such as `Finance Team (EMEA)`.

## Service Accounts

Service accounts are configured in `openwiki.json` and exposed in sanitized form
through:

```sh
openwiki --root /data/wiki auth token list
openwiki --root /data/wiki auth token inspect service:proposal-agent
```

Create and rotate tokens with short expirations:

```sh
openwiki --root /data/wiki auth token create \
  --profile proposal-agent \
  --id service:proposal-agent \
  --expires-in-days 30

openwiki --root /data/wiki auth token rotate service:proposal-agent \
  --expires-in-days 30
```

The raw token is printed only by create and rotate commands. List, inspect, UI,
and identity-summary views show token metadata and counts, never token values or
hashes.

## `group:all-users`

`group:all-users` is always present in permission evaluation. In a private team
deployment it means every authenticated user that reached OpenWiki through the
trusted boundary. It must not be treated as anonymous public internet access for
write-capable hosted servers.

Use this grant for broad internal knowledge:

```json
{ "principal": "group:all-users", "section": "section:team-knowledge", "role": "viewer" }
```

Use explicit groups for sensitive Spaces:

```json
{ "principal": "group:finance", "section": "section:finance", "role": "contributor" }
{ "principal": "group:finance-reviewers", "section": "section:finance", "role": "reviewer" }
```

## Preview And Dry Run

Admins can answer "can group X read/propose/review path Y and why?" from the CLI:

```sh
openwiki --root /data/wiki policy preview \
  --group finance \
  --path wiki/finance/compensation.md \
  --operation wiki.propose_edit
```

Use `--json` for automation. In the web UI, open **Admin -> Spaces -> Permission
Preview** to see matching Spaces, matching grants, allowed operations, and
record-level visibility reasons.

## Preflight Checklist

Before enabling hosted browser writes:

- `OPENWIKI_TRUST_AUTH_HEADERS=1` is set only for traffic behind the proxy.
- `OPENWIKI_TRUST_AUTH_HEADERS_SECRET` is a long random shared secret.
- The proxy strips all inbound `x-openwiki-*` headers before adding trusted
  identity values.
- `OPENWIKI_PUBLIC_ORIGIN` matches the external HTTPS origin.
- `OPENWIKI_TRUST_PROXY_ORIGIN=1` is used only when the same proxy strips and
  rewrites forwarded origin headers.
- `openwiki deploy preflight --deploy-profile kubernetes-enterprise --root /data/wiki`
  passes.
