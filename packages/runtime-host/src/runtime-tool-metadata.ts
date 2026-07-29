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
