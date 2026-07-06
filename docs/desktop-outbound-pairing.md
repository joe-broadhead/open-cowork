---
title: Desktop Outbound Pairing
description: Let a remote gateway or mobile surface send commands to an explicitly paired Desktop Local workspace without exposing Desktop or the local OpenCode server on the network.
---

# Desktop Outbound Pairing

Desktop outbound pairing lets a remote gateway or mobile surface send commands
to an explicitly paired Desktop Local workspace without exposing Desktop or the
local OpenCode server on the network.

This is a connector authority, not sync. Desktop stays the execution authority,
OpenCode stays the runtime, and the local session registry remains the source
of truth for paired local threads.

## Authority Model

The paired Desktop path has these invariants:

- Desktop opens the outbound connection to a broker. No public Desktop or
  OpenCode port is opened.
- Pairings are explicit, revocable, and scoped to allowlisted workspaces and
  optional allowlisted sessions.
- Remote commands are accepted only for the Local workspace in the v1
  implementation.
- Local paths, local MCP details, artifact bodies, and secrets are redacted by
  default before events or command results leave the machine.
- Remote approvals and question replies default to local confirmation, not
  remote authority.
- Every remote command and pairing lifecycle change is written to the local
  audit log.

## Pairing Records

Desktop persists pairing metadata in local app data and stores pairing tokens in
the OS-backed secret store when available. The renderer only receives metadata:
whether a token exists, device id, status, timestamps, policy, and broker URL.
It does not receive saved token plaintext after creation.

Pairing record fields:

- `id`
- `label`
- `deviceName`
- `status`
- `enabled`
- `brokerUrl`
- `allowedWorkspaceIds`
- `allowedSessionIds`
- `policy`
- heartbeat and command cursor timestamps
- revocation timestamp

## Outbound Broker Contract

The production transport is an outbound HTTP JSON client. A compatible broker
implements:

```text
POST /api/desktop-pairing/heartbeat
POST /api/desktop-pairing/commands/claim
POST /api/desktop-pairing/commands/:id/ack
POST /api/desktop-pairing/commands/:id/fail
POST /api/desktop-pairing/events
POST /api/desktop-pairing/revoke
```

Desktop authenticates with:

- `Authorization: Bearer <pairing-token>`
- `x-open-cowork-pairing-id`
- `x-open-cowork-device-id`

Non-loopback broker URLs must use HTTPS and must not target loopback,
link-local, private, non-routable, or cloud metadata networks. Desktop rejects
literal private targets before saving a pairing and re-checks DNS resolution
before every token-bearing broker request. Broker URLs cannot include embedded
username/password credentials; query strings and fragments are stripped before
persistence. Local development may use `http://localhost`,
`http://127.0.0.1`, or `http://[::1]`.

## Command Lease Semantics

The broker returns commands with:

- `sequence`
- `lease.leasedBy`
- `lease.leaseToken`
- `lease.leaseExpiresAt`

Desktop sends the lease token back when it acknowledges or fails the command.
The broker owns distributed claim semantics; Desktop owns local policy checks
and execution. Commands after the last durable sequence can be replayed safely
because Desktop acknowledges each command id and persists the last observed
sequence.

Paired Desktop command acknowledgements are lease-fenced, not projection-fenced.
The command result envelope includes `projectionFence: null` and
`projectionFenceStatus.reasonCode:
desktop_pairing_projection_fence_unsupported` so remote callers do not mistake
the absence of a cloud projection checkpoint for an observed UI state. Callers
that need consistency must use the command ack/fail result, durable command
sequence, and redacted event stream; a paired Desktop projection fence can only
be added after a durable paired projection checkpoint exists.

Supported commands:

- `create_session`
- `prompt`
- `abort`
- `permission.respond`
- `question.reply`
- `question.reject`
- `status`
- `revoke_pairing`

## Remote-Safe Event Stream

Desktop observes local OpenCode session projection events and publishes a
remote-safe event stream to connected pairings. Redaction is recursive and
removes:

- absolute local paths and `file://` URLs
- secret-like fields such as tokens, passwords, API keys, and credentials
- local MCP process details such as commands, args, env, cwd, and pid
- artifact bodies unless policy explicitly allows them

## Desktop UI

The Local workspace Settings panel includes Pairing controls for:

- creating a pairing
- copying the one-time token
- connecting or disconnecting the outbound connector
- manually syncing once
- revoking a pairing
- reviewing recent remote-access audit events

The Desktop workspace switcher also projects configured pairings as
`Paired Desktop` workspace rows so users can see whether a connector is
online, offline, disabled, or revoked. Those rows are status/support surfaces:
the Local workspace remains the execution authority, and Desktop does not
route paired workspace chat/session controls through Cloud.

Cloud workspaces do not show the Pairing settings panel because Cloud/Gateway
sync is already handled through the Cloud control plane.
