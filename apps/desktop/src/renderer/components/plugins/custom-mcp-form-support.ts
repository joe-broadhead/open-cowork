import type {
  CustomMcpConfig,
  CustomMcpPermissionMode as SharedCustomMcpPermissionMode,
  CustomSkillConfig,
} from '@open-cowork/shared'

export const customMcpInputClass = 'w-full px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border'
export const CUSTOM_MCP_VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

export type CustomMcpFormType = 'stdio' | 'http'
export type CustomMcpFormScope = 'machine' | 'project'
export type CustomMcpPermissionMode = SharedCustomMcpPermissionMode
export type KeyValueDraft = { id: string; key: string; value: string }

let nextKeyValueDraftId = 0

export function createKeyValueDraft(key = '', value = ''): KeyValueDraft {
  nextKeyValueDraftId += 1
  return { id: `custom-mcp-field-${nextKeyValueDraftId}`, key, value }
}

export function createKeyValueDraftsFromRecord(record?: Record<string, string>): KeyValueDraft[] {
  const entries = Object.entries(record || {})
  if (entries.length === 0) return [createKeyValueDraft()]
  return entries.map(([key, value]) => createKeyValueDraft(key, value))
}

export function buildCustomMcpDraft({
  scope,
  projectTargetDirectory,
  name,
  label,
  description,
  traceLabel,
  tracePluralLabel,
  type,
  command,
  args,
  url,
  envPairs,
  headerPairs,
  googleAuthEnabled,
  authModeAvailable,
  allowPrivateNetwork,
  permissionMode,
}: {
  scope: CustomMcpFormScope
  projectTargetDirectory: string | null
  name: string
  label: string
  description: string
  traceLabel?: string
  tracePluralLabel?: string
  type: CustomMcpFormType
  command: string
  args: string
  url: string
  envPairs: readonly KeyValueDraft[]
  headerPairs: readonly KeyValueDraft[]
  googleAuthEnabled: boolean
  authModeAvailable: boolean
  allowPrivateNetwork: boolean
  permissionMode: CustomMcpPermissionMode
}): CustomMcpConfig {
  const mcp: CustomMcpConfig = {
    scope,
    directory: scope === 'project' ? projectTargetDirectory || null : null,
    name: name.trim(),
    label: label.trim() || undefined,
    description: description.trim() || undefined,
    traceLabel: traceLabel?.trim() || undefined,
    tracePluralLabel: tracePluralLabel?.trim() || undefined,
    type,
  }

  if (type === 'stdio') {
    mcp.command = command.trim()
    mcp.args = args.trim() ? args.trim().split(/\s+/).filter(Boolean) : []
    const env = keyValueDraftsToRecord(envPairs)
    if (Object.keys(env).length > 0) mcp.env = env
    if (googleAuthEnabled && authModeAvailable) mcp.googleAuth = true
  } else {
    mcp.url = url.trim()
    const headers = keyValueDraftsToRecord(headerPairs)
    if (Object.keys(headers).length > 0) mcp.headers = headers
    if (allowPrivateNetwork) mcp.allowPrivateNetwork = true
  }

  if (permissionMode === 'allow') mcp.permissionMode = 'allow'
  return mcp
}

function keyValueDraftsToRecord(pairs: readonly KeyValueDraft[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const { key, value } of pairs) {
    if (key.trim()) record[key.trim()] = value
  }
  return record
}

export function collectCustomMcpIssues({
  draft,
  isEditing,
  existingNames,
  scope,
  projectTargetDirectory,
  type,
}: {
  draft: CustomMcpConfig
  isEditing: boolean
  existingNames: readonly string[]
  scope: CustomMcpFormScope
  projectTargetDirectory: string | null
  type: CustomMcpFormType
}): string[] {
  const next: string[] = []
  if (!draft.name) {
    next.push('Add an MCP id so the runtime can register it.')
  } else if (!CUSTOM_MCP_VALID_NAME.test(draft.name)) {
    next.push('Use alphanumeric characters, hyphens, or underscores only for the MCP id.')
  }
  if (draft.name && !isEditing && existingNames.includes(draft.name)) {
    next.push(`A custom MCP named "${draft.name}" already exists.`)
  }
  if (scope === 'project' && !projectTargetDirectory) {
    next.push('Choose a project directory for this project-scoped MCP.')
  }
  if (type === 'stdio' && !draft.command?.trim()) {
    next.push('Add the stdio command that starts this MCP server.')
  }
  if (type === 'http' && !draft.url?.trim()) {
    next.push('Add the HTTP or SSE endpoint URL for this MCP server.')
  }
  return next
}

export function linkedSkillNamesForMcp(skills: readonly CustomSkillConfig[], mcpName: string): string[] {
  return skills
    .filter((skill) => (skill.toolIds || []).includes(mcpName))
    .map((skill) => skill.name)
}

export function toggleStringSelection(current: readonly string[], value: string): string[] {
  return current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value]
}

export function nextSkillToolIdsForMcp({
  currentToolIds,
  mcpId,
  shouldBeLinked,
}: {
  currentToolIds: readonly string[]
  mcpId: string
  shouldBeLinked: boolean
}): string[] | null {
  const currentlyLinked = currentToolIds.includes(mcpId)
  if (currentlyLinked === shouldBeLinked) return null
  if (shouldBeLinked) return Array.from(new Set([...currentToolIds, mcpId]))
  return currentToolIds.filter((id) => id !== mcpId)
}
