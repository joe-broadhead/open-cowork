# Product Contract

Open Cowork has three user-facing surfaces over one OpenCode-backed product
model:

- Desktop
- Cloud Web
- Gateway

The contract is workspace-scoped product sync. It is not peer-to-peer desktop
sync and it is not OpenCode runtime-home replication. OpenCode owns execution.
Open Cowork owns composition, workspace routing, projection, policy, artifacts,
workflows, Gateway adapters, and deployer ergonomics.

## Workspace Ownership

A thread belongs to exactly one workspace.

| Workspace | Execution authority | Source of truth | Sync behavior |
|---|---|---|---|
| Desktop Local | Desktop main process and local OpenCode runtime | Local app data, local registry, local settings, local runtime state | Private to that device. Never syncs implicitly. |
| Desktop Cloud | Cloud worker and OpenCode runtime owned by Cloud | Tenant-scoped Cloud control plane | Syncs with Cloud Web and Gateway through Cloud sessions, events, projections, artifacts, workflows, settings metadata, and policy. |
| Cloud Web | Cloud worker and OpenCode runtime owned by Cloud | Tenant-scoped Cloud control plane | Same Cloud workspace as Desktop Cloud and Gateway. |
| Gateway Channel | Cloud worker and OpenCode runtime owned by Cloud | Tenant-scoped Cloud control plane plus channel binding/delivery records | Cloud-only headless access to bound Cloud sessions. |

Local Desktop threads, host paths, local stdio MCPs, machine-native runtime
config, local provider credentials, OAuth tokens, and local-only artifacts stay
local unless a user explicitly starts a cloud-safe import or upload flow.

## Product Surfaces

### Desktop Local

Desktop Local is the current private desktop behavior:

- local OpenCode runtime ownership
- local project directories and sandbox workspaces
- local stdio MCPs allowed by local policy
- local settings and encrypted credentials
- local session registry and local thread index
- local artifacts and explicit local filesystem reveal/export actions

Cloud configuration is not required for Desktop Local. Cloud failures must not
block local chat, agents, tools, skills, workflows, or thread history.

### Desktop Cloud

Desktop Cloud uses the Desktop renderer with a Cloud workspace selected. The
Desktop main process owns auth tokens, routing, cache, and security policy.
Cloud workers own OpenCode execution.

Desktop Cloud can:

- list, create, activate, prompt, abort, and hydrate Cloud sessions
- consume Cloud projections and SSE events
- answer Cloud approvals and questions
- show Cloud artifacts and download/export through Cloud APIs
- use Cloud workflows, tags, filters, capabilities, settings metadata, and
  custom content when policy allows it
- render cached Cloud state while offline

Desktop Cloud must not:

- open a local project picker as implicit context for a Cloud thread
- send local host paths to Cloud APIs
- expose local stdio MCP process commands to Cloud
- use machine-native OpenCode config
- upload local files, local artifacts, local credentials, or MCP secrets without
  an explicit cloud-safe import/upload action

### Cloud Web

Cloud Web is a browser client for the same Cloud control plane. It does not
import server-only stores, secret adapters, runtime adapters, or the OpenCode
SDK.

Cloud Web can:

- start and continue Cloud threads
- render the full Cloud projection contract
- send prompts through durable Cloud commands
- answer approvals and questions through Cloud command routes
- browse artifacts and fetch artifact bodies only on explicit user action
- run Cloud workflows when policy allows
- show profile, capability, settings, BYOK status, billing, usage, Gateway,
  member, audit, and diagnostic surfaces according to role

Browser disabled controls are ergonomic hints only. Cloud APIs remain the
authorization boundary.

### Gateway Channel

Gateway is a headless Cloud client/channel adapter. It can run on a VPS, Mac
mini, Raspberry Pi, internal server, Kubernetes, or managed infrastructure.

Gateway owns:

- channel I/O
- provider-specific signing/webhook or polling behavior
- chat-side identity resolution
- channel-specific rendering
- approval/question interaction UX
- delivery retry and diagnostics

Cloud owns:

- tenants, users, memberships, profiles, and policy
- sessions, commands, events, projections, workflows, and artifacts
- worker leases and OpenCode execution
- channel binding/delivery records
- approval and question authority

Gateway can only participate in synced work through Cloud workspaces. Gateway
must not import `@opencode-ai/sdk`, spawn OpenCode, or own control-plane
Postgres state.

## Active Workspace And Routing

