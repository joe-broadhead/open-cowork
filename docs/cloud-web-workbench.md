# Cloud Web Studio

Cloud Web is the browser Studio for cloud workspaces. It is a Cloud API
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
| `threads` | Studio | Member | `sessions`, `sessionView`, `projectSourceValidate`, `projectSnapshots` | Browser list is bounded by `CLOUD_WEB_THREAD_PAGE_SIZE`. The browser consumes `/api/sessions` cursor pages with Load more, preserves loaded pages across workspace SSE refreshes, and only displays total estimates returned by the backend. Objectives are selected-chat scoped until a Cloud objective index exists. | Chat controls disable when policy blocks chat. Local host paths and local MCP process details are never sent as chat context. |
| `chat` | Studio | Public | `sessionView`, `sessionEvents`, `sessionPrompt`, `sessionPermissionRespond`, `sessionQuestionReply`, `sessionQuestionReject` | Session SSE resumes from the durable Cloud projection sequence. | Chat Home is the default public route while auth resolves. Signed-out composer controls stay disabled; signed-in prompts create chat-only Cloud sessions on first send. Runtime state is rendered from Cloud projections, not a browser-only projection model. |
| `agents` | Studio | Member | `workspace`, `capabilitiesCatalog` | Capability filtering is local and performance-tested. | Coworker metadata is cloud profile metadata only; local stdio MCP commands and secrets are not rendered. |
| `capabilities` | Studio | Member | `capabilitiesCatalog`, `capabilityTools`, `capabilitySkills` | Local capability filtering is bounded; API cursoring is deferred. | Machine-scoped MCPs are visible only as policy-limited metadata. |
| `workflows` | Studio | Member | `workflows`, `workflow`, `workflowRun`, `workflowPause`, `workflowResume`, `workflowArchive` | Playbook summary rendering is bounded to 100 playbooks and 50 recent runs in the browser; run-history cursoring is deferred. | Playbook controls disable when profile policy blocks workflows. Rows never expose worker credentials or local paths. |
| `channels` | Studio | Member | `channelAgents`, `channelBindings`, `channelDeliveries` | Channel coworkers and bindings request `limit=100`; delivery status requests and renders the first 50 rows with member-facing bounded-list copy. Delivery stream cursoring stays with Gateway/admin flows. | User route is read-only and focused on reach, delivery status, and linked chats. Credential refs, payload secrets, signed URLs, tokens, and provider internals are stripped before rendering. |
| `artifacts` | Studio | Member | `sessionArtifacts`, `sessionArtifact` | Selected-session artifact metadata rendering is bounded to 100 artifacts. Selected-chat history is explicit; cross-session artifact browsing is deferred. | Artifact bodies fetch only after explicit action. Signed URLs, object keys, buckets, tokens, and object-store internals are stripped from metadata. |
| `org` | Admin | Public | `authMe`, `config`, `workspace` | Not applicable. | Org is an explicit public org/profile surface, not the signed-out fallback. Bootstrap JSON carries public branding, route metadata, endpoint metadata, and feature metadata only. |
| `members` | Admin | Admin | `adminMembers`, `adminMemberInvite`, `adminMemberUpdate` | Members endpoint supports `q` and `limit`; the browser requests `limit=100` and renders at most 100 rows. | Member rows expose identity, role, and status only. Invite and role controls disable for non-admins and non-invite signup modes. |
| `policy` | Admin | Member | `adminPolicy`, `adminWorkerPools`, `adminWorkers`, `adminWorkerHeartbeats` | Worker pools and workers load first pages with `limit=100`; heartbeat detail is worker-scoped. | Policy and worker health summaries are read-only in v1 and exclude credentials, heartbeat tokens, and worker secrets. |
| `byok` | Admin | Admin | `byok`, `byokSave`, `byokValidate`, `byokDisable` | Not applicable. | Provider keys are write-only. The browser only renders provider id, credential kind, last4/fingerprint/status, and validation timestamps. |
| `connections` | Admin | Admin | `apiTokens`, `apiTokenCreate`, `apiTokenRevoke` | API token list requests `limit=100` and the browser renders at most 100 rows; cursoring is deferred. | Token plaintext is shown once after creation and never stored in persistent browser storage. |
| `billing` | Admin | Admin | `billingSubscription`, `billingCheckout`, `billingPortal` | Not applicable. | Billing renders entitlement state and plan metadata only. Self-host mode disables managed billing controls. |
| `gateway` | Admin | Admin | `channelAgents`, `channelAgentCreate`, `channelBindings`, `channelBindingCreate`, `channelDeliveries`, `channelDeliveryRetry`, `channelDeliveryDeadLetter` | Headless agents and bindings request `limit=100`; delivery backlog requests and renders the first 50 rows. Provider streams are handled by Gateway, not the browser. | Channel credential refs are metadata only. Delivery payloads are browser-sanitized before details render. Retry and dead-letter actions require admin controls and confirmation. |
| `audit` | Admin | Admin | `adminAudit` | Audit endpoint loads the first 100 events. Cursor export is deferred. | Audit metadata must be server-redacted and is browser-sanitized again before display or export. |
| `usage` | Admin | Member | `usageEvents`, `usageSummary` | Usage events load `limit=20`; summaries load `limit=100`. | Usage events include metering dimensions only, not prompts, provider keys, or tokens. |
| `diagnostics` | Admin | Admin | `diagnostics`, `runtimeStatus`, `workerHeartbeats` | Diagnostics includes bounded worker heartbeat and gateway delivery samples. Browser diagnostics arrays are recursively capped before rendering. | Diagnostics are redacted recursively. Cloud Web hides controls from non-admin users, and the API may still require operator-token privileges for global operational state. |

