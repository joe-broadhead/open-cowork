# Channel Commands

Telegram and WhatsApp channel commands provide ID-light control of the current Channel binding.

All inbound requires a trusted target (allowlist entry or accepted claim code); only the setup-safe `/start`, `/help`, `/commands`, and `/whereami` work before trust. Free text is additionally gated per sender: by default only trusted actors (allowlisted `userIds`/`adminUserIds`, the claiming sender, or a private chat where sender id equals chat id) can drive the bound agent with free text, and privileged commands always run the per-sender actor preflight. See [Security](../operations/security.md) for the allowlist and `trustTargetMembersForFreeText` semantics.

Gateway Method language uses Project, Issue, Session, Channel, Permission, Question, and Proof. Legacy storage and commands still expose `roadmapId` for Project records and `taskId` for Issue records; `/roadmaps` and `/tasks` remain supported aliases, while `/initiatives` and `/issues` are the preferred user-facing commands.

The canonical local-beta action registry is `src/channel-actions.ts`. It generates the typed-command inventory, Telegram native slash-command registration, selected Telegram/WhatsApp menu actions, capability classification, `/channels/capabilities` action parity rows, and the Mission Control Channels action-parity table. Any new channel command should be added there first so typed fallbacks, native affordances, capability checks, and docs stay aligned.

## General Commands

| Command | Purpose |
| --- | --- |
| `/help`, `/start`, `/commands` | Show command menu. |
| `/whereami` | Show channel trust, binding, project, and notification context. |
| `/status` | Show Channel binding and Issue queue status. |
| `/current` | Show the current Issue, Project, or Session binding target. |
| `/open [sessionId\|projectAlias\|roadmapId]` | Return OpenCode Web/TUI links plus Mission Control/session evidence fallback for the current session. |
| `/latest` | Show latest Issue/Run context for the current binding. |

## Session And Binding Commands

| Command | Purpose |
| --- | --- |
| `/new [title]` | Create and bind a fresh OpenCode Session from this channel. |
| `/session [list\|select <sessionId>]`, `/sessions` | List or select recent OpenCode Sessions for this channel. |
| `/switch <sessionId\|projectAlias\|roadmapId>` | Switch this channel to a Session, Project alias, or Project record. |
| `/bind session <sessionId> [--rebind]` | Bind this channel to an OpenCode Session. |
| `/bind project <alias> <roadmapId> [--rebind]` | Bind this channel to a Project alias and record. |
| `/bind issue <taskId> [--rebind]`, `/bind initiative <roadmapId> [--rebind]` | Bind this channel to an Issue or an Initiative. |
| `/unbind` | Remove this channel binding. |

If OpenCode no longer recognizes a bound or requested Session, Gateway does not return a dead Web deep link. `/open`, `/switch <sessionId>`, `/bind session <sessionId> --rebind`, `/status`, `/latest`, and `/project open` return an unavailable-Web notice, a typed recovery action, a TUI resume command, Mission Control, and the local session-evidence route. Rebinding a Project with `--rebind` probes the existing supervisor Session and replaces it with a fresh/reusable Session when the old one has disappeared.

## Durable Work Commands

