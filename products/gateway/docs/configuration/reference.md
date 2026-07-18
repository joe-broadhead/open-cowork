# Configuration Reference

Gateway config lives at:

```text
~/.config/opencode-gateway/config.json
```

## Top-Level Keys

| Key | Required | Purpose |
| --- | --- | --- |
| `opencodeConfigDir` | no | OpenCode profile directory for Gateway asset installation. |
| `opencodeUrl` | yes | Local OpenCode API URL. Default: `http://127.0.0.1:4096`. |
| `httpPort` | yes | Local Gateway daemon port. Default: `4097`. |
| `heartbeat` | yes | Scheduler wake heartbeat settings. |
| `channelSync` | yes | OpenCode session to channel delivery settings. |
| `security` | yes | HTTP exposure, webhook mode, and channel trust policy. |
| `governance` | yes | Cost, token, budget, and runtime policy. |
| `humanLoop` | yes | Durable human approval gates, timeouts, and escalation policy. |
| `alerts` | yes | Proactive alert rules plus optional durable outbound delivery to trusted channel targets. |
| `storage` | yes | Durable backend mode, unbounded-table retention windows, and disabled-by-default Postgres-compatible preview settings. |
| `environments` | yes | Execution environment registry, defaults, and capacity/approval policy. |
| `scheduler` | yes | Scheduler cadence, concurrency, retries, pipeline, and stage profiles. |
| `profiles` | yes | Named scheduler profiles for model, agent, skills, permissions, environment, budgets, output contracts, and lifecycle state. |
| `agentTeams` | no | Project/domain role-to-profile routing teams with capability requirements, quality defaults, version, and lifecycle state. A generated `default` team mirrors `scheduler.stageProfiles`. |
| `channels` | yes | Telegram, WhatsApp, and private-alpha Discord credentials/settings. |

## Minimal Example

