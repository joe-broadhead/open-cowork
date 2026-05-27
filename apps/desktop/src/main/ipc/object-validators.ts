import type {
  ChartSaveArtifactRequest,
  CustomAgentConfig,
  CustomMcpConfig,
  CustomSkillConfig,
  DestructiveConfirmationRequest,
  RuntimeContextOptions,
  ScopedArtifactRef,
  SessionArtifactExportRequest,
  SessionArtifactListRequest,
  SessionArtifactRequest,
  SessionArtifactUploadRequest,
  ThreadSearchQuery,
  ToolListOptions,
  WorkspaceOptions,
} from '@open-cowork/shared'
import type { CoworkSettings } from '../settings.ts'
import { assertCustomMcpContentLimits, assertCustomSkillContent, assertCustomSkillFiles } from '../custom-content-limits.ts'
import { validateCustomAgentContentLimits } from '../custom-content-limits.ts'
import { normalizeThreadSearchQuery } from '../thread-index/thread-index-normalizers.ts'

const MAX_IPC_STRING_BYTES = 64 * 1024
const MAX_IPC_ID_BYTES = 512
const MAX_SETTINGS_UPDATE_BYTES = 512 * 1024
const MAX_CHART_DATA_URL_BYTES = 8 * 1024 * 1024 + 128
const MAX_ARTIFACT_UPLOAD_BASE64_BYTES = 35 * 1024 * 1024
const SCOPES = new Set(['machine', 'project'])
const MCP_TYPES = new Set(['stdio', 'http'])
const MCP_PERMISSION_MODES = new Set(['ask', 'allow'])
const AGENT_COLORS = new Set(['primary', 'warning', 'accent', 'success', 'info', 'secondary'])
const RUNTIME_PERMISSION_POLICIES = new Set(['allow', 'ask', 'deny'])
const RUNTIME_CONFIG_SOURCES = new Set(['app', 'machine'])
const DESTRUCTIVE_ACTIONS = new Set(['session.delete', 'agent.remove', 'mcp.remove', 'skill.remove', 'app.reset'])

const SETTINGS_UPDATE_KEYS = new Set([
  '_schemaVersion',
  'selectedProviderId',
  'selectedModelId',
  'selectedSmallModelId',
  'providerCredentials',
  'integrationCredentials',
  'integrationEnabled',
  'bashPermission',
  'fileWritePermission',
  'enableBash',
  'enableFileWrite',
  'runtimeConfigSource',
  'runtimeToolingBridgeEnabled',
  'workflowLaunchAtLogin',
  'workflowRunInBackground',
  'workflowDesktopNotifications',
  'workflowQuietHoursStart',
  'workflowQuietHoursEnd',
  'workspaceId',
])

function byteLength(value: string) {
  return Buffer.byteLength(value, 'utf8')
}

function assertJsonSize(value: unknown, label: string, maxBytes: number) {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error(`${label} must be JSON-serializable.`)
  }
  if (byteLength(serialized) > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  }
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, key: string, label: string, maxBytes = MAX_IPC_STRING_BYTES) {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  const trimmed = value.trim()
  if (byteLength(trimmed) > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  }
  return trimmed
}

