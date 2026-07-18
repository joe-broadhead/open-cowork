# Channels

Gateway channels route external chat messages into OpenCode sessions and sync OpenCode session output back to the channel.

For the canonical cross-channel continuity model, see [Identity Graph](../concepts/identity-graph.md).

For adapter implementation requirements across Telegram, WhatsApp, Discord, Slack-like tools, and future surfaces, see [Channel Adapter Contract](../concepts/channel-adapter-contract.md).

## Structured Message Renderer Contract

Gateway domain code can describe outbound UX with the channel-agnostic renderer contract in `src/channels/renderer.ts`. The contract separates message intent from provider delivery:

- `StructuredGatewayMessage` is the input schema. It contains a message kind, title, optional status/severity/summary, generic rich blocks, generic actions, and a required deterministic plain-text fallback.
- `RichMessageBlock` supports headings, text, facts, tables, collapsible details, media references, and dividers without naming Telegram, WhatsApp, or Discord concepts.
- `MessageAction` describes interactive actions as labels plus commands or URLs. Channels that cannot render native buttons still receive the same actions in the plain-text fallback.
- `renderStructuredMessage()` negotiates the best output mode for a channel: rich blocks, markdown, then plain text by default.

Channels advertise generic capabilities through `ChannelAdapter.capabilities`. The canonical registry lives in `src/channels/capabilities.ts`; current adapter instances expose the same declaration on `ChannelAdapter.capabilities`, and `GET /channels/capabilities` returns the merged runtime/planned matrix.

Renderer flags are the narrow subset used by `renderStructuredMessage()`:

| Capability | Meaning |
| --- | --- |
| `plainText` | Can send deterministic text fallback. This is the universal baseline. |
| `markdown` | Can preserve markdown formatting. |
| `richBlocks` | Can render structured blocks natively. |
| `streamingDraft` | Can update a draft or streaming message before final send. |
| `buttons` | Can render action buttons, list rows, or components. |
| `tables` | Can render table blocks natively. |
| `collapsibleDetails` | Can render expandable detail sections natively. |
| `media` | Can render media blocks natively. |

The broader adapter capability categories are:

| Category | Meaning | Expected fallback |
| --- | --- | --- |
| `richText` | Preserves formatted text beyond plain strings. | Render readable plain text. |
| `richCards` | Maps `StructuredGatewayMessage` blocks into native cards, embeds, rich messages, or equivalent. | Choose Markdown/plain text rather than dropping blocks. |
| `inlineActions` | Renders actions as native buttons, rows, components, or equivalent controls. | Include the same command or URL payload in text. |
| `callbacks` | Receives native action selections and normalizes them back to Gateway command payloads. | Let users type the same slash command. |
| `filesMedia` | Normalizes inbound attachments and/or renders safe outbound media references. | Show safe media IDs or links as text. |
| `threading` | Preserves provider-native topics, threads, or forum posts as `threadId`. | Bind at the chat/session boundary. |
| `identityBinding` | Uses stable provider IDs for channel binding and sender identity. | Refuse ambiguous display-name identity. |
| `deepLinks` | Carries OpenCode Web/TUI links or provider-native URL controls. | Print link text. |
| `notifications` | Can receive Gateway sync, request, alert, and progress notifications. | Leave delivery uncheckpointed on send failure. |
| `edits` | Can update previous Gateway messages safely. | Send follow-up state. |
| `deletes` | Can delete or hide previous Gateway messages safely. | Prefer superseding follow-ups and keep audit history. |
| `fallbackBehavior` | Has a declared degradation path with bounded deterministic text. | Plain text is the last resort. |

Reusable card builders are available for the first product surfaces that need richer channel UX:

- `statusCard`
- `progressCard`
- `gateApprovalCard`
- `runResultCard`
- `issueListCard`
- `initiativeUpdateCard`
- `incidentAlertCard`

Each card builder returns a structured message with stable plain text. That fallback is the contract of last resort for WhatsApp text, Telegram markdown failures, CLI-like views, and any future provider with limited capabilities.

