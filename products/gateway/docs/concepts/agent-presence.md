# AgentPresence (always-on assistants)

AgentPresence is Gateway’s durable binding for claw-style always-on assistants.

> OpenCode owns the agent definition and the session. Gateway owns the sticky
> binding, channel route, and status that survive restarts.

**Name note:** this is **not** channel “typing/presence” indicators
(`channel-actions`). Those remain separate.

## Model

| Field | Meaning |
| --- | --- |
| `presenceId` | Durable id (`ap_…`) |
| `kind` | `assistant` in v1 |
| `name` | Operator label |
| `opencodeAgent` | OpenCode agent name (must **already exist** in OpenCode config) |
| `sessionId` | Sticky OpenCode session |
| `provider` / `chatId` / `threadId` | Optional channel surface for free-text routing |
| `status` | `active` \| `paused` \| `blocked` \| `archived` |
| `wake` | Reserved JSON for future cadence policy; **not scheduled in v1** |

**v1 always-on model = sticky session + status routing**, not roadmap-supervisor
wake leases. Free-text on a bound trusted channel is routed into the sticky
session when status is `active`.

## Create

```bash
opencode-gateway persona create concierge --prompt "You are concierge."
opencode-gateway presence create --name home --agent concierge --provider telegram --chat-id <id>
```

HTTP/MCP forbid `skipAgentCheck`; only unit tests may use the internal
`createAgentPresenceForTest` helper.

## Boundaries

- No second persona runtime inside Gateway.
- Roadmap supervisors remain the roadmap controller; AgentPresence is chat/assistant-scoped.
- Capability state: **partial** until dogfood evidence + optional wake policy land.
