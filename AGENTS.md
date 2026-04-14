# Open Cowork Repository

This file is for coding contributors and local coding agents working on the Open Cowork codebase.

## Scope

- Product runtime behavior lives in [apps/desktop/runtime-config/AGENTS.md](apps/desktop/runtime-config/AGENTS.md).
- Built-in agent policy lives in [apps/desktop/src/main/agent-config.ts](apps/desktop/src/main/agent-config.ts).

Do not duplicate product agent behavior across multiple prompt files when code or generated prompts are the real source of truth.

## Editing guidance

- Prefer changing runtime behavior in code and generated agent config rather than patching prompts alone.
- Keep the runtime prompt high-level and stable; keep exact orchestration rules centralized in code.
- Treat custom sub-agents as OpenCode-native agents generated into runtime config, not as a separate Open Cowork execution system.
- Preserve the separation between parent-session UI and delegated child-session task runs.
