import { getEffectiveSettings } from '@open-cowork/runtime-host/settings'
import { humanizeToolId, isVisibleRuntimeToolId, runtimeToolId } from '@open-cowork/runtime-host/runtime-tools'
import { resolveConfiguredMcpRuntimeEntry, resolveCustomMcpRuntimeEntryForRuntime, type ResolvedRuntimeMcpEntry } from '@open-cowork/runtime-host/runtime-mcp'
import { listCustomMcps } from '@open-cowork/runtime-host/native-customizations'
import { validateCustomMcpStdioCommand } from '@open-cowork/runtime-host/mcp-stdio-policy'
import { getCustomAgentCatalog } from '@open-cowork/runtime-host/custom-agents'
import { buildCustomAgentPermissionFromCatalog } from '@open-cowork/runtime-host/custom-agents-utils'
import type {
  CapabilityTool,
  CapabilityToolEntry,
  CustomAgentConfig,
  RuntimeContextOptions,
} from '@open-cowork/shared'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { listBuiltInAgentDetails } from './built-in-agent-details.ts'
type CapabilityToolDiscoveryDeps = {
  resolveContextDirectory: (options?: RuntimeContextOptions) => string | null
  logHandlerError: (handler: string, err: unknown) => void
  capabilityToolMethodCache: Map<string, { expiresAt: number; entries: CapabilityToolEntry[] }>
}

export const CAPABILITY_TOOL_DISCOVERY_TIMEOUT_MS = 5_000

type CapabilityToolDiscoveryOptions = RuntimeContextOptions & {
  deep?: boolean
  discoveryTimeoutMs?: number
  signal?: AbortSignal
}

export type ListToolsFromMcpEntryOptions = {
  timeoutMs?: number
  signal?: AbortSignal
}

export async function buildCustomAgentPermission(agent: CustomAgentConfig, options?: RuntimeContextOptions) {
  const catalog = await getCustomAgentCatalog(options)
  return buildCustomAgentPermissionFromCatalog(agent, catalog)
}

function capabilityToolPrefixes(tool: CapabilityTool) {
  const prefixes = new Set<string>()

  if (tool.namespace) {
    prefixes.add(`mcp__${tool.namespace}__`)
    prefixes.add(`${tool.namespace}_`)
  }

  prefixes.add(`mcp__${tool.id}__`)
  prefixes.add(`${tool.id}_`)

  return Array.from(prefixes)
}

function runtimeToolMatchesCapability(entry: unknown, tool: CapabilityTool) {
  const id = runtimeToolId(entry)
  if (!id) return false
  if (id === tool.id) return true
  return capabilityToolPrefixes(tool).some((prefix) => id.startsWith(prefix))
}

function isMcpBackedCapability(tool: CapabilityTool) {
  return Boolean(tool.namespace) || tool.patterns.some((pattern) => pattern.startsWith('mcp__'))
}

function capabilityDiscoveryTimeoutError(timeoutMs: number) {
  const error = new Error(`MCP capability discovery timed out after ${timeoutMs}ms.`)
  error.name = 'TimeoutError'
  return error
}

function createDiscoveryAbortSignal(options: ListToolsFromMcpEntryOptions) {
  const timeoutMs = options.timeoutMs ?? CAPABILITY_TOOL_DISCOVERY_TIMEOUT_MS
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | null = null
  const onCallerAbort = () => {
    controller.abort(options.signal?.reason || new Error('MCP capability discovery was cancelled.'))
  }

  if (options.signal?.aborted) {
    onCallerAbort()
  } else {
    options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  }

  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      controller.abort(capabilityDiscoveryTimeoutError(timeoutMs))
    }, timeoutMs)
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeout) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onCallerAbort)
    },
  }
}

function abortReason(signal: AbortSignal) {
  const reason = signal.reason
  return reason instanceof Error ? reason : new Error('MCP capability discovery was cancelled.')
}

async function withDiscoveryAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal)
  let cleanup = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    return await Promise.race([operation, aborted])
  } finally {
    cleanup()
  }
}

export async function listToolsFromMcpEntry(entry: unknown, options: ListToolsFromMcpEntryOptions = {}) {
  if (!entry) return []

  const runtimeEntry = entry as ResolvedRuntimeMcpEntry
  const client = new McpClient(
    { name: 'open-cowork-capabilities', version: '1.0.0' },
    { capabilities: {} },
  )

  const abort = createDiscoveryAbortSignal(options)

  try {
    if (runtimeEntry.type === 'local') {
      const [command, ...args] = runtimeEntry.command
      if (!command) return []
      const transport = new StdioClientTransport({
        command,
        args,
        env: runtimeEntry.environment,
        stderr: 'pipe',
      })
      await withDiscoveryAbort(client.connect(transport), abort.signal)
    } else {
      const requestInit: RequestInit = {
        ...(runtimeEntry.headers ? { headers: runtimeEntry.headers } : {}),
        signal: abort.signal,
      }
      const transport = new StreamableHTTPClientTransport(new URL(runtimeEntry.url), {
        requestInit,
      })
      await withDiscoveryAbort(client.connect(transport), abort.signal)
    }

    const result = await withDiscoveryAbort(client.listTools(), abort.signal)
    return (result.tools || []).map((tool: { name: string; description?: string }) => ({
      id: tool.name,
      description: tool.description?.trim() || 'No description available for this MCP method.',
    }))
  } finally {
    abort.cleanup()
    await client.close().catch(() => {})
  }
}

export function isLikelyMcpAuthError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '')
  return /missing authorization header|invalid_token|unauthorized|forbidden|40[13]|needs_auth|oauth/i.test(message)
}

