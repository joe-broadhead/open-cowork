import type { RuntimeContextOptions } from '@open-cowork/shared'
import { getEffectiveSettings } from './settings.ts'
import { getV2ClientForDirectory, getRuntimeHomeDir } from './runtime.ts'
import { ensureRuntimeContextDirectory } from './runtime-context.ts'
import { resolveProjectDirectory } from './runtime-paths.ts'
import { log } from './logger.ts'

export type RuntimeToolMetadata = {
  id: string
  description: string
}

const NATIVE_WRITE_TOOLS = new Set([
  'bash',
  'edit',
  'write',
  'apply_patch',
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

export function humanizeToolId(value: string) {
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

export function isNativeRuntimeTool(entry: unknown) {
  const id = runtimeToolId(entry)
  return Boolean(id) && !id.startsWith('mcp__')
}

export function nativeToolSupportsWrite(id: string) {
  return NATIVE_WRITE_TOOLS.has(id)
}

export function nativeToolPermissionPatterns(id: string) {
  return nativeToolSupportsWrite(id)
    ? { allowPatterns: [] as string[], askPatterns: [id] }
    : { allowPatterns: [id], askPatterns: [] as string[] }
}

export async function listRuntimeToolsForContext(context?: RuntimeContextOptions) {
  const settings = getEffectiveSettings()
  const provider = settings.effectiveProviderId || ''
  const model = settings.effectiveModel || ''
  const directory = resolveProjectDirectory(context?.directory) || getRuntimeHomeDir()

  if (!provider || !model) return []

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
    return result.data || []
  } catch (error) {
    log('error', `runtime tool discovery failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

export function toRuntimeToolMetadata(entry: unknown): RuntimeToolMetadata | null {
  const id = runtimeToolId(entry)
  if (!id) return null
  const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null
  const description = typeof record?.description === 'string' && record.description.trim().length > 0
    ? record.description.trim()
    : 'Native OpenCode tool available in the current runtime context.'
  return { id, description }
}
