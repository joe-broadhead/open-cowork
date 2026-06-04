# Cloud Web Workbench

Cloud Web is the browser workbench for cloud workspaces. It is a Cloud API
client over the same tenant-scoped sessions, projections, workflows, artifacts,
policy, and gateway records used by Desktop Cloud and Gateway. It must not
import server-only stores, secret adapters, runtime adapters, or OpenCode SDK
surfaces.

The canonical workspace and sync promises live in
[Product Contract](product-contract.md). This page is the release contract for
the browser surface.

## Route/API Matrix

The typed source of truth is
`apps/website/src/route-api-matrix.ts`. Every route must have a matrix entry
with required role, backing endpoint ids, loading/empty/error states,
disabled-state behavior, pagination or cursor notes, redaction requirements,
structured pagination/redaction contracts, and tests. The route matrix tests
fail if a route omits its limit/cursor mode, raw-secret policy, or
loading/empty/error state contract.

| Route id | Surface | Required role | Backing endpoint ids | Pagination / cursor | Redaction and disabled behavior |
|---|---|---|---|---|---|
| `threads` | Workbench | Member | `sessions`, `sessionView`, `projectSourceValidate`, `projectSnapshots` | Browser list is bounded by `CLOUD_WEB_THREAD_PAGE_SIZE`. The browser consumes `/api/sessions` cursor pages with Load more, preserves loaded pages across workspace SSE refreshes, and only displays total estimates returned by the backend. | Chat controls disable when policy blocks chat. Local host paths and local MCP process details are never sent as thread context. |
| `chat` | Workbench | Member | `sessionView`, `sessionEvents`, `sessionPrompt`, `sessionPermissionRespond`, `sessionQuestionReply`, `sessionQuestionReject` | Session SSE resumes from the durable Cloud projection sequence. | Composer disables until a Cloud thread is selected. Runtime state is rendered from Cloud projections, not a browser-only projection model. |
| `agents` | Workbench | Member | `workspace`, `capabilitiesCatalog` | Capability filtering is local and performance-tested. | Agent metadata is cloud profile metadata only; local stdio MCP commands and secrets are not rendered. |
| `capabilities` | Workbench | Member | `capabilitiesCatalog`, `capabilityTools`, `capabilitySkills` | Local capability filtering is bounded; API cursoring is deferred. | Machine-scoped MCPs are visible only as policy-limited metadata. |
| `workflows` | Workbench | Member | `workflows`, `workflow`, `workflowRun`, `workflowPause`, `workflowResume`, `workflowArchive` | Workflow summary rendering is bounded to 100 workflows and 50 recent runs in the browser; run-history cursoring is deferred. | Workflow controls disable when profile policy blocks workflows. Rows never expose worker credentials or local paths. |
| `artifacts` | Workbench | Member | `sessionArtifacts`, `sessionArtifact` | Selected-session artifact metadata rendering is bounded to 100 artifacts. Cross-session artifact browsing is deferred. | Artifact bodies fetch only after explicit action. Signed URLs, object keys, buckets, tokens, and object-store internals are stripped from metadata. |
| `org` | Admin | Public | `authMe`, `config`, `workspace` | Not applicable. | Signed-out state hides signed-in routes. Bootstrap JSON carries public branding, route metadata, endpoint metadata, and feature metadata only. |
| `members` | Admin | Admin | `adminMembers`, `adminMemberInvite`, `adminMemberUpdate` | Members endpoint supports `q` and `limit`; the browser requests `limit=100` and renders at most 100 rows. | Member rows expose identity, role, and status only. Invite and role controls disable for non-admins and non-invite signup modes. |
| `policy` | Admin | Member | `adminPolicy`, `adminWorkerPools`, `adminWorkers`, `adminWorkerHeartbeats` | Worker pools and workers load first pages with `limit=100`; heartbeat detail is worker-scoped. | Policy and worker health summaries are read-only in v1 and exclude credentials, heartbeat tokens, and worker secrets. |
| `byok` | Admin | Admin | `byok` | Not applicable. | Provider keys are write-only. The browser only renders provider id, credential kind, last4/fingerprint/status, and validation timestamps. |
| `connections` | Admin | Admin | `apiTokens` | API token list requests `limit=100` and the browser renders at most 100 rows; cursoring is deferred. | Token plaintext is shown once after creation and never stored in persistent browser storage. |
| `billing` | Admin | Admin | `billingSubscription` | Not applicable. | Billing renders entitlement state and plan metadata only. Self-host mode disables managed billing controls. |
| `gateway` | Admin | Admin | `channelAgents`, `channelBindings`, `channelDeliveries`, `channelDeliveryRetry`, `channelDeliveryDeadLetter` | Headless agents and bindings request `limit=100`; delivery backlog requests and renders the first 50 rows. Provider streams are handled by Gateway, not the browser. | Channel credential refs are metadata only. Delivery payloads are browser-sanitized before details render. Retry and dead-letter actions require admin controls and confirmation. |
| `audit` | Admin | Admin | `adminAudit` | Audit endpoint loads the first 100 events. Cursor export is deferred. | Audit metadata must be server-redacted and is browser-sanitized again before display or export. |
| `usage` | Admin | Member | `usageEvents`, `usageSummary` | Usage events load `limit=20`; summaries load `limit=100`. | Usage events include metering dimensions only, not prompts, provider keys, or tokens. |
| `diagnostics` | Admin | Operator | `diagnostics`, `runtimeStatus`, `workerHeartbeats` | Diagnostics includes bounded worker heartbeat and gateway delivery samples. Browser diagnostics arrays are recursively capped before rendering. | Diagnostics are redacted recursively. Org admins may see the route, but the API may require operator-token privileges for global operational state. |

