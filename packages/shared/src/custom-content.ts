import type { WorkflowSurface } from './workflow.js'

export type CustomMcpPermissionMode = 'ask' | 'allow'

export interface CustomMcpConfig {
  workspaceId?: string
  scope: 'machine' | 'project'
  directory?: string | null
  name: string
  label?: string
  description?: string
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  googleAuth?: boolean
  allowPrivateNetwork?: boolean
  permissionMode?: CustomMcpPermissionMode
  traceLabel?: string
  tracePluralLabel?: string
}

export interface CustomMcpTestResult {
  ok: boolean
  methods: Array<{
    id: string
    description: string
  }>
  authRequired?: boolean
  error?: string | null
}

export type McpPreflightStatus =
  | 'ok'
  | 'missing_credentials'
  | 'auth_rejected'
  | 'forbidden'
  | 'network_error'
  | 'http_error'
  | 'protocol_error'
  | 'invalid_config'
  | 'not_found'
  | 'not_applicable'

export interface McpPreflightResult {
  ok: boolean
  status: McpPreflightStatus
  mcpName: string
  message: string
  host?: string
  httpStatus?: number
  responseBody?: string
  methodCount?: number
  helpText?: string
}

export interface CustomSkillConfig {
  workspaceId?: string
  scope: 'machine' | 'project'
  directory?: string | null
  name: string
  content: string
  files?: Array<{
    path: string
    content: string
  }>
  toolIds?: string[]
}

export type AgentColor = 'primary' | 'warning' | 'accent' | 'success' | 'info' | 'secondary'

// Inference tuning fields forwarded to OpenCode's AgentConfig. Every field is
// optional; unset fields inherit session defaults. `options` is a passthrough
// bag for provider-specific knobs (reasoning effort, max_tokens, cache
// controls) that don't have dedicated AgentConfig top-level slots.
export interface AgentInferenceOptions {
  model?: string | null
  variant?: string | null
  temperature?: number | null
  top_p?: number | null
  steps?: number | null
  options?: Record<string, unknown> | null
}

export interface CustomAgentConfig extends AgentInferenceOptions {
  workspaceId?: string
  scope: 'machine' | 'project'
  directory?: string | null
  name: string
  description: string
  instructions: string
  skillNames: string[]
  toolIds: string[]
  enabled: boolean
  color: AgentColor
  avatar?: string | null
  deniedToolPatterns?: string[]
}

export interface CustomAgentIssue {
  code: string
  message: string
}

// Portable bundle emitted by "Export agent" and consumed by "Import agent".
// Skills and tools reference by id; we do not bundle their implementations.
export interface AgentBundle {
  format: 'cowork-agent-v1'
  name: string
  description: string
  instructions: string
  skillNames: string[]
  toolIds: string[]
  color: AgentColor
  avatar?: string | null
  enabled?: boolean
  model?: string | null
  variant?: string | null
  temperature?: number | null
  top_p?: number | null
  steps?: number | null
  options?: Record<string, unknown> | null
  exportedAt?: string
  exportedBy?: string
}

export interface CustomAgentSummary extends CustomAgentConfig {
  writeAccess: boolean
  valid: boolean
  issues: CustomAgentIssue[]
}

export interface ScopedArtifactRef {
  workspaceId?: string
  name: string
  scope: 'machine' | 'project'
  directory?: string | null
}

export interface AgentCatalogTool {
  id: string
  name: string
  icon: string
  description: string
  supportsWrite: boolean
  source: 'builtin' | 'custom'
  patterns: string[]
}

export interface AgentCatalogSkill {
  name: string
  label: string
  description: string
  source: 'builtin' | 'custom'
  origin?: 'open-cowork' | 'custom'
  scope?: 'machine' | 'project' | null
  location?: string | null
  toolIds?: string[]
}

export interface AgentCatalog {
  tools: AgentCatalogTool[]
  skills: AgentCatalogSkill[]
  reservedNames: string[]
  colors: AgentColor[]
}

export interface BuiltInAgentDetail extends AgentInferenceOptions {
  name: string
  label: string
  source: 'open-cowork' | 'opencode'
  mode: 'primary' | 'subagent'
  surface?: WorkflowSurface
  hidden: boolean
  disabled: boolean
  color: string
  description: string
  instructions: string
  skills: string[]
  toolAccess: string[]
  nativeToolIds: string[]
  configuredToolIds: string[]
  avatar?: string | null
}

export interface RuntimeAgentDescriptor {
  name: string
  mode?: 'primary' | 'subagent' | 'all' | null
  description?: string | null
  model?: string | null
  color?: string | null
  disabled?: boolean
  toolIds?: string[]
  toolCount?: number
  writeAccess?: boolean
  steps?: number | null
}
