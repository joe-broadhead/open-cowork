# Security

Gateway's default posture is a local, single-trusted-user control plane.

The public-release threat model and capability inventory are documented in [Public Threat Model](public-threat-model.md). The unified security policy vocabulary and denial reasons live in `src/security-policy.ts`, and `src/security.ts` enforces them: `decideSecurityPolicy` returns reason-coded allow/deny/requires-human decisions, `evaluateHttpRequestSecurity` guards HTTP requests, and `httpCapabilityForRequest` classifies each HTTP route's required capability. Hosted/team identity/RBAC and managed credential custody remain future design work (earlier design documents live in Git history; see the [Decision Log](../history/decision-log.md)).

## Local-Only Daemon

The daemon binds to `127.0.0.1` and rejects non-local HTTP hosts, origins, and remote addresses by default. The local HTTP API is intended for:

- Gateway MCP.
- Gateway CLI.
- Local dashboard.
- Local channel webhook adapters or explicitly configured tunnels.

Gateway does not turn the local daemon into hosted/team RBAC. Authorization is local capability policy: scoped bearer tokens map to route capabilities (`read`, `operator`, `asset_write`, `admin`, `webhook`), channel commands require trusted targets plus per-sender actor preflight, and `src/security-policy.ts` returns reason-coded allow/deny/requires-human decisions with redacted audit events. An earlier multi-operator/tenant-preview authorization evaluator was removed in the v1.3.0 consolidation. Hosted control-plane, SaaS, multi-tenant production, compliance-certified, and organization-wide RBAC remain unsupported until later evidence-backed decisions.

If you expose any route beyond localhost, use one of the explicit exposed modes below and put the route behind infrastructure that authenticates the caller. `unsafeAllowNoAuth` is still a local/test escape hatch, not an authorization grant.

## Local Writer Leadership

Gateway supports one local writer for a state directory. On daemon startup it records a persistent local daemon identity and a short-lived writer lease in `gateway.db`. The writer owns scheduler dispatch, startup recovery, supervisor wakeups, channel sync sends, and provider adapter ingress. A duplicate daemon against the same state path becomes standby: it can serve redacted status/health, but it must not start external channel adapters or mutate the work graph.

Operators can inspect the current role with `opencode-gateway status`, Mission Control health, or `GET /gateway/leadership`. A graceful stop (`opencode-gateway stop`, SIGTERM/SIGINT, or `POST /shutdown`/`POST /restart`) releases the writer lease so the next daemon start acquires leadership immediately, and the new writer adopts still-live run leases from its predecessor so in-flight completions are accepted instead of fenced. If a previous writer crashes without releasing its lease, restart Gateway or call `POST /gateway/leadership/recover`; recovery only succeeds after the old lease is stale and records an audit event. This is a local-first fencing model, not a hosted/team coordination design.

## Threat Models

| Mode | Supported | Boundary |
| --- | --- | --- |
| Local personal | Yes | One trusted user on the local machine. Daemon listens on `127.0.0.1`. |
| Local plus channel | Yes | Telegram/WhatsApp can reach Gateway through provider APIs; restrict trusted chat IDs. |
| Public webhook ingress | Constrained | Only documented webhook routes should be tunneled; provider signature verification and allowlists are required. |
| Exposed HTTP API | Advanced | Requires `security.allowNonLocalHttp=true` plus a scoped Gateway HTTP token unless explicitly marked unsafe. |
| Self-hosted team | Future design target | Requires a hosted/team product boundary, identity/RBAC, shared durable state, secrets, audit, topology, and an explicit readiness decision. |
| Hosted/multi-tenant | No | Requires a separate hosted product design for authn/authz, tenancy, audit review, quotas, worker isolation, secrets, SLO/DR, extension governance, and [multi-daemon coordination](../concepts/multi-daemon-scaling.md). |

## Exposed HTTP Controls

Default config:

```json
{
  "security": {
    "httpHost": "127.0.0.1",
    "allowNonLocalHttp": false,
    "publicWebhookMode": false,
    "unsafeAllowNoAuth": false,
    "capabilityScopedLoopback": true,
    "requireNonMcpDestructiveApproval": true,
    "exposedHttp": {
      "requireStrongToken": true,
      "trustedProxyCidrs": [],
      "rateLimit": { "enabled": true },
      "authLockout": { "enabled": true }
    },
    "unsafeAllowAllChannelTargets": {
      "telegram": false,
      "whatsapp": false,
      "discord": false
    }
  }
}
```