Progress, gate approval, run result, incident alert, and issue list cards share the same hierarchy: title, state, summary when present, key facts, next action, details or tables, then provider-rendered actions. Plain-text and Markdown fallbacks are bounded so large issue lists or incident evidence remain readable without expanding into an oversized channel message.

Provider examples:

- Telegram advertises `plainText`, `markdown`, and rich message capabilities when rich messages are enabled. The adapter maps generic renderer blocks to Telegram Bot API Rich Messages and falls back to `sendMessage` if rich mode is disabled, a block cannot be safely represented, or Telegram rejects the rich payload.
- WhatsApp today advertises `plainText` and command-menu style `buttons`. Structured messages gracefully degrade to plain text unless a future adapter maps them to WhatsApp templates or interactive messages.
- Discord alpha advertises Markdown and, when explicitly enabled, bounded embed/component support for `richBlocks`, `buttons`, `tables`, `collapsibleDetails`, and safe media links. Domain code does not need Discord-specific branches.

## Capability Matrix

Legend: Supported means Gateway uses the capability today. Partial means the capability exists for a subset of flows or one direction. Planned means it is the intended alpha shape but no adapter behavior is implemented yet. Unsupported means fallback is the expected behavior.

| Capability | Telegram | WhatsApp | Discord alpha |
| --- | --- | --- | --- |
| Rich text | Supported | Unsupported | Supported Markdown |
| Rich cards | Supported when rich messages are enabled | Unsupported | Partial embeds |
| Inline actions | Partial URL/copy controls | Partial command list | Partial buttons |
| Callbacks | Partial callback query command actions | Partial interactive replies | Partial signed interactions |
| Files/media | Partial safe outbound rich media | Partial inbound metadata | Partial attachments/safe links |
| Threading | Supported Telegram topics | Unsupported | Partial thread sends |
| Identity binding | Supported | Supported | Supported stable IDs |
| Deep links | Partial URL actions and `/open` text | Partial text links | Partial link buttons |
| Notifications | Supported | Supported | Supported alpha send path |
| Edits | Unsupported | Unsupported | Unsupported |
| Deletes | Unsupported | Unsupported | Unsupported |
| Fallback behavior | Rich to Markdown to plain send | Plain text; command list to text | Embed/component to Markdown/plain |

Current alpha policy is conservative: Telegram is the rich production path, WhatsApp is plain-text-first with a native command menu, and Discord remains disabled until an operator explicitly enables the private alpha.

## Connector Onboarding Model

The same capability declaration also includes `onboarding` metadata. This lets CLI, Mission Control, health, and docs describe setup with one product language even when providers use different mechanics.

Universal connector states:

```text
not_configured -> credentials_needed -> provider_connected
provider_connected -> polling_ready -> trusted_target_pending
provider_connected -> webhook_needed -> verification_pending -> trusted_target_pending
trusted_target_pending -> bound -> ready
any state with warnings -> degraded
any unsafe or missing hard requirement -> blocked
```

Universal setup actions are:

- `connect`: add provider credentials, OAuth/embedded signup, or local connector config.
- `verify`: prove polling, webhook challenge, signature verification, or local route readiness.
- `trust`: establish a trusted target by allowlist today or claim code/provider install later.
- `bind`: link the trusted target to a Gateway Session, Issue, or Initiative.
- `repair`: follow redacted diagnostics for a degraded or blocked connector.
- `disconnect`: remove or disable the connector.

Every connector status also includes an additive `onboardingFlow` object. It is the shared product contract used by `opencode-gateway channel setup <provider>`, `opencode-gateway channel status <provider> --json`, `/channels/connectors`, and Mission Control:

- `path`: the canonical checklist, always `connect -> verify -> trust -> bind -> monitor`.
- `currentStep`: the single step the operator should work on next.
- `primaryAction`: one safe next action with a short explanation and command when a command is possible.
- `fallbackAction`: a repair, manual trust, or safe exposure fallback when the primary action cannot complete.
- `steps`: per-step status (`done`, `current`, `blocked`, or `pending`), redacted references, and blocker codes.

