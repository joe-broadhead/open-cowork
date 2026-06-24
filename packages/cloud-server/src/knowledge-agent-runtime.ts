import {
  signKnowledgeAgentToken,
  KNOWLEDGE_AGENT_TOKEN_TTL_MS,
} from './knowledge-agent-token.ts'

// Structural subset of the OpenCode `Config` we touch. Declared locally (rather
// than importing `@opencode-ai/sdk`) so this module stays OUTSIDE the documented
// OpenCode SDK runtime boundary (see docs/opencode-sdk-v2-boundary.md); the real
// `Config` typing is applied in app.ts, which is a boundary module. The injected
// `knowledge` entry is a local-command MCP, matching `McpLocalConfig`.
type RuntimeMcpLocalEntry = {
  type: 'local'
  command: string[]
  enabled?: boolean
}
type RuntimeConfigWithMcp = {
  mcp?: Record<string, unknown>
  [key: string]: unknown
}

// Per-session spawn wiring for the cloud knowledge-agent write-path. When (and
// ONLY when) knowledge is enabled AND a signing secret AND a public URL are
// available, we mint a per-session, tenant-scoped signed token and expose it to
// the spawned OpenCode runtime so the bundled knowledge MCP can reach the cloud
// agent-propose route:
//   - env  OPEN_COWORK_KNOWLEDGE_TOOL_URL   = <publicUrl>/api/knowledge/agent
//   - env  OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN = <minted per-session token>
//   - mcp  knowledge = { type: 'local', command: ['node', <mcpScriptPath>] }
//
// The MCP's contract is `${OPEN_COWORK_KNOWLEDGE_TOOL_URL}/propose`, so the base
// path resolves to `/api/knowledge/agent/propose` — the route registered in
// http-server.ts. Fail closed: if knowledge is disabled, or there is no secret,
// public URL, or MCP script path, NOTHING is injected (returns null) and the
// route would reject anyway.

// The MCP resolves its own base path from OPEN_COWORK_KNOWLEDGE_TOOL_URL and
// appends `/propose`. Keep this in lockstep with the route in http-server.ts.
export const KNOWLEDGE_AGENT_ROUTE_BASE_PATH = '/api/knowledge/agent'

export type KnowledgeAgentRuntimeAugmentationInput = {
  knowledgeEnabled: boolean
  /** Cloud signing secret; absent ⇒ fail closed (no token minted). */
  secret: string | null | undefined
  /** Stable public origin, e.g. https://cloud.example.com; absent ⇒ fail closed. */
  publicUrl: string | null | undefined
  /** Filesystem path to the bundled cloud knowledge MCP; absent ⇒ fail closed. */
  mcpScriptPath: string | null | undefined
  execution: { tenantId: string; sessionId: string }
  now?: () => number
  ttlMs?: number
}

export type KnowledgeAgentRuntimeAugmentation = {
  env: Record<string, string>
  mcp: Record<string, RuntimeMcpLocalEntry>
}

function knowledgeAgentToolUrl(publicUrl: string) {
  // Trim a trailing slash so `${base}/propose` (the MCP's contract) is clean.
  return `${publicUrl.replace(/\/+$/, '')}${KNOWLEDGE_AGENT_ROUTE_BASE_PATH}`
}

export function buildKnowledgeAgentRuntimeAugmentation(
  input: KnowledgeAgentRuntimeAugmentationInput,
): KnowledgeAgentRuntimeAugmentation | null {
  const secret = input.secret?.trim()
  const publicUrl = input.publicUrl?.trim()
  const mcpScriptPath = input.mcpScriptPath?.trim()
  const tenantId = input.execution.tenantId?.trim()
  const sessionId = input.execution.sessionId?.trim()
  // Fail closed on any missing prerequisite.
  if (!input.knowledgeEnabled || !secret || !publicUrl || !mcpScriptPath || !tenantId || !sessionId) {
    return null
  }
  const nowMs = (input.now ?? Date.now)()
  const token = signKnowledgeAgentToken(secret, {
    tenantId,
    sessionId,
    exp: nowMs + (input.ttlMs ?? KNOWLEDGE_AGENT_TOKEN_TTL_MS),
  })
  return {
    env: {
      OPEN_COWORK_KNOWLEDGE_TOOL_URL: knowledgeAgentToolUrl(publicUrl),
      OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN: token,
    },
    mcp: {
      knowledge: {
        type: 'local',
        command: ['node', mcpScriptPath],
        enabled: true,
      },
    },
  }
}

// Merge the augmentation into a per-session runtime config + env. Returns new
// objects (does not mutate the inputs) so the shared process env / base config
// are never polluted across sessions. When no augmentation applies, the inputs
// are returned structurally unchanged.
export function applyKnowledgeAgentRuntimeAugmentation<
  E extends Record<string, string | undefined>,
  C extends RuntimeConfigWithMcp | undefined,
>(
  input: {
    env: E
    runtimeConfig: C
    augmentation: KnowledgeAgentRuntimeAugmentation | null
  },
): { env: E; runtimeConfig: C | (RuntimeConfigWithMcp & Record<string, unknown>) } {
  if (!input.augmentation) {
    return { env: input.env, runtimeConfig: input.runtimeConfig }
  }
  return {
    env: { ...input.env, ...input.augmentation.env },
    runtimeConfig: {
      ...(input.runtimeConfig ?? {}),
      mcp: {
        ...(input.runtimeConfig?.mcp ?? {}),
        ...input.augmentation.mcp,
      },
    },
  }
}
