# Managed OpenCode server hosts

Open Cowork runs a **managed OpenCode server** as a child process. Two host
entrypoints share the same core (`runtime-managed-server-core`) and differ only
in how the supervisor is forked.

## When each host is used

| Host | Module | Process model | Used by |
| --- | --- | --- | --- |
| Electron utilityProcess | `packages/runtime-host/src/runtime-managed-server.ts` | Electron `utilityProcess.fork` | Desktop main process |
| Node child_process | `packages/runtime-host/src/runtime-node-managed-server.ts` | `child_process.fork` | Cloud worker / non-Electron runtimes |

Shared:

- `runtime-managed-server-core.ts` — lifecycle, protocol, restart policy
- `runtime-managed-server-protocol.ts` — parent/supervisor messages
- `runtime-managed-server-output.ts` — log tail helpers
- `runtime-managed-server-supervisor.ts` — supervisor entry

## Drift control (JOE-869)

1. **Keep the split** — Electron utilityProcess isolation is intentional for desktop;
   cloud must not depend on Electron APIs.
2. **Maximize shared core tests** — behavior changes land in core + shared tests;
   host modules stay thin fork adapters.
3. **Do not** reimplement restart/protocol logic in either host module.

Desktop injects the utilityProcess forker at startup via
`setManagedOpencodeSupervisorForker`. Cloud uses the Node host factory directly.