## Desktop/Cloud Studio Parity Matrix

The typed source of truth is
`apps/website/src/workbench-parity.ts`. Cloud Web route labels, summaries,
browser bootstrap metadata, and rendered parity cards consume this matrix.
This document mirrors the same rows, and render tests assert every documented
row against the typed source so the product boundary cannot drift silently. The
purpose is to make shared Desktop concepts feel like the same product while
keeping Cloud Web honest about cloud-only and desktop-only boundaries.

| Concept | Availability | Cloud route(s) | Cloud Web affordance | Product boundary |
|---|---|---|---|---|
| Projects and Chat History | Shared with Desktop | `threads` | Browse recent chats, filters, tags, and project-backed Cloud work without exposing local paths. | Cloud Web reads Cloud session records and projections through the Cloud API; Desktop may also show local sessions. |
| Chat | Shared with Desktop | `chat` | Open a chat-first Studio home, create a chat-only Cloud session on first send, and submit prompts through durable Cloud commands. | Cloud Web never builds a browser-only projection model or invokes local OpenCode runtime commands. |
| Runtime Status | Shared with Desktop | `chat` | Show status, streaming state, cost, token usage, context, compactions, tool calls, task runs, todos, and errors from Cloud projections. | Cloud Web reports projected Cloud runtime state only; machine health and local model controls remain Desktop-owned. |
| Approvals & Questions | Shared with Desktop | `chat` | Render pending and resolved approvals/questions and answer them through Cloud API endpoints. | Approval and question semantics remain OpenCode-owned; Cloud Web only submits tenant-scoped responses. |
| Coworkers | Shared with Desktop | `agents` | Show profile-allowed coworkers, built-in/custom metadata, and a Start chat action. | Cloud Web displays policy-safe coworker metadata and cannot edit local custom agent files. |
| Tools & Skills | Shared with Desktop | `capabilities` | Show allowed tools, skills, MCP metadata, linked coworkers, and policy verdicts. | Cloud Web renders cloud-safe capability metadata; runtime execution remains owned by OpenCode workers. |
| Objectives | Shared with Desktop | `threads` | Show the selected Cloud chat objective, project source, and follow-up todos from durable projection state. | Cloud Web projects objective context from Cloud sessions; it does not invent a cross-project objective model in the browser. |
| Artifacts | Shared with Desktop | `artifacts`, `chat` | Show artifact cards, selected-chat history, sanitized metadata, explicit view/download actions, and selected-chat previews. | Cloud Web fetches artifact bodies only after explicit user action and strips object-store internals from metadata. |
| Playbooks | Shared with Desktop | `workflows`, `chat` | Create, list, run, pause, resume, archive, and inspect Cloud playbook definitions and run chats. | Cloud Web runs saved playbooks through Cloud workflow APIs; local launch-at-login and native notifications remain Desktop settings. |
| Channels | Shared with Desktop | `channels`, `chat` | Show connected channel agents, channel bindings, delivery status, and linked Cloud run chats without exposing admin controls. | Cloud Web reads channel state through tenant-scoped Cloud APIs; Gateway delivery, provider adapters, and OpenCode execution remain service-owned. |
| Cloud Project Sources | Cloud-only | `threads` | Start project-backed Cloud chats from allowed git repositories or explicit browser-uploaded snapshots. | Cloud policy validates git and snapshot sources before execution. |
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
| Headless Gateway | `gateway` | Desktop Gateway connection and workflow delivery status | Configure headless agents, channel bindings, setup guidance, and delivery backlog controls. | Channel credential refs, delivery targets, payloads, provider internals, and errors are browser-sanitized before rendering. |
| Audit | `audit` | Desktop diagnostics and sensitive-action history context | Browse and export redacted administrative events for sensitive Cloud actions. | Audit metadata must be server-redacted and is sanitized again before display or export. |
| Usage | `usage` | Desktop chat cost, token, and runtime status summaries | Show quota windows, recent metering totals, and bounded usage event samples. | Usage events include metering dimensions only, never prompts, provider keys, or tokens. |
| Diagnostics | `diagnostics` | Desktop Health Center and support bundle surfaces | Prepare redacted health summaries and support bundles for Cloud runtime, BYOK, gateway, and object-store state. | Diagnostics are recursively redacted and array-capped before rendering or download. |