```json
{
  "opencodeUrl": "http://127.0.0.1:4096",
  "httpPort": 4097,
  "heartbeat": { "intervalMs": 300000 },
  "channelSync": { "enabled": true, "intervalMs": 3000, "includeUserMessages": true },
  "security": {
    "httpHost": "127.0.0.1",
    "allowNonLocalHttp": false,
    "publicWebhookMode": false,
    "unsafeAllowNoAuth": false,
    "capabilityScopedLoopback": true,
    "requireNonMcpDestructiveApproval": true,
    "exposedHttp": {
      "requireStrongToken": true,
      "minTokenLength": 16,
      "minTokenEntropyBits": 48,
      "trustedProxyCidrs": [],
      "rateLimit": { "enabled": true, "windowMs": 60000, "maxRequests": 120, "maxTrackedClients": 4096 },
      "authLockout": { "enabled": true, "maxConsecutiveFailures": 5, "lockoutMs": 60000 }
    },
    "trustTargetMembersForFreeText": false,
    "unsafeAllowAllChannelTargets": {
      "telegram": false,
      "whatsapp": false,
      "discord": false
    },
    "channelAllowlists": {
      "telegram": [],
      "whatsapp": [],
      "discord": []
    }
  },
  "governance": {
    "enabled": true,
    "action": "block",
    "global": { "dailyCostUsd": 10, "monthlyCostUsd": 200 },
    "roadmaps": {},
    "tasks": {},
    "stages": {
      "implement": { "tokenLimit": 2000000, "action": "pause" }
    },
    "runtime": { "maxRunMs": 0, "staleRunMs": 3600000 }
  },
  "humanLoop": {
    "enabled": true,
    "taskStartApproval": false,
    "stageApprovals": ["verify"],
    "defaultTimeoutMs": 86400000,
    "timeoutAction": "escalate",
    "priorityTimeoutMs": { "HIGH": 3600000, "MEDIUM": 14400000, "LOW": 86400000 }
  },
  "alerts": {
    "profileHealth": { "enabled": true, "windowDays": 7, "minRuns": 10, "maxGenuineFailureRate": 0.5 },
    "stuckTask": { "enabled": true, "runThreshold": 15 },
    "delivery": {
      "enabled": false,
      "maxAttempts": 10,
      "targets": []
    }
  },
  "storage": {
    "backend": "local_sqlite",
    "retention": {
      "runsMaxAgeDays": 90,
      "receiptsMaxAgeDays": 90
    }
  },
  "environments": {
    "defaultEnvironment": "local-process",
    "maxConcurrent": 20,
    "maxRetained": 10,
    "backendMaxConcurrent": {},
    "requireApprovalForRemote": true,
    "requireApprovalForPrivilegedContainer": true,
    "environments": {
      "local-process": { "backend": "local-process" }
    }
  },
  "scheduler": {
    "enabled": true,
    "intervalMs": 10000,
    "maxConcurrent": 3,
    "leaseMs": 3600000,
    "retryLimit": 2,
    "maxRunsPerTask": 25,
    "defaultPipeline": ["implement", "review", "verify"],
    "stageProfiles": {
      "default": "implementer",
      "implement": "implementer",
      "review": "reviewer",
      "verify": "verifier",
      "audit": "auditor",
      "plan": "planner"
    },
    "stageConcurrency": {},
    "profileConcurrency": {}
  },
  "profiles": {
    "planner": {
      "model": { "providerID": "openrouter", "modelID": "deepseek/deepseek-v4-pro", "variant": "high" },
      "agent": "gateway-planner",
      "skills": ["gateway-planner"],
      "mcpServers": ["gateway"],
      "permission": { "gateway_*": "allow", "read": "allow", "edit": "ask", "bash": "ask" },
      "heartbeatMs": 300000,
      "maxTokens": 50000,
      "role": "planning",
      "promotionState": "promoted"
    },
    "implementer": {
      "model": { "providerID": "openrouter", "modelID": "deepseek/deepseek-v4-pro", "variant": "high" },
      "agent": "gateway-implementer",
      "skills": ["gateway-stage"],
      "mcpServers": ["gateway"],
      "permission": { "gateway_*": "allow", "read": "allow", "edit": "allow", "bash": "allow" },
      "heartbeatMs": 0,
      "maxTokens": 200000,
      "role": "execution",
      "capabilities": ["repo-write"],
      "outputContract": { "format": "stage-result", "requiredEvidence": ["tests run or blocker"], "failureClass": true },
      "promotionState": "promoted"
    },
    "reviewer": {
      "model": { "providerID": "openai", "modelID": "gpt-5.5", "variant": "xhigh" },
      "agent": "gateway-reviewer",
      "skills": ["gateway-stage", "gateway-review-gate"],
      "permission": { "gateway_*": "allow", "read": "allow", "edit": "deny", "bash": "allow" },
      "heartbeatMs": 0,
      "maxTokens": 120000,
      "role": "execution"
    },
    "verifier": {
      "model": { "providerID": "openai", "modelID": "gpt-5.5", "variant": "xhigh" },
      "agent": "gateway-verifier",
      "skills": ["gateway-stage", "gateway-review-gate"],
      "permission": { "gateway_*": "allow", "read": "allow", "edit": "deny", "bash": "allow" },
      "heartbeatMs": 0,
      "maxTokens": 120000,
      "role": "execution"
    },
    "supervisor": {
      "model": { "providerID": "openai", "modelID": "gpt-5.5", "variant": "xhigh" },
      "agent": "gateway-supervisor",
      "skills": ["gateway-supervisor"],
      "permission": { "gateway_*": "allow", "read": "allow", "edit": "deny", "bash": "ask" },
      "heartbeatMs": 0,
      "maxTokens": 120000,
      "role": "planning"
    }
  },
  "agentTeams": {},
  "channels": {
    "richMessages": { "enabled": true },
    "telegram": { "richMessages": { "enabled": true } },
    "whatsapp": {},
    "discord": { "enabled": false, "richMessages": { "enabled": true } }
  }
}
```

## Validation Bounds