`workspaceId` scopes every workspace-owned API. When omitted, clients use the
active workspace for that surface.

Desktop starts with the Local workspace active on fresh installs. Selecting a
Cloud workspace changes the visible sessions, settings, custom content,
artifacts, workflow state, and policy scope. Switching back to Local restores
local behavior without Cloud dependency.

Workspace switching must not merge or leak:

- sessions or projections
- thread tags and smart filters
- workflow definitions or runs
- artifacts
- settings metadata
- custom agents, skills, or MCP metadata
- cached Cloud cursors
- errors or status banners

## Cloud Offline And Degraded Behavior

Cloud cache is a read-only fallback in v1.

When a Cloud workspace is offline or degraded, clients may render cached
metadata and projections, but must block Cloud mutations such as prompts,
workflow runs, custom content writes, artifact uploads, and settings changes.
Local Desktop remains fully usable.

Cloud cache may store:

- Cloud event cursors
- session projections and session lists
- thread metadata, tags, and filters
- workflow lists and run summaries
- settings/custom-content/artifact metadata

Cloud cache must not store:

- raw provider keys
- OAuth access or refresh tokens
- API tokens
- MCP secrets
- channel secrets
- local file contents outside an explicit upload/cache contract
- signed object-store URLs or raw object-store keys as long-lived state

## Artifacts

Artifact ownership follows the workspace:

| Artifact source | Visible in | Body access | Reveal/export |
|---|---|---|---|
| Local Desktop artifact | Desktop Local | Local app data or local sandbox | Local-only reveal/export. No implicit Cloud upload. |
| Cloud artifact | Desktop Cloud, Cloud Web, Gateway when channel supports files | Cloud artifact API/object store | Download/export through Cloud policy. No raw object keys in clients. |
| Imported artifact | Target Cloud workspace after explicit import | Cloud artifact API/object store | Same as Cloud artifact after validation. |

Cloud artifact metadata may sync. Artifact bodies are fetched only after an
explicit user or channel action.

## Workflows

Workflows are an Open Cowork control-plane layer around OpenCode-native
execution.

| Workspace | Workflow owner | Execution path |
|---|---|---|
| Desktop Local | Local workflow store | Desktop creates a run thread and prompts local OpenCode. |
| Cloud | Cloud control plane | Cloud scheduler/API creates a run command and a Cloud worker prompts OpenCode. |
| Gateway | Cloud control plane | Gateway requests or receives Cloud workflow activity through Cloud APIs and delivery records. |

Workflow state must be durable and transactional in its owning workspace. It
must not be reconstructed from transient renderer state.

## Settings And Custom Content

Only portable Cloud workspace metadata syncs:

- appearance and composer preferences where supported
- selected Cloud profile and non-secret defaults
- custom agent/skill/MCP metadata that is Cloud-safe
- capability catalog and policy verdicts
- provider credential status such as missing, configured, expired, or
  admin-managed

Raw credentials never sync. Local stdio MCPs, host paths, local shell bridges,
machine-native config, and local project-source assumptions are blocked in
Cloud unless a deployer maps them to a Cloud-safe remote MCP, package, endpoint,
or explicit uploaded snapshot.

Policy-blocked custom content should remain visible when useful, with explicit
disabled reasons. It should not silently disappear when the user needs to
understand why a Cloud workspace cannot run it.

## Local-To-Cloud Copy And Import

Local-to-Cloud movement is always explicit.

A valid import flow must:

- require a user action such as Copy to Cloud
- preview included messages, attachments, artifacts, project-source data, and
  excluded items
- exclude local host paths and project roots by default
- validate payloads before Cloud submission
- reject local paths, secret-like values, raw tokens, and local MCP process
  details
- create a new Cloud thread or artifact records in the target Cloud workspace

Import does not change the original Local thread's ownership.

## Shared Status Vocabulary

Workspace capability support uses the shared status vocabulary from
`packages/shared/src/workspace.ts`.

Shared surface identifiers:

| Surface id | Surface |
|---|---|
| `desktop_local` | Desktop Local |
| `desktop_cloud` | Desktop Cloud |
| `cloud_web` | Cloud Web |
| `gateway_channel` | Gateway Channel |
| `admin_operator` | Admin/Operator |