Provider-specific details stay in setup path metadata, credential rows, callback diagnostics, and trust modes. Product surfaces should render `onboardingFlow` first, then expand provider details only when the operator needs them. This keeps Telegram, WhatsApp Cloud API, WhatsApp Embedded Signup scaffolds, and Discord alpha on the same Connect -> Verify -> Trust -> Bind journey without hiding real provider blockers.

A connector is fully ready once its trusted target is bound. Setup and trust can still be incomplete: a provider can have a guided setup path and stay `blocked` or `degraded` until credentials, webhook verification, and trust are in place.

Per-provider modes, trust paths, and webhook routes are documented in the Telegram, WhatsApp, and Discord sections below. Channel readiness is trust- and binding-based, not credential-based:

| Channel | Current readiness posture | What counts as ready | Limitation to name in handoff evidence |
| --- | --- | --- | --- |
| Telegram | Telegram is the mature external beta path; a connector is ready once its trusted target is bound. | Trusted binding of the current target to a Gateway Session, Issue, or Initiative. | Some permission and argument-autocomplete flows remain bounded; name them in handoff evidence. |
| WhatsApp | Cloud API direct setup is implemented and guided; external readiness stays provider/setup blocked until credentials and webhook verification are in place. | Cloud API credentials present, `/webhooks/whatsapp` verified, signed messages subscription active, trusted sender claimed or allowlisted, and a bound target. | Embedded Signup/provider-managed setup is scaffolded unless Meta Login, token exchange, provider asset capture, and webhook subscription are implemented. |
| Discord alpha | Disabled by default; alpha only. | Explicit alpha enablement, signed interaction route, trusted channel/thread, and binding. | Alpha only; do not treat as a promoted production channel. |
| Future adapter template | Scaffolded through SDK fixture archetypes. | Adapter passes the contract suite, declares redaction and trust metadata, then binds a trusted provider target. | Template or fixture success alone is not a live provider claim. |

Future adapters start from the SDK fixture archetype that matches their transport and follow the same Connect -> Verify -> Trust -> Bind journey: `connectorCapabilityTemplates.webhook` for Slack-like signed callbacks and Discord-like app installs, `connectorCapabilityTemplates.polling` for Matrix-like sync loops, and `connectorCapabilityTemplates.local` for custom enterprise or local-only surfaces.

Connector diagnostics are redaction-safe. They can name missing keys, route paths, and config fields, but they must not display raw token values, app secrets, webhook signatures, raw chat IDs, raw phone numbers, or private transcript text. Runtime status computation belongs in the connector registry; this capability metadata is the provider-neutral contract it consumes.

Webhook-based connectors use a provider-neutral verifier in connector status and CLI output. The verifier reports:

- whether the connector is local-only, using authenticated reverse proxy mode, using `security.publicWebhookMode`, or blocked by unsafe public exposure;
- whether the expected callback route is one of Gateway's documented public webhook routes;
- whether public webhook mode exempts only those documented routes;
- whether admin, operator, dashboard, assets, storage, and other non-webhook routes remain capability-protected;
- whether local challenge and signature prerequisites are present;
- whether an exposed context has Gateway HTTP capability tokens configured, including a `webhook` or `admin` token for authenticated webhook ingress.

### CLI Connector Setup

The local CLI exposes the same onboarding model for every provider:

```bash
opencode-gateway channel list
opencode-gateway channel status telegram
opencode-gateway channel setup whatsapp
opencode-gateway channel verify whatsapp
opencode-gateway channel trust whatsapp
opencode-gateway channel claim whatsapp
```

Use `channel list` to see each connector state and safe next action. Use `channel status <provider>` for redacted credentials, missing prerequisites, diagnostics, callback readiness, and evidence references. `--json` is available for automation and returns the same redacted connector payload used by the HTTP/MCP status surfaces.

`channel setup <provider>` walks the operator through Connect -> Verify -> Trust -> Bind. It reports whether required values are present and where they should be stored, but it does not echo tokens, app secrets, webhook signatures, raw chat IDs, raw phone numbers, or private messages.