## Desktop/Cloud Workbench Parity Matrix

The typed source of truth is
`apps/website/src/workbench-parity.ts`. Cloud Web route labels, summaries,
browser bootstrap metadata, and rendered parity cards consume this matrix.
This document mirrors the same rows, and render tests assert every documented
row against the typed source so the product boundary cannot drift silently. The
purpose is to make shared Desktop concepts feel like the same product while
keeping Cloud Web honest about cloud-only and desktop-only boundaries.

| Concept | Availability | Cloud route(s) | Cloud Web affordance | Product boundary |
|---|---|---|---|---|
| Threads | Shared with Desktop | `threads` | List, filter, page, create, and reopen tenant-scoped Cloud threads. | Cloud Web reads Cloud session records and projections through the Cloud API; Desktop may also show local sessions. |
| Chat | Shared with Desktop | `chat` | Render the selected Cloud session timeline and send prompts through durable Cloud commands. | Cloud Web never builds a browser-only projection model or invokes local OpenCode runtime commands. |
| Runtime Status | Shared with Desktop | `chat` | Show status, streaming state, cost, token usage, context, compactions, tool calls, task runs, todos, and errors from Cloud projections. | Cloud Web reports projected Cloud runtime state only; machine health and local model controls remain Desktop-owned. |
| Approvals & Questions | Shared with Desktop | `chat` | Render pending and resolved approvals/questions and answer them through Cloud API endpoints. | Approval and question semantics remain OpenCode-owned; Cloud Web only submits tenant-scoped responses. |
| Agents | Shared with Desktop | `agents` | Show profile-allowed agents, built-in/custom metadata, and a Start thread action. | Cloud Web displays policy-safe agent metadata and cannot edit local custom agent files. |
| Tools & Skills | Shared with Desktop | `capabilities` | Show allowed tools, skills, MCP metadata, linked agents, and policy verdicts. | Cloud Web renders cloud-safe capability metadata; runtime execution remains owned by OpenCode workers. |
| Artifacts | Shared with Desktop | `artifacts`, `chat` | Show artifact cards, loaded-thread history, sanitized metadata, explicit view/download actions, and selected-thread previews. | Cloud Web fetches artifact bodies only after explicit user action and strips object-store internals from metadata. |
| Workflows | Shared with Desktop | `workflows`, `chat` | Create, list, run, pause, resume, archive, and inspect Cloud workflow definitions and run threads. | Cloud Web runs saved workflows through Cloud workflow APIs; local launch-at-login and native notifications remain Desktop settings. |
| Cloud Project Sources | Cloud-only | `threads` | Create Cloud threads from allowed git repositories or explicit browser-uploaded snapshots. | Cloud policy validates git and snapshot sources before execution. |
| Local Filesystem | Unavailable in Cloud | `threads`, `artifacts` | Use git URLs, managed Cloud project sources, uploaded snapshots, and Cloud artifacts instead. | Browser sessions must not implicitly read or upload host paths from the user machine. |
| Local Stdio MCPs | Unavailable in Cloud | `capabilities`, `agents` | Show only policy-safe MCP metadata that has been converted into the Cloud profile. | Cloud Web cannot spawn local stdio MCP processes or expose command lines, environment variables, or secret refs. |
| Machine Runtime Config | Desktop-only | `chat`, `agents`, `capabilities` | Show current Cloud profile, feature flags, and projected runtime state. | Cloud Web does not configure the local machine runtime, provider defaults, local approvals mode, or desktop notification settings. |

## Admin/Settings Surface Matrix

