# Channel Adapter Contract

Gateway channel adapters turn external surfaces into one shared OpenCode/Gateway work graph. TUI, Web, Telegram, WhatsApp, Discord, Slack-like tools, and future chat products must not fork routing, binding, rendering, command, trust, sync, or idempotency behavior per provider.

This contract defines what an adapter must implement, what it may implement as a capability, and which Gateway primitive owns each concern.

## Contract Goals

- Preserve one OpenCode session history and one Gateway durable work graph across all surfaces.
- Keep provider-specific protocol work inside adapters and product behavior inside Gateway core modules.
- Let domain code send structured Gateway messages without knowing whether the target is Telegram, WhatsApp, Discord, Web, or another surface.
- Fail closed at trust boundaries and degrade gracefully at rendering boundaries.
- Make retry, dedupe, observability, and migration behavior explicit before adding Discord or any other new provider.

## Current Primitive Mapping

| Concern | Gateway primitive |
| --- | --- |
| Adapter interface | `src/channels/provider.ts` `ChannelAdapter`, `ChannelMessage` |
| Capability registry | `src/channels/capabilities.ts` `ChannelCapabilities`, `supportsChannelCapability()`, `actionDeliveryForCapabilities()` |
| Connector onboarding | `src/channels/capabilities.ts` `ChannelOnboardingCapabilities`, connector states, setup actions, credential requirements, trust requirements, and setup diagnostics |
| Structured outbound UX | `src/channels/renderer.ts` `StructuredGatewayMessage`, `RichMessageBlock`, `MessageAction`, `renderStructuredMessage()` |
| Channel target and binding | `src/channel-sessions.ts`, `ChannelBindingRecord`, `channel_bindings` table |
| Commands and actions | `src/channel-commands.ts`, especially `handleChannelCommand()` and `channelCommandMenuActions()` |
| Provider-neutral action registry and parity matrix | `src/channel-actions.ts` `CHANNEL_OPERATOR_ACTIONS`, `channelActionParityMatrix()` |
| Cross-surface continuity | `docs/concepts/identity-graph.md`, `src/channel-sync.ts` |
| Trust and allowlists | `src/security.ts` `isTrustedChannelTarget()`, `channelTargetLabel()` |
| Webhook/public HTTP boundary | `src/security.ts` HTTP helpers and provider webhook routes |
| Redaction | `src/security.ts` `redactSensitiveText()` / `redactSensitiveObject()` plus provider-specific error cleanup |
| Operational events | `src/wakeup.ts` `queueEvent()` and `src/work-store.ts` audit/work events |

Adapters may add provider helpers, but they should hand off to these primitives as quickly as possible.

## Required Adapter Surface

Every adapter must satisfy `ChannelAdapter`:

| Member | Required behavior |
| --- | --- |
| `name` | Stable provider key used in bindings, sync checkpoints, allowlists, events, and logs. It must be lowercase and migration-stable. |
| `start()` | Validate configuration, register webhooks or polling loops, and emit a redacted readiness/failure event. Missing credentials should disable the adapter without crashing the daemon. |
| `stop()` | Stop polling, timers, stream clients, and webhook side effects owned by the adapter. |
| `sendMessage(chatId, text, options)` | Send bounded plain text to the provider target. It is the universal fallback path, must honor `options.threadId` when the provider supports threads/topics, and must reject when outbound credentials or enablement are missing; an unconfigured adapter must never resolve as a successful no-op. |
| `onMessage(handler)` | Register the normalized inbound handler. Adapters must call it only after authentication/signature checks and channel target trust checks. |

Adapters should implement these optional capabilities when the provider can support them safely:

| Member | Optional behavior |
| --- | --- |
| `capabilities` | Advertise the explicit capability declaration from `src/channels/capabilities.ts`. Core rendering uses render flags to select rich, markdown, or plain text; orchestration uses category helpers such as `supportsChannelCapability()` instead of provider-name checks. |
| `sendStructuredMessage()` | Convert `StructuredGatewayMessage` into provider-native rich UI, or call `sendMessage()` with the renderer fallback. |
| `sendCommandMenu()` | Render `ChannelCommandAction` items as provider-native buttons, lists, slash-command hints, or components. Fallback is the plain `/commands` text. |

## Inbound Message Contract

Adapters normalize every provider event into `ChannelMessage` before handing it to Gateway:

| Field | Requirement |
| --- | --- |
| `provider` | Same value as `ChannelAdapter.name`. |
| `chatId` | Stable addressable conversation target for binding and outbound delivery. It must be deterministic across restarts and provider retries. |
| `threadId` | Stable sub-conversation identifier when the provider has topics, threads, forum posts, message threads, or equivalent. Omit only when the target has no thread scope. |
| `messageId` | Provider-native event or message ID when available. This is optional for current adapters, but new adapters should populate it for idempotency, replay protection, and audit correlation. |
| `userId` | Stable sender identifier from the provider. Do not use display names as identity. |
| `text` | Normalized command/prompt text. Interactive button/list/component selections must become their command payload, not their display label when a command payload exists. |
| `attachments` | Metadata for user-supplied media/files. Store provider media IDs or safe URLs, MIME type, and display name; do not download or persist secrets in the adapter contract. |
| `timestamp` | Provider event time as ISO-8601 when available; otherwise adapter receipt time. |

Adapters must ignore unsupported event types unless they can map them into this shape without ambiguity. They must not mutate channel bindings, resolve projects, or create OpenCode sessions directly; those decisions belong to the command handler and routing/session code.

## Outbound Rendering Contract

Plain text is the baseline for every adapter. Rich output is negotiated through the render slice of `ChannelCapabilities`:

- `plainText` must work for all production adapters.
- `markdown` means provider markdown can safely preserve formatting without breaking delivery.
- `richBlocks` means the adapter can map generic `RichMessageBlock` values into native rich UI.
- `buttons` means the adapter can render `MessageAction` or command actions as native components, list rows, command buttons, or equivalent.
- `tables`, `collapsibleDetails`, and `media` must be advertised only when the adapter can render those blocks safely.
- `streamingDraft` is reserved for providers that can update an in-progress message before final delivery.

The full capability declaration also covers `richText`, `richCards`, `inlineActions`, `callbacks`, `filesMedia`, `threading`, `identityBinding`, `deepLinks`, `notifications`, `edits`, `deletes`, and `fallbackBehavior`. Each category has a status of `supported`, `partial`, `planned`, or `unsupported` plus fallback notes. Runtime code should branch through typed helpers such as `supportsChannelCapability()` or `actionDeliveryForCapabilities()` so adding Discord or improving WhatsApp does not create provider-specific product branches.

Domain code should create `StructuredGatewayMessage` values and let `renderStructuredMessage()` pick the best mode. If native rendering fails, an adapter must fall back to deterministic markdown or plain text and emit a redacted degradation event. A failed rich send must not drop the notification unless plain text delivery also fails.

Provider-specific rendering must preserve the product hierarchy: title, status/severity, summary, facts, next action, details/tables/media, and actions. If a provider cannot represent one block type, the adapter should choose a lower render mode rather than inventing a provider-only layout that changes meaning.

## Universal Connector Onboarding Contract

Every channel must expose setup metadata through `ChannelCapabilities.onboarding`. This is a provider-neutral product contract for CLI, Mission Control, health, docs, and future setup automation. It does not compute live status by itself; runtime status can combine this declaration with config, environment, route, binding, and evidence state.

The universal connector states are:

| State | Meaning | Primary next action |
| --- | --- | --- |
| `not_configured` | No connector metadata or local configuration exists yet. | `connect` |
| `credentials_needed` | Required provider credentials or local config are missing. | `connect` or `repair` |
| `provider_connected` | Credentials or install context are present enough to contact the provider. | `verify` or `trust` |
| `webhook_needed` | A provider callback route is needed before inbound events can be accepted. | `verify` or `repair` |
| `polling_ready` | The connector can receive provider events through polling or an equivalent stream. | `trust` or `bind` |
| `verification_pending` | A challenge, signature, or local verifier must pass before inbound events are accepted. | `verify` or `repair` |
| `trusted_target_pending` | Provider setup works, but no trusted target may mutate Gateway state. | `trust` |
| `bound` | A trusted target is linked to a Gateway Session, Issue, or Initiative. | `disconnect` |
| `ready` | Connector is configured, trusted, and bound to a Gateway Session, Issue, or Initiative. | `disconnect` |
| `degraded` | Connector can partially operate, but setup or delivery has warnings. | `repair` |
| `blocked` | Connector must not be used until a missing provider, security, or trust blocker is fixed. | `repair` |

The shared setup actions are `connect`, `verify`, `trust`, `bind`, `repair`, and `disconnect`. Each provider may support only the relevant subset, but the user journey remains one shape: Connect -> Verify -> Trust -> Bind -> Monitor. A connector is ready once its trusted target is bound.