`channel claim <provider>` generates a short-lived trusted-target claim code for Telegram, WhatsApp, or Discord. Send the displayed code from the provider chat/channel/thread that should become trusted. Gateway accepts the code only after provider authentication/signature checks, scopes it to the requested provider and `trust_target` action, stores only a hash of the code, and then adds the claiming target to the matching allowlist. Expired, replayed, wrong-provider, and wrong-code attempts are denied with redacted audit/work events and do not resolve session or project context.

For repeatable live negative-access evidence, generate a one-shot denial probe:

```bash
opencode-gateway channel claim telegram --prove-denial --ttl 30m
opencode-gateway channel claim whatsapp --prove-denial --ttl 30m
opencode-gateway channel claim discord --prove-denial --ttl 30m
```

Send the displayed code from the provider target being tested. Gateway rejects that one message, records a redacted provider-native denied `channel.inbound` audit event, consumes the code, and does not add the target to an allowlist or forward the message to an agent. A real non-allowlisted target remains a valid negative check, but the denial probe is the preferred operator UX when a second account, phone, group, or channel is not available.

For WhatsApp direct Cloud API setup, the CLI points to the exact local inputs Gateway needs:

- `WHATSAPP_ACCESS_TOKEN` or `channels.whatsapp.accessToken`
- `WHATSAPP_PHONE_NUMBER_ID` or `channels.whatsapp.phoneNumberId`
- `WHATSAPP_VERIFY_TOKEN` or `channels.whatsapp.verifyToken`
- `WHATSAPP_APP_SECRET` or `channels.whatsapp.appSecret`
- a provider callback URL ending in `/webhooks/whatsapp`
- a trusted sender established by `opencode-gateway channel claim whatsapp`, or a manual fallback in `security.channelAllowlists.whatsapp`

Environment variables are preferred for channel secrets. Local config remains compatibility mode and is reported by readiness as `security_secret_lifecycle` posture. The credential inventory, redaction policy, and rotation runbook are documented in [Security](../operations/security.md); a managed hosted vault is not a current capability.

`channel verify <provider>` is local and read-only: it checks config presence, webhook route exposure mode, documented route mapping, non-webhook route protection, HTTP token posture, challenge readiness, and signature readiness without sending provider messages or private content. It is safe to paste its output into review evidence after checking that no operator-specific path context is sensitive.

The channel action registry is the source of truth for typed commands, provider-native command menus, rich action controls, fallback copy, safety class, and presence/typing behavior. `GET /channels/capabilities`, Mission Control, and readiness surfaces use the same registry contract:

- Telegram registers the supported slash-command verb menu through `setMyCommands` and sends bounded `typing` presence only after trusted inbound work starts. Telegram command arguments and subcommands remain typed or copy-command fallback; they are not claimed as provider-native autocomplete. Typing feedback has a fixed heartbeat, a hard timeout, and degraded-provider failures are recorded without blocking the handler.
- WhatsApp keeps typed-command and list/button fallback metadata visible, but provider-native slash and typing remain unclaimed until live provider support exists.
- Discord remains contract-level deferred metadata until an enabled provider adapter exists.

Unsupported native controls must degrade to typed commands, copyable command text, or text menus. Do not treat command metadata, fixtures, or credentials as live channel readiness.

The same native-control truth is also emitted as operator journey rows:

- `supported`: the surface is expected to work directly, such as Telegram typed commands, registered slash command verbs, and trusted-inbound typing.
- `partial`: the native control works for selected cases but must keep typed/copy fallback visible, such as Telegram rich actions and WhatsApp list/button metadata.
- `fallback`: the provider does not have that native primitive, so the typed command path is the intentional UX, such as WhatsApp slash commands.
- `deferred`: the provider path is planned, scaffolded, or intentionally not provider-native in the current contract, such as Telegram argument autocomplete, WhatsApp typing/presence, and Discord controls.
- `blocked`: setup, trust, or verification is missing and the connector should not be treated as ready.