The typed source of truth is
`apps/website/src/admin-surface-matrix.ts`. Cloud Web admin route summaries,
browser bootstrap metadata, rendered admin surface cards, and locked-control
copy consume this matrix. This document mirrors the same rows, and render tests
assert every documented row against the typed source.

| Surface | Route | Desktop analog | Cloud Web affordance | Sensitive boundary |
|---|---|---|---|---|
| Workspace Profile | `org` | Desktop account, workspace, and profile status surfaces | Show signed-in org identity, role, profile, and public sign-in state. | Bootstrap and signed-out state expose only public branding, route metadata, endpoint metadata, and feature flags. |
| Members | `members` | Desktop account/settings identity context | Manage org member roles, invites, activation, suspension, and invite-mode state. | Member rows expose identity, role, and status only; authorization remains server-side. |
| Profiles & Policy | `policy` | Desktop runtime settings, capability policy, and Health Center | Show Cloud profile features, project-source policy, runtime guardrails, gateway policy, and worker health. | Cloud Web reports policy and health summaries without configuring local runtime, host paths, or stdio MCP processes. |
| BYOK | `byok` | Desktop provider credential setup | Add, rotate, validate, and disable provider credentials through write-only Cloud APIs. | Provider keys are never rendered after submission; the browser receives metadata such as provider id, status, last4, and validation timestamps. |
| Connections | `connections` | Desktop Cloud connection and Gateway pairing surfaces | Issue scoped Desktop, Gateway, and admin API tokens with one-time plaintext reveal. | Token plaintext is shown once after creation and is not stored in persistent browser state. |
| Billing | `billing` | Desktop entitlement and setup status surfaces | Show managed billing mode, plan state, checkout/portal actions, and resolved entitlements. | Billing renders plan and entitlement metadata only; provider integration stays behind the Cloud API. |
| Headless Gateway | `gateway` | Desktop Gateway connection and workflow delivery status | Configure headless agents, channel bindings, setup guidance, and delivery backlog controls. | Channel credential refs, delivery targets, payloads, and errors are browser-sanitized before rendering. |
| Audit | `audit` | Desktop diagnostics and sensitive-action history context | Browse and export redacted administrative events for sensitive Cloud actions. | Audit metadata must be server-redacted and is sanitized again before display or export. |
| Usage | `usage` | Desktop chat cost, token, and runtime status summaries | Show quota windows, recent metering totals, and bounded usage event samples. | Usage events include metering dimensions only, never prompts, provider keys, or tokens. |
| Diagnostics | `diagnostics` | Desktop Health Center and support bundle surfaces | Prepare redacted health summaries and support bundles for Cloud runtime, BYOK, gateway, and object-store state. | Diagnostics are recursively redacted and array-capped before rendering or download. |

## End-User Workbench Contract

Cloud Web must keep parity with Desktop Cloud for cloud workspaces:

- start and continue Cloud threads
- hydrate from the full Cloud `SessionView` projection
- render messages, task runs, tool calls, approvals, questions, todos,
  artifacts, cost, status, and errors
- send prompts through durable Cloud commands
- answer approvals and questions through Cloud APIs
- reconnect SSE from durable projection cursors
- browse artifact metadata and fetch bodies only on explicit action
- run workflows through the Cloud workflow API
- show custom agent, skill, and MCP metadata with policy verdicts

The browser must not create a second projection model. It consumes Cloud
snapshots and events through the shared API contract.

`/api/sessions` cursors are opaque, scoped to the authenticated tenant, user,
and active filters, and invalid or mismatched cursors fail closed with `400`.
Workspace SSE refreshes rehydrate the same number of loaded pages rather than
collapsing a large thread list back to page one.

## Admin Contract

Admin and operator surfaces must avoid direct database or shell access for
normal operations:

- members, invite mode, roles, and status
- profile, capability, project-source, runtime, and gateway policy summaries
- BYOK provider status and write-only key rotation
- API tokens for Desktop and Gateway clients
- billing and entitlement status
- quota windows, usage totals, and usage event samples
- org-scoped managed worker pools and worker health summaries
- headless agents, channel bindings, and delivery backlog
- redacted audit logs and diagnostics

Sensitive mutations must be role-checked by the Cloud API and auditable. Browser
disabled controls are only ergonomic hints; authorization remains server-side.

## Browser Quality Gates

Cloud Web changes should run:

```bash
pnpm test:cloud-web
```

For release-sensitive changes also run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:cloud-continuation
pnpm docs:build
git diff --check
```

The Cloud Web gates cover JSDOM workflow smoke, CI Chromium desktop/mobile
smoke, accessibility/keyboard behavior, responsive layout expectations,
performance budgets for large thread and admin lists, route/API matrix coverage,
backend cursor validation, and package-boundary checks that keep the browser out
of server-only modules.