async function discoverCapabilityToolEntries(
  tool: CapabilityTool,
  options: CapabilityToolDiscoveryOptions | undefined,
  deps: CapabilityToolDiscoveryDeps,
) {
  if (!isMcpBackedCapability(tool)) return tool.availableTools || []

  const cacheKey = `${tool.source}:${tool.id}:${tool.namespace || ''}:${deps.resolveContextDirectory(options) || 'machine'}`
  const cached = deps.capabilityToolMethodCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.entries
  }

  const settings = getEffectiveSettings()
  const builtinEntry = tool.source === 'builtin'
    ? resolveConfiguredMcpRuntimeEntry(tool.namespace || tool.id, settings)
    : null
  const matchingCustomMcp = tool.source === 'custom'
    ? listCustomMcps(options).find((entry) => entry.name === tool.id || entry.name === tool.namespace) || null
    : null
  const customEntry = matchingCustomMcp
    ? await resolveCustomMcpRuntimeEntryForRuntime(matchingCustomMcp)
    : null

  if (matchingCustomMcp?.type === 'stdio') {
    try {
      validateCustomMcpStdioCommand(matchingCustomMcp)
    } catch (error) {
      deps.logHandlerError(`capability:mcp-tools ${tool.id}`, error)
      return []
    }
  }

  const shouldSkipDirectProbe = Boolean(
    matchingCustomMcp
    && matchingCustomMcp.type === 'http'
    && (!matchingCustomMcp.headers || Object.keys(matchingCustomMcp.headers).length === 0),
  )
  if (shouldSkipDirectProbe) return []

  const entries = await listToolsFromMcpEntry(builtinEntry || customEntry, {
    timeoutMs: options?.discoveryTimeoutMs,
    signal: options?.signal,
  }).catch((error) => {
    deps.logHandlerError(`capability:mcp-tools ${tool.id}`, error)
    return []
  })

  // Bound the cache so a long-running session with many projects x tools
  // can't grow the map unbounded. The key space is
  // `source:id:namespace:directory` so collisions across users are rare;
  // when we hit the cap we evict the oldest entry (FIFO is sufficient
  // since all entries share the same 30s TTL).
  const CAPABILITY_CACHE_MAX = 500
  if (deps.capabilityToolMethodCache.size >= CAPABILITY_CACHE_MAX) {
    const oldestKey = deps.capabilityToolMethodCache.keys().next().value
    if (oldestKey !== undefined) deps.capabilityToolMethodCache.delete(oldestKey)
  }
  deps.capabilityToolMethodCache.set(cacheKey, {
    expiresAt: Date.now() + 30_000,
    entries,
  })

  return entries
}

export function createCapabilityToolDiscovery(deps: CapabilityToolDiscoveryDeps) {
  return {
    async withDiscoveredBuiltInTools(
      tools: CapabilityTool[],
      runtimeTools: unknown[],
      options?: CapabilityToolDiscoveryOptions,
    ) {
      const builtInAgentDetails = listBuiltInAgentDetails()
      const nativeToolEntries = new Map<string, CapabilityTool>()

      for (const entry of runtimeTools) {
        const id = runtimeToolId(entry)
        if (!id) continue
        if (!isVisibleRuntimeToolId(id)) continue
        if (id.startsWith('mcp__')) continue
        if (tools.some((tool) => runtimeToolMatchesCapability(entry, tool))) continue

        const agentNames = builtInAgentDetails
          .filter((agent) => agent.nativeToolIds.includes(id))
          .map((agent) => agent.label)

        const description = typeof (entry as { description?: string })?.description === 'string' && (entry as { description?: string }).description!.trim().length > 0
          ? (entry as { description?: string }).description!.trim()
          : 'Native OpenCode tool available in the current runtime context.'

        nativeToolEntries.set(id, {
          id,
          name: humanizeToolId(id),
          description,
          kind: 'built-in',
          source: 'builtin',
          origin: 'opencode',
          namespace: null,
          patterns: [id],
          availableTools: [
            {
              id,
              description,
            },
          ],
          agentNames,
        })
      }

      const combined = [...tools, ...nativeToolEntries.values()].sort((a, b) => a.name.localeCompare(b.name))

      return Promise.all(combined.map(async (tool) => {
        const runtimeEntries = runtimeTools
          .filter((entry) => runtimeToolMatchesCapability(entry, tool))
          .map((entry) => ({
            id: runtimeToolId(entry),
            description: typeof (entry as { description?: string })?.description === 'string' && (entry as { description?: string }).description!.trim().length > 0
              ? (entry as { description?: string }).description!.trim()
              : 'No description available for this MCP method.',
          }))
          .filter((entry): entry is CapabilityToolEntry => Boolean(entry.id))

        if (runtimeEntries.length > 0) {
          return { ...tool, availableTools: runtimeEntries }
        }

        if (!isMcpBackedCapability(tool)) {
          return tool
        }

        // `deep` is the opt-in for the expensive per-MCP probe. List
        // views (the Capabilities grid) skip it: the card renders from
        // name + description + icon alone, and probing 16 MCPs on every
        // page open pushes the IPC into 3-5s. Detail views
        // (capabilities.tool(id)) pass deep:true so the method table is
        // populated when the user actually opens one tool.
        if (!options?.deep) return tool

        const fallbackEntries = await discoverCapabilityToolEntries(tool, options, deps)
        if (fallbackEntries.length > 0) {
          return { ...tool, availableTools: fallbackEntries }
        }

        return tool
      }))
    },
  }
}