The channel certification matrix also reports the SDK contract posture for each provider: adapter archetype, recovery parity, and any explicit waiver. A waiver is only an operator-accepted exception for a bounded run; it must name the missing requirement, reason, scope, accepting operator, rerun trigger, and redacted evidence refs. A waived channel is not certified and must not be used for universal parity claims.

### Connector Troubleshooting Matrix

Start with `opencode-gateway channel status <provider> --json` and `opencode-gateway channel repair <provider>`. Paste only redacted output into Linear, GitHub, or docs.

| State or failure | Operator action | Evidence to keep |
| --- | --- | --- |
| `not_configured` | Run `channel setup <provider>` and choose the implemented setup path for the provider. Leave scaffolded paths labeled scaffolded until their provider exchange and install evidence exist. | Provider, selected setup path, and generated safe next action. |
| `credentials_needed` or `missing_credentials` | Run `channel setup <provider>` and add the named env/config keys. For WhatsApp direct, provide access token, phone number ID, verify token, and app secret. Restart Gateway if the daemon reads credentials from its launch environment. | Redacted status showing required keys and configured true/false flags, not values. |
| `provider_connected` | Continue with `channel verify <provider>` when the provider needs route/signature checks, or `channel trust <provider>` when polling/local verification is already satisfied. | Redacted status showing configured true, current stage, and next action. |
| `webhook_needed`, `verification_pending`, `callback_url_missing`, `verify_token_mismatch`, or `signature_verification_missing` | Expose only the documented provider route, then run `channel verify <provider>`. For WhatsApp, the callback must end in `/webhooks/whatsapp`; for Discord, expose only `POST /webhooks/discord`. Confirm `security.publicWebhookMode` or authenticated reverse proxy mode protects every non-webhook route. | `channel verify` output, route exposure mode, documented route path, and redacted signature/challenge readiness. |
| `polling_ready` | Generate a claim code or add the explicit allowlist, then bind the trusted target to the current work context. | Redacted trust status and binding evidence. |
| `trusted_target_pending` | Prefer `channel claim <provider>` and send the claim from the target chat/channel/thread. Use manual `security.channelAllowlists.<provider>` only when claim codes cannot be used. Remove unsafe allow-all before beta evidence. | Claim creation/acceptance audit event with redacted provider target label, or redacted allowlist shape. |
| `bound`, or a bound target does not match the expected Session, Issue, or Initiative | Inspect `gateway_channel_binding_list` or Mission Control channel binding details. Rebind only with an explicit operator action such as the supported `/project bind` or `/bind session` flow; do not infer context from display names. | Binding ID, provider, redacted target label, parent Session/Issue/Initiative IDs, and the explicit rebind command used. |
| `ready` | Keep monitoring with `channel status <provider>`, Mission Control, and readiness after channel code, provider setup, trust policy, or binding changes. | Latest redacted status references and date of last check. |
| `degraded` | Read diagnostics and decide whether the warning is accepted for this run. Unsafe allow-all, webhook verifier warnings, or delivery fallback warnings must be named in evidence. | Redacted diagnostics, accepted limitation, and next repair action. |
| `blocked` | Do not use the connector for beta readiness. Repair the named hard requirement or file a blocker with safe next action. | Redacted repair output and Linear blocker link. |

## Routing Behavior

| Intent | Agent |
| --- | --- |
| Default chat | `gateway-assistant` |
| Status, health, logs, config, channel operations | `gateway-coordinator` |
| Roadmaps, tasks, queue, scheduler planning | `gateway-planner` |
| Implementation requests | `gateway-implementer` |
| Review, verify, audit requests | `gateway-reviewer` |

Bindings are stored in `gateway.db`, not in chat-specific files.

## Telegram

Configure one of:

- `TELEGRAM_BOT_TOKEN`
- `channels.telegram.botToken` in Gateway config

Telegram chats and threads are bound to OpenCode sessions. Use channel commands for ID-light control of the current binding and related work.

Telegram Rich Messages are enabled by default. Disable them globally or only for Telegram if an operator needs the legacy `sendMessage` path:

```json
{
  "channels": {
    "richMessages": { "enabled": false },
    "telegram": {
      "richMessages": { "enabled": false }
    }
  }
}
```

