# Execution Environments

Gateway schedules durable work. Execution environments describe where task stages are allowed to run and what the stage must be able to see before Gateway spends model tokens on an OpenCode session.

The environment system is intentionally OpenCode-native. OpenCode still owns agents, sessions, permissions, questions, model use, and tool execution. Gateway owns deterministic environment resolution, preflight, governance, run metadata, and operator visibility.

## Resolution Order

Gateway resolves one environment spec for every task stage before dispatch.

The merge order is deterministic:

1. Global Gateway default from `config.json`.
2. Scheduler profile default from `profiles.<name>.environment`.
3. Repository config from `.gateway/env.json`, `.gateway/env.yaml`, or `.gateway/env.yml` in the task workdir tree.
4. Roadmap default from `roadmap.environment`.
5. Task override from `task.environment`.

Later trusted profile, roadmap, and task layers override scalar fields and merge lists deterministically. The administrator registry remains the trust root for repository config: repository definitions must extend an administrator-defined environment (or safely overlay one with the same name), and every repository-derived definition must be no more capable than its parent. A repository may add workload tools, validation commands, and ordinary environment values or tighten approved limits. It may not add setup commands, forwarded secrets, cache/host mounts, retention, images, entrypoints, runtime executables, provider/class selection, network reachability, or process/container privilege.

## Gateway Config

Every install ships with an explicit `local-process` default:

```json
{
  "environments": {
    "defaultEnvironment": "local-process",
    "maxConcurrent": 20,
    "requireApprovalForRemote": true,
    "requireApprovalForPrivilegedContainer": true,
    "environments": {
      "local-process": {
        "backend": "local-process"
      }
    }
  }
}
```

`local-process` is the compatibility backend. It evaluates tools from the daemon process environment and binds OpenCode sessions to the resolved workdir.

Only administrator-owned Gateway config may introduce a `local-container` runtime or `remote-crabbox` CLI. When a repository selects one of those environments, Gateway resolves both the approved executable and any repository-supplied spelling to canonical files, requires an exact match, rejects executables inside the repository config root, and executes the approved canonical path. An unavailable executable fails repository resolution closed. Administrator-owned custom executable paths outside the repository remain supported.

Gateway canonicalizes checkout and environment workdirs through existing symlinks. A repository-supplied workdir must remain inside the canonical checkout. Filesystem roots, the home directory itself, sensitive home trees such as `.ssh`, `.gnupg`, `.aws`, `.kube`, and `.config`, and system trees such as `/etc`, `/proc`, `/sys`, `/dev`, and `/run` are rejected before backend preflight.

### Working directory

Bind a real repository so agents do (and reviewers verify) actual file work in the right place:

- `opencode-gateway project new <alias> --title "..." --directory /path/to/repo` binds the whole project to that directory.
- A named environment (or `.gateway/env.yaml`) with an explicit `workdir` does the same for a stage/task/roadmap.

If a `local-process` task resolves with **no** bound workdir, Gateway does **not** fall back to the daemon's ambient working directory (which would leak agent file edits into wherever the daemon runs). Instead it creates a Gateway-owned, per-project workspace under the state directory (`<state-dir>/workspaces/<roadmap-or-task-id>`) so file work stays real and contained.

## Repository Config

Repository config is optional. Put it under `.gateway/env.json`, `.gateway/env.yaml`, or `.gateway/env.yml`.

Generate a starter `.gateway/env.yaml` from the CLI:

```bash
opencode-gateway env template node
opencode-gateway env template python
opencode-gateway env template rust
opencode-gateway env template docs
opencode-gateway env template container
opencode-gateway env template crabbox
```

Use `--stdout` to inspect without writing and `--force` to replace an existing template. Treat generated files as workload starters: bind each definition to an administrator environment with `extends`, move runtime, image, provider, setup, secret, cache/mount, and network policy into that administrator definition, and leave only workload validation or tighter limits in the repository file.

### Node Example

```yaml
defaultEnvironment: node-local
environments:
  node-local:
    extends: local-process
    tools:
      - node
      - npm
    validation:
      - npm test
    resources:
      timeout: 30m
```

### Rust Example

```yaml
defaultEnvironment: rust-local
environments:
  rust-local:
    extends: local-process
    tools:
      - rust
      - cargo
    validation:
      - cargo test --locked
```

### Python Docs Example

```yaml
defaultEnvironment: docs
environments:
  docs:
    extends: local-process
    tools:
      - python
      - uv
      - mkdocs
    validation:
      - uv run mkdocs build --strict
```

