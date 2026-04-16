export const IPC = {
  SESSION_CREATE: 'session:create',
  SESSION_PROMPT: 'session:prompt',
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  SESSION_ABORT: 'session:abort',
  RUNTIME_STATUS: 'runtime:status',
  DIAGNOSTICS_PERF: 'diagnostics:perf',
  PERMISSION_RESPOND: 'permission:respond',
  SESSION_PATCH: 'session:patch',
  NOTIFICATION: 'runtime:notification',
  PERMISSION_REQUEST: 'permission:request',
  MCP_STATUS: 'mcp:status',
} as const

export interface SessionInfo {
  id: string
  title?: string
  directory?: string | null
  createdAt: string
  updatedAt: string
}

export type DashboardTimeRangeKey = 'last7d' | 'last30d' | 'ytd' | 'all'

export interface SessionUsageSummary {
  messages: number
  userMessages: number
  assistantMessages: number
  toolCalls: number
  taskRuns: number
  cost: number
  tokens: SessionTokens
}

export interface DashboardTimeRange {
  key: DashboardTimeRangeKey
  label: string
  startAt: string | null
  endAt: string
}

export interface DashboardSessionSummary extends SessionInfo {
  providerId?: string | null
  modelId?: string | null
  usage: SessionUsageSummary
}

export interface DashboardSummary {
  range: DashboardTimeRange
  totals: SessionUsageSummary & { threads: number }
  recentSessions: DashboardSessionSummary[]
  generatedAt: string
  backfilledSessions: number
}

export interface MessageAttachment {
  mime: string
  url: string
  filename?: string
}

export interface MessageSegment {
  id: string
  content: string
  order: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments?: MessageAttachment[]
  segments?: MessageSegment[]
  timestamp?: string | null
  providerId?: string | null
  modelId?: string | null
  order: number
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'running' | 'complete' | 'error'
  output?: unknown
  attachments?: MessageAttachment[]
  agent?: string | null
  sourceSessionId?: string | null
  order: number
}

export interface CompactionNotice {
  id: string
  status: 'compacting' | 'compacted'
  auto: boolean
  overflow: boolean
  sourceSessionId?: string | null
  order: number
}

export interface TaskTranscriptSegment {
  id: string
  content: string
  order: number
}

export interface TodoItem {
  content: string
  status: string
  priority: string
  id?: string
}

export interface ExecutionPlanItem {
  content: string
  status: string
  priority: string
  id?: string
}

export interface SessionTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface TaskRun {
  id: string
  title: string
  agent: string | null
  status: 'queued' | 'running' | 'complete' | 'error'
  sourceSessionId: string | null
  content: string
  transcript: TaskTranscriptSegment[]
  toolCalls: ToolCall[]
  compactions: CompactionNotice[]
  todos: TodoItem[]
  error: string | null
  sessionCost: number
  sessionTokens: SessionTokens
  order: number
}

export interface PendingApproval {
  id: string
  sessionId: string
  taskRunId?: string | null
  tool: string
  input: Record<string, unknown>
  description: string
  order: number
}

export interface QuestionOption {
  label: string
  description: string
}