| Field | Bounds |
| --- | --- |
| `httpPort` | `1` to `65535` |
| `heartbeat.intervalMs` | `1000` ms to `24h` |
| `channelSync.intervalMs` | `1000` ms to `24h` |
| `security.httpHost` | Hostname/IP characters only; default `127.0.0.1` |
| `security.capabilityScopedLoopback` | Default `true`. Loopback write/admin requests must present a capability-scoped bearer token; local read and provider-verified webhook routes remain reachable without a token. `opencode-gateway install` creates a `0600` admin token file and configures the supervised daemon with `OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE`; the CLI reads the same default token file. Set to `false` only to intentionally restore legacy loopback write trust. Also settable via `OPENCODE_GATEWAY_CAPABILITY_SCOPED_LOOPBACK` |
| `OPENCODE_GATEWAY_HTTP_{READ,OPERATOR,ASSET_WRITE,ADMIN,WEBHOOK}_TOKEN_FILE` | File-backed form of every scoped HTTP token. The target must be a regular, nonsymlink file owned by the effective service user, owner-only on POSIX, no larger than 8 KiB, and contain one nonempty single-line token. Safely loaded values participate in exact redaction; unsafe files are ignored as credentials |
| `security.requireNonMcpDestructiveApproval` | Default `true`. Destructive human-gate approvals arriving through the MCP proxy trust tier are rejected so the MCP tool cannot auto-approve its own destructive gates; the operator must approve out-of-band (HTTP/CLI). The daemon derives MCP surface from Gateway request headers, not JSON body `actor`/`source` fields. Also settable via `OPENCODE_GATEWAY_REQUIRE_NON_MCP_DESTRUCTIVE_APPROVAL` |
| `security.exposedHttp.requireStrongToken` | Default `true`. In exposed mode (`allowNonLocalHttp`), reject daemon startup when a configured HTTP token is shorter than `minTokenLength` or below `minTokenEntropyBits`. Only affects exposed-with-token deployments; localhost default and public-webhook/unsafe modes are unaffected. **Upgrade migration:** an existing exposed deployment whose token is short/low-entropy will now **fail to start** — rotate to a strong random token or set `requireStrongToken=false` to acknowledge the weaker token |
| `security.exposedHttp.minTokenLength` | `8` to `512`; default `16`. Minimum length for an exposed-mode HTTP token |
| `security.exposedHttp.minTokenEntropyBits` | `0` to `512`; default `48`. Minimum estimated entropy (length × log2 distinct chars) for an exposed-mode HTTP token |
| `security.exposedHttp.trustedProxyCidrs[]` | Empty by default. IPv4/IPv6 CIDRs for immediate reverse-proxy peers whose `Forwarded` or `X-Forwarded-For` chain may affect abuse-control client identity. Headers from any other socket peer are ignored. Gateway walks a trusted chain right-to-left and uses the first untrusted hop. If both header families are supplied, their complete normalized chains must match; malformed or conflicting families fall back to the socket peer. List only proxies that sanitize or append forwarding headers, never arbitrary client networks |
| `security.exposedHttp.rateLimit.*` | Exposed-mode-only sliding-window per-derived-client-address request limiter (returns `429` + `Retry-After`). `enabled` (default `true`), `windowMs` (`100`–`3600000`, default `60000`), `maxRequests` (`1`–`1000000`, default `120`), `maxTrackedClients` (`1`–`1000000`, default `4096`, LRU-evicted to bound memory). Without `trustedProxyCidrs`, the socket peer is the key. Keep edge-proxy rate limiting as the outer control |
| `security.exposedHttp.authLockout.*` | Exposed-mode-only consecutive-auth-failure lockout. Unknown/missing/malformed/rotating bearer guesses share one derived-address bucket; each configured valid credential has a separate one-way identity so invalid traffic cannot lock out a different valid token behind the same NAT/proxy. `enabled` (default `true`), `maxConsecutiveFailures` (`1`–`10000`, default `5`), `lockoutMs` (`100`–`86400000`, default `60000`). Successful authentication resets only its valid-credential key |
| `security.unsafeAllowAllChannelTargets.*` | Test-only bypass for fail-closed channel allowlists; production should keep `false` |
| `security.trustTargetMembersForFreeText` | Opt-out of per-sender actor trust for free text in trusted targets (default `false`, strict). When `true`, any member of a trusted target may send free text to the bound agent; privileged commands still require a trusted actor |
| `security.channelAllowlists.*[].chatId` | `1` to `256` characters |
| `security.channelAllowlists.*[].threadId` | up to `256` characters |
| `security.channelAllowlists.*[].userIds[]` | actor IDs trusted to send free text and run privileged channel commands for that target; each `1` to `256` characters. Claim-code trust records the claiming sender here automatically |
| `security.channelAllowlists.*[].adminUserIds[]` | admin actor IDs trusted to send free text and run privileged channel commands for that target; each `1` to `256` characters |
| `channels.discord.enabled` | defaults to `false`; must be explicit for the private alpha adapter |
| `governance.*CostUsd` | `0` to `1,000,000` |
| `governance.*.tokenLimit` | `0` to `10,000,000,000` |
| `governance.runtime.maxRunMs` | `0` to `30d`; `0` disables hard runtime kill |
| `governance.runtime.staleRunMs` | `0` to `30d` |
| `humanLoop.stageApprovals[]` | `1` to `64` letters, numbers, underscores, or dashes |
| `humanLoop.defaultTimeoutMs` | `1000` ms to `30d` |
| `humanLoop.timeoutAction` | `remind`, `escalate`, `pause`, or `block` |
| `humanLoop.priorityTimeoutMs.*` | `1000` ms to `30d` |
| `alerts.profileHealth.enabled` | `true`/`false` (default `true`); fires a proactive alert when a profile's genuine failure rate degrades |
| `alerts.profileHealth.windowDays` | `1` to `365` days (default `7`); lookback window for the per-profile scorecard the alert reads |
| `alerts.profileHealth.minRuns` | `1` to `100,000` (default `10`); minimum terminal runs in the window before the profile can alert, so a thin sample cannot cry wolf |
| `alerts.profileHealth.maxGenuineFailureRate` | `0` to `1` (default `0.5`); alert fires above this genuine failure rate. Genuine excludes operational (session-recovery/force-done/lease-expired) and external (provider-balance/transport/provider-error) errored runs, so Gateway run-lifecycle churn never trips it |
| `alerts.stuckTask.enabled` | `true`/`false` (default `true`); fires when a single task accumulates an excessive cumulative run count (the runaway signal), warning before `scheduler.maxRunsPerTask` hard-blocks it and escalating to critical once blocked |
| `alerts.stuckTask.runThreshold` | `1` to `1000` (default `15`); a task at or above this many total runs alerts. Keep it below `scheduler.maxRunsPerTask` so the operator is warned before the cap blocks the task |
| `alerts.delivery.enabled` | Default `false`. When true, active alert campaigns are delivered to configured trusted channel targets; resolved and suppressed alerts are not sent |
| `alerts.delivery.maxAttempts` | `1` to `100` (default `10`) per alert campaign and target. Failures are durable; reaching the cap records `alert.notification.dead_lettered` and requires operator repair |
| `alerts.delivery.targets[]` | Unique `{provider, chatId, threadId?, minimumSeverity}` targets. `provider` is `telegram`, `whatsapp`, or `discord`; IDs are `1` to `256` characters; `minimumSeverity` is `warning` or `critical` (default `critical`). Every target must also be present in `security.channelAllowlists` and have a configured provider adapter |
| `storage.backend` | Must be `local_sqlite` (the only supported backend); any other value is rejected |
| `storage.retention.runsMaxAgeDays` | `60` to `3650` days (default `90`); prunes only terminal runs older than this that are neither a task's most-recent run nor its current run — the `60`-day floor keeps every run inside the analytics/governance read windows |
| `storage.retention.receiptsMaxAgeDays` | `7` to `3650` days (default `90`); prunes idle dispatch/wakeup/progress receipt rows older than this (active leases and pending deliveries are always kept) |
| `environments.defaultEnvironment` | Must reference an entry in `environments.environments` |
| `environments.maxConcurrent` | `1` to `500` prepared/running environments |
| `environments.maxRetained` | `0` to `500` retained environments allowed before dispatch waits |
| `environments.backendMaxConcurrent.*` | `1` to `500` prepared/running/retained environments per backend |
| `environments.*.backend` | `local-process`, `local-container`, `remote-crabbox`, or `custom` |
| `environments.*.resources.timeoutMs` | `1000` ms to `30d` |
| `environments.*.network.mode` | `unrestricted`, `restricted`, or `disabled` |
| `environments.*.secrets.allow[]` | Environment variable names only; values are never stored |
| `environments.*.container.*` | `runtime`, `image`, `entrypoint`, `workdir`, `user`, `network`, `privileged`, `mounts`, `pull`, and `warm`; `local-container` requires `container.image` |
| `environments.*.crabbox.*` | `cli`, `brokerUrl`, `profile`, `provider`, `class`, `ttl`, `warm`, `keepOnFailure`, and `actionsHydration`; broker URL is passed to the CLI and redacted in run metadata |
| Repository `.gateway/env.*` overrides | Must extend an administrator environment and remain monotonic. They may add tools, validation, and ordinary env values or tighten limits; they cannot add setup, secret/cache/mount access, retention, images/entrypoints/runtimes, provider/class/broker selection, network access, or privilege. Repository workdirs are canonicalized and must stay inside the canonical checkout and outside sensitive roots |
| `scheduler.intervalMs` | `1000` ms to `24h` |
| `scheduler.maxConcurrent` | `1` to `20` |
| `scheduler.leaseMs` | `1m` to `7d` |
| `scheduler.retryLimit` | `0` to `10` (per-dispatch attempt cap) |
| `scheduler.maxRunsPerTask` | `1` to `1000` (default `25`); cumulative ceiling on how many **runs** a single task may ever accumulate. This counts runs — one per stage dispatch — not pipeline passes or retry attempts: a 3-stage pipeline (`implement`→`review`→`verify`) consumes ~3 runs per clean pass, and every retry/session-recovery re-dispatch is another run, so set it deliberately for long custom pipelines. A task that reaches the cap is blocked for operator attention (unblock/cancel/raise the cap) instead of being re-dispatched indefinitely — the guard against a runaway task silently consuming unbounded runs/spend. Separate from and higher than `retryLimit` |
| `scheduler.stageConcurrency.*` | `1` to `100` |
| `scheduler.profileConcurrency.*` | `1` to `100` |
| `profiles.*.promotionState` | `draft`, `evaluated`, `promoted`, `deprecated`, or `blocked` |
| `profiles.*.permission.*` | `allow`, `ask`, or `deny` |
| `profiles.*.budget.maxTokens` | `0` to `10,000,000,000` |
| `profiles.*.budget.maxCostUsd` | `0` to `1,000,000` |
| `profiles.*.budget.maxRuntimeMs` | `0` to `30d` |
| `profiles.*.budget.retryLimit` | `0` to `10` |
| `profiles.*.budget.humanGate` | `never`, `on-risk`, or `always` |
| `profiles.*.outputContract.format` | `text`, `json`, `stage-result`, or `supervisor-result` |
| `agentTeams.*.roles.*` | Existing profile names; `default` is required or inferred from `implement`/first role |
| `agentTeams.*.capabilityRequirements.*[]` | `1` to `128` letters, numbers, underscores, dashes, dots, colons, slashes, or asterisks |
| `agentTeams.*.version` | `1` to `64` letters, numbers, underscores, dashes, dots, or colons |
| `agentTeams.*.promotionState` | `draft`, `evaluated`, `promoted`, `deprecated`, or `blocked` |

See [Agent Contracts](agent-contracts.md) for the full production schema and [Agent Teams](agent-teams.md) for role/team/profile/OpenCode-agent distinctions and safe examples.

Config parsing fails closed on malformed JSON. Gateway does not silently fall back to defaults when a config file exists but cannot be parsed.

## Routing File

Channel/user routing config path:

```text
~/.config/opencode-gateway/routing.json
```

Default routing:

```json
{
  "default": "gateway-assistant",
  "routes": [
    { "pattern": "status|health|doctor|logs|config|channel", "agent": "gateway-coordinator" },
    { "pattern": "plan|roadmap|task|queue|scheduler", "agent": "gateway-planner" },
    { "pattern": "implement|fix|build|change", "agent": "gateway-implementer" },
    { "pattern": "review|verify|audit", "agent": "gateway-reviewer" }
  ]
}
```
