# Progress Update Policy

Progress update policy controls when Gateway sends user-visible project, attention, supervisor, and delegated-work updates. Workflow events are still recorded even when delivery is deferred or suppressed.

## Policy Shape

Project bindings are the durable policy source for Telegram, WhatsApp, OpenCode session, and project-bound targets:

- `notificationMode=immediate` sends normal progress as soon as routing observes it.
- `notificationMode=digest` batches normal progress until the digest interval is due. Critical updates can still send immediately.
- `notificationMode=muted` suppresses user-visible delivery while preserving workflow events.
- `mutedUntil` temporarily suppresses delivery until an ISO timestamp.
- `quietHours` is a UTC window such as `{ "start": "22:00", "end": "07:00", "timezone": "UTC" }`. Normal progress is deferred and suppression events include `deferredUntil`.
- Escalation defaults allow critical updates to bypass digest and quiet-hours deferral. Set `criticalBypassDigest=false` or `criticalBypassQuietHours=false` in binding quiet-hours JSON or delegation `notificationTarget.escalation` JSON to make critical updates wait with normal progress.

Critical delegated-work progress is `blocked`, `gate_opened`, `failed`, or `completion_proposed`. Critical project attention is any attention group with severity `critical`.

## Resolution Order

Gateway resolves policy deterministically:

1. A routed project/channel binding uses its own notification fields.
2. A supervisor session uses `notificationPolicyRef` when it names a project binding ID, `project_binding:<id>`, or alias.
3. If no explicit supervisor ref matches, Gateway uses the binding for the same roadmap and session.
4. Parent-session delegated progress uses explicit `notificationTarget` policy fields only when `notificationTarget.mode=parent_session`; channel target policy does not mute or digest the parent callback.
5. Targets without a channel deliver to their OpenCode session when a session client is available; otherwise Gateway records deferred suppression.

Suppression and failure events keep stable dedupe keys compatible with existing `delegation.progress.notified`, `delegation.progress.suppressed`, and `delegation.progress.failed` events.

## Operator Controls

From a trusted Telegram or WhatsApp channel:

- `/project notify immediate [alias]` sends normal project updates immediately.
- `/project notify digest [alias]` batches normal updates.
- `/project notify muted [alias]` suppresses user-visible updates.
- `/project quiet HH:MM HH:MM [alias]` defers normal updates during the UTC window.
- `/project quiet off [alias]` clears quiet hours.
- Existing `/watch` and `/unwatch` shortcuts still map to immediate and muted modes.
