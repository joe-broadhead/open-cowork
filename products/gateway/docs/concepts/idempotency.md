# Idempotency Strategy

Gateway treats retries, duplicate webhooks, restarts, and repeated scheduler passes as normal operating conditions. Idempotency is owned by the durable primitive closest to the side effect; notification policy decides when a message should be sent, while idempotency decides whether this exact side effect was already proven.

## Action Keys

| Action | Idempotency key | Proof of completion | Retry behavior |
| --- | --- | --- | --- |
| Channel sync outbound delivery | `sessionId:provider:chatId:threadId` checkpoint plus OpenCode message ID and created timestamp | `channel-sync.json` `seenMessageIds`, `lastMessageCreated`, and `lastMessageCreatedIds` after `sendMessage()` succeeds | Failed sends do not mark the message seen, so the next sync pass retries from the last successful checkpoint. |
| Channel inbound echo suppression | Session, provider, chat/thread, text hash, receipt time, and provider message ID when known | `pendingInbound` entries in `channel-sync.json` | Source-channel user messages are skipped for that same target; other linked targets can still receive a labeled relay. |
| OpenCode question/permission notifications | `question:<requestId>` or `permission:<requestId>` plus `provider:chatId:threadId` | `opencode.request.notified` work event | Duplicate webhooks and concurrent handlers share an in-flight target lock and then check the durable event before sending. Failed sends record `opencode.request.notify_failed` and a warning alert, but not the success marker. |
| Delegated work submission | Caller-provided `DelegationRequest.idempotencyKey` | `delegation_receipts` row, mirrored by `delegation.mapped` event | A retry returns the existing receipt with `idempotencyStatus=replayed` and does not create duplicate tasks, roadmaps, supervisors, or project bindings. |
| Delegated progress notification | Hash of progress event ID, target key, progress kind, and durable subject data | `delegation_progress_route_receipts` row with redacted route state, mirrored by `delegation.progress.notified` when delivery succeeds | Repeated delivery passes suppress user-visible duplicates inside the dedupe window from durable route receipts even if old notification events are unavailable. Failures, stale parent sessions, muted/deferred policy, and orphaned parent anchors are classified with safe next actions. |
| Project attention notification | Hash of roadmap, target key, and sorted open attention item set | `project.notification.sent` event for that route dedupe key | Repeated attention scans suppress duplicates until the item set changes or the dedupe window expires. Failed sends record `project.notification.failed` and alerts only. |
| Supervisor wakeup | Hash of supervisor, roadmap, wake reason, legacy reason, window key, and cursor event ID | `supervisor_wakeup_receipts.idempotency_key` plus supervisor lease fields | Concurrent passes respect the active lease. Expired leases can reacquire the same deterministic receipt without advancing the event cursor until completion succeeds. |
| Human gate decision | Gate ID and terminal gate status | `human_gate.decided` and `audit.human_decision` events, plus gate terminal status | Repeating a decision against an already terminal gate returns the stored gate and does not replay task mutation or audit events. |

## Durable Storage

`gateway.db` stores idempotency state for Gateway-owned work and notifications. Notification dedupe proof events (`opencode.request.notified`, `project.notification.sent`, `team_assignment.briefing.notified`, `channel.action.accepted`, and `telegram.command_menu.registration.succeeded`) are in the durable work-event allowlist, so the event-row cap and age-based retention cannot prune them inside their dedupe windows. Delegation receipts use a first-class `delegation_receipts` table because workflow events are retention-bound and should not be the only replay source. Delegated progress uses `delegation_progress_receipts` for the progress row and `delegation_progress_route_receipts` for per-target delivery state; route rows contain redacted provider/session context, not raw provider payloads or transcript bodies. Supervisor wakeups use `supervisor_wakeup_receipts` because leases and completion receipts need an auditable lifecycle.

`channel-sync.json` remains a provider-agnostic compatibility store for OpenCode session-to-channel delivery checkpoints. It is intentionally written only after successful sends or skipped messages that do not require user-visible delivery.

## Failure Rules

- A failed user-visible send must not create the success marker for that send.
- A failure event may be appended with redacted error details so operators can audit retries.
- Digest timestamps and delivery checkpoints advance only after successful delivery.
- Policy suppression events are separate from dedupe success markers; muted, quiet-hours, and digest deferrals must not prove delivery.
- Provider-native idempotency keys should be used by future adapters when available, but Gateway still records its own durable proof.

## Policy Boundary

Progress update policy controls immediate, digest, muted, quiet-hours, and escalation behavior. This strategy only defines duplicate prevention and auditability for whatever delivery decision the policy returns. See [Progress Update Policy](progress-update-policy.md) for policy semantics.
