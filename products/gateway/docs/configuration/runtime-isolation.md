# Runtime Isolation

Gateway records a runtime isolation profile for every scheduler-created OpenCode run. The profile is the durable contract for where the agent ran, what environment backend was used, which tools were preflighted, what network policy applied, how secrets were named, and what cleanup policy owns the environment after the run.

This is a local-first isolation contract. It makes execution boundaries visible and testable for public beta, but it is not a hosted multi-tenant sandbox by itself.

## What Gets Recorded

Each scheduler run stores `runtimeProfile` beside the existing environment snapshot:

| Area | Recorded contract |
| --- | --- |
| Environment | Environment name, backend, spec hash, runtime/image/provider metadata, and environment run ID |
| CWD | The OpenCode working directory source with the local path redacted |
| Filesystem | Local workdir, container workspace, remote lease, or custom backend policy plus redacted mounts |
| Network | `disabled`, `restricted`, or `unrestricted` plus explicit allow entries |
| Process | Timeout, environment TTL, and cleanup policy |
| Permissions | Profile permissions or review-gate isolation source |
| Tools | Required tools and preflight checks |
| Secrets | Allowed secret names only, never values |
| Validation | Errors and warnings used by the scheduler gate |

Mission Control, `/runs`, `/environments`, and the MCP environment tools expose bounded runtime summaries. Local filesystem paths are redacted to `~`, `<tmp>`, or a stable path hash before they leave the store-facing contract.

## Scheduler Gate

Gateway validates the environment spec before it creates an OpenCode session. The first contract blocks:

* Environments explicitly marked with `custom.runtimeIsolation: "unsafe"` or `custom.unsafeRuntimeIsolation: true`.
* Wildcard network allow entries such as `*`, `0.0.0.0/0`, or `::/0`.
* A local-container restrictive mode that conflicts with `container.network`.
* A nonempty local-container `network.allow`; Gateway currently has no Docker-compatible egress allowlist mechanism, so it fails closed.
* Filesystem roots, the home root, known credential/config trees, and system-sensitive trees as an execution workdir.
* Local-container host mounts that resolve through symlinks to a sensitive path or outside the approved workdir, daemon checkout, and temporary roots.

The scheduler records an alert with source `gateway.runtime`, blocks the task with an actionable note, and does not create an OpenCode session when the profile is rejected.

## Cleanup Semantics

Runtime cleanup state is derived from the current environment snapshot:

* Successful stages release or retain environments according to `cleanup.retainOnSuccess`.
* Failed, blocked, expired, cancelled, and orphan-recovered stages release or retain according to `cleanup.retainOnFailure`.
* Manual `environment_action` operations are idempotent and update the visible runtime cleanup summary.
* Restart recovery reconciles retained and cleanup-failed environments through the backend controller.
* Remote Crabbox acquisition intents can be looked up and released by their dispatch idempotency key even when a crash occurred before the environment snapshot was attached.

The runtime profile is immutable evidence of the contract used at session creation. Cleanup state is projected from the current environment so operator reports stay accurate after retain, release, abort, or recovery.

## Lifecycle Diagnostics

Runtime lifecycle diagnostics appear in the same environment view used by `/environments`, Mission Control, and the MCP environment tools. Diagnostics are redacted and action-oriented; they explain what an operator should do without exposing local private paths, secret values, provider payloads, or transcript content.

| Diagnostic | Typical cause | Operator action |
| --- | --- | --- |
| `preflight_blocked` | A tool, setup command, validation command, permission gate, or runtime prerequisite failed before OpenCode session creation. | Fix the missing prerequisite or environment config, then retry the task. |
| `stale_active_environment` | A prepared or blocked environment remains active past its lifecycle window. | Run `environment_reconcile`, inspect the owning run/session, and recover or retry from durable state. |
| `retained_resource` | An environment was intentionally retained but exceeded the inspection window. | Collect evidence, then release or clean up the resource. |
| `cleanup_failed` | Backend release/cleanup failed. | Inspect the redacted cleanup error, fix the backend/resource issue, then rerun cleanup. |
| `missing_workspace` | Environment metadata points at a backend-managed workspace that no longer exists. | Treat the run as orphaned or stale; reconcile and retry from durable state. |
| `abandoned_workspace` | A released environment still has a backend-managed workspace on disk. | Clean up the workspace after confirming no active run owns it. |
| `missing_artifact` | A file-backed evidence reference no longer exists. | Regenerate evidence or mark the proof incomplete before using the run as release evidence. |
| `custom_backend_preview` | A custom backend is in use. | Keep it preview-only unless its isolation contract is declared and reviewed. |

These diagnostics do not make local-process execution a sandbox. They make runtime ownership, cleanup, and orphan risk visible enough for local beta and preview proof drills.

## Local-First Limits

`local-process` runs inside the local operator trust boundary. It preflights required tools, but it does not prevent arbitrary host process or network behavior beyond OpenCode permissions and Gateway review-gate isolation. Restrictive network fields on this backend are recorded as capability metadata with an explicit validation warning; use `local-container` when a task requires enforced network denial.

`local-container` adds a stronger filesystem/process boundary when an administrator-approved container runtime and image are configured. Checkout, workdir, and host-mount paths are canonicalized before preflight so an in-checkout symlink cannot expose an out-of-checkout or sensitive host tree. `disabled` and deny-all `restricted` both generate `--network none`. Nonempty egress allowlists are rejected until an enforcement adapter exists. Privileged containers remain human-gated.

`remote-crabbox` records the remote lease contract and cleanup metadata. Gateway does not currently pass an enforceable network policy to Crabbox, so restrictive network fields are capability metadata with a validation warning. It depends on the remote provider/broker enforcing its own sandbox guarantees and remains operator-managed experimental capacity, not a self-hosted or hosted worker claim.

Hosted, organization-scale, and multi-tenant guarantees require identity, secrets, remote-execution, and audit-log evidence that does not exist yet; those claims stay blocked in the claim registry (see the [Decision Log](../history/decision-log.md)).