`GET /channels/capabilities` exposes the action parity matrix and native control coverage from the
`src/channel-actions.ts` registry alongside Mission Control channel data. That view separates
provider-native support from Gateway fallback, and keeps WhatsApp and Discord live-readiness claims
blocked until their provider setup, trust, and binding exist. (The milestone-era
channel-certification report modules were removed in the v1.3.0 consolidation; readiness now keys on
connector state.)

`ChannelOnboardingCapabilities` must declare:

- setup modes such as `polling`, `webhook`, `local`, `embeddedSignup`, or `providerManaged`;
- credential requirements with environment/config keys and a `secret` marker for redaction;
- webhook route requirements and signature/challenge posture when the provider uses callbacks;
- trust requirements, including manual allowlist support and planned claim-code/provider-install flows;
- setup diagnostics with a stable code, connector state, severity, summary, and remediation.

Current provider mapping:

| Provider | Setup modes | Trust model |
| --- | --- | --- |
| Telegram | `polling` | Claim code or manual allowlist fallback. |
| WhatsApp | `webhook`, `embeddedSignup`, `providerManaged` | Claim code or manual allowlist fallback; provider install planned. |
| Discord alpha | `webhook`, `providerManaged` | Claim code or manual allowlist fallback; provider install planned. |

Provider readiness reports must distinguish configuration and trust posture:

| Posture | Contract meaning |
| --- | --- |
| Ready | Connector is trusted and bound to a Gateway Session, Issue, or Initiative. |
| Fixture validated | Connector passed adapter contract tests, but is not yet trusted and bound to a live provider target. |
| Scaffolded | Setup metadata or UX exists for a path that is not live-enabled yet, such as WhatsApp Embedded Signup/provider-managed onboarding before Meta Login/token exchange and provider asset capture are implemented. |
| Provider-blocked | Gateway has a safe path, but live readiness is blocked by provider credentials, provider setup, external review, business prerequisites, or webhook verification outside local control. |
| Explicitly waived | A named operator has accepted a missing requirement for a bounded run with rationale, scope, evidence ref, and rerun trigger. Adapters must not silently convert a missing requirement into readiness. |

Diagnostics must be safe to display. They may name missing keys such as `WHATSAPP_ACCESS_TOKEN` or `channels.whatsapp.accessToken`, but they must not contain raw token values, app secrets, webhook signatures, private transcript text, raw chat IDs, or raw phone numbers. Provider target identifiers in diagnostics and evidence must use redaction helpers or local-only explicit operator confirmation.

## Commands And Actions

Slash commands and interactive actions are one command surface:

- Text commands must flow through `handleChannelCommand()` after trust checks.
- Native action controls must send the same command payloads used in text fallbacks, such as `/status`, `/gate approve ...`, or `/project bind ...`.
- Command menus should come from `channelCommandMenuActions()` so every surface exposes the same product commands.
- Adapter-specific command registration, such as slash-command manifests, may improve discoverability but must not create commands with behavior that bypasses Gateway command handlers.
- Mutating commands must keep current ambiguity and rebind rules: no silent project/session choice, and replacements require explicit `--rebind` or equivalent API intent.

## Identity, Binding, And Continuity

The canonical channel target is `(provider, chatId, threadId?)`. This tuple is used for:

- Trust allowlists.
- Channel bindings to OpenCode sessions, tasks, and roadmaps.
- Project context resolution.
- Channel sync delivery checkpoints.
- Source-channel echo suppression.
- Notification policy.

Adapters must preserve provider identity at the most precise target level that users perceive as a conversation. Group-wide traffic and thread/topic traffic should not collapse into the same target when the provider distinguishes them.

Gateway owns binding lifecycle through channel commands, HTTP routes, and MCP tools. An adapter may expose provider-native buttons or slash commands that call those paths, but it must not keep a separate binding store.

## Trust And Permissions

Inbound traffic must be authenticated before it is trusted:

- Webhooks must verify provider signatures, challenge tokens, or equivalent.
- Polling/streaming adapters must authenticate with provider credentials before accepting events.
- `isTrustedChannelTarget(provider, chatId, threadId, config)` must pass before an inbound message can resolve context, mutate bindings, create sessions, or run commands other than safe discovery commands such as `/whereami` and command-menu requests.
- If provider credentials are configured, the provider fails closed until an allowlist or explicit test-only unsafe allow-all flag exists.
- Provider user permissions are advisory input; Gateway trust still keys on channel target allowlists today.

For Discord-like providers, bot permissions and role/member checks may further restrict which events are accepted, but they do not replace Gateway channel target trust.