When enabled, structured messages use `sendRichMessage` with escaped rich HTML, safe HTTP/HTTPS media references, inline URL/copy-command buttons, tables, details blocks, and thread/topic routing. If the rich payload is too long, contains unsupported media, or fails at Telegram, Gateway sends the deterministic Markdown/plain fallback through the existing Telegram `sendMessage` behavior.

Restrict trusted Telegram chats with `security.channelAllowlists.telegram`:

```json
{
  "security": {
    "channelAllowlists": {
      "telegram": [
        { "chatId": "telegram-fixture-chat", "userIds": ["trusted-user-id"] },
        { "chatId": "telegram-fixture-chat", "threadId": "topic-fixture", "adminUserIds": ["operator-user-id"] }
      ],
      "whatsapp": [],
      "discord": []
    }
  }
}
```

Gateway fails closed until a provider has an allowlist entry, whether or not that provider has credentials configured. For isolated local testing only, `security.unsafeAllowAllChannelTargets.telegram=true` accepts any Telegram chat and causes readiness to warn.

For private one-to-one chats, a target entry authorizes both free text and privileged channel commands when Telegram reports the same chat and user ID. For shared chats, groups, topics, or any target where several people can speak, add `userIds` or `adminUserIds` to the allowlist entry: by default Gateway forwards free text only from those trusted actors (claim-code trust records the claiming sender automatically), and privileged command preflight checks the actor as well as the chat/thread for commands such as project creation, binding changes, approval decisions, or task mutation. Free text from other members of a trusted target is rejected with a redacted denial audit unless the explicit `security.trustTargetMembersForFreeText=true` opt-out is set; that opt-out never relaxes privileged command preflight.

## WhatsApp

WhatsApp has two product-facing setup paths in the shared connector UX:

- **Cloud API direct** is implemented for local and self-hosted operators. It uses Meta Cloud API credentials, Gateway's `/webhooks/whatsapp` verifier, trusted-target claim codes or allowlists, and channel binding.
- **Embedded Signup / provider-managed** is scaffolded and documented, but not live-enabled in Gateway yet. It records the required Meta app and provider prerequisites without pretending Gateway can complete Meta Login, authorization-code exchange, provider asset capture, or provider-managed trust today.

