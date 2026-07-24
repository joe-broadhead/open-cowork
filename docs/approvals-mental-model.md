# Approvals: inline transcript vs queue page

**Issue:** JOE-885

## Two surfaces, one model

| Surface | Role | Urgency |
| --- | --- | --- |
| **Inline transcript** (`ApprovalCard` in chat) | Act on the permission **in the thread that blocked** | Immediate — agent is waiting |
| **Approvals queue** (sidebar → Approvals) | Backlog of pending permissions/questions across sessions | Catch-up / multi-thread |

Neither is redundant:

- Inline is the primary path while chatting.
- Queue is for cross-session review and when the user navigated away mid-wait.

## UX rules

1. Queue items deep-link back to the source session when possible.
2. Resolving either surface must clear the same pending approval id.
3. Copy should say “Needs you in this thread” (inline) vs “Waiting across threads” (queue).
4. Do not show empty theater on the queue when the user is mid-chat with an inline card — optional badge counts already bridge the two.
5. **Always allow** is not shown on the queue until a real lasting-allow policy path
   ships (JOE-1039). Use **Allow once** / **Deny** on the queue; lasting rules
   belong in Settings permissions (runtime restart). Do not ship a disabled teaser.