function rawString(record: Record<string, unknown>, key: string, label: string, maxBytes = MAX_IPC_STRING_BYTES) {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  if (byteLength(value) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  return value
}

function optionalString(record: Record<string, unknown>, key: string, label: string, maxBytes = MAX_IPC_STRING_BYTES) {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  if (byteLength(value) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  return value
}

function optionalNullableString(record: Record<string, unknown>, key: string, label: string, maxBytes = MAX_IPC_STRING_BYTES) {
  const value = record[key]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string or null.`)
  if (byteLength(value) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  return value
}

function optionalBoolean(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`)
  return value
}

function optionalNumber(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key]
  if (value === undefined || value === null) return value as undefined | null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`)
  return value
}

function optionalStringArray(record: Record<string, unknown>, key: string, label: string, maxItems = 128) {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
  if (value.length > maxItems) throw new Error(`${label} exceeds ${maxItems} entries.`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`${label}[${index}] must be a string.`)
    if (byteLength(entry) > MAX_IPC_STRING_BYTES) throw new Error(`${label}[${index}] is too large.`)
    return entry
  })
}

function optionalStringRecord(record: Record<string, unknown>, key: string, label: string, maxEntries = 128) {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  const input = plainRecord(value, label)
  const entries = Object.entries(input)
  if (entries.length > maxEntries) throw new Error(`${label} exceeds ${maxEntries} entries.`)
  const next: Record<string, string> = {}
  for (const [entryKey, entryValue] of entries) {
    if (typeof entryValue !== 'string') throw new Error(`${label}.${entryKey} must be a string.`)
    if (byteLength(entryKey) > MAX_IPC_ID_BYTES) throw new Error(`${label} key is too large.`)
    if (byteLength(entryValue) > MAX_IPC_STRING_BYTES) throw new Error(`${label}.${entryKey} is too large.`)
    next[entryKey] = entryValue
  }
  return next
}

function optionalNestedStringRecord(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  const outer = plainRecord(value, label)
  const next: Record<string, Record<string, string>> = {}
  for (const [outerKey, outerValue] of Object.entries(outer)) {
    next[outerKey] = optionalStringRecord({ [outerKey]: outerValue }, outerKey, `${label}.${outerKey}`) || {}
  }
  return next
}

function optionalBooleanRecord(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  const input = plainRecord(value, label)
  const next: Record<string, boolean> = {}
  for (const [entryKey, entryValue] of Object.entries(input)) {
    if (typeof entryValue !== 'boolean') throw new Error(`${label}.${entryKey} must be a boolean.`)
    next[entryKey] = entryValue
  }
  return next
}

function optionalJsonRecord(record: Record<string, unknown>, key: string, label: string, maxBytes = 32 * 1024) {
  const value = record[key]
  if (value === undefined || value === null) return value as undefined | null
  const input = plainRecord(value, label)
  assertJsonSize(input, label, maxBytes)
  return input
}

function requiredScope(record: Record<string, unknown>) {
  const scope = record.scope
  if (typeof scope !== 'string' || !SCOPES.has(scope)) {
    throw new Error('Scope must be "machine" or "project".')
  }
  return scope as 'machine' | 'project'
}

export function validateRuntimeContextOptions(record: Record<string, unknown>): RuntimeContextOptions {
  return {
    workspaceId: optionalString(record, 'workspaceId', 'Workspace id', MAX_IPC_ID_BYTES),
    sessionId: optionalString(record, 'sessionId', 'Session id', MAX_IPC_ID_BYTES),
    directory: optionalNullableString(record, 'directory', 'Directory'),
  }
}

export function validateWorkspaceOptions(record: Record<string, unknown>): WorkspaceOptions {
  return {
    workspaceId: optionalString(record, 'workspaceId', 'Workspace id', MAX_IPC_ID_BYTES),
  }
}

export function validateToolListOptions(record: Record<string, unknown>): ToolListOptions {
  return {
    ...validateRuntimeContextOptions(record),
    provider: optionalNullableString(record, 'provider', 'Provider id', MAX_IPC_ID_BYTES),
    model: optionalNullableString(record, 'model', 'Model id', MAX_IPC_ID_BYTES),
    deep: optionalBoolean(record, 'deep', 'Deep tool discovery'),
  }
}

export function validateScopedArtifactRef(record: Record<string, unknown>): ScopedArtifactRef {
  return {
    workspaceId: optionalString(record, 'workspaceId', 'Workspace id', MAX_IPC_ID_BYTES),
    name: requiredString(record, 'name', 'Name', MAX_IPC_ID_BYTES),
    scope: requiredScope(record),
    directory: optionalNullableString(record, 'directory', 'Directory'),
  }
}

export function validateSessionArtifactRequest(record: Record<string, unknown>): SessionArtifactRequest {
  return {
    sessionId: requiredString(record, 'sessionId', 'Session id', MAX_IPC_ID_BYTES),
    filePath: requiredString(record, 'filePath', 'Artifact path'),
    workspaceId: optionalString(record, 'workspaceId', 'Workspace id', MAX_IPC_ID_BYTES),
  }
}

export function validateSessionArtifactExportRequest(record: Record<string, unknown>): SessionArtifactExportRequest {
  return {
    ...validateSessionArtifactRequest(record),
    suggestedName: optionalString(record, 'suggestedName', 'Suggested filename', MAX_IPC_ID_BYTES),
  }
}

export function validateSessionArtifactListRequest(record: Record<string, unknown>): SessionArtifactListRequest {
  return {
    sessionId: requiredString(record, 'sessionId', 'Session id', MAX_IPC_ID_BYTES),
    workspaceId: optionalString(record, 'workspaceId', 'Workspace id', MAX_IPC_ID_BYTES),
  }
}

export function validateSessionArtifactUploadRequest(record: Record<string, unknown>): SessionArtifactUploadRequest {
  return {
    sessionId: requiredString(record, 'sessionId', 'Session id', MAX_IPC_ID_BYTES),
    filename: requiredString(record, 'filename', 'Artifact filename', MAX_IPC_ID_BYTES),
    contentType: optionalNullableString(record, 'contentType', 'Artifact content type', MAX_IPC_ID_BYTES),
    dataBase64: requiredString(record, 'dataBase64', 'Artifact data', MAX_ARTIFACT_UPLOAD_BASE64_BYTES),
    workspaceId: optionalString(record, 'workspaceId', 'Workspace id', MAX_IPC_ID_BYTES),
  }
}

export function validateChartSaveArtifactRequest(record: Record<string, unknown>): ChartSaveArtifactRequest {
  const dataUrl = requiredString(record, 'dataUrl', 'Chart data URL', MAX_CHART_DATA_URL_BYTES)
  if (!dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error('Chart data URL must be a PNG data URL.')
  }
  const chart = record.chart === undefined || record.chart === null ? record.chart : plainRecord(record.chart, 'Chart metadata')
  return {
    sessionId: requiredString(record, 'sessionId', 'Session id', MAX_IPC_ID_BYTES),
    toolCallId: requiredString(record, 'toolCallId', 'Tool call id', MAX_IPC_ID_BYTES),
    toolName: requiredString(record, 'toolName', 'Tool name', MAX_IPC_ID_BYTES),
    dataUrl,
    taskRunId: optionalNullableString(record, 'taskRunId', 'Task run id', MAX_IPC_ID_BYTES),
    chart: chart as ChartSaveArtifactRequest['chart'],
  }
}

export function validateSettingsUpdate(record: Record<string, unknown>): Partial<CoworkSettings> & WorkspaceOptions {
  assertJsonSize(record, 'Settings update', MAX_SETTINGS_UPDATE_BYTES)
  for (const key of Object.keys(record)) {
    if (!SETTINGS_UPDATE_KEYS.has(key)) throw new Error(`Unknown settings key: ${key}`)
  }
  const update: Partial<CoworkSettings> & WorkspaceOptions = {}
  if (record._schemaVersion !== undefined) {
    if (typeof record._schemaVersion !== 'number' || !Number.isInteger(record._schemaVersion)) {
      throw new Error('Settings schema version must be an integer.')
    }
    update._schemaVersion = record._schemaVersion
  }
  update.workspaceId = optionalString(record, 'workspaceId', 'Workspace id', MAX_IPC_ID_BYTES)
  update.selectedProviderId = optionalNullableString(record, 'selectedProviderId', 'Selected provider id', MAX_IPC_ID_BYTES) as string | null | undefined
  update.selectedModelId = optionalNullableString(record, 'selectedModelId', 'Selected model id', MAX_IPC_ID_BYTES) as string | null | undefined
  update.selectedSmallModelId = optionalNullableString(record, 'selectedSmallModelId', 'Selected small model id', MAX_IPC_ID_BYTES) as string | null | undefined
  update.providerCredentials = optionalNestedStringRecord(record, 'providerCredentials', 'Provider credentials')
  update.integrationCredentials = optionalNestedStringRecord(record, 'integrationCredentials', 'Integration credentials')
  update.integrationEnabled = optionalBooleanRecord(record, 'integrationEnabled', 'Integration enabled')
  for (const key of ['bashPermission', 'fileWritePermission'] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== 'string' || !RUNTIME_PERMISSION_POLICIES.has(record[key])) {
        throw new Error(`${key} must be allow, ask, or deny.`)
      }
      update[key] = record[key] as CoworkSettings['bashPermission']
    }
  }
  update.enableBash = optionalBoolean(record, 'enableBash', 'Bash enabled')
  update.enableFileWrite = optionalBoolean(record, 'enableFileWrite', 'File write enabled')
  if (record.runtimeConfigSource !== undefined) {
    if (typeof record.runtimeConfigSource !== 'string' || !RUNTIME_CONFIG_SOURCES.has(record.runtimeConfigSource)) {
      throw new Error('Runtime config source must be app or machine.')
    }
    update.runtimeConfigSource = record.runtimeConfigSource as 'app' | 'machine'
  }
  update.runtimeToolingBridgeEnabled = optionalBoolean(record, 'runtimeToolingBridgeEnabled', 'Runtime tooling bridge enabled')
  update.workflowLaunchAtLogin = optionalBoolean(record, 'workflowLaunchAtLogin', 'Workflow launch at login')
  update.workflowRunInBackground = optionalBoolean(record, 'workflowRunInBackground', 'Workflow run in background')
  update.workflowDesktopNotifications = optionalBoolean(record, 'workflowDesktopNotifications', 'Workflow desktop notifications')
  update.workflowQuietHoursStart = optionalNullableString(record, 'workflowQuietHoursStart', 'Workflow quiet hours start', MAX_IPC_ID_BYTES) as string | null | undefined
  update.workflowQuietHoursEnd = optionalNullableString(record, 'workflowQuietHoursEnd', 'Workflow quiet hours end', MAX_IPC_ID_BYTES) as string | null | undefined

  return Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)) as Partial<CoworkSettings>
}

export function validateCustomMcpConfig(record: Record<string, unknown>): CustomMcpConfig {
  const type = record.type
  if (typeof type !== 'string' || !MCP_TYPES.has(type)) {
    throw new Error('MCP type must be stdio or http.')
  }
  const permissionMode = optionalString(record, 'permissionMode', 'MCP permission mode', MAX_IPC_ID_BYTES)
  if (permissionMode && !MCP_PERMISSION_MODES.has(permissionMode)) {
    throw new Error('MCP permission mode must be ask or allow.')
  }
  const config: CustomMcpConfig = {
    workspaceId: optionalString(record, 'workspaceId', 'Workspace id', MAX_IPC_ID_BYTES),
    scope: requiredScope(record),
    directory: optionalNullableString(record, 'directory', 'Directory'),
    name: requiredString(record, 'name', 'MCP name', MAX_IPC_ID_BYTES),
    label: optionalString(record, 'label', 'MCP label'),
    description: optionalString(record, 'description', 'MCP description'),
    type: type as CustomMcpConfig['type'],
    command: optionalString(record, 'command', 'MCP command'),
    args: optionalStringArray(record, 'args', 'MCP args'),
    env: optionalStringRecord(record, 'env', 'MCP env'),
    url: optionalString(record, 'url', 'MCP URL'),
    headers: optionalStringRecord(record, 'headers', 'MCP headers'),
    googleAuth: optionalBoolean(record, 'googleAuth', 'MCP Google auth'),
    allowPrivateNetwork: optionalBoolean(record, 'allowPrivateNetwork', 'MCP private network access'),
    permissionMode: permissionMode as CustomMcpConfig['permissionMode'],
    traceLabel: optionalString(record, 'traceLabel', 'MCP trace label'),
    tracePluralLabel: optionalString(record, 'tracePluralLabel', 'MCP trace plural label'),
  }
  assertCustomMcpContentLimits(config)
  return config
}

export function validateCustomSkillConfig(record: Record<string, unknown>): CustomSkillConfig {
  const content = rawString(record, 'content', 'Skill content')
  if (!content.trim()) throw new Error('Skill content is required.')
  const filesInput = record.files
  let files: CustomSkillConfig['files']
  if (filesInput !== undefined && filesInput !== null) {
    if (!Array.isArray(filesInput)) throw new Error('Skill files must be an array.')
    files = filesInput.map((entry, index) => {
      const file = plainRecord(entry, `Skill file ${index + 1}`)
      return {
        path: requiredString(file, 'path', `Skill file ${index + 1} path`, MAX_IPC_ID_BYTES),
        content: rawString(file, 'content', `Skill file ${index + 1} content`),
      }
    })
  }
  const skill: CustomSkillConfig = {
    workspaceId: optionalString(record, 'workspaceId', 'Workspace id', MAX_IPC_ID_BYTES),
    scope: requiredScope(record),
    directory: optionalNullableString(record, 'directory', 'Directory'),
    name: requiredString(record, 'name', 'Skill name', MAX_IPC_ID_BYTES),
    content,
    files,
    toolIds: optionalStringArray(record, 'toolIds', 'Skill tool ids'),
  }
  assertCustomSkillContent(skill.content || '')
  assertCustomSkillFiles(skill.files || [])
  return skill
}

export function validateCustomAgentConfig(record: Record<string, unknown>): CustomAgentConfig {
  const agent: CustomAgentConfig = {
    workspaceId: optionalString(record, 'workspaceId', 'Workspace id', MAX_IPC_ID_BYTES),
    scope: requiredScope(record),
    directory: optionalNullableString(record, 'directory', 'Directory'),
    name: requiredString(record, 'name', 'Agent name', MAX_IPC_ID_BYTES),
    description: requiredString(record, 'description', 'Agent description'),
    instructions: requiredString(record, 'instructions', 'Agent instructions'),
    skillNames: optionalStringArray(record, 'skillNames', 'Agent skills') || [],
    toolIds: optionalStringArray(record, 'toolIds', 'Agent tools') || [],
    enabled: optionalBoolean(record, 'enabled', 'Agent enabled') ?? true,
    color: 'primary',
    avatar: optionalNullableString(record, 'avatar', 'Agent avatar'),
    deniedToolPatterns: optionalStringArray(record, 'deniedToolPatterns', 'Agent denied tool patterns'),
    model: optionalNullableString(record, 'model', 'Agent model'),
    variant: optionalNullableString(record, 'variant', 'Agent variant'),
    temperature: optionalNumber(record, 'temperature', 'Agent temperature'),
    top_p: optionalNumber(record, 'top_p', 'Agent top_p'),
    steps: optionalNumber(record, 'steps', 'Agent steps'),
    options: optionalJsonRecord(record, 'options', 'Agent options'),
  }
  if (typeof record.color !== 'string' || !AGENT_COLORS.has(record.color)) {
    throw new Error('Agent color is invalid.')
  }
  agent.color = record.color as CustomAgentConfig['color']
  const issue = validateCustomAgentContentLimits(agent)[0]
  if (issue) throw new Error(issue.message)
  return agent
}

export function validateDestructiveConfirmationRequest(record: Record<string, unknown>): DestructiveConfirmationRequest {
  const action = record.action
  if (typeof action !== 'string' || !DESTRUCTIVE_ACTIONS.has(action)) {
    throw new Error('Destructive action is invalid.')
  }
  if (action === 'app.reset') return { action }
  if (action === 'session.delete') {
    return {
      action,
      sessionId: requiredString(record, 'sessionId', 'Session id', MAX_IPC_ID_BYTES),
    }
  }
  return {
    action: action as 'agent.remove' | 'mcp.remove' | 'skill.remove',
    target: validateScopedArtifactRef(plainRecord(record.target, 'Destructive target')),
  }
}

export function validateThreadSearchQuery(record: Record<string, unknown>): ThreadSearchQuery {
  return normalizeThreadSearchQuery(record)
}
