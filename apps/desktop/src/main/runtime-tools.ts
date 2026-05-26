import type { RuntimeContextOptions } from '@open-cowork/shared'
import { getEffectiveSettings } from './settings.ts'
import { getV2ClientForDirectory, getRuntimeHomeDir } from './runtime.ts'
import { ensureRuntimeContextDirectory } from './runtime-context.ts'
import { resolveProjectDirectory } from './runtime-paths.ts'
import { log } from './logger.ts'
import {
  RUNTIME_TOOL_CACHE_TTL_MS,
  currentRuntimeToolCacheGeneration,
  runtimeToolCache,
  runtimeToolInflight,
} from './runtime-tool-cache.ts'
import { sdkErrorMessage } from './sdk-error.ts'

export type RuntimeToolMetadata = {
  id: string
  description: string
}

type ResolvedRuntimeToolContext = {
  directory: string
  provider: string
  model: string
  logScope?: string
}

const HIDDEN_RUNTIME_TOOL_IDS = new Set([
  'skill',
  'invalid',
])

const NATIVE_WRITE_TOOLS = new Set([
  'bash',
  'edit',
  'write',
  'apply_patch',
  'task',
  'todowrite',
])

export function runtimeToolId(entry: unknown) {
  const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null
  return typeof record?.id === 'string'
    ? record.id
    : typeof record?.name === 'string'
      ? record.name
      : ''
}

export function isVisibleRuntimeToolId(id: string) {
  return Boolean(id) && !HIDDEN_RUNTIME_TOOL_IDS.has(id)
}

export function humanizeToolId(value: string) {
  if (value === 'task') return 'Task Delegation'
  if (value === 'websearch') return 'Web Search'
  if (value === 'webfetch') return 'Web Fetch'
  if (value === 'todowrite') return 'Todo Write'
  if (value === 'apply_patch') return 'Apply Patch'
  return value
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function nativeToolSupportsWrite(id: string) {
  return NATIVE_WRITE_TOOLS.has(id)
}

export function nativeToolPermissionPatterns(id: string) {
  return nativeToolSupportsWrite(id)
    ? { allowPatterns: [] as string[], askPatterns: [id] }
    : { allowPatterns: [id], askPatterns: [] as string[] }
}

export async function listRuntimeToolsForResolvedContext(context: ResolvedRuntimeToolContext) {
  const { directory, provider, model, logScope = 'runtime tool discovery' } = context
  if (!provider || !model) return []

  const cacheKey = `${directory}|${provider}|${model}`
  const now = Date.now()
  const cached = runtimeToolCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.tools
  }

  const inflight = runtimeToolInflight.get(cacheKey)
  if (inflight) return await inflight.promise

  const generation = currentRuntimeToolCacheGeneration()
  const promise = (async () => {
    await ensureRuntimeContextDirectory(directory)

    const client = getV2ClientForDirectory(directory)
    if (!client) return []

    try {
      const result = await client.tool.list({
        directory,
        provider,
        model,
      }, {
        throwOnError: true,
      })
      const tools = (result.data || []).filter((entry) => isVisibleRuntimeToolId(runtimeToolId(entry)))
      if (currentRuntimeToolCacheGeneration() === generation) {
        runtimeToolCache.set(cacheKey, { expiresAt: Date.now() + RUNTIME_TOOL_CACHE_TTL_MS, tools })
      }
      return tools
    } catch (error) {
      log('error', `${logScope} failed: ${sdkErrorMessage(error)}`)
      return []
    }
  })()
  const inflightEntry = { promise }

  runtimeToolInflight.set(cacheKey, inflightEntry)
  try {
    return await promise
  } finally {
    if (runtimeToolInflight.get(cacheKey) === inflightEntry) {
      runtimeToolInflight.delete(cacheKey)
    }
  }
}

export async function listRuntimeToolsForContext(context?: RuntimeContextOptions) {
  const settings = getEffectiveSettings()
  const provider = settings.effectiveProviderId || ''
  const model = settings.effectiveModel || ''
  const directory = resolveProjectDirectory(context?.directory) || getRuntimeHomeDir()

  return listRuntimeToolsForResolvedContext({
    directory,
    provider,
    model,
    logScope: 'runtime tool discovery',
  })
}

export function toRuntimeToolMetadata(entry: unknown): RuntimeToolMetadata | null {
  const id = runtimeToolId(entry)
  if (!isVisibleRuntimeToolId(id)) return null
  const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null
  const description = typeof record?.description === 'string' && record.description.trim().length > 0
    ? record.description.trim()
    : 'Native OpenCode tool available in the current runtime context.'
  return { id, description }
}
