---
title: Projects
description: Coordination board for objectives, tasks, and linked OpenCode work chats.
---

# Projects

**Product decision (JOE-1052):** Projects is the **coordination board** surface —
objectives, Kanban-style tasks, assignees, and linked OpenCode work chats —
not a full-text chat history browser.

Quick session switching stays in the **sidebar recent-work list** and thread
search. Do not document Projects as “facets/tags search history” unless that
UI ships again under an explicit product decision.

## What you can do

- Browse coordination **projects** (objectives) and their **tasks**
- Move tasks across board columns
- Open a linked conversation when the project has a source session
- Open task work targets when coordination has linked a work session
- Assign work to coworkers from the roster when the authority supports it

## Authorities

| Workspace | Board behavior |
| --- | --- |
| Desktop Local | Local coordination store |
| Desktop Cloud / Cloud Web | Cloud coordination APIs (must not silently fall back to local host paths) |
| Standalone Gateway (deferred sessions) | Connection-only; board/session ops follow support matrix |

## Empty and restricted states

- Empty board: create or seed a project via the board CTA
- Deferred/blocked support: show `workspace.support()` reason — never opaque errors
- Missing linked conversation: warn and keep the board usable

## Related

- [Desktop app guide](desktop-app.md)
- [Coordination model](coordination-model.md)
- [Product purity register](product-purity-register.md)
