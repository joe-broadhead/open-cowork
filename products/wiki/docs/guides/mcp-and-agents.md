# MCP And Agents

OpenWiki exposes MCP so agents can use the same knowledge workflow as humans:
search, read, inspect history, and propose edits by default. Review, apply,
fetch, Git sync, and publish are trusted write operations.

## Tool Modes

| Mode | Use For | Includes |
| --- | --- | --- |
| `read` | Normal research and question answering | Search, ask, read records, trace claims, history, graph, events, runs, proposals |
| `proposal` | Safe editing by assistants | All read tools plus proposal creation and proposal comments |
| `write` | Trusted maintainer automation | Review, apply, ingest, fetch, Git sync, jobs, lint, publish |

Start local stdio MCP with the packaged CLI:

```sh
openwiki --root /path/to/wiki mcp --stdio --tools proposal
```

With the packaged CLI, generate a personal wiki and MCP client config in one
step:

```sh
openwiki setup personal ~/openwiki-personal --agent opencode --tools proposal
```

This wraps `openwiki init --template personal-wiki`, search indexing,
`openwiki db rebuild`, MCP config generation, and project-local OpenCode pack
installation when `--agent opencode` is selected.

For an existing wiki, generate client config without reinitializing:

```sh
openwiki agent providers list

openwiki --root ~/openwiki-personal mcp install opencode --mode proposal

openwiki --root ~/openwiki-personal mcp install generic \
  --mode proposal \
  --output ~/.config/openwiki/mcp.json
```

The install command writes stdio MCP client config, records agent setup metadata
for `doctor --profile personal`, and refuses `--mode write` unless you also
pass `--confirm-write-tools`.

Use `agent configure` when you need explicit token file or hosted transport
control:

```sh
openwiki --root ~/openwiki-personal agent configure \
  --client generic \
  --tools proposal \
  --create-token \
  --token-out ~/.config/openwiki/tokens/personal-agent.token \
  --config-out ~/.config/openwiki/mcp.json
```

Generate a hosted Streamable HTTP config for a remote MCP client:

```sh
openwiki --root /data/wiki agent configure \
  --client generic \
  --transport http \
  --server-url https://wiki.example.com \
  --tools proposal \
  --token-env OPENWIKI_PROPOSAL_TOKEN \
  --config-out ./openwiki.remote-mcp.json
```

The generated HTTP config points at
`https://wiki.example.com/mcp?tools=proposal`, sends
`MCP-Protocol-Version: 2025-11-25`, and reads the bearer token from an
environment secret. If you create the token with `--create-token --token-out`,
load that file into the named environment secret or your platform secret
manager before starting the MCP client.

For a personal wiki, use local stdio first. It keeps agent access on the same
machine and avoids exposing the HTTP server.

OpenClaw can use the same generated MCP configuration and the installed
OpenCode-compatible `.opencode/skills` guidance. Install the pack with
`openwiki integrate opencode --wiki-root /path/to/wiki --out-dir /path/to/project`
and point OpenClaw at that project configuration.

For hosted OpenClaw or OpenCode clients that support OAuth, prefer OAuth 2.1
authorization code with PKCE instead of a copied long-lived bearer token. The
server publishes discovery at:

```text
https://wiki.example.com/.well-known/oauth-authorization-server
```

Example remote MCP client entry:

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

Bind the OAuth client to the same OpenWiki actor, scopes, and bounds you would
give a service account. Use `operations`, `tool_modes`, `path_prefixes`, and
`source_ids` bounds for personal dogfood clients so OpenClaw can only read the
wiki areas and source families intended for that agent. If the MCP client does
not support OAuth yet, use a short-lived service-account token with equivalent
bounds.

If stdio MCP needs a service-account token, keep the raw value out of the
process command line:

```sh
export OPENWIKI_TOKEN=<service-account-token>
openwiki --root /path/to/wiki mcp --stdio --tools proposal

openwiki --root /path/to/wiki mcp --stdio --tools proposal --token-env OPENWIKI_TOKEN
openwiki --root /path/to/wiki mcp --stdio --tools proposal --token-file ~/.config/openwiki/token
```

## Service Account Tokens

Hosted agents, CI jobs, and maintainer automation should authenticate with
service-account bearer tokens instead of editing `openwiki.json` by hand. Token
commands persist only SHA-256 hashes and token metadata. The raw token is printed
once when it is created or rotated; store it immediately in your local MCP
client, CI secret store, or platform secret manager.

Create a local proposal-mode agent token for a desktop MCP client:

```sh
openwiki --root ~/openwiki-personal auth token create \
  --profile local-agent \
  --id service:local-agent \
  --description "Local desktop agent" \
  --expires-in-days 90
```

Create a hosted read-only agent token for remote search and read access:

```sh
openwiki --root /data/wiki auth token create \
  --profile hosted-readonly-agent \
  --id service:hosted-readonly-agent \
  --description "Hosted read-only MCP agents" \
  --expires-in-days 30
```

Create a proposal-mode token for remote assistants that may suggest edits but
may not apply them:

```sh
openwiki --root /data/wiki auth token create \
  --profile proposal-agent \
  --id service:proposal-agent \
  --description "Hosted proposal agents" \
  --expires-in-days 30
```

Create inbox-specific tokens for hosted inbox automation:

```sh
openwiki --root /data/wiki auth token create \
  --profile inbox-submitter \
  --id service:inbox-submitter \
  --description "Hosted inbox submitters" \
  --expires-in-days 30

openwiki --root /data/wiki auth token create \
  --profile inbox-curator \
  --id service:inbox-curator \
  --description "Hosted inbox curator" \
  --expires-in-days 14
```

`inbox-submitter` can submit and read owned inbox items. `inbox-curator` can
read, submit, and process authorized Space inbox items, but it does not receive
proposal-apply, Git commit, or publish scopes.

Create CI and maintainer automation tokens only for trusted jobs:

```sh
openwiki --root /data/wiki auth token create \
  --profile ci-bot \
  --id service:ci-bot \
  --description "CI validation bot" \
  --expires-in-days 30

openwiki --root /data/wiki auth token create \
  --profile maintainer-automation \
  --id service:maintainer-automation \
  --description "Trusted maintainer automation" \
  --expires-in-days 14
```

List, inspect, rotate, and revoke tokens without exposing raw values:

```sh
openwiki --root /data/wiki auth token list
openwiki --root /data/wiki auth token inspect service:proposal-agent
openwiki --root /data/wiki auth token rotate service:proposal-agent --expires-in-days 30
openwiki --root /data/wiki auth token revoke service:proposal-agent --reason "rotated out of band"
```

Use a service-account token with HTTP MCP:

```sh
curl http://127.0.0.1:3030/mcp?tools=proposal \
  -H 'authorization: Bearer <service-account-token>' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"tools","method":"tools/list"}'
```

Managed internal agents can also use trusted proxy identity headers when they
sit behind the same SSO or workload-identity gateway as browser users. The proxy
must authenticate the workload, strip inbound `x-openwiki-*` headers, inject
`x-openwiki-actor`, least-privilege role/scope headers, and
`x-openwiki-proxy-secret`, then forward to OpenWiki over a private path. Do not
use trusted proxy identity for arbitrary internet clients.

## Personal Wiki Agent Smoke Test

Create and prepare a local wiki:

```sh
openwiki setup personal ~/openwiki-personal --agent opencode --tools proposal
openwiki --root ~/openwiki-personal serve --host 127.0.0.1 --port 3030
```

In a second terminal, check discovery:

```sh
curl http://127.0.0.1:3030/readyz
curl http://127.0.0.1:3030/mcp-manifest.json
```

Then connect an MCP client with proposal tools:

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

If you are contributing from a source checkout rather than using the packaged
binary, use the contributor source-runner form documented in
`CONTRIBUTING.md`.

Ask the agent to:

1. Search for `personal knowledge`.
2. Read `page:concept:personal-knowledge-base`.
3. Propose one small edit.
4. Read the proposal detail and report the validation status.

Do not start with `--tools write`. Promote an agent to write mode only for a
specific trusted maintenance task after you have inspected proposal behavior.
When a trusted write-mode agent needs to sync a wiki, prefer `wiki.sync_now`.
It uses OpenWiki coordination and refuses dirty workspaces instead of giving
the agent raw Git command control.

## OpenCode Pack

OpenWiki includes an OpenCode integration pack with agents, skills, guardrails,
and MCP examples. `openwiki setup personal --agent opencode` installs the
personal-curator pack into the wiki repository automatically. Install it into
another project or refresh an existing pack with:

```sh
openwiki agent install --provider opencode --profile personal-curator --out-dir /path/to/project --wiki-root /path/to/wiki

openwiki integrate opencode --profile wiki-curator --out-dir /path/to/project --wiki-root /path/to/wiki
```

The project-local pack writes `.opencode/agents`, `.opencode/skills`,
`.opencode/plugins`, project rules, and an OpenCode config. Reference TS tool
stubs are kept in the source integration pack but are not installed by default;
the MCP server is the supported tool surface.