| Status | Meaning |
|---|---|
| `supported` | The action is available in this workspace and current state. |
| `read_only` | The surface may render state but cannot mutate it now. |
| `blocked_by_policy` | The action is implemented but disallowed by profile, role, quota, billing, or deployer policy. |
| `not_supported` | The action is intentionally unavailable for this workspace or surface. |
| `deferred` | The product contract reserves the capability, but it is not implemented yet. |

Stable contract reason codes:

| Reason code | Use |
|---|---|
| `workspace.auth_required` | User must authenticate before the Cloud action can run. |
| `workspace.offline_read_only` | Cloud state is cached/read-only because live Cloud access is unavailable. |
| `workspace.local_only` | Action is valid only in Desktop Local. |
| `workspace.cloud_only` | Action is valid only in a Cloud workspace. |
| `workspace.policy_disabled` | Profile, role, or deployer policy disabled the action. |
| `workspace.quota_denied` | Quota prevented the action. |
| `workspace.capacity_denied` | Worker or system capacity prevented the action. |
| `workspace.billing_denied` | Billing or entitlement state prevented the action. |
| `workspace.not_supported` | The action is outside the surface contract. |
| `workspace.deferred` | The action is planned but not available. |

Domain-specific policy codes may be more precise, such as
`quota.prompts_per_hour_exceeded`, `billing.subscription_inactive`, or
`project_source.git.host_denied`. They should still map cleanly to one of the
contract reason categories for UI and channel copy.

## Surface Support Matrix

| Capability | Desktop Local | Desktop Cloud | Cloud Web | Gateway Channel | Admin/Operator |
|---|---|---|---|---|---|
| Direct chat prompt | `supported` | `supported` when online/authenticated | `supported` when online/authenticated | `supported` through bound Cloud session | `not_supported` |
| Session list and hydrate | `supported` | `supported`; `read_only` from cache offline | `supported` | `supported` only for bound channel sessions | `supported` for scoped admin views |
| Local project picker | `supported` | `not_supported` | `not_supported` | `not_supported` | `not_supported` |
| Cloud Git source | `not_supported` | `supported` by policy | `supported` by policy | `supported` through binding/default project source | `supported` for policy setup |
| Uploaded snapshot | `not_supported` unless importing | `supported` by explicit upload | `supported` by explicit upload | `deferred` except provider file upload flows | `supported` for policy setup |
| Local stdio MCP | `supported` by local policy | `not_supported` | `not_supported` | `not_supported` | `blocked_by_policy` unless mapped to Cloud-safe alternative |
| Remote MCP metadata | `supported` by local config | `supported` by Cloud policy | `supported` by Cloud policy | `supported` through Cloud session policy | `supported` for policy setup |
| Machine runtime config | `supported` only as explicit desktop escape hatch | `not_supported` | `not_supported` | `not_supported` | `not_supported` |
| Artifact metadata | `supported` | `supported`; cached read-only offline | `supported` | `supported` where channel can render/link | `supported` for summaries |
| Artifact body download | `supported` | `supported` by Cloud policy | `supported` by Cloud policy | `supported` as file or link by channel capability | `supported` for support only when authorized |
| Workflow run | `supported` | `supported` by Cloud policy | `supported` by Cloud policy | `supported` through Cloud command/delivery flow | `supported` for operations visibility |
| BYOK key entry | `not_supported` | `not_supported` from Desktop renderer | `supported` for admins only | `not_supported` | `supported` for admins/operators |
| Gateway delivery retry | `not_supported` | `not_supported` | `supported` for admins | `supported` internally by Gateway | `supported` for admins/operators |
| Diagnostics export | `supported` redacted | `supported` redacted | `supported` redacted for admins | `supported` redacted | `supported` redacted/operator-scoped |

## Downstream Configuration Boundaries

Downstream deployers may configure:

- branding and public copy
- default Cloud connections
- auth and IdP metadata references
- feature flags and launch tier
- provider profiles and allowed models/tools/MCPs
- storage/object-store adapters
- secret/KMS adapters
- billing mode and entitlement adapter
- Gateway provider bindings
- worker pool mode and capacity policy
- legal/support/privacy/security links

Downstream deployers must not use config to bypass the workspace contract:

- no implicit local thread upload
- no raw secret sync through config
- no local host path execution in Cloud
- no local stdio MCP execution in Cloud
- no Gateway-owned OpenCode runtime
- no provider-specific branches in core product code

Private managed SaaS values such as real project ids, account ids, domains,
prices, customer data, support rosters, and secrets belong in downstream/private
repos or provider secret managers, not in this public repo.