## Local Containers

The `local-container` backend runs environment preflight through an administrator-configured local container CLI and records image/runtime metadata on every run. It is opt-in and blocks before session creation if the runtime, image, declared tools, setup commands, or validation commands are unavailable inside the container.

Supported local CLIs use Docker-compatible arguments. Configure the executable in administrator-owned Gateway config first:

```json
{
  "environments": {
    "environments": {
      "docker-container": {
        "backend": "local-container",
        "resources": { "cpu": 4, "memory": "8Gi", "timeout": "90m" },
        "network": { "mode": "restricted" },
        "secrets": { "allow": ["GITHUB_TOKEN"] },
        "cache": { "volumes": [{ "name": "npm-cache", "path": "/home/node/.npm" }] },
        "container": {
          "runtime": "docker",
          "image": "ghcr.io/example/project-runner:2026-06-14",
          "workdir": "/workspace",
          "user": "1000:1000",
          "pull": "missing",
          "privileged": false
        }
      }
    }
  }
}
```

The administrator definition must approve the image and all host/cache mounts, setup commands, secret names, network reachability, entrypoint, user, and privilege. Repositories can select the profile, add workload validation, and reduce its resource/timeout/TTL ceilings. Common approved CLIs are:

- Docker Desktop or Docker Engine: `container.runtime: docker`
- OrbStack Docker compatibility: `container.runtime: docker`
- Podman Docker-compatible CLI: `container.runtime: podman`

Gateway creates a run-scoped host workspace under the system temp directory, copies the configured workdir into it, mounts that workspace at `container.workdir` (default `/workspace`), and removes it on release/cleanup. Cache volumes are named from the environment spec hash and cache name so caches are shared by repo/environment but not by task workspace.

For stage work, Gateway gives OpenCode a generated command wrapper path as the `commandPrefix`. The wrapper invokes the configured Docker-compatible runtime, mirrors stdout/stderr back to the agent, preserves the command exit code, and writes per-command stdout, stderr, exit code, timing, and metadata files under the run capture directory. Those capture files and files under `.gateway/artifacts/` in the isolated workspace are attached to the run as backend-managed artifacts during stage completion.

Set `container.warm: true` to enable an optional local warm pool keyed by runtime, image, and environment spec hash. Gateway warms the image/spec once per daemon process with a no-op container command and records whether later runs hit the warmed pool in run metadata. Warm pools are opportunistic and do not change cleanup of task workspaces.

```yaml
defaultEnvironment: node-container
environments:
  node-container:
    extends: docker-container
    tools:
      - node
      - npm
    container:
      warm: true
    validation:
      - npm test
    resources:
      cpu: 2
      timeout: 45m
```

Privileged containers require human approval when `environments.requireApprovalForPrivilegedContainer` and `humanLoop.destructiveActionApproval` are enabled.

Container network policy is enforced as follows:

- `disabled` always emits exactly `--network none`; any other `container.network` value is rejected.
- `restricted` with an empty allowlist is deny-all and also emits `--network none`.
- `restricted` with `network.allow` fails closed because Gateway does not currently configure a Docker-compatible egress firewall.
- `unrestricted` emits no network argument unless the resolved container configuration selects a Docker network.
- On `local-process`, `remote-crabbox`, and `custom`, network fields remain capability metadata and produce an explicit runtime-isolation warning; those backends do not enforce them. Use `local-container` for Gateway-enforced network denial.

Administrator runtime examples:

```yaml
# Docker Desktop or Docker Engine
container:
  runtime: docker
  image: node:22-bookworm

# OrbStack Docker compatibility also uses the docker CLI
container:
  runtime: docker
  image: node:22-bookworm

# Podman with Docker-compatible arguments
container:
  runtime: podman
  image: node:22-bookworm
```

## Crabbox Remote Capacity

The `remote-crabbox` backend is for operator-managed remote leased environments. Gateway validates the administrator-approved Crabbox CLI/runtime, creates human gates when policy requires approval, warms a Crabbox lease, runs environment preflight/setup/validation commands through that lease, and records non-secret lease/run metadata. This is experimental remote capacity for a trusted operator, not a self-hosted or hosted-worker release claim; those claims stay blocked in the claim registry.

First add an administrator environment that owns the CLI, broker/provider selection, machine class, maximum lease/runtime limits, setup, retention, and secret policy:

```yaml
approved-crabbox:
  backend: remote-crabbox
  resources:
    cpu: 16
    memoryGb: 32
    timeout: 2h
  crabbox:
    cli: crabbox
    profile: default
    provider: hetzner
    class: beast
    ttl: 2h
    actionsHydration: true
    keepOnFailure: true
```

The repository may then select that approved capacity, declare workload tools/validation, and tighten its ceilings:

```yaml
defaultEnvironment: remote-large
environments:
  remote-large:
    extends: approved-crabbox
    tools:
      - node
      - npm
      - cargo
    validation:
      - npm test
    crabbox:
      ttl: 45m
      warm: true
    resources:
      cpu: 8
      memoryGb: 16
      timeout: 45m
```

Remote environments require human approval when `environments.requireApprovalForRemote` and `humanLoop.externalSideEffectApproval` are enabled.

Repository `env` entries for a remote environment are forwarded as workload values, but variables that can control the trusted host-side CLI are administrator-only. Gateway rejects executable/search paths, language or dynamic-loader hooks, proxy/CA routing, credential/config roots, and `CRABBOX_*` variables in repository definitions.

Gateway uses the documented Crabbox CLI contract:

- `crabbox warmup --timing-json --slug ogw-<key-hash>` creates and waits for a ready `cbx_...` lease. Gateway derives the opaque slug from the scheduler's environment-acquisition idempotency key; the raw key is not sent as provider metadata.
- `crabbox inspect --id <lease> --json` captures non-secret provider/state metadata.
- `crabbox run --id <lease> --timing-json -- ...` checks declared tools and runs single argv commands.
- `crabbox run --id <lease> --timing-json --shell '<command>'` runs setup and validation shell snippets.
- `crabbox stop <lease>` releases the lease; `crabbox release <lease>` is used only as a compatibility fallback when `stop` is unavailable.

Environment prepare receives the durable dispatch acquisition key. Before creating remote capacity, the Crabbox controller looks up the deterministic slug and reuses its canonical lease when found, closing the crash window between provider creation and durable run attachment. After a keyed warmup it resolves that slug again; if Crabbox appended a suffix because two creates raced, Gateway releases the duplicate before adopting the canonical keyed lease. The controller also exposes `lookupByKey` and idempotent `releaseByKey`; restart reconciliation should call those methods for an acquisition intent that has no attached environment snapshot, then either attach the recovered lease or release it before retrying dispatch.

OpenCode remains the stage orchestration runtime. Gateway starts the OpenCode session in the local repo workdir and includes the Crabbox command prefix in the stage prompt so repository commands run through Crabbox sync, logging, timing, and artifact collection:

```text
crabbox run --id cbx_... --timing-json -- <command>
```

For self-hosted/direct provider use, install the Crabbox CLI where the Gateway daemon runs and configure Crabbox provider credentials outside Gateway. For brokered use, authenticate Crabbox with the broker before dispatch:

```sh
crabbox login --url https://broker.example.com --token-stdin
crabbox config set-broker --url https://broker.example.com --token-stdin
```

You can also set `crabbox.brokerUrl` in a Gateway environment; Gateway passes it to Crabbox as `CRABBOX_COORDINATOR` for the CLI process and stores only `<configured>` in run metadata. Provider credentials, broker tokens, VNC passwords, and secret env values should stay in Crabbox config or process environment, not in Gateway config.

`crabbox.keepOnFailure: true` makes Gateway retain the lease when the stage fails. Otherwise Gateway calls `crabbox stop` during environment finalization. Crabbox timing JSON artifact refs, run IDs, slugs, provider, class, remote workdir, and redacted command summaries are surfaced on the Gateway run environment snapshot.

## Task Overrides

Use a named environment:

```json
{
  "environment": "remote-large",
  "qualitySpec": {
    "requiredTools": ["cargo", "uv"]
  }
}
```

Or inline overrides:

```json
{
  "environment": {
    "extends": "rust-local",
    "resources": { "cpu": 8, "timeoutMs": 7200000 },
    "network": { "mode": "unrestricted" }
  }
}
```

## Preflight And Evidence

Gateway runs environment preflight before creating an OpenCode session.

## Controller Contract

Every backend is selected through an Environment Controller interface. The controller lifecycle is:

1. `resolve` merges config and selectors into one deterministic spec.
2. `hydrate` prepares dependency/source state before a session is created.
3. `prepare` creates a run-scoped environment record and runs backend preflight.
4. `attach` returns the OpenCode workdir/attachment context.
5. `collectArtifacts` reports backend-managed artifacts.
6. `release`, `retain`, and `cleanup` update cleanup state.
7. `reconcile` summarizes active, retained, and failed-cleanup environments after restart or heartbeat.

