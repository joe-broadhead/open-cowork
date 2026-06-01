---
title: Cloud Gateway Registration
description: Contract for connecting Standalone Gateway workspaces and edge execution capacity to Open Cowork Cloud.
---

# Cloud Gateway Registration

Cloud Gateway registration is the optional bridge between a Standalone Team
Gateway and Open Cowork Cloud. It is not required for Gateway-only operation,
and it is not a database merge between Gateway Postgres and Cloud Postgres.

Registration also follows the shared
[Coordination Model](coordination-model.md): Gateway-owned Projects, Tasks,
Runs, Schedules, Watches, Delegations, Artifacts, Questions, and Permissions
remain Gateway-owned unless an explicit import/export or Cloud-owned edge work
claim says otherwise.

The registration model has two independent jobs:

- let Cloud know about an external Gateway workspace without taking ownership
  of Gateway sessions
- optionally let Cloud route eligible Cloud-owned work to trusted Gateway edge
  capacity with managed-worker leases and fencing

## Decision

Cloud registrations use one of three explicit kinds:

| Kind | Meaning | Source of truth | Work claiming |
| --- | --- | --- | --- |
| `external_workspace` | Cloud stores a redacted reference to a Standalone Gateway workspace. | Gateway remains source of truth for Gateway sessions, workflows, artifacts, approvals, questions, and audit. | Not allowed. |
| `edge_worker` | A Gateway deployment registers as Cloud edge execution capacity for eligible Cloud sessions or workflows. | Cloud remains source of truth for Cloud sessions, events, projections, artifacts, checkpoints, leases, usage, and audit. | Allowed only through managed-worker lease/fencing. |
| `external_workspace_edge_worker` | The same Gateway is visible as an external workspace and can also run eligible Cloud work. | Split by work owner. Gateway-owned work stays Gateway-owned; Cloud-owned work stays Cloud-owned. | Allowed only for the Cloud-owned lane. |

Gateway-only remains valid when Cloud is absent. Cloud-connected Gateway is an
explicit registration, not the default Gateway mode.

The typed public contract lives in
`packages/shared/src/cloud-gateway-registration.ts`.

## Trust Model

Supported trust models are:

| Trust model | Status |
| --- | --- |
| `self_hosted_same_operator` | Allowed for `external_workspace`; allowed for edge work when the same organization operates Cloud, Gateway, Postgres, object storage, secrets, and incident response. |
| `saas_operator_managed` | Allowed for `external_workspace`; allowed for edge work when the SaaS operator manages or provisions the Gateway capacity and owns the operational boundary. |
| `customer_hosted_managed_saas_deferred` | Allowed only for `external_workspace` metadata integration. Edge work is deferred until a separate trust, update, networking, data-residency, and liability review exists. |

Customer-hosted Gateway edge workers must not be connected to a separate
managed SaaS Cloud control plane by configuration accident. Public deployment
templates and validators should fail closed until that mode has a dedicated
design.

## Credentials

Registration credentials are scoped, expiring, rotatable, revocable, and
hash-stored after issuance. A Gateway registration credential never inherits
tenant admin, operator, BYOK, billing, or Desktop authority.

Credential scopes:

| Scope | Purpose |
| --- | --- |
| `gateway.registration.heartbeat` | Send liveness, version, mode, health, and current load. |
| `gateway.registration.capabilities` | Advertise provider, runtime, workflow, artifact, and policy capabilities. |
| `gateway.registration.metadata_sync` | Sync allowed redacted external-workspace metadata. |
| `gateway.edge.claim` | Claim eligible Cloud-owned work. |
| `gateway.edge.lease_renew` | Renew active Cloud-owned work leases while OpenCode runs. |
| `gateway.edge.write_fenced_output` | Write Cloud-owned events, projections, artifacts, checkpoints, usage, and status with the active lease token. |

Service tokens authenticate the Gateway process. Channel actor identity,
approval authority, and user membership still resolve separately. A Gateway
token alone must never authorize a human approval, BYOK reveal, org
administration, or operator action.

## External Workspace Mode

`external_workspace` is for visibility and controlled continuation
boundaries. Cloud may store:

- Gateway registration id, display name, URL, status, version, and health
- redacted capability advertisements
- redacted coordination metadata for Projects, Tasks, Runs, Schedules, Watches,
  Delegations, Artifacts, Questions, and Permissions when policy allows it
- redacted session/workflow metadata when policy allows it
- redacted projection snapshots when an explicit sync policy allows it
- artifact metadata, not artifact bodies, unless a separate import/export flow
  copies the artifact into Cloud object storage
- audit summaries and event cursors

Gateway remains authoritative for Gateway sessions. Cloud does not claim,
retry, repair, or finalize Gateway-owned work.

External workspace sync must not include:

- raw Gateway database rows
- OpenCode runtime homes, XDG roots, or cache/state directories
- local host paths
- raw provider keys, BYOK plaintext, OAuth tokens, or API tokens
- MCP secrets or channel secrets
- Gateway private file bodies
- unfenced event writes

## Edge Worker Mode

`edge_worker` lets trusted Gateway capacity run Cloud-owned work. From the
Cloud product perspective this is still Cloud work:

- Cloud owns session, command, event, projection, workflow, usage, artifact,
  checkpoint, audit, and policy records.
- The Gateway edge process claims work through the managed-worker service
  plane.
- Every Cloud-owned write includes the active lease token.
- Cloud object storage owns Cloud artifacts and checkpoints.
- Gateway local runtime roots are scratch execution state, not the durable
  source of truth.

Eligible work must be allowlisted by profile and policy. Cloud must reject
edge claims when:

- the registration, credential, worker, pool, or tenant is revoked, expired,
  paused, draining, incompatible, or over quota
- the work requires host paths, local stdio MCPs, machine runtime config, or
  provider credentials outside Cloud-approved runtime config
- object storage, secret adapter, checkpoint, or BYOK policy is not compatible
  with remote edge execution
- the Gateway reports an incompatible Open Cowork, OpenCode, event contract,
  projection contract, or checkpoint schema version

No database transaction may remain open while Gateway-run OpenCode work is
running.

## Combined Mode

`external_workspace_edge_worker` keeps two lanes separate:

- Gateway-owned lane: Gateway sessions, workflows, artifacts, and audit stay
  Gateway-owned. Cloud may hold only allowed external-workspace metadata.
- Cloud-owned lane: eligible Cloud sessions or workflows may be executed by
  Gateway edge capacity, but Cloud remains the durable source of truth.

The two lanes must never share ids in a way that implies ownership transfer.
Cross-lane movement is an explicit import, export, registration, or sync
operation with audit.

## Events And Projections

Allowed sync scopes are deliberately narrow:

- `health`
- `capabilities`
- `redacted_session_metadata`
- `redacted_projection_snapshot`
- `workflow_status`
- `artifact_metadata`
- `audit_summary`
- `event_cursor`
- `cloud_work_events`
- `cloud_work_projection`
- `cloud_work_artifact_metadata`
- `cloud_work_checkpoint_metadata`

Forbidden sync scopes are always forbidden:

- `raw_gateway_database`
- `raw_opencode_runtime_home`
- `raw_local_paths`
- `raw_provider_keys`
- `raw_mcp_secrets`
- `raw_channel_secrets`
- `gateway_private_files`
- `cloud_byok_plaintext`
- `unfenced_event_writes`

Cloud late-join, repair, and replay logic must depend on Cloud-owned events
and projections for Cloud-owned work. It must not reconstruct Cloud sessions
from Gateway process memory or Gateway-local database state.

## Artifact And Checkpoint Ownership

Artifact and checkpoint ownership follows the work owner:

| Work owner | Artifact body | Checkpoint | Client access |
| --- | --- | --- | --- |
| Gateway-owned external workspace | Gateway artifact store | Gateway checkpoint/store policy | Cloud may show redacted metadata or time-bounded links only when policy allows. |
| Cloud-owned edge work | Cloud object store | Cloud checkpoint metadata/object store | Cloud APIs authorize download/export; Gateway writes metadata with lease token. |
| Combined mode | Split by work owner | Split by work owner | No implicit body copy across lanes. |

If a Gateway edge worker uploads a Cloud-owned object but crashes before
metadata write, the object remains invisible until metadata is written with
the active lease token or cleanup removes it.

