---
title: Hybrid Security Gates
description: Mode-aware security, policy, audit, quota, and restore gates for Desktop, Gateway, Cloud, and hybrid Open Cowork deployments.
---

# Hybrid Security Gates

Open Cowork can now run as Desktop, Cloud Web, Standalone Gateway, Cloud
Channel Gateway, Desktop pairing, or a full hybrid of those surfaces. This page
defines the production security gates for those modes. It complements
[Deployment Topologies](deployment-topologies.md): topologies say what you are
deploying; security gates say which auth, policy, audit, quota, redaction, and
restore behavior must be true before that topology is exposed to users.

The machine-readable contract lives at
`deploy/security/hybrid-security-gates.json`. `pnpm deploy:validate` and
`pnpm ops:validate` verify that the contract, docs, and code evidence stay in
sync.

## Non-Negotiable Rules

- Open Cowork is a product layer on top of OpenCode, not a second runtime.
- Every thread has one execution authority at a time: `desktop_local`,
  `cloud_worker`, or `gateway_standalone`.
- The Gateway is either a standalone execution owner or a Cloud channel adapter;
  it must not silently switch roles.
- Remote approvals for Desktop-owned execution default to `local_confirmation`.
- `remote_allowed` is an explicit, scoped policy decision. Missing policy falls
  back to `requires_local_confirmation` or `blocked_by_policy`, never remote
  approval.
- A Gateway service token authenticates the Gateway process only. It does not
  grant the channel actor approval authority.
- Public provider callbacks require provider signing, HMAC, or equivalent
  shared-secret verification.
- Production modes fail closed without TLS, admin token, durable stores,
  backup/restore posture, and redaction posture.

## Gate Matrix

| Gate | Topology profile | Execution authority | Production boundary |
| --- | --- | --- | --- |
| `desktop-local` | `desktop-only` | `desktop_local` | Local Desktop owns OpenCode execution and local data. |
| `desktop-pairing` | `desktop-gateway` | `desktop_local` | Desktop opens an outbound connector; no Desktop or OpenCode port is public. |
| `standalone-gateway` | `gateway-only` | `gateway_standalone` | Gateway owns private OpenCode and private Gateway Postgres. |
| `cloud-worker` | `cloud-only` | `cloud_worker` | Cloud web/worker/scheduler own Cloud workspaces through Postgres/object store. |
| `cloud-channel-gateway` | `cloud-channel-gateway` | `cloud_worker` | Gateway is a Cloud client and channel adapter; Cloud workers execute. |
| `cloud-gateway-edge` | `cloud-gateway-edge` | `cloud_worker`, `gateway_standalone` | Cloud registers external Gateway state without taking implicit execution ownership. |
| `full-hybrid` | `full-hybrid` | per workspace | All smaller gates pass and each workspace declares one execution authority. |

## Approval And Question Policy

Approval and question behavior follows the execution authority that owns the
thread.

For `desktop-local`, there is no remote approval path. The local Desktop user
answers OpenCode approvals and questions.

For `desktop-pairing`, Desktop remains the authority. The default remote
approval and question policy is `local_confirmation`. A remote client may send a
prompt or response request, but Desktop returns `requires_local_confirmation`
until a local user confirms it. `remote_allowed` may be used only when all of
these are true:

- the pairing policy explicitly enables it;
- the actor, workspace, session, and action risk are in scope;
- revocation and lease fencing are active;
- the action is written to the local audit log;
- redaction still blocks raw provider keys, local paths, local MCP details, and
  artifact bodies unless policy explicitly allows them.

For `cloud-worker`, Cloud membership, role, profile policy, subscription/quota
state, and runtime policy decide approval and question authority. Pending
permissions and questions must be present in durable projection state so late
join clients can recover after restart.

For `standalone-gateway`, the channel actor must resolve to Gateway RBAC before
approvals or questions can be answered. Approval tokens are single-use and
replay protected.

For `cloud-channel-gateway`, the Gateway service token proves the process is
allowed to call Cloud APIs. It does not prove that the human or channel actor is
allowed to approve a permission. Cloud must resolve provider identity and check
membership/RBAC before accepting approval or question replies.

## Auth And Revocation

Every connector has an explicit auth and revocation contract:

- Desktop local: preload whitelist plus main-process project grants.
- Desktop pairing: bearer pairing token, pairing id, device id, command leases,
  and pairing revocation.
- Standalone Gateway: admin token for operator endpoints, private OpenCode
  endpoint, provider signing or HMAC for public ingress, and provider credential
  rotation.
