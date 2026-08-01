---
title: Projects
description: Coordination board for objectives, tasks, and linked OpenCode work chats.
---

# Projects

**Product decision:** Projects is the **coordination board** surface —
objectives, Kanban-style tasks, assignees, and linked OpenCode work chats —
not a full-text chat history browser.

Quick session switching stays in the **sidebar recent-chat list** and chat
search. Do not document Projects as “facets/tags search history” unless that
UI ships again under an explicit product decision.

## What you can do

- Browse coordination **projects** (objectives) and their **tasks**
- Move tasks across board columns
- Open a linked chat from a project
- Open a task's linked chat when work has started
- Assign work to coworkers from the roster when the authority supports it

## Authorities

| Workspace | Board behavior |
| --- | --- |
| Desktop Local | Local coordination store |
| Desktop Cloud, Paired, or Gateway workspace | Restricted handoff; Desktop never falls back to the Local coordination store |
| Cloud Web | Workspace-scoped Cloud coordination APIs; never local host paths |
| Standalone Gateway | Connection-only; board/session operations follow its support matrix |

## Empty and restricted states

- Empty board: create or seed a project via the board CTA
- Deferred/blocked support: show `workspace.support()` reason — never opaque errors
- Missing linked conversation: warn and keep the board usable

## Related

- [Desktop app guide](desktop-app.md)
- [Coordination model](coordination-model.md)
- [Product contract](product-contract.md)