## Threads, Topics, And Target Mapping

Adapters must document their mapping from provider-native IDs into `chatId` and `threadId`.

| Provider concept | Gateway mapping rule |
| --- | --- |
| One-to-one or account chat | `chatId` is the stable conversation/account ID; `threadId` omitted. |
| Group/channel without threads | `chatId` is the stable group/channel ID; `threadId` omitted. |
| Topic/thread inside a group/channel | `chatId` is the containing addressable channel; `threadId` is the topic/thread ID. |
| Provider workspace/tenant | Include it in config, trust rules, or the `chatId` scheme when needed to avoid collisions. Do not rely on display names. |

Existing Telegram topics map `message_thread_id` to `threadId`. WhatsApp currently has no thread scope and uses sender phone/account as `chatId`.

## Sync, Idempotency, And Replay Rules

Channel sync is Gateway-owned. Adapters must support it by preserving stable target IDs and using `sendMessage()` consistently:

- Delivery checkpoints are keyed by session, provider, chatId, and threadId.
- Inbound prompts are recorded as pending inbound messages so sync can avoid echoing the same user text back to its source channel.
- New adapters should populate `ChannelMessage.messageId` whenever the provider supplies one. Follow-up sync work may use that value for stronger inbound dedupe; text-hash matching remains the compatibility fallback.
- Provider webhook retries and reconnect replays must be idempotent. The adapter should drop duplicate provider events when it can prove duplication by message/event ID.
- Every outbound outbox row has a stable `idempotencyKey`, and Gateway passes that same key on every retry. Adapters should map it to the provider's native idempotency/request key when available.
- Adapters that receive a provider message/receipt ID may return it and optionally implement receipt reconciliation. Gateway durably records the receipt before marking the outbox row delivered; after a crash it reconciles that receipt before deciding whether to resend.
- Providers that ignore idempotency keys and cannot reconcile receipts retain an explicit **at-least-once** fallback. A crash after provider acceptance but before Gateway's delivered commit can duplicate a message; adapters and operator documentation must not claim exactly-once delivery in that mode.

Adapters must not write their own sync checkpoint files. `src/channel-sync.ts` owns checkpoint persistence.

## Errors, Retries, And Rate Limits

Adapters should classify provider failures into these operational outcomes:

| Outcome | Behavior |
| --- | --- |
| Configuration/auth failure | Disable or keep adapter not ready, emit redacted startup event, and let readiness/alerts surface the problem. |
| Transient send failure | Throw from send API after bounded retry/fallback so caller can stop a sync pass and preserve checkpoint state. |
| Rich render failure | Degrade to markdown/plain text and emit a redacted degradation event. |
| Permanent target failure | Emit a redacted event with provider/status detail and avoid marking sync checkpoint as delivered. |
| Rate limit | Respect provider retry-after guidance when available, avoid tight retry loops, and leave undelivered messages uncheckpointed. |
| Malformed inbound event | Drop or reject with a redacted event; do not call the Gateway handler with partial identity. |

Error text must be cleaned with the shared redaction helpers or provider-specific equivalent before logging, queueing events, or audit storage.

## Secrets And Data Handling

Adapters must keep provider credentials out of persistent work state, audit payloads, logs, command replies, and channel messages:

- Prefer environment variables or redacted config fields for tokens/secrets.
- Never include bearer tokens, bot tokens, app secrets, webhook signatures, or provider raw payloads in user-visible messages.
- Redact provider response bodies before `queueEvent()` or audit/work events.
- Attachment URLs must be safe to display. Private file handles, signed URLs, and media IDs should be treated as provider-scoped references unless a later media service explicitly brokers them.

## Observability And Audit

Adapters should emit operational events for readiness, startup failure, inbound rejection, delivery failure, rich-message degradation, and webhook verification problems. Use `queueEvent()` for operator-visible activity.

Security decisions and human decisions should be durable audit/work events when they affect trust or work state. Current adapters record denied untrusted inbound as `audit.security` with `operation: channel.inbound`; future adapters should preserve that pattern.

Event payloads should identify provider and target with `channelTargetLabel()` or a redacted/hash-safe equivalent, include provider status codes when helpful, and avoid raw secrets or full message bodies unless the body is already an intentional Gateway command/result.

## Discord Implications

Discord is implemented as a private-alpha adapter on this contract, not as a separate product path.