## Recovery And Revocation

Revocation behavior is fail-closed:

1. Revoke the registration credential.
2. Mark the registration and worker record `revoked` or `draining` according
   to incident severity.
3. Reject future heartbeats, metadata sync, lease claims, renewals, and fenced
   writes from that credential.
4. Let existing Cloud leases expire or be reaped through managed-worker
   recovery. Do not hand-edit command/session records.
5. Keep Gateway-only local work available if the Gateway operator chooses to
   keep Standalone Gateway running without Cloud.
6. Preserve redacted audit, heartbeat rejection, stale-owner rejection,
   delivery, and diagnostics evidence.

Drain behavior is controlled and non-destructive:

1. Mark the registration or worker `draining`.
2. Reject new Cloud-owned edge claims for that registration.
3. Allow active leases to renew only until the configured drain deadline.
4. Stop metadata sync writes that would imply fresh availability.
5. Requeue, reap, or dead-letter unfinished Cloud-owned work through normal
   managed-worker recovery after the drain deadline.
6. Leave Gateway-owned standalone work under Gateway operator control.

Recovery behavior:

| Failure | Required behavior |
| --- | --- |
| Gateway offline in external-workspace mode | Cloud marks registration offline and stops metadata sync; Gateway-only remains local to Gateway. |
| Gateway crashes before claiming Cloud work | Work remains queued for other eligible Cloud capacity. |
| Gateway crashes during Cloud work | Lease expires; Cloud reaper retries or dead-letters according to command/workflow policy. |
| Gateway loses lease then writes | Cloud rejects stale-owner writes and records audit/metrics. |
| Gateway token is compromised | Revoke credential; all scopes fail; Cloud-owned leases expire or are reaped. |
| Gateway artifact link expires | Cloud keeps metadata but requires a fresh authorized link or explicit import. |

## Threat Model

| Threat | Mitigation |
| --- | --- |
| Gateway token compromise | Scope credentials by registration, tenant/org, kind, and operation; hash-store tokens; expire and revoke. |
| Gateway database treated as Cloud source of truth | Contract forbids database merging and raw Gateway database sync. |
| Customer-hosted worker accesses managed SaaS BYOK | Customer-hosted managed SaaS edge work is deferred; worker-role BYOK reveal remains Cloud-owned and policy-gated. |
| Local path or MCP secret leak | Sync scopes forbid raw paths, local stdio MCP commands, channel secrets, and MCP secrets. |
| Stale edge worker writes | Every Cloud-owned write requires active lease-token fencing. |
| Artifact body crossover | Body copy requires explicit import/export; metadata alone does not grant body access. |
| Approval impersonation | Gateway process token is not actor authority; approvals use resolved user/channel identity and policy. |
| Version drift | Heartbeats include Open Cowork, OpenCode, event contract, projection contract, and checkpoint schema versions; incompatible workers are paused or rejected. |

## Future API Shape

The future Cloud API should expose this contract without making implementation
details public:

- `POST /api/admin/gateway-registrations`
- `GET /api/admin/gateway-registrations`
- `GET /api/admin/gateway-registrations/:registrationId`
- `POST /api/admin/gateway-registrations/:registrationId/rotate`
- `POST /api/admin/gateway-registrations/:registrationId/revoke`
- `POST /api/gateway-registrations/:registrationId/heartbeat`
- `POST /api/gateway-registrations/:registrationId/capabilities`
- `POST /api/gateway-registrations/:registrationId/metadata-sync`
- `POST /api/gateway-registrations/:registrationId/claim`
- `POST /api/gateway-registrations/:registrationId/renew`
- `POST /api/gateway-registrations/:registrationId/fenced-output`

Admin routes require org admin or operator authority. Gateway self routes
require scoped registration credentials. Edge claim routes must additionally
check managed-worker lifecycle, entitlement, quota, profile, compatibility,
and lease-fencing policy.

## Current Implementation Status

This document defines the production contract for issue #582. It does not turn
on hybrid execution. The current Cloud Channel Gateway and Standalone Gateway
entry points still reject `gateway.productMode: "hybrid"` until the future API,
store records, deployment validators, and recovery drills are implemented.