Gateway refuses to bind to a non-local host unless `security.allowNonLocalHttp` is true. For exposed API/dashboard access, set one or more Gateway HTTP bearer tokens and send the configured bearer token through the HTTP authorization header.

Configure one or more capability-scoped bearer tokens for any non-local setup:

| Environment variable | Capability | Typical use |
| --- | --- | --- |
| `OPENCODE_GATEWAY_HTTP_READ_TOKEN` | `read` | Dashboard, health, readiness, lists, reports, redacted config, and read-only state inspection. |
| `OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN` | `operator` | Durable work mutations such as tasks, roadmaps, scheduler actions, channel sends, human-gate decisions, and OpenCode request replies. Also satisfies `read`. |
| `OPENCODE_GATEWAY_HTTP_ASSET_WRITE_TOKEN` | `asset_write` | OpenCode MCP/tool/agent/skill create, update, and delete routes. Also satisfies `read`. |
| `OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN` | `admin` | Full exposed HTTP administration. Satisfies every route capability. |
| `OPENCODE_GATEWAY_HTTP_WEBHOOK_TOKEN` | `webhook` | Authenticated webhook ingress when `publicWebhookMode` is not used. |

Sensitive local-administration routes require `admin`: `GET /config?redact=false`, `PATCH /config`, `GET /storage/export`, `POST /storage/restore`, storage backup/drill mutation routes, `POST /shutdown`, and `POST /restart`. Data-destructive administration routes (config patch and restore) also create a durable human approval gate when `humanLoop.destructiveActionApproval` is enabled; retry the same request with the approved gate ID before it mutates state. A `once` approval is consumed after the successful destructive request; use an explicit `always` approval only for intentionally reusable exact-operation approvals. `POST /shutdown` and `POST /restart` are process-lifecycle operations, not data-destructive ones: they preserve all durable state, are audited, and are intentionally not human-gated so a local `opencode-gateway stop` always works (a local operator can SIGTERM the daemon regardless).

OpenCode asset mutation routes require `asset_write` or `admin`: `POST`/`PUT`/`DELETE /opencode/mcp/:name`, `/opencode/tools/:name`, `/opencode/agents/:name`, and `/opencode/skills/:name`.

For a public webhook tunnel, prefer keeping Gateway bound locally and configure the tunnel to forward only the provider route you need:

```text
/webhooks/whatsapp
/webhooks/discord
```

If Gateway itself must bind to a non-local host for webhook ingress, set `security.publicWebhookMode=true`. This unauthenticated exception applies only to documented webhook routes. Non-webhook routes still require a bearer token with the route's required capability unless `security.unsafeAllowNoAuth=true` is set. `unsafeAllowNoAuth` should only be used for isolated test networks.

Readiness and doctor output report HTTP auth posture as counts and capability names only. They never include token values.

Route, MCP, trusted-channel-command, and CLI capability classification is enforced in code by `src/security.ts` (`httpCapabilityForRequest`, `evaluateHttpRequestSecurity`) and `src/security-policy.ts`, covering local daemon routes, MCP groups, trusted-channel command groups, CLI groups, binding requirements, OpenCode-owned decision routing, and exposed-mode fail-closed invariants. Focused tests fail when a new surface is not classified. This is local evidence for the current single-operator boundary; it is not hosted/team RBAC certification.

## Default Hardening Controls and Their Honest Limits

These controls add defense-in-depth. They are useful guardrails, but each has a boundary worth stating plainly so you do not over-trust it.

### Capability-scoped loopback (`security.capabilityScopedLoopback`, default `true`)

Loopback write/admin requests are no longer auto-trusted and must present a capability-scoped bearer token. Local read and provider-verified webhook routes remain reachable without a token for health, status, and dashboard ergonomics. `opencode-gateway install` creates a `0600` admin token file in the Gateway config directory, points the supervised daemon at it through `OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE`, and the CLI reads that same file automatically. You can also export `OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN` in both daemon and CLI environments. Set `security.capabilityScopedLoopback=false` only to intentionally restore legacy local write trust.

### Non-MCP destructive approval (`security.requireNonMcpDestructiveApproval`, default `true`)

Destructive human-gate approvals arriving through the MCP proxy trust tier are rejected, so the **MCP tool cannot auto-approve its own destructive gates** — the operator must approve out-of-band over HTTP/CLI. The daemon derives the MCP surface from Gateway request headers, not JSON body `actor`/`source` fields. This is still a guardrail against the honest/automated MCP path, not an adversary-proof control against a local process that already holds machine access and an admin token.