`local-process` is the compatibility controller. It attaches OpenCode to the resolved workdir and runs host PATH checks through the controller preflight path.

## Dependency Source Hydration

When a pending task has blocking dependencies (`blocks`, `blocked_by`, or `parent`), Gateway builds a backend-neutral source plan before dispatch. The plan records the target base ref, dependency task IDs, patch IDs, changed files, and patch-apply result in the `environment.hydrated` workflow event.

Dependency outputs use patch artifacts from successful dependency runs. Implement stages should write unified diff files under the workdir, for example `.gateway/patches/task.patch`, and cite them as `patch:.gateway/patches/task.patch` or `patch-file:.gateway/patches/task.patch` in the final JSON artifacts. `.patch` and `.diff` refs in diff evidence are also accepted.

Hydration validates every dependency patch before OpenCode session creation. If a patch is missing, empty, conflicting, or cannot be checked with `git apply`, the dependent task is blocked with actionable environment evidence. Already-applied patches are treated as restart-safe and do not block retry dispatch.

Preflight checks include:

- Backend validity.
- Container or Crabbox adapter availability when selected.
- Host availability for `qualitySpec.requiredTools` and environment `tools` on `local-process`.
- Runtime/adapter availability and command references for `local-container` and `remote-crabbox` tool checks.
- Canonical administrator approval for runtime executables selected through repository config.
- Network-policy enforceability and exact local-container network arguments.
- Secret allowlist shape.
- Network policy serialization.
- Capacity limits from `environments.maxConcurrent`, `environments.maxRetained`, `environments.backendMaxConcurrent`, and `resources.maxConcurrent`.

Every scheduler run stores an `environment` snapshot with backend, workdir, spec hash, preflight result, runtime/image/provider metadata, network policy, secret names, TTL, cleanup state, and artifact references.

## Operator Surfaces

Environment metadata appears in:

- Task and run HTTP API responses.
- `GET /environments`, `GET /environments/{id}`, and `POST /environments/{id}/action`.
- `gateway_environment_list`, `gateway_environment_get`, `gateway_environment_action`, and `gateway_environment_reconcile` MCP output.
- Dashboard task rows, recent run attribution, and the Execution Environments tab.
- Safe dashboard artifact links for known `file:` refs attached to Gateway runs. `GET /artifacts?ref=...` opens only refs already recorded on a run and redacts known secret values before returning text.
- Workflow events such as `environment.prepared`.
- Roadmap memory, observability metrics, incident reports, and alerts for resolution, capacity, preflight, and cleanup failures.

Secrets are deny-by-default for all environment selectors. Gateway stores allowed secret names in run records, not secret values, and dashboard/API surfaces use redacted environment records.

Operator actions are intentionally environment-scoped:

- `retain` keeps the environment lease/workspace for manual inspection.
- `release` asks the backend controller to release the lease/workspace and marks cleanup as released.
- `cleanup` retries backend cleanup for retained or failed-cleanup environments.
- `abort` cleans up the environment and aborts the associated OpenCode session when the run is still active, without rewriting task status through the environment API.

Daemon startup and every scheduler cycle run environment reconciliation. Reconciliation groups active, retained, and cleanup-failed environment snapshots by backend and records an `environment.reconciled` workflow event when retained or cleanup-failed state needs operator visibility. Cleanup failures raise the `environments:cleanup-failed` alert so operators can inspect, retry cleanup, or release the affected lease.

Common operator flow:

```text
gateway_environment_list status=cleanup_failed
gateway_environment_get environmentId=env_...
gateway_environment_action environmentId=env_... action=cleanup note="retried after backend recovery"
gateway_environment_reconcile
```

## Rollout Checklist

For the full migration and rollback guide, see [Environment Rollout](environment-rollout.md).

1. Keep `local-process` as the default while adding `.gateway/env.*` to one repository.
2. Add `tools` and `validation` first; verify preflight blocks missing host tools before session creation.
3. Add task or roadmap `environment` selectors for narrow workloads.
4. Enable `local-container` only after the image and runtime are available on the daemon host.
5. Enable `remote-crabbox` only after approval policy, budget limits, Crabbox login/provider config, cleanup ownership, and credential rotation are in place.
6. Watch dashboard run attribution for backend, preflight, TTL, and cleanup state.
7. Keep remote and privileged backends approval-gated until the team has validated cleanup and spend controls.