| Command | Purpose |
| --- | --- |
| `/issues`, `/tasks` | List active Issues. |
| `/initiatives`, `/roadmaps` | List active Projects/Initiatives. |
| `/project create <alias> [title] [--rebind]` | Create a supervised Project and bind it to this channel. |
| `/project status [alias]` | Resolve the current project context or a project alias. |
| `/project bind <alias> <roadmapId> [--rebind]` | Bind the current Channel to a Project alias, Project record (`roadmapId`), and the default supervisor or current OpenCode Session. |
| `/project unbind [alias]` | Remove the current chat/thread project binding, or a named alias in this channel. |
| `/project digest [alias]`, `/digest [alias]` | Show the current Project digest of recent events and decisions. |
| `/project watch [alias]`, `/watch [alias]` | Watch Project notifications (immediate delivery). |
| `/project unwatch [alias]`, `/unwatch [alias]` | Mute Project notifications. |
| `/project notify <immediate\|digest\|muted> [alias]` | Set project notification delivery mode for the current binding. |
| `/project quiet <HH:MM> <HH:MM> [alias]` | Defer normal project updates during the UTC quiet-hours window. |
| `/project quiet off [alias]` | Clear quiet hours for the current project binding. |
| `/project decisions [alias]` | List open human gates and completion proposals for the project. |
| `/project review-now [alias]` | Queue the project's default supervisor for immediate review. |
| `/project complete [list\|approve\|reject] [proposalId] [note]` | List or decide the project's pending completion proposals. |
| `/project open [alias]` | Return OpenCode Web/TUI and Mission Control links for the project's supervisor Session. |
| `/project pause [alias]`, `/project resume [alias]` | Pause or resume the project's default supervisor. |
| `/completion [list]` | List pending completion proposals for the current project context, or all pending proposals if no project is bound. |
| `/completion approve <proposalId> [note]` | Approve a Project completion proposal and mark the Project done. |
| `/completion reject <proposalId> [note]` | Reject a Project completion proposal and schedule supervisor follow-up. |
| `/pause` | Pause current Issue context. |
| `/resume` | Resume current Issue context. |
| `/retry` | Retry current Issue context. |
| `/done` | Mark current Issue context done. |
| `/block` | Block current Issue context. |
| `/cancel` | Cancel current Issue context. |
| `/issue <pause\|resume\|cancel\|retry\|done\|block> <taskId> [note]`, `/task ...` | Act on an Issue by ID instead of the current binding. |
| `/scheduler <status\|pause\|resume\|run>` | Show or control scheduler state. |
| `/attention` | Show all Gateway and OpenCode items needing a human. |
| `/gates` | List pending Gateway human gates. |
| `/gate approve <gateId> [once\|always] [note]` | Approve a Gateway human gate. |
| `/gate reject <gateId> [note]` | Reject a Gateway human gate and block related work. |
| `/governance` | Show budget, token, cost, and runtime governance state. |
| `/alerts` | Show active Gateway alerts. |
| `/alert ack <alertId> [note]` | Acknowledge an active alert. |
| `/alert resolve <alertId> [note]` | Resolve an active alert. |
| `/alert suppress <alertId> [note]` | Suppress an active alert for the default suppression window. |
| `/incident [alertId]` | Generate an incident report. |

When the current Issue has a running Gateway run, trusted channel `/cancel`, `/retry`, and `/block`
use the active-run supervision contract rather than a blind task mutation. Gateway verifies the run
is still active, the task still owns that run, and the run lease is not expired before applying the
control. Retry-style behavior requeues durable work for scheduler redispatch and does not reuse the
current OpenCode session. If ownership is stale, the channel reply gives the same safe next action as
CLI/Mission Control, such as `opencode-gateway operator recover`.

## OpenCode Requests

| Command | Purpose |
| --- | --- |
| `/questions` | List pending OpenCode-native questions. |
| `/answer <questionId> <label-or-answer>` | Answer an OpenCode-native question from the current bound channel session. |
| `/reject-question <questionId>`, `/reject_question <questionId>` | Reject an OpenCode-native question from the current bound channel session. |
| `/permissions` | List pending OpenCode-native permission requests. |
| `/approve <permissionId> once\|always` | Approve an OpenCode-native permission request for the current bound channel session. |
| `/deny <permissionId>` | Deny an OpenCode-native permission request for the current bound channel session. |

Questions and permissions are owned by OpenCode. Gateway surfaces them to the channel as structured `Question required` and `Permission required` messages where the adapter supports native controls. Native buttons and lists carry the same slash command payloads shown above, so typed fallbacks and rich actions use the same stale/replay/session checks. Successful replies are reported as forwarded to OpenCode; OpenCode owns the final question or permission receipt.

Gateway human gates are separate durable scheduler/work gates. They do not replace OpenCode-native permission or question requests.

Every operator decision shown in a channel includes the same decision contract used by Needs Attention and Mission Control:

- `Decision owner`: `OpenCode`, `Gateway`, or Gateway channel security.
- `Decision state`: `requires_open_code`, `requires_gateway`, `answered`, `expired`, `denied`, `stale`, or `blocked`.
- `Next action`: the safe surface and typed fallback to use next.
- `Receipt owner`: the system that must record the final decision, such as OpenCode for native permission/question replies.

Channel callbacks and typed replies fail closed when they are stale, replayed, sent by the wrong actor, sent from the wrong channel, expired, or no longer pending. The audit event records the reason-coded decision without raw provider targets.