### Exposed-mode token-entropy floor (`security.exposedHttp.requireStrongToken`, default `true`)

In exposed mode the daemon refuses to start with a short or low-entropy HTTP token. **Upgrade migration / breaking change:** an existing exposed deployment whose token is below `minTokenLength`/`minTokenEntropyBits` will now fail to start after upgrading. Rotate to a strong random token (recommended) or set `security.exposedHttp.requireStrongToken=false` to explicitly acknowledge the weaker token. This never affects the localhost default or public-webhook/unsafe modes.

### Exposed-mode proxy identity, rate limits, and lockout

`security.exposedHttp.trustedProxyCidrs` is empty by default, so `Forwarded` and `X-Forwarded-For` cannot spoof the address used by Gateway's abuse controls. Add only the IPv4/IPv6 CIDRs of **immediate reverse-proxy peers** that sanitize or append forwarding headers. Once the socket peer is trusted, Gateway walks the forwarding chain right-to-left through trusted proxies and uses the first untrusted hop as the client address. A request from any peer outside the allowlist ignores forwarding headers entirely.

When a trusted peer supplies both header families, their complete normalized address chains must match. A conflict, an invalid address, an empty element, a missing/duplicate `for=` parameter, or one malformed family alongside one valid family fails closed to the immediate socket peer; Gateway never silently chooses the more favorable family. Configure the proxy to emit one family where possible, or verify that both are identical.

Do not use a client network, `0.0.0.0/0`, or `::/0` as a trusted proxy. List every controlled proxy hop, configure the edge to discard untrusted inbound forwarding headers, and test both a real client and a forged header before exposure. An omitted internal proxy causes clients to share that proxy's address; an overbroad CIDR lets clients choose an apparent address.

The exposed-mode rate limiter (`security.exposedHttp.rateLimit.*`) buckets by that derived client address. Authentication lockout (`security.exposedHttp.authLockout.*`) puts every unknown, missing, malformed, or rotating bearer guess into one failure bucket for that address. Only values that match a configured valid credential receive separate one-way credential identities, so guessing cannot evade lockout and an attacker still cannot lock out a different valid operator credential sharing a NAT or proxy. Keep equivalent edge rate limiting and lockout at the TLS-terminating proxy; Gateway's controls are defense in depth, not a substitute for the ingress boundary.

## Channel Exposure

For webhook-based connectors, expose only the documented provider routes:

- `GET /webhooks/whatsapp`
- `POST /webhooks/whatsapp`
- `POST /webhooks/discord`

The connector verifier reports whether Gateway is in local-only mode, authenticated reverse proxy mode, public webhook mode, or unsafe public mode. It also checks that the expected provider route is documented, public webhook mode exempts only that route, non-webhook routes remain capability-protected, local challenge/signature prerequisites are present, and exposed contexts have scoped HTTP capability tokens configured. Authenticated webhook ingress needs a `webhook` or `admin` Gateway HTTP token; a read/operator/asset token alone is not enough for provider callback routes.

Keep the rest of the daemon private. Telegram uses long polling by default and does not require exposing an HTTP route.

WhatsApp Embedded Signup/provider-managed onboarding is a scaffolded setup path until Gateway implements Meta Login, authorization-code exchange, provider asset capture, token rotation, and redacted install evidence. Do not treat an Embedded Signup configuration ID, app ID, or provider name as a trust grant. A provider-managed install must still land in the same local security model: signed webhooks, scoped public exposure, explicit trusted sender claim or allowlist, and binding before readiness.

Use channel allowlists before relying on channels for approvals or task control:

```json
{
  "security": {
    "channelAllowlists": {
      "telegram": [{ "chatId": "telegram-fixture-chat", "threadId": "topic-fixture", "adminUserIds": ["operator-user-id"] }],
      "whatsapp": [{ "chatId": "wa-fixture-target", "adminUserIds": ["operator-wa-id"] }],
      "discord": [{ "chatId": "discord-fixture-channel", "adminUserIds": ["operator-discord-id"] }]
    }
  }
}
```

An entry with only `chatId` trusts all threads for that chat. An entry with `threadId` trusts only that chat/thread pair.

Trust is enforced per sender, not just per chat. Free-text messages are forwarded verbatim as agent prompts, so by default Gateway only forwards free text from a trusted actor: a sender listed in the entry's `userIds`/`adminUserIds`, or — for entries without an actor list — a private chat where the sender id equals the chat id (the normal single-operator Telegram/WhatsApp DM). Claim-code trust records the claiming sender as the entry's trusted actor automatically. Free text from any other member of a trusted target is rejected with a redacted `channel.inbound` denial audit event, exactly like an untrusted-target rejection. Privileged channel commands always run the per-sender actor preflight.