## End-User Studio Contract

Cloud Web must keep parity with Desktop Cloud for cloud workspaces:

- start and continue Cloud chats
- hydrate from the full Cloud `SessionView` projection
- render messages, task runs, tool calls, approvals, questions, todos,
  artifacts, cost, status, and errors
- send prompts through durable Cloud commands
- answer approvals and questions through Cloud APIs
- reconnect SSE from durable projection cursors
- browse artifact metadata and fetch bodies only on explicit action
- run playbooks through the Cloud workflow API
- review connected channel coworkers, bindings, and delivery status without
  exposing admin controls or delivery payloads
- show custom coworker, skill, and MCP metadata with policy verdicts

The browser must not create a second projection model. It consumes Cloud
snapshots and events through the shared API contract.

## Shared IA Contract

Cloud Web and Desktop share the same Studio IA vocabulary. The implementation
still uses stable `data-workbench-*` hooks for tests and hydration:

- `data-workbench-pane="threads"` marks the thread list/sidebar.
- `data-workbench-pane="conversation"` marks the active chat surface.
- `data-workbench-pane="review"` marks the contextual review pane.
- `data-action-cluster="true"` marks the consolidated chat/action toolbar.
- `data-diff-view="true"` marks review-first artifact and diff surfaces.

Desktop uses `WorkbenchLayout`, `ActionCluster`, and `DiffView` directly in
the renderer. Cloud Web uses the same `@open-cowork/ui` primitives in the
hydrated React client and preserves matching SSR hooks before hydration. The
Cloud review pane presents runtime status and sanitized artifacts; artifact
metadata remains review-first and fetches bodies only after explicit view or
download actions. Desktop-only actions, such as local runtime or git-native
controls, stay absent or disabled in Cloud per the parity matrix.

## React Migration Scaffold

Cloud Web renders the visible shell inside `#open-cowork-cloud-react-root`
through a React SSR wrapper, then mounts a Vite-built React controller at
`/assets/open-cowork-cloud-react.js`. The controller owns auth bootstrap,
routing, Studio surfaces, admin/settings surfaces, and theme switching while
portaling into stable SSR shell slots. The bootstrap contract stays unchanged:
`#open-cowork-cloud-bootstrap` carries route, endpoint, parity, admin-surface,
branding, role, and feature metadata, and the HTTP server keeps the same CSP
nonce boundary.

There are no remaining vanilla feature scripts under `apps/website/src/client`.
Projects, chat, coworkers, capabilities, playbooks, channels, artifacts,
admin/settings surfaces, and the browser theme switcher are React-owned in the
browser bundle.
New feature work must use the shared `AppAPI` contract from
`packages/shared/src/app-api.ts`, `AppApiProvider` / `useAppApi()` from
`@open-cowork/ui/app-api`, and the Cloud fetch/SSE adapter in
`apps/website/src/app-api.ts`. The Cloud adapter may only request `/api/*` or
`/auth/*` paths and may only open `/api/*` event streams. Desktop uses
`apps/desktop/src/renderer/app-api.ts` as the IPC-backed adapter.

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

## Visual QA Checklist

For visual or surface-organization changes, compare Cloud Web and Desktop
side-by-side before merge. The expected match is product language and workflow
parity, not pixel-perfect screenshots.