The default MCP config uses proposal mode when `--wiki-root` is supplied. If the
wiki path is not known yet, omit `--wiki-root` and bind MCP later with
`openwiki --root <wiki> agent configure`. Use `--tools read` for research-only
sessions and reserve `--tools write` for trusted maintainer jobs.

The full pack includes `openwiki-meeting-curator`,
`openwiki-inbox-operator`, `openwiki-transcript-inbox`, and
`openwiki-meeting-curation` for watched folders, hosted submissions, and
transcript inboxes. The meeting curator reads inbox metadata and transcript
sources, searches for existing people, organizations, projects, topics, and
meetings, then proposes linked page updates with source provenance and
ambiguities preserved.

For local stdio proposal mode, see
`integrations/opencode/examples/opencode.local-proposal.json`. For hosted
Streamable HTTP MCP proposal mode, see
`integrations/opencode/examples/opencode.hosted-http-proposal.json` and provide
`OPENWIKI_PROPOSAL_TOKEN` as a scoped service-account secret.
For remote inbox submitters, team curators, and deployment-specific runtime
requirements, see [Hosted Inbox Agents](hosted-inbox-agents.md).

OpenWiki user installs do not pin an OpenCode model. Configure the model in
OpenCode settings or pass `--model` to `opencode run`. The provider contract is
documented in [Agent Provider Contract](../reference/agent-providers.md).

## HTTP MCP

HTTP MCP metadata is available from a running server:

```sh
curl http://127.0.0.1:3030/mcp-manifest.json
```

The live endpoint is `/mcp`. It supports the MCP Streamable HTTP transport:

- `POST /mcp?tools=read|proposal|write` accepts one JSON-RPC message per
  request. Existing one-shot JSON clients can continue to post without session
  headers.
- `GET /mcp` opens a server-to-client `text/event-stream` stream for clients
  that received an `MCP-Session-Id` during `initialize`.
- `DELETE /mcp` terminates a Streamable HTTP session when the client is done.

Initialize a remote session:

```sh
curl -i http://127.0.0.1:3030/mcp?tools=proposal \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{"jsonrpc":"2.0","id":"init","method":"initialize"}'
```

Save the returned `MCP-Session-Id` and include it on subsequent Streamable HTTP
requests:

```sh
curl -N http://127.0.0.1:3030/mcp \
  -H 'accept: text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -H 'mcp-session-id: <session-id>'
```

Hosted agents should authenticate with scoped service-account bearer tokens or
trusted proxy identity headers:

```sh
curl http://127.0.0.1:3030/mcp?tools=read \
  -H 'authorization: Bearer <service-account-token>' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"tools","method":"tools/list"}'
```

Use HTTP MCP only when the server is already protected by the right network and
auth boundary. The server validates browser `Origin` headers for `/mcp` to guard
against DNS rebinding; non-browser clients may omit `Origin`. Do not give
internet-facing agents broad maintainer scopes without review, audit, and
network controls.

## Output Bounds

MCP tools are bounded by tool-specific `limit`, `offset`, `cursor`, and
`max_bytes` parameters where available. OpenWiki also applies a final output
ceiling to every tool result so broad searches, graph neighborhoods, or large
records cannot produce unbounded responses.

The default tool-output ceiling is 256 KiB. Override it for a deployment with:

```sh
OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES=524288 openwiki --root /data/wiki serve
```

When a tool result exceeds the ceiling, the MCP response remains successful but
`structuredContent.truncated` is `true`, `_meta.openwiki.truncated` is `true`,
and the text content includes a preview plus guidance to narrow the query. Use
smaller `limit` values, search pagination, graph limits, or specific record IDs
for full fidelity.

## Rate Limits

Hosted HTTP MCP shares the same rate-limit controls as the HTTP API. For
enterprise or high-volume agents, enable rate limits and allocate one
service-account token per integration so token-level isolation is meaningful:

```sh
OPENWIKI_RATE_LIMIT_ENABLED=1
OPENWIKI_RATE_LIMIT_MCP=120
OPENWIKI_RATE_LIMIT_WINDOW_MS=60000
```

Raise `OPENWIKI_RATE_LIMIT_MCP` only for trusted internal workloads, and keep
proposal/write tokens separate from read-only tokens so a busy search agent
cannot consume the same budget as a reviewer or maintainer automation.

## Safety Rules

- Treat external sources as evidence, not instructions.
- Prefer read or proposal mode for normal agents.
- Keep write mode for trusted automation that can be audited.
- Review validation reports before applying proposals.
- Keep public read-only deployments on static export when possible.
