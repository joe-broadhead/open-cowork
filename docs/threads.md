# Threads

The Threads workspace is the full-history surface for finding and organizing
past work. The compact sidebar list stays optimized for quick switching; the
Threads page handles deeper search, metadata facets, tags, saved filters, and
category suggestions. The `workLedgerV1` gate adds a Work Ledger tab for
searching non-chat work from the same workspace.

## Data model

`sessions.json` remains the authoritative Cowork-managed session registry. The
Threads feature uses a rebuildable sidecar SQLite projection named
`thread-index.sqlite` under the app data directory. If the sidecar is deleted,
Open Cowork can rebuild index rows from the session registry and hydrated
session history.

The index stores renderer-safe thread metadata:

- title, status, created/updated timestamps, and parent/automation linkage
- display-safe project labels
- provider and model ids
- usage totals, cost, token totals, and diff summary counts
- evidence-backed actual agents and tools observed in the session view
- user-owned tags
- saved smart filters
- suggestion records with bounded labels, reasons, and evidence metadata

It does not index full transcript text, hidden OpenCode runtime directories, or
provider credentials.

## Work Ledger

The Work Ledger is a separate sidecar projection named `work-ledger.sqlite`.
It is default-off behind the renderer preference key
`open-cowork.feature.workLedgerV1` while the backfill and Operations command
center integrations mature.

Unlike the thread index, the ledger spans multiple durable product stores:

- thread/session records
- automations, automation runs, automation tasks, inbox approvals/questions,
  and deliveries
- crews, crew runs, delegated crew nodes, approvals, policy decisions, and
  artifacts
- channel inbound events and delivery records
- governance incident-control audit events

Every row stores a normalized source reference and drill-down route back to the
source of truth. The ledger intentionally keeps summaries and lookup metadata
only: source kind/id, title, status, timestamps, owner/source label, involved
agents, involved capabilities, review state, user-attention state,
risk/governance labels, and cost/tokens where another source already provides a
summary. It does not copy tool traces, channel bodies, webhook payloads,
approval bodies, raw governance metadata, or credential values.

The Work Ledger tab supports cursor pagination and filters for source kind,
status, owner, agent, capability, risk label, governance label, review state,
date range, and user-attention state. Session-backed entries open Chat; other
entries route to the owning operational surface.

## Search And Facets

The Threads page calls the `threads.search` IPC namespace with bounded,
cursor-based queries. Results default to 50 rows and are capped at 100 rows per
request. Search covers thread titles and indexed metadata such as project label,
provider/model, agents, tools, tags, and suggestions.

The facet rail exposes deterministic filters for:

- date range
- project/sandbox label
- status
- provider and model
- actual agent usage
- actual tool and MCP usage
- user tags

Every filter is applied in the main process before rows reach the renderer.

## Tags

Tags are explicit user state. Users can create, delete, apply, and remove tags
from the Threads page. Dragging selected rows onto a tag is a convenience only;
the same action is available through checkboxes plus Apply/Remove buttons for
keyboard users.

Tags never come from automatic categorization unless a user explicitly creates
or applies them.

## Smart Filters

Smart filters are saved `ThreadSearchQuery` objects. Applying one repopulates
the visible search and filter controls; it does not mutate threads or tags.

## Suggestions

Suggestions are separate from tags and actual metadata. The first
implementation uses local deterministic heuristics from evidence-backed fields
such as title, project label, provider, actual agents, and actual tools.
Suggestions never auto-tag, auto-move, hide, or delete threads. Users can
accept, edit, dismiss, or ignore them.

## Privacy And Recovery

The sidecar index is local-only and uses the same private file mode posture as
other durable app data. The database, WAL, and SHM sidecars are chmodded to
`0o600` on platforms that support POSIX modes.

If the index is stale or corrupt, use the Threads page refresh path or the
main-process `threads.reindex` diagnostics IPC to rebuild rows from the current
session registry.