The typed source of truth for release visual QA is
`apps/website/src/studio-production-qa.ts`. The matrix below must cover every
Cloud Web route at desktop, tablet, and mobile widths. Tests assert every row so
the checklist cannot drift from the source contract.

## Studio Production Visual QA Matrix

| Surface | Cloud route(s) | Desktop surface | Cloud Web check | Required states | Product boundary |
|---|---|---|---|---|---|
| Home, Chat, and composer | `chat` | Home and Chat composer-first runtime surface | Default route opens to chat, shows coworker selection, disables signed-out send controls, and submits prompts through Cloud commands after auth. | `loading`, `empty`, `error`, `disabled`, `permission-gated`, `offline-disconnected`, `retry` | Cloud Web consumes Cloud session projections and commands only; OpenCode owns session execution and event semantics. |
| Projects and thread history | `threads` | Projects with recent chats, project context, filters, and reopen actions | Thread list, filters, selected objective, project-source status, bounded loading, and Load more behavior match the Desktop Studio vocabulary. | `loading`, `empty`, `error`, `disabled`, `permission-gated`, `offline-disconnected`, `retry` | Browser project sources stay cloud-safe; local host paths are never inferred, uploaded, or rendered as available Cloud context. |
| Runtime review, approvals, and questions | `chat`, `artifacts` | Chat transcript, task lanes, approvals, questions, todos, runtime status, cost, tokens, and review panel | Messages, delegated specialist lanes, running/completed/error task states, approval/question cards, deliverables, todos, artifacts, cost, token usage, and follow-up actions are visible from Cloud projections. | `loading`, `empty`, `error`, `disabled`, `permission-gated`, `offline-disconnected`, `retry`, `destructive-confirmation` | Approval and question semantics remain OpenCode-owned; Cloud Web only submits tenant-scoped responses through Cloud API endpoints. |
| Coworkers, tools, and skills | `agents`, `capabilities` | Team and Tools & Skills capability catalog | Coworker cards, picker states, linked skills, linked tools, MCP policy verdicts, and Start chat actions use the shared Studio primitive language. | `loading`, `empty`, `error`, `disabled`, `permission-gated`, `retry` | Cloud Web renders policy-safe metadata only and cannot edit local custom agent files or spawn local stdio MCPs. |
| Playbooks and runs | `workflows` | Playbooks list, saved workflow setup chats, run controls, and run history | Playbook cards, run rows, pause/resume/archive actions, empty states, and blocked policy copy behave like Desktop workflows while staying browser-bounded. | `loading`, `empty`, `error`, `disabled`, `permission-gated`, `offline-disconnected`, `retry`, `destructive-confirmation` | Cloud Web runs saved playbooks through Cloud workflow APIs; OpenCode-native agents still execute the work. |
| Channels and artifacts | `channels`, `artifacts`, `chat` | Channel status, linked run chats, artifact cards, and review-first artifact previews | Connected channel coworkers, bindings, delivery status, sanitized artifact metadata, explicit view/download actions, and selected-chat previews stay reachable without admin controls. | `loading`, `empty`, `error`, `disabled`, `permission-gated`, `offline-disconnected`, `retry` | Provider payloads, signed URLs, object-store internals, channel secrets, and delivery targets are stripped before rendering. |
| Team and member admin boundary | `org`, `members`, `policy`, `usage` | Desktop account, Team context, Settings policy, Health Center, and usage summaries | Org profile, member rows, invite/role controls, policy summaries, usage quotas, and worker health are visually grouped under Admin without dominating the default Studio path. | `loading`, `empty`, `error`, `disabled`, `permission-gated`, `retry`, `destructive-confirmation` | Browser disabled controls are ergonomic only; Cloud API authorization remains server-side and tenant-scoped. |
| Secrets, Gateway, audit, and diagnostics | `byok`, `connections`, `billing`, `gateway`, `audit`, `diagnostics` | Desktop Cloud connection setup, Gateway pairing, provider credentials, billing, audit, and Health Center support bundle surfaces | BYOK write-only rotation, one-time token reveal, gateway delivery controls, billing portal actions, audit export, diagnostics redaction, confirmations, and settled disabled states are visible and keyboard-reachable. | `loading`, `empty`, `error`, `disabled`, `permission-gated`, `offline-disconnected`, `retry`, `destructive-confirmation`, `one-time-reveal` | Raw secrets, provider keys, auth headers, signed URLs, object-store internals, local paths, command lines, and environment variables must not render outside intentional safe reveal flows. |