| Discord concept | Contract implication |
| --- | --- |
| Guild | Treat as workspace/tenant context. Include guild ID in allowlist/config or a collision-proof `chatId` scheme. |
| Channel | Use stable channel ID as the main `chatId` for guild text channels and DMs, with guild context where needed. |
| Thread/forum post | Use Discord thread ID as `threadId` when messages occur inside a thread or forum post. Preserve parent channel/guild context for trust and display. |
| Message ID / interaction ID | Populate `messageId` with the stable message or interaction event ID for dedupe and audit correlation. |
| User/member | Use Discord user ID for `userId`; role/member names are display/permission metadata, not identity keys. |
| Slash commands | Register slash commands only as provider-native entry points into existing Gateway command handlers. Keep text command parity. |
| Components/buttons/selects | Map component custom IDs to existing command payloads and `MessageAction.command`; do not create Discord-only action semantics. |
| Embeds | Map `StructuredGatewayMessage` title/status/summary/facts/tables/details/media into embeds only when `capabilities` honestly advertises support. Preserve plain fallback. |
| Permissions | Check bot permissions and optional guild/member policy before handler invocation, then still require Gateway target trust. |
| Rate limits | Honor Discord route/global rate limits and leave sync checkpoints unadvanced until sends succeed. |

Discord stays conservative in alpha: it is disabled unless explicitly configured, sends plain text/Markdown, can render bounded embeds/buttons when rich messages are enabled, and retries Markdown/plain fallbacks when native delivery fails. It does not create a Discord-specific binding table, project resolver, command parser, or notification policy.

## Compatibility And Migration Rules

- Existing Telegram and WhatsApp behavior is the compatibility baseline.
- Adding a provider must not change `ChannelBindingRecord` semantics for existing rows.
- Provider `name`, `chatId`, and `threadId` mappings are durable identifiers. Changing them requires an explicit migration plan for bindings, allowlists, and sync checkpoints.
- New capabilities must be additive. Domain code should not branch on provider names for product behavior.
- Rich-message improvements must keep deterministic plain-text fallbacks stable enough for tests and low-capability providers.
- New commands must be added to the shared command handler and menu before provider-native discovery surfaces expose them.
- Trust must fail closed for configured providers. Unsafe allow-all flags remain local/test-only escape hatches.
- A new adapter may add provider-specific config and webhook routes, but public exposure should remain scoped to documented provider webhook paths and the daemon should default to localhost.

## Shared Contract Tests

Adapter behavior is proven through per-provider test files (`src/__tests__/telegram.test.ts`, `src/__tests__/whatsapp.test.ts`, `src/__tests__/discord.test.ts`) plus the shared renderer and capability tests. Shared fixtures for rich-card parity checks live in `src/__tests__/helpers/adapter-fixtures.ts`.

An adapter's tests must verify:

- the adapter declares the full capability matrix and a plain-text fallback path;
- setup/onboarding metadata declares universal states, actions, diagnostics, and redaction-safe credentials;
- unsupported capabilities include documented fallback notes;
- rich cards degrade through `renderStructuredMessage()` instead of losing title, facts, tables, details, media references, or actions;
- action identifiers stay stable across native controls and text fallbacks and do not include adapter-private state;
- edits and deletes remain explicit fallbacks until a provider documents safe native semantics for updating or removing prior messages.

Run the focused provider suites with:

```sh
npx vitest run src/__tests__/telegram.test.ts src/__tests__/discord.test.ts
```

When docs change, also run the docs build from a Python environment with the documentation requirements installed:

```sh
python -m pip install -r docs/requirements.txt
python -m mkdocs build --strict
```

## Adapter Readiness Checklist

Before enabling a future adapter in production:

- Document provider ID mapping for `provider`, `chatId`, `threadId`, `messageId`, and `userId`.
- Match the setup shape of the closest existing adapter (webhook, polling, or provider-managed install) and cover the same contract assertions in the new adapter's test file before it appears as connectable.
- Add config docs for credentials, webhook routes or polling mode, and allowlist examples.
- Prove untrusted inbound is rejected before context resolution or mutation.
- Prove plain-text send, command handling, command menu fallback, and channel binding commands work.
- Prove structured messages degrade through `renderStructuredMessage()` without provider-specific product branches.
- Prove sync delivery checkpoints and source-channel suppression work for same-session multi-surface traffic.
- Prove provider retries/replays do not duplicate inbound commands or outbound sync delivery beyond provider limits.
- Prove credentials and provider error bodies are redacted in logs, events, config reads, and audit records.
- Add focused tests for mapping, trust rejection, render fallback, and command/action payloads.