Both paths follow the same Connect -> Verify -> Trust -> Bind -> Monitor journey. Cloud API direct uses the access token, phone number ID, verify token, and app secret (see the credential list under [CLI Connector Setup](#cli-connector-setup) above); the Embedded Signup / provider-managed path stays `scaffolded` until backend Meta Login, token exchange, asset capture, webhook subscription, and rotation are implemented, and a discovered sender still needs claim-code or explicit allowlist trust.

Select direct setup implicitly by configuring those credentials, or explicitly with:

```json
{
  "channels": {
    "whatsapp": {
      "setupMode": "cloudApiDirect"
    }
  }
}
```

Expose only these daemon routes through your public tunnel or reverse proxy:

- `GET /webhooks/whatsapp`
- `POST /webhooks/whatsapp`

The daemon should remain bound to `127.0.0.1`. Any public exposure belongs in an authenticating proxy or tunnel configuration. If `security.publicWebhookMode=true` is used because the daemon itself is reachable from the provider, Gateway exempts only `GET`/`POST /webhooks/whatsapp`; every other route still requires the normal HTTP capability boundary.

Restrict trusted WhatsApp senders with `security.channelAllowlists.whatsapp`:

```json
{
  "security": {
    "channelAllowlists": {
      "telegram": [],
      "whatsapp": [{ "chatId": "wa-fixture-target" }]
    }
  }
}
```

When any WhatsApp credential is configured, inbound webhooks are rejected unless the sender matches `security.channelAllowlists.whatsapp` or the explicit test-only `security.unsafeAllowAllChannelTargets.whatsapp=true` flag is set.

## Discord Alpha

Discord is a private-alpha adapter. It is disabled by default even when credentials are present. Enable it only for a controlled workspace after configuring target allowlists. It is not a promoted production channel yet.

Use environment variables for local development so secrets do not land in `config.json`:

| Environment variable | Config key |
| --- | --- |
| `OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED=true` | `channels.discord.enabled` |
| `DISCORD_BOT_TOKEN` | `channels.discord.botToken` |
| `DISCORD_APPLICATION_ID` | `channels.discord.applicationId` |
| `DISCORD_PUBLIC_KEY` | `channels.discord.publicKey` |

Minimal config-only shape:

```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "richMessages": { "enabled": true }
    }
  },
  "security": {
    "channelAllowlists": {
      "telegram": [],
      "whatsapp": [],
      "discord": [{ "chatId": "123456789012345678", "adminUserIds": ["987654321098765432"] }]
    }
  }
}
```

The adapter sends through Discord's REST channel message API. Structured Gateway cards render as bounded embeds and buttons when rich messages are enabled; if Discord rejects the native payload, Gateway retries the shared Markdown/plain fallback. Component interactions and slash-command interactions are accepted only through fresh signed Discord interaction webhooks at:

- `POST /webhooks/discord`

Gateway rejects Discord interaction signatures whose timestamp falls outside the short replay window, then uses that signed timestamp as the normalized inbound message time. This keeps replayed button or slash payloads from being treated as fresh operator intent.

For local webhook testing, expose only `/webhooks/discord` through a tunnel and set `security.publicWebhookMode=true` or use an authenticated reverse proxy. Keep the daemon bound to `127.0.0.1` unless you have also configured the normal non-local HTTP safeguards.

`security.publicWebhookMode=true` exempts only `POST /webhooks/discord` for Discord. `GET /webhooks/discord`, channel send routes, admin routes, OpenCode asset routes, storage routes, dashboard routes, and other Gateway HTTP routes remain outside the public webhook exception.

Readiness and Mission Control show Discord as its own alpha provider. A configured Discord alpha is healthy only when all of these are true:

- `channels.discord.enabled=true` or `OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED=true` is set.
- A bot token is configured for outbound progress/final receipts.
- A public key is configured for signed interaction webhook verification.
- `security.channelAllowlists.discord` contains explicit trusted channel or channel/thread targets.
- `security.unsafeAllowAllChannelTargets.discord` is false.

Trusted thread routing uses the same identity graph as Telegram topics: a binding can trust `{ "chatId": "parent-channel", "threadId": "thread-id" }`, and inbound Discord events that carry a parent channel plus thread are normalized to that target before project/session resolution.

The current alpha is fixture-backed unless an operator deliberately runs a live Discord workspace drill. The fixtures verify:

- signed component or slash-command interaction normalization into Gateway command text;
- untrusted channel/thread denial before binding resolution;
- progress and final delegated-work receipts rendered as Discord embeds with deterministic Markdown/plain fallbacks;
- redacted startup and delivery failure events.

Limitations in this alpha:

- no production bot-management UI, slash-command registration workflow, websocket gateway manager, message edits, or message deletes;
- no Discord-specific project resolver, command parser, binding table, or notification policy; Discord uses the shared identity graph and channel binding model;
- inbound channel trust still requires `security.channelAllowlists.discord` unless the local/test-only `security.unsafeAllowAllChannelTargets.discord=true` escape hatch is set;
- Discord thread support depends on Discord payloads carrying either `thread_id` or a channel object with `parent_id`.

Promotion criteria before Discord can move beyond alpha:

- live trusted-channel drill with redacted progress and final receipts;
- negative proof that an untrusted Discord channel/thread leaks no state;
- slash-command registration and operator setup flow documented;
- service health, readiness, Mission Control, and adapter-contract tests green in `npm run verify`;
- review-gate evidence for the final diff and no unresolved security findings.

Focused local validation:

```sh
npx vitest run src/__tests__/discord.test.ts
```

## Channel Binding Tools

- `gateway_channel_binding_list`
- `gateway_channel_binding_get`
- `gateway_channel_binding_upsert`
- `gateway_channel_binding_delete`
- `gateway_channel_send`
- `gateway_channel_send_to_task`
- `gateway_channel_send_to_roadmap`