- App shell, sidebar, topbar, active route, status text, and density use the
  same dark product language.
- Cards, panels, tables, rows, badges, notices, empty states, focus rings, and
  destructive/primary/secondary controls read like Desktop primitives.
- Projects, chat, runtime status, approvals, questions, coworkers, tools,
  skills, playbooks, channels, and artifacts map to the Desktop/Cloud parity
  matrix.
- Org, members, policy, BYOK, connections, gateway, billing, audit, usage, and
  diagnostics map to the admin/settings surface matrix.
- `/assets/open-cowork-cloud-react.js` mounts the React controller for
  `#open-cowork-cloud-react-root` and the root reports an explicit hydrated
  status in browser smoke tests.
- Loading, empty, error, disabled, confirmation, and one-time reveal states stay
  visible and consistent without exposing secrets.
- Desktop-only boundaries remain explicit: no local host paths, local stdio MCP
  process controls, machine runtime config, or browser-owned OpenCode runtime.
- Responsive desktop and mobile views have no horizontal overflow, clipped
  controls, or unreachable keyboard focus targets.
- `/assets/fonts/*.woff2` requests return `200 font/woff2` and computed fonts
  resolve to Mona Sans / Hubot Sans in the real-browser smoke.
- `/assets/open-cowork-cloud-react.js` returns the Vite-built React client
  asset, and the real-browser smoke verifies that the nonce'd module route is
  requested and can mount the controller for `#open-cowork-cloud-react-root`.

## Production Audit Checklist

The typed source of truth is `apps/website/src/studio-production-qa.ts`. This
checklist is the closeout audit for Studio parity work before the roadmap can
be considered complete.

| Check id | Requirement | Evidence |
|---|---|---|
| `canonical-shared-tokens` | Shared design tokens are the only canonical Studio token source for Desktop and Cloud Web. | `packages/shared/src/design-tokens.ts`, `tests/design-tokens-sync.test.ts`, `docs/design-tokens.md` |
| `shared-primitives-first` | Shared Studio primitives are preferred before app-local component duplication. | `packages/ui/src/`, `docs/design-system.md`, `apps/website/src/modularity.test.ts` |
| `shared-product-vocabulary` | Desktop and Cloud Web use the same user-facing vocabulary for shared concepts. | `docs/desktop-app.md`, `docs/cloud-web-workbench.md`, `apps/website/src/workbench-parity.ts` |
| `cloud-api-client-only` | Cloud Web remains a Cloud API client and does not own execution, projection semantics, or OpenCode runtime behavior. | `apps/website/src/app-api.ts`, `apps/website/src/modularity.test.ts`, `docs/architecture.md` |
| `admin-not-default-path` | Admin/setup controls are explicit secondary surfaces and do not dominate the default user path. | `apps/website/src/app-shell.ts`, `apps/website/src/admin-surface-matrix.ts`, `docs/cloud-web-workbench.md` |
| `safe-redaction` | No raw secrets, signed URLs, object-store internals, local paths, command lines, environment variables, or provider payloads render outside intentional safe reveal flows. | `apps/website/src/route-api-matrix.ts`, `apps/website/src/render.test.ts`, `tests/cloud-http-server.test.ts` |
| `honest-performance-budgets` | Performance budgets stay honest for added routes, surfaces, large fixtures, and responsive layouts. | `apps/website/src/performance.test.ts`, `apps/website/src/modularity.test.ts`, `docs/cloud-web-workbench.md` |
| `docs-match-shipped-behavior` | Docs describe shipped behavior and explicit boundaries, not aspirational runtime behavior. | `docs/cloud-web-workbench.md`, `docs/release-checklist.md`, `apps/website/src/studio-production-qa.test.ts` |

## OpenWiki/Knowledge Deferral

Knowledge/OpenWiki is intentionally deferred and ships with no Cloud Web route,
no visible CTA, no runtime dependency, and no data-sync claim in this roadmap.
Do not add a placeholder that implies wiki content is synced, indexed, or
available to OpenCode. Do not couple Cloud Web, Desktop, Gateway, or the Cloud
API to a local OpenWiki checkout while this contract is in force.

Create a separate future roadmap before adding a Knowledge route, CTA, sync
contract, local OpenWiki checkout dependency, or runtime integration.