For shared chats, groups, or topics, add every operator to `userIds` (or `adminUserIds`). If you intentionally want any member of a trusted target to drive the bound agent with free text (pre-1.4 behavior), set the explicit opt-out — it never relaxes privileged command preflight:

```json
{
  "security": {
    "trustTargetMembersForFreeText": true
  }
}
```

Prefer claim codes over manually copying private target IDs:

```bash
opencode-gateway channel claim telegram
opencode-gateway channel claim whatsapp
opencode-gateway channel claim discord
```

The command prints a short-lived code and expiry. Send that code from the provider target that should become trusted. Gateway stores only a code hash, accepts it only for the scoped provider and `trust_target` action, and records redacted audit/work events for creation, acceptance, expiry, denial, and replay. A claim message from an untrusted target does not resolve project/session context or mutate work state beyond the minimal allowlist entry needed to trust that exact provider target.

For a repeatable check of negative access without a second account or phone, use a one-shot denial probe:

```bash
opencode-gateway channel claim telegram --prove-denial --ttl 30m
opencode-gateway channel claim whatsapp --prove-denial --ttl 30m
opencode-gateway channel claim discord --prove-denial --ttl 30m
```

Send the displayed code through the provider. Gateway rejects that one message, records a redacted provider-native denied `channel.inbound` audit event, consumes the code, and does not add the target to an allowlist or forward the message to an agent. Treat the resulting audit as denial evidence only; it is not a trust grant.

Gateway fails closed for any channel provider without an allowlist, whether or not the provider has credentials configured. The only bypass is the explicit test-only flag:

```json
{
  "security": {
    "unsafeAllowAllChannelTargets": {
      "telegram": false,
      "whatsapp": false,
      "discord": false
    }
  }
}
```

Do not enable an unsafe allow-all channel target for unattended or production work; readiness reports it as a warning.

## Channel Evidence Handling

Channel readiness evidence must be redacted before it leaves the operator machine. Use the connector status, verifier, and evidence exporter instead of screenshots or provider-console transcripts:

```bash
opencode-gateway channel status <provider> --json
opencode-gateway channel verify <provider>
```

Acceptable evidence can name provider, connector state, setup mode, missing key names, documented webhook route paths, and redacted target labels. It must not include raw tokens, app secrets, verify tokens, webhook signatures, raw chat IDs, raw phone numbers, private message bodies, provider payloads, or screenshots that show those values.

Use these labels consistently:

| Label | Meaning |
| --- | --- |
| `scaffolded` | Config or UX exists for a provider path, but required provider exchange, install, or asset capture is not implemented or verified. |
| `provider_blocked` | Gateway has the product path, but live readiness is blocked by missing provider credentials, provider setup, app review, business prerequisites, or external verification. |
| `explicitly_waived` | A named operator decision accepts a missing requirement for a specific run. The waiver must name the requirement, reason, scope, expiry or rerun trigger, and residual risk. |

## Secrets

Gateway may read local HTTP and channel credentials from environment variables or config. Environment variables are preferred for local beta. Local config secrets remain compatibility mode and are reported as warnings by `security_secret_lifecycle`.

The secret lifecycle layer (`src/secrets-lifecycle.ts`, inspected with `opencode-gateway secrets status`) provides value-free secret references and a local in-memory adapter for these same inputs. Readiness may show `secretref_*` IDs, source env/config names, scope paths, owner/provider metadata, rotation health, revocation state, scoped injection destinations, provider/project/worker guardrails, and redacted lifecycle audit event types. Those references are safe evidence. The adapter may resolve values only in memory for explicitly allowlisted local contexts; it does not provide managed self-hosted, hosted, multi-tenant, or team-shared credential custody.

Gateway HTTP bearer tokens:

- `OPENCODE_GATEWAY_HTTP_READ_TOKEN`
- `OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN`
- `OPENCODE_GATEWAY_HTTP_ASSET_WRITE_TOKEN`
- `OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN`
- `OPENCODE_GATEWAY_HTTP_WEBHOOK_TOKEN`

