# Environment Rollout

Use this guide to introduce Gateway execution environments without changing OpenCode's ownership of agents, sessions, permissions, questions, or model usage.

## Rollout Stages

1. Keep `local-process` as the global default.
2. Add `.gateway/env.yaml` to one repository with only `tools`, `validation`, `resources.timeout`, and `network.mode`.
3. Run one low-risk smoke task and confirm the run stores an environment snapshot.
4. Move repeated `qualitySpec.requiredTools` into the repo environment spec.
5. Add roadmap or task environment overrides only for workloads that need different resources.
6. Enable `local-container` or `remote-crabbox` only after approval, budget, cleanup, and credential policies are reviewed.
7. Keep the rollout reversible by leaving `environments.defaultEnvironment` set to `local-process` until the team has multiple successful runs.

## Minimal Repo Config

```yaml
defaultEnvironment: local
environments:
  local:
    extends: local-process
    tools:
      - node
      - npm
    validation:
      - npm test
    resources:
      timeout: 30m
    network:
      mode: unrestricted
```

## Smoke Task

Create one task that proves the environment resolves and preflights before a stage session is created:

```json
{
  "title": "Smoke test repo environment",
  "description": "Run the repository smoke command using the repo .gateway/env.yaml contract.",
  "qualitySpec": {
    "requiredTools": ["node", "npm"],
    "verificationCommands": ["npm test"],
    "acceptanceCriteria": ["The task run records an environment snapshot and passes the smoke command."],
    "evidenceRequirements": ["Run ID, environment name/backend, preflight result, and command output summary."]
  }
}
```

## Migration From Required Tools

Existing tasks can keep `qualitySpec.requiredTools`. Gateway merges those tools into the resolved environment spec for the stage.

Prefer this migration path:

1. Leave task-level `qualitySpec.requiredTools` in place.
2. Add the same tool names to `.gateway/env.yaml`.
3. Confirm preflight evidence shows the expected merged tool list.
4. Remove duplicated task-level tool declarations only after the repo-level environment config is present on every active branch/worktree.

## Backend Readiness

`local-process` checklist:

- Gateway daemon `PATH` exposes required tools.
- Workdir resolution points at the intended checkout.
- Network mode reflects capability intent only; restrictive modes produce a runtime warning and are not enforced by the host backend.
- Secret-like env keys are not embedded in task or repo selectors.

`local-container` checklist:

- Container runtime is declared in administrator-owned Gateway config and installed outside the repository config root.
- Repository definitions extend that approved environment and do not introduce a runtime executable, image, entrypoint, setup command, secret/cache/host mount, network, user, or privilege change.
- Administrator-owned image reference is pinned by tag or digest.
- `disabled` or deny-all `restricted` runs include `--network none`; nonempty `network.allow` is not supported and fails closed.
- Cache volumes are repo/environment namespaced.
- Setup and validation commands succeed inside the image, not just on the host.
- Captured stdout/stderr metadata and `.gateway/artifacts/` refs do not contain secrets before they are surfaced in run artifacts.
- `container.warm` is enabled only for images where the no-op warm command is safe.
- Privileged mode remains disabled unless a human gate approves it.
- The stage prompt tells the OpenCode agent to use Gateway's generated command prefix for runtime/image execution and capture.

`remote-crabbox` checklist:

- Crabbox CLI is declared in administrator-owned Gateway config and installed outside the repository config root.
- Repository definitions extend that approved environment and do not introduce a CLI executable, broker/provider/class, setup, secret, retention, or privilege-bearing option.
- Direct provider credentials or broker login are configured in Crabbox, not in Gateway.
- Brokered installs have run `crabbox login --url <broker-url>` or provide `crabbox.brokerUrl` so Gateway can set `CRABBOX_COORDINATOR` for CLI calls.
- The administrator environment includes the intended Crabbox `profile`, `provider`, `class`, maximum `ttl`, and `keepOnFailure` policy; repository selectors may only tighten those limits.
- Remote use is routed through `humanLoop.externalSideEffectApproval` unless explicitly waived.
- Budget and runtime ceilings are configured before remote work starts.
- Retain-on-failure policy has an operator cleanup owner.
- Crabbox timing JSON artifact/log refs are safe to show in Gateway events and do not include provider credentials.
- Dispatch recovery can look up and release the deterministic `ogw-<acquisition-key-hash>` slug before a retry creates more capacity.

## Feature Flags And Compatibility

The safe default is an explicit `local-process` environment. To pause rollout, remove task/roadmap/profile environment overrides and leave the global default unchanged.

Use these compatibility rules:

- Missing `.gateway/env.*` files are ignored.
- Existing tasks without an environment selector use `environments.defaultEnvironment`.
- Repository definitions must extend an administrator-approved environment or safely overlay one with the same name.
- Repository overrides are capability-monotonic, and repository workdirs remain within the canonical checkout after symlink resolution.
- `local-container` and `remote-crabbox` configs validate metadata and adapter availability, but do not require Docker or Crabbox in CI unless selected by a task.
- Remote and privileged backends should stay approval-gated until cleanup and spend controls are proven.

## Rollback

Rollback is configuration-only for the default local path:

1. Remove task, roadmap, and profile `environment` overrides.
2. Set `environments.defaultEnvironment` to `local-process`.
3. Pause tasks that are waiting on remote or privileged environment gates.
4. Release or retain any active backend resources according to the run cleanup state.
5. Retry blocked tasks after preflight shows `local-process` again.

Do not delete run records during rollback. They provide the audit trail for preflight, approval, and cleanup decisions.

## CI Validation

Docs and examples are intentionally generic. For repository-specific CI, validate YAML and run one smoke task with the same tool names declared in `.gateway/env.yaml`. Avoid CI jobs that require Docker or Crabbox unless that repository explicitly opts into those backends.