export interface PendingQuestionPrompt {
  header: string
  question: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export interface PendingQuestion {
  id: string
  sessionId: string
  questions: PendingQuestionPrompt[]
  tool?: {
    messageId: string
    callId: string
  }
}

export interface SessionError {
  id: string
  sessionId: string | null
  message: string
  order: number
}

export interface SessionView {
  messages: Message[]
  toolCalls: ToolCall[]
  taskRuns: TaskRun[]
  compactions: CompactionNotice[]
  pendingApprovals: PendingApproval[]
  pendingQuestions: PendingQuestion[]
  errors: SessionError[]
  todos: TodoItem[]
  executionPlan: ExecutionPlanItem[]
  sessionCost: number
  sessionTokens: SessionTokens
  lastInputTokens: number
  contextState: 'idle' | 'measured' | 'compacting' | 'compacted'
  compactionCount: number
  lastCompactedAt: string | null
  activeAgent: string | null
  lastItemWasTool: boolean
  revision: number
  lastEventAt: number
  isGenerating: boolean
  isAwaitingPermission: boolean
  isAwaitingQuestion: boolean
}

export interface SessionMessageTextPatch {
  type: 'message_text'
  sessionId: string
  messageId: string
  segmentId: string
  content: string
  mode: 'append' | 'replace'
  role?: 'user' | 'assistant'
  attachments?: MessageAttachment[]
  eventAt: number
}

export interface SessionTaskTextPatch {
  type: 'task_text'
  sessionId: string
  taskRunId: string
  segmentId: string
  content: string
  mode: 'append' | 'replace'
  eventAt: number
}

export type SessionPatch = SessionMessageTextPatch | SessionTaskTextPatch

export interface RuntimeNotification {
  type: 'done' | 'error'
  sessionId?: string | null
  synthetic?: boolean
  message?: string
}

export interface PerfCounterSnapshot {
  kind: 'counter'
  name: string
  value: number
  updatedAt: string
}

export interface PerfDistributionSnapshot {
  kind: 'distribution'
  name: string
  unit: 'ms' | 'count'
  count: number
  samplesTracked: number
  total: number
  avg: number
  min: number
  max: number
  p50: number
  p95: number
  last: number
  slowCount: number
  updatedAt: string
}

export interface PerfSnapshot {
  capturedAt: string
  counters: PerfCounterSnapshot[]
  distributions: PerfDistributionSnapshot[]
}

export interface RuntimeStatus {
  ready: boolean
  error?: string | null
}

export interface RuntimeInputDiagnostics {
  opencodeVersion: string | null
  providerId: string | null
  providerName: string | null
  providerPackage: string | null
  modelId: string | null
  runtimeModel: string | null
  defaultProviderId: string | null
  defaultModelId: string | null
  providerSource: 'settings' | 'default' | 'fallback'
  modelSource: 'settings' | 'default' | 'fallback'
  providerOptions: Record<string, unknown>
  credentialOverrideKeys: string[]
}

export interface ToolListOptions {
  sessionId?: string
  directory?: string | null
  provider?: string | null
  model?: string | null
}

export interface RuntimeContextOptions {
  sessionId?: string
  directory?: string | null
}

export interface SkillImportSelection {
  token: string
  directory: string
}

export interface SandboxStorageStats {
  root: string
  totalBytes: number
  workspaceCount: number
  referencedWorkspaceCount: number
  unreferencedWorkspaceCount: number
  staleWorkspaceCount: number
  staleThresholdDays: number
}

export interface SandboxCleanupResult {
  mode: 'old-unreferenced' | 'all-unreferenced'
  removedWorkspaces: number
  removedBytes: number
}

export interface SessionArtifactRequest {
  sessionId: string
  filePath: string
}

export interface SessionArtifactExportRequest extends SessionArtifactRequest {
  suggestedName?: string
}

export interface SessionArtifact {
  id: string
  toolId: string
  toolName: string
  filePath: string
  filename: string
  order: number
  taskRunId?: string | null
}

export type DestructiveAction =
  | 'session.delete'
  | 'agent.remove'
  | 'mcp.remove'
  | 'skill.remove'

export type DestructiveConfirmationRequest =
  | {
      action: 'session.delete'
      sessionId: string
    }
  | {
      action: 'agent.remove' | 'mcp.remove' | 'skill.remove'
      target: ScopedArtifactRef
    }

export interface DestructiveConfirmationGrant {
  token: string
  expiresAt: string
}

export interface ToolCallEvent {
  type: 'tool_call'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultEvent {
  type: 'tool_result'
  id: string
  name: string
  output: unknown
  isError: boolean
}

export interface PermissionRequest {
  id: string
  sessionId: string
  taskRunId?: string | null
  tool: string
  input: Record<string, unknown>
  description: string
}

export interface McpStatus {
  name: string
  connected: boolean
  rawStatus?: string
}

export interface CustomMcpConfig {
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

export interface CustomSkillConfig {
  scope: 'machine' | 'project'
  directory?: string | null
  name: string
  content: string
  files?: Array<{
    path: string
    content: string
  }>
}

export type AgentColor = 'primary' | 'warning' | 'accent' | 'success' | 'info' | 'secondary'

export interface CustomAgentConfig {
  scope: 'machine' | 'project'
  directory?: string | null
  name: string
  description: string
  instructions: string
  skillNames: string[]
  toolIds: string[]
  enabled: boolean
  color: AgentColor
}

export interface CustomAgentIssue {
  code: string
  message: string
}

export interface CustomAgentSummary extends CustomAgentConfig {
  writeAccess: boolean
  valid: boolean
  issues: CustomAgentIssue[]
}

export interface ScopedArtifactRef {
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

export interface BuiltInAgentDetail {
  name: string
  label: string
  source: 'open-cowork' | 'opencode'
  mode: 'primary' | 'subagent'
  hidden: boolean
  color: string
  description: string
  instructions: string
  skills: string[]
  toolAccess: string[]
  nativeToolIds: string[]
  configuredToolIds: string[]
}

export interface CredentialField {
  key: string
  label: string
  description: string
  placeholder?: string
  secret?: boolean
  required?: boolean
  env?: string
  runtimeKey?: string
}

export interface ProviderModelDescriptor {
  id: string
  name: string
  description?: string
}

export interface ProviderDescriptor {
  id: string
  name: string
  description: string
  credentials: CredentialField[]
  models: ProviderModelDescriptor[]
}

export interface BrandingConfig {
  name: string
  appId: string
  dataDirName: string
  helpUrl: string
}

export interface PublicAppConfig {
  branding: BrandingConfig
  auth: {
    mode: 'none' | 'google-oauth'
    enabled: boolean
  }
  providers: {
    available: ProviderDescriptor[]
    defaultProvider: string | null
    defaultModel: string | null
  }
}

export interface AppSettings {
  selectedProviderId: string | null
  selectedModelId: string | null
  providerCredentials: Record<string, Record<string, string>>
  integrationCredentials: Record<string, Record<string, string>>
  enableBash: boolean
  enableFileWrite: boolean
}

export interface EffectiveAppSettings extends AppSettings {
  effectiveProviderId: string | null
  effectiveModel: string | null
}

export interface AuthState {
  authenticated: boolean
  email: string | null
}

export type {
  CapabilityToolEntry,
  CapabilitySkill,
  CapabilityTool,
  CapabilitySkillBundle,
  CapabilitySkillBundleFile,
} from './capabilities.js'

export interface OpenCoworkAPI {
  auth: {
    status: () => Promise<AuthState>
    login: () => Promise<AuthState>
  }
  session: {
    create: (directory?: string) => Promise<SessionInfo>
    activate: (sessionId: string, options?: { force?: boolean }) => Promise<SessionView>
    prompt: (sessionId: string, text: string, attachments?: Array<{ mime: string; url: string; filename?: string }>, agent?: string) => Promise<void>
    list: () => Promise<SessionInfo[]>
    get: (id: string) => Promise<SessionInfo | null>
    abort: (sessionId: string) => Promise<void>
    rename: (sessionId: string, title: string) => Promise<boolean>
    delete: (sessionId: string, confirmationToken?: string | null) => Promise<boolean>
    export: (sessionId: string) => Promise<string | null>
    fork: (sessionId: string, messageId?: string) => Promise<SessionInfo | null>
    share: (sessionId: string) => Promise<string | null>
    unshare: (sessionId: string) => Promise<boolean>
    summarize: (sessionId: string) => Promise<string | null>
    revert: (sessionId: string) => Promise<boolean>
    unrevert: (sessionId: string) => Promise<boolean>
    children: (sessionId: string) => Promise<any[]>
    diff: (sessionId: string) => Promise<Array<{ file: string; before: string; after: string; additions: number; deletions: number }>>
    todo: (sessionId: string) => Promise<any[]>
  }
  permission: {
    respond: (id: string, allowed: boolean) => Promise<void>
  }
  question: {
    reply: (sessionId: string, requestId: string, answers: string[][]) => Promise<void>
    reject: (sessionId: string, requestId: string) => Promise<void>
  }
  settings: {
    get: () => Promise<EffectiveAppSettings>
    set: (updates: Partial<AppSettings>) => Promise<EffectiveAppSettings>
  }
  mcp: {
    auth: (mcpName: string) => Promise<boolean>
    connect: (name: string) => Promise<void>
    disconnect: (name: string) => Promise<void>
  }
  dialog: {
    selectDirectory: () => Promise<string | null>
  }
  artifact: {
    export: (request: SessionArtifactExportRequest) => Promise<string | null>
    reveal: (request: SessionArtifactRequest) => Promise<boolean>
    storageStats: () => Promise<SandboxStorageStats>
    cleanup: (mode: SandboxCleanupResult['mode']) => Promise<SandboxCleanupResult>
  }
  confirm: {
    requestDestructive: (request: DestructiveConfirmationRequest) => Promise<DestructiveConfirmationGrant>
  }
  model: {
    info: () => Promise<any>
  }
  tools: {
    list: (options?: ToolListOptions) => Promise<any[]>
  }
  command: {
    list: () => Promise<Array<{ name: string; description?: string; source?: string }>>
    run: (sessionId: string, name: string) => Promise<boolean>
  }
  provider: {
    list: () => Promise<any[]>
  }
  runtime: {
    status: () => Promise<RuntimeStatus>
  }
  diagnostics: {
    perf: () => Promise<PerfSnapshot>
  }
  app: {
    config: () => Promise<PublicAppConfig>
    builtinAgents: () => Promise<BuiltInAgentDetail[]>
    dashboardSummary: (range?: DashboardTimeRangeKey) => Promise<DashboardSummary>
    runtimeInputs: () => Promise<RuntimeInputDiagnostics>
  }
  agents: {
    catalog: (options?: RuntimeContextOptions) => Promise<AgentCatalog>
    list: (options?: RuntimeContextOptions) => Promise<CustomAgentSummary[]>
    create: (agent: CustomAgentConfig) => Promise<boolean>
    update: (target: ScopedArtifactRef, agent: CustomAgentConfig) => Promise<boolean>
    remove: (target: ScopedArtifactRef, confirmationToken?: string | null) => Promise<boolean>
  }
  capabilities: {
    tools: (options?: ToolListOptions) => Promise<import('./capabilities').CapabilityTool[]>
    tool: (id: string, options?: ToolListOptions) => Promise<import('./capabilities').CapabilityTool | null>
    skills: (options?: RuntimeContextOptions) => Promise<import('./capabilities').CapabilitySkill[]>
    skillBundle: (skillName: string, options?: RuntimeContextOptions) => Promise<import('./capabilities').CapabilitySkillBundle | null>
  }
  custom: {
    listMcps: (options?: RuntimeContextOptions) => Promise<CustomMcpConfig[]>
    addMcp: (mcp: CustomMcpConfig) => Promise<boolean>
    removeMcp: (target: ScopedArtifactRef, confirmationToken?: string | null) => Promise<boolean>
    testMcp: (mcp: CustomMcpConfig) => Promise<CustomMcpTestResult>
    listSkills: (options?: RuntimeContextOptions) => Promise<CustomSkillConfig[]>
    addSkill: (skill: CustomSkillConfig) => Promise<boolean>
    selectSkillDirectoryImport: () => Promise<SkillImportSelection | null>
    importSkillDirectory: (selectionToken: string, target: ScopedArtifactRef) => Promise<CustomSkillConfig>
    removeSkill: (target: ScopedArtifactRef, confirmationToken?: string | null) => Promise<boolean>
  }
  on: {
    sessionPatch: (callback: (patch: SessionPatch) => void) => () => void
    notification: (callback: (event: RuntimeNotification) => void) => () => void
    sessionView: (callback: (data: { sessionId: string; view: SessionView }) => void) => () => void
    permissionRequest: (callback: (request: PermissionRequest) => void) => () => void
    mcpStatus: (callback: (statuses: McpStatus[]) => void) => () => void
    authExpired: (callback: () => void) => () => void
    menuAction: (callback: (action: string) => void) => () => void
    menuNavigate: (callback: (view: string) => void) => () => void
    runtimeReady: (callback: () => void) => () => void
    sessionUpdated: (callback: (data: { id: string; title: string }) => void) => () => void
  }
}

export type CoworkAPI = OpenCoworkAPI

declare global {
  interface Window {
    openCowork: OpenCoworkAPI
  }
}

export * from './shortcuts.js'