Each scope also accepts the corresponding `*_TOKEN_FILE` variable, for example `OPENCODE_GATEWAY_HTTP_READ_TOKEN_FILE`. Gateway opens scoped token files without following symlinks, requires the opened descriptor to remain the same regular file owned by the effective service user, requires owner-only permissions on POSIX, caps the file at 8 KiB, and rejects empty, NUL-bearing, or multiline values. Unsafe files are not authentication credentials and their contents are not loaded into redaction. Provision every scoped file as the service UID with mode `0600`; the bundled Docker Compose file performs this handoff by copying `/run/secrets` into a nonroot-owned tmpfs before starting the daemon.

Channel/provider inputs:

- `TELEGRAM_BOT_TOKEN`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_APP_SECRET`
- `OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED`
- `DISCORD_BOT_TOKEN`
- `DISCORD_APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`

OpenCode model-provider keys and MCP connector credentials are owned by OpenCode/provider tooling. Gateway may reference model, provider, profile, skill, tool, or MCP names; it must not copy raw key values into durable work, logs, docs, or evidence.

Diagnostics redact configured channel tokens and HTTP bearer values, including safely loaded values from all five scoped `*_TOKEN_FILE` inputs. Generated launchd/systemd service files use an allowlisted runtime environment and point to the owner-only local admin token through `OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE`; they do not embed its value. Compose mounts read/operator/admin tokens as service-scoped files under `/run/secrets` and sets only the corresponding `*_TOKEN_FILE` paths. Telegram, WhatsApp, and Discord credentials remain in Gateway config or the explicitly managed service/foreground environment; never put raw values in a committed Compose file.

Gateway redacts secrets in doctor output, daemon log reads, MCP config responses, and redacted HTTP config responses. Direct local `GET /config?redact=false` is an audited sensitive operation.

`opencode-gateway readiness` reports `security_secret_lifecycle` with credential input IDs, classes, env var names, config key names, value-free reference IDs, scope metadata, scoped injection posture, rotation health, revocation state, audit event names, and risk codes only. It never includes token values. A failure means a hard credential lifecycle prerequisite is missing, such as WhatsApp credentials without signed inbound verification. A warning means local compatibility is allowed but should be tightened, such as secret values in local config or use of the legacy admin HTTP token.

## Secret Rotation Runbook

Treat any pasted token, terminal transcript, CI log, or shared screen exposure as compromised.

| Secret | Rotate in source system | Update Gateway |
| --- | --- | --- |
| Telegram bot token | Use `@BotFather` to revoke/regenerate the bot token. | Update `TELEGRAM_BOT_TOKEN` or `channels.telegram.botToken`, then restart Gateway. |
| WhatsApp access token | Rotate the Meta app/system-user token. | Update `WHATSAPP_ACCESS_TOKEN` or `channels.whatsapp.accessToken`, then restart Gateway. |
| WhatsApp verify token | Choose a new verify token in Meta webhook settings. | Update `WHATSAPP_VERIFY_TOKEN` or `channels.whatsapp.verifyToken`, then re-verify the webhook. |
| WhatsApp app secret | Rotate the Meta app secret if exposed. | Update `WHATSAPP_APP_SECRET` or `channels.whatsapp.appSecret`; verify signed webhook delivery. |
| OpenCode provider keys | Rotate at the provider or OpenCode credential store. | Restart OpenCode; Gateway does not store provider keys. |
| GitHub/GHCR tokens | Revoke and recreate in GitHub. | Update the shell/CI secret store that uses them; Gateway service files must not embed them. |

After rotating, run:

```bash
opencode-gateway doctor
opencode-gateway readiness
```

Confirm diagnostics show redacted values only and channel sends still work from allowlisted chats.

## Audit Events

Gateway records sensitive operations as `audit.security` events in `gateway.db`. Each event includes timestamp, actor/source, operation, target, result, and optional details.

Audited operations include:

- Unredacted config reads.
- Config updates.
- Restart and shutdown requests.
- Channel binding changes.
- Channel sends.
- Rejected non-local HTTP requests.
- Rejected untrusted channel inbound messages.

## File Permissions

Gateway writes config and sidecar files under `~/.config/opencode-gateway` with user-only permissions where supported:

- `config.json`
- `gateway.db` (including the `gateway.db-wal` and `gateway.db-shm` SQLite sidecars, which are re-restricted on every write-open)
- `channel-sync.json`
- `channel-sync.json.sqlite`
- `events.json`
- `sessions.json`

## OpenCode Permissions

OpenCode owns tool permission and question requests. Gateway can list, forward, surface, and reply to those OpenCode-native requests through explicit tools, but it does not bypass OpenCode permissions or run a separate automatic approval engine. Keep dangerous tools such as `bash` and `edit` in `ask` mode for exposed/channel deployments unless there is an explicit operator on duty.