- Cloud worker: OIDC, signed trusted header auth, cookie auth, or scoped API
  token; membership and API-token revocation block new mutations.
- Cloud Channel Gateway: scoped gateway service token plus separate inbound
  actor identity resolution; channel binding and token revocation stop routing.
- Cloud Gateway Edge: registration tokens, heartbeat, lease fencing, and
  explicit `customer_hosted_managed_saas_deferred` review before managed SaaS
  claims are made.

## Audit Taxonomy

Security-sensitive actions must be auditable in the authority that owns them.
The gate contract lists the minimum audit events for each mode. The taxonomy
includes:

- pairing lifecycle: `pairing.created`, `pairing.updated`,
  `pairing.enabled`, `pairing.disabled`, `pairing.connected`,
  `pairing.offline`, `pairing.revoked`;
- remote commands: `command.accepted`, `command.completed`,
  `command.failed`, `command.blocked`, `remote.event.published`;
- provider ingress: `provider.ingress.accepted`,
  `provider.ingress.rejected`;
- approvals and questions: `permission.requested`,
  `permission.responded`, `question.asked`, `question.replied`;
- Cloud control plane: `org.created`, `membership.created`,
  `api_token.created`, `api_token.revoked`, `byok.secret.updated`,
  `quota.rejected`;
- channel operations: `gateway.registered`, `gateway.revoked`,
  `channel.binding.created`, `channel.binding.revoked`,
  `delivery.sent`, `delivery.dead_lettered`;
- edge operations: `gateway.registration.heartbeat`,
  `gateway.edge.write_fenced_output`.

Audit rows must not contain raw provider keys, OAuth tokens, MCP secrets,
channel secrets, local file contents, or sensitive local paths.

## Quotas And Rate Limits

Production deployments must apply rate limits at every public or remotely
reachable boundary:

- Cloud: IP, token, user, org, workspace, worker-spawn, prompt, and workflow
  limits.
- Gateway: provider ingress, channel actor, delivery retry, dead-letter, and
  operator endpoint limits.
- Desktop pairing: pairing command, broker command lease, and remote event
  publish limits.
- Edge registration: heartbeat, command, and fenced write limits.

Where the protocol supports it, throttles return `Retry-After`. Quota denials
should be clear: `402` for billing/entitlement failures and `429` for rate
limits.

## Durability, Backup, And Restore

Production security posture includes recovery posture:

- Cloud requires Postgres, provider-backed object storage, secret-manager/KMS
  references, worker checkpoints, event logs, and session projections.
- Standalone Gateway requires Gateway Postgres, artifact storage where file
  ingress is enabled, channel credential secret storage, delivery cursors, and
  dead-letter retention.
- Desktop pairing requires Desktop pairing records, broker command log, broker
  event cursor, and local audit records.
- Full hybrid restore drills prove that authority boundaries survive restore
  and that no local data is uploaded implicitly.

Restore evidence must include redaction review. Use
[Backup and Restore](runbooks/backup-restore.md) and
[Restore Drill Report](runbooks/restore-drill-report.md) as the operator
templates.

## Redaction Requirements

Diagnostics, logs, caches, dashboards, audit rows, and channel messages must
redact:

- raw provider keys and BYOK plaintext;
- OAuth access and refresh tokens;
- MCP secrets;
- channel provider secrets and signing tokens;
- private artifact URLs unless the actor is authorized;
- local host paths and local file bodies unless explicitly uploaded through a
  Cloud-safe artifact flow;
- raw Gateway database state, raw OpenCode runtime homes, and gateway private
  files in Cloud registration payloads.

The default posture is metadata over contents. If a deployment chooses to
expose richer fields, that exposure must be explicit in policy and covered by
audit.

## Fail-Closed Validation

`pnpm deploy:validate` checks the gate contract and cross-references code
evidence for the following fail-closed behavior:

- Desktop pairing defaults to `local_confirmation`.
- Desktop pairing can return `requires_local_confirmation` and
  `blocked_by_policy`.
- Public Cloud does not trust unsigned header auth.
- Public Cloud fails closed without Postgres, provider-backed object storage,
  production secrets, auth, and worker checkpoints.
- Gateway operator endpoints require an admin token.
- Gateway webhook ingress requires provider signing, HMAC, or a shared secret.
- Gateway fake provider is local/demo-only.
- Gateway rejects public OpenCode endpoints.
- Cloud and Gateway throttles expose `Retry-After`.
- Full hybrid requires one execution authority per thread.

`pnpm ops:validate` checks that the operations artifacts include the gate
contract, backup/restore posture, topology docs, observability assets, and
mode-aware runbook references.
