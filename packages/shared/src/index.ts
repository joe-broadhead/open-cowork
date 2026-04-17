// Aggregate diff stats for a session, mirroring SDK Session.summary (additions
// + deletions + file count across the session's snapshot diff). Distinct from
// SessionUsageSummary below, which is our product-side cost/token rollup.
export interface SessionChangeSummary {
  additions: number
  deletions: number
  files: number
}

// Per-file diff entry, mirroring SDK SnapshotFileDiff. `patch` is a unified
// diff (git-style hunks) produced by OpenCode's snapshot engine.
export interface SessionFileDiff {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: 'added' | 'deleted' | 'modified'
}

export interface SessionInfo {
  id: string
  title?: string
  directory?: string | null
  createdAt: string
  updatedAt: string
  // Parent session when this was created via session:fork. Stable once set.
  parentSessionId?: string | null
  // Condensed diff summary (no per-file patches) from SDK Session.summary.
  // Refreshed when we call session.get; sidebar renders without a full diff.
  changeSummary?: SessionChangeSummary | null
  // When present, the session is currently reverted to the message with this
  // id. Cleared on unrevert. From SDK Session.revert.messageID.
  revertedMessageId?: string | null
}

export type DashboardTimeRangeKey = 'last7d' | 'last30d' | 'ytd' | 'all'

// Usage attributed to a single sub-agent across the aggregation window.
// Populated by summing task runs whose `agent` matches the entry's name.
// The primary orchestrator is represented as `agent: null` when we want
// to attribute everything not routed through a sub-agent task.
export interface AgentUsageEntry {
  agent: string | null
  taskRuns: number
  cost: number
  tokens: SessionTokens
}

export interface SessionUsageSummary {
  messages: number
  userMessages: number
  assistantMessages: number
  toolCalls: number
  taskRuns: number
  cost: number
  tokens: SessionTokens
  // Per-agent cost/token breakdown. Optional so older persisted summaries
  // (without the field) keep deserialising — the dashboard recomputes on
  // backfill so stale summaries gain the breakdown automatically.
  agentBreakdown?: AgentUsageEntry[]
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
  // Aggregated per-agent usage across the window, sorted by cost desc.
  // Named agents only — the primary orchestrator ("build"/"plan") rolls
  // up under `agent: null` so it doesn't dominate the chart.
  topAgents: AgentUsageEntry[]
  generatedAt: string
  backfilledSessions: number
  // Sessions whose usage summaries could not be reconstructed THIS CALL.
  // The dashboard surfaces a subtle warning chip so users know totals
  // may be understated until the underlying error is resolved. Distinct
  // from `backfillPendingCount`, which tracks sessions still being drained
  // on a background queue after the main response returned.
  backfillFailedCount?: number
  backfillPendingCount?: number
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
  // The session id of the task that spawned this one, when a sub-agent
  // delegates further. Lets the orchestration UI render a 2-level tree
  // (root task → spawned child). Null for tasks launched directly by
  // the primary agent. Resolved from OpenCode `session.created.parentID`
  // in the main process via `event-task-state.ts` lineage tracking.
  parentSessionId?: string | null
  content: string
  transcript: TaskTranscriptSegment[]
  toolCalls: ToolCall[]
  compactions: CompactionNotice[]
  todos: TodoItem[]
  error: string | null
  sessionCost: number
  sessionTokens: SessionTokens
  order: number
  // ISO timestamps for the live elapsed-clock UX. startedAt is set when the
  // task first enters the `running` state; finishedAt is set when it leaves
  // it (either `complete` or `error`). Both are optional so older persisted
  // state without these fields keeps deserializing.
  startedAt?: string | null
  finishedAt?: string | null
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

// ── Explorer (SDK find.* + file.*) ────────────────────────────────────────
// Contract between the main-process explorer handlers and the renderer's
// Explorer panel. Names mirror the SDK's FileNode / FileContent / File /
// Symbol shapes but normalized (camelCase, flattened ranges, stable arrays)
// so the renderer never touches SDK snake_case.

export interface FileNode {
  name: string
  path: string
  absolute: string
  type: 'file' | 'directory'
  ignored: boolean
}

export interface FileContent {
  type: 'text' | 'binary'
  content: string
  diff?: string | null
  patch?: string | null
  encoding?: string | null
}

export interface FileStatus {
  path: string
  added: number
  removed: number
  status: 'added' | 'deleted' | 'modified'
}

export interface ExplorerRangePos {
  line: number
  col: number
}

export interface ExplorerSymbol {
  name: string
  kind: number
  path: string
  range: {
    start: ExplorerRangePos
    end: ExplorerRangePos
  }
}

export interface TextMatch {
  path: string
  lineNumber: number
  lineText: string
  submatches: Array<{ text: string; start: number; end: number }>
}

export interface FindFilesOptions {
  query: string
  dirs?: boolean
  type?: 'file' | 'directory'
  limit?: number
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

// Request shape for persisting a chart PNG captured client-side. The
// main process validates the data URL, writes the bytes under a
// per-session chart-artifacts root, and returns a SessionArtifact
// the renderer can feed into the existing export/reveal IPC.
export interface ChartSaveArtifactRequest {
  sessionId: string
  toolCallId: string
  toolName: string
  dataUrl: string
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
  // Opt-in: inject `GOOGLE_APPLICATION_CREDENTIALS` into this MCP's
  // subprocess env pointing at the user's Google ADC file (written after
  // a successful `auth.mode: google-oauth` login). Lets trusted Google
  // MCPs (Sheets, BigQuery, Drive, etc.) reuse the app-level sign-in
  // without a second OAuth prompt. Only takes effect when the app has
  // Google OAuth enabled AND the user has signed in — otherwise the
  // MCP spawns without the env var, same as today. Default false
  // because arbitrary MCPs should not get a Google access token.
  googleAuth?: boolean
  // Opt-in: allow this HTTP MCP to talk to loopback, link-local, or
  // RFC1918 private addresses. Default false blocks SSRF vectors like
  // `http://169.254.169.254/` (cloud metadata) and `http://localhost/`
  // exfil channels. Downstream installs with legit corporate-internal
  // MCPs flip this per-MCP; the UI surfaces a warning when it's set.
  allowPrivateNetwork?: boolean
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
  // Ids of tools this skill needs to be useful. Built-in skills declare
  // the same link via `configuredSkill.toolIds` in `open-cowork.config.json`;
  // the agent builder uses it for the "skill needs these tools" auto-attach
  // hint. Persisted inside the skill's SKILL.md frontmatter as a YAML
  // array so the bundle stays self-contained — no sidecar files to sync.
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
  scope: 'machine' | 'project'
  directory?: string | null
  name: string
  description: string
  instructions: string
  skillNames: string[]
  toolIds: string[]
  enabled: boolean
  color: AgentColor
  // Optional data URI (e.g. `data:image/png;base64,…`) for a custom
  // avatar uploaded by the user. Persisted alongside the agent's
  // sidecar JSON so it round-trips through `agents:create` /
  // `agents:update` without new IPC. Renderer downsamples the uploaded
  // image to ≤192px before setting this field to keep the sidecar JSON
  // a reasonable size. Null / missing falls back to gradient initials.
  avatar?: string | null
  // Specific tool patterns (e.g. `mcp__github__delete_repo`) the agent
  // should be blocked from using even when the parent MCP's wildcard is
  // allowed via `toolIds`. Lets users scope an agent to a subset of an
  // MCP's methods. Empty / undefined means no extra denies beyond the
  // usual deny-everything-except-allowed baseline.
  deniedToolPatterns?: string[]
}

export interface CustomAgentIssue {
  code: string
  message: string
}

// Portable bundle emitted by "Export agent" and consumed by "Import agent".
// Intentionally a superset of the persisted fields — the format version is
// explicit so downstream tooling (or a later registry UI) can evolve the
// shape while keeping older files importable. Skills and tools reference by
// id; we do NOT bundle their implementations, so an imported agent whose
// refs aren't in the target catalog will show up as "needs attention" in
// the builder (same as any locally authored agent with missing refs).
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
  hidden: boolean
  disabled: boolean
  color: string
  description: string
  instructions: string
  skills: string[]
  toolAccess: string[]
  nativeToolIds: string[]
  configuredToolIds: string[]
  // Parity with CustomAgentConfig.avatar. Built-ins ship without
  // custom images in v1 but the type stays uniform so renderer
  // code can take a single Agent-like shape.
  avatar?: string | null
}

// Config override for one of the four Cowork built-in agents. Every field
// is optional — downstream distributions can disable an agent entirely,
// swap its model, or retune inference without replacing the prompt.
export interface BuiltInAgentOverride extends AgentInferenceOptions {
  disable?: boolean
  hidden?: boolean
  description?: string
  instructions?: string
  color?: string
}

export interface RuntimeAgentDescriptor {
  name: string
  mode?: 'primary' | 'subagent' | 'all' | null
  description?: string | null
  model?: string | null
  color?: string | null
  disabled?: boolean
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

// Per-model pricing + context info cached by the main process after
// fetching `client.provider.list()`. The renderer uses this to render
// per-message cost estimates and context-usage hints. Identical shape to
// what `runtime.ts:getModelInfo()` returns; kept here so the preload /
// renderer boundary has a stable contract.
export interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
  cachePer1M?: number
}

export interface ModelInfoSnapshot {
  pricing: Record<string, ModelPricing>
  contextLimits: Record<string, number>
}

export interface ProviderModelDescriptor {
  id: string
  name: string
  description?: string
  // Set on models defined directly in `providers.descriptors[x].models` so
  // the picker pins them above dynamically-fetched catalog entries. Lets
  // downstream distributions keep a curated set of defaults on top while
  // still exposing the full catalog below.
  featured?: boolean
  // Optional context window (tokens). Populated from dynamic catalogs when
  // the upstream response includes it. Used by the picker to surface "long
  // context" capability at a glance.
  contextLength?: number
}

export interface ProviderDescriptor {
  id: string
  name: string
  description: string
  credentials: CredentialField[]
  models: ProviderModelDescriptor[]
}

export interface BrandThemeTokens {
  base: string
  surface: string
  surfaceHover: string
  surfaceActive: string
  elevated: string
  border: string
  borderSubtle: string
  text: string
  textSecondary: string
  textMuted: string
  accent: string
  accentHover: string
  green: string
  amber: string
  red: string
  info: string
  accentForeground: string
  shadowCard: string
  shadowElevated: string
  bgImage: string
}

export interface BrandThemeDefinition {
  id: string
  label: string
  description?: string
  swatches?: string[]
  dark: BrandThemeTokens
  light?: BrandThemeTokens
}

export interface BrandingConfig {
  name: string
  appId: string
  dataDirName: string
  helpUrl: string
  // Kebab-case namespace used to derive filesystem names under user projects.
  // Drives the `.<projectNamespace>/` overlay directory and the
  // `.<projectNamespace>.json` sidecar suffix for custom agent/skill metadata.
  // Defaults to "opencowork" for back-compat; a downstream fork (e.g. Nike
  // Agent) sets this to "nike-agent" so user projects get `.nike-agent/`.
  projectNamespace?: string
  // Optional override of the default UI theme id. Falls back to a built-in
  // preset if unset or unknown.
  defaultTheme?: string
  // Extra themes appended to the built-in preset list. Downstream forks can
  // ship their own palette (e.g. "Nike Red") without touching source.
  themes?: BrandThemeDefinition[]
}

export interface AgentStarterTemplate {
  id: string
  label: string
  description: string
  // Matches the AgentColor union in the renderer agent builder.
  color: string
  instructions: string
  temperature?: number | null
  steps?: number | null
  toolIds?: string[]
  skillNames?: string[]
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
  // Starter templates shown on the "New agent" template picker. Seeded
  // with the upstream defaults and extensible by downstream config.
  agentStarterTemplates: AgentStarterTemplate[]
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

export interface CoworkAPI {
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
    // Aborts a single sub-agent task under a root session without
    // cancelling the root or its siblings. Used by the task drill-in
    // drawer's per-task abort button.
    abortTask: (rootSessionId: string, childSessionId: string) => Promise<void>
    rename: (sessionId: string, title: string) => Promise<boolean>
    delete: (sessionId: string, confirmationToken?: string | null) => Promise<boolean>
    export: (sessionId: string) => Promise<string | null>
    fork: (sessionId: string, messageId?: string) => Promise<SessionInfo | null>
    share: (sessionId: string) => Promise<string | null>
    unshare: (sessionId: string) => Promise<boolean>
    summarize: (sessionId: string) => Promise<{ ok: true } | { ok: false, message: string }>
    revert: (sessionId: string, messageId?: string) => Promise<boolean>
    unrevert: (sessionId: string) => Promise<boolean>
    children: (sessionId: string) => Promise<any[]>
    diff: (sessionId: string, messageId?: string) => Promise<SessionFileDiff[]>
    fileSnippet: (request: { sessionId: string; filePath: string; startLine: number; endLine: number }) => Promise<string[]>
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
    // Returns credentials masked ('••••••••' for set values). Safe default
    // for any consumer that only needs non-secret fields.
    get: () => Promise<EffectiveAppSettings>
    // Returns unmasked credentials. Only the credential editor surfaces
    // (SetupScreen, SettingsPanel → Models) should call this.
    getWithCredentials: () => Promise<EffectiveAppSettings>
    set: (updates: Partial<AppSettings>) => Promise<EffectiveAppSettings>
  }
  mcp: {
    auth: (mcpName: string) => Promise<boolean>
    connect: (name: string) => Promise<void>
    disconnect: (name: string) => Promise<void>
  }
  dialog: {
    selectDirectory: () => Promise<string | null>
    // Opens the system file picker filtered to image MIME types. On
    // cancel or error returns null. On success returns the raw bytes +
    // mime of the selected image so the renderer can downsample before
    // persisting the avatar into the agent sidecar.
    selectImage: () => Promise<{ mime: string; base64: string } | null>
    // Pick a JSON file from disk and return its parsed contents. Used by
    // the "Import agent" flow. Returns null on cancel or parse failure.
    openJson: () => Promise<{ content: unknown; filename: string } | null>
    // Save text to disk via the system save dialog. Returns the saved
    // path, or null on cancel. Used by "Export agent".
    saveText: (defaultFilename: string, content: string) => Promise<string | null>
  }
  chart: {
    renderSvg: (spec: Record<string, unknown>) => Promise<string>
    saveArtifact: (request: ChartSaveArtifactRequest) => Promise<SessionArtifact>
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
    info: () => Promise<ModelInfoSnapshot>
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
    // Fire-and-forget. Called by the renderer's error boundary so
    // render panics land in the sanitized diagnostics bundle. Payload
    // fields are all strings so log sanitizer runs uniformly.
    reportRendererError: (payload: { message: string; stack?: string; componentStack?: string; view?: string }) => void
  }
  app: {
    config: () => Promise<PublicAppConfig>
    builtinAgents: () => Promise<BuiltInAgentDetail[]>
    dashboardSummary: (range?: DashboardTimeRangeKey) => Promise<DashboardSummary>
    runtimeInputs: () => Promise<RuntimeInputDiagnostics>
    refreshProviderCatalog: (providerId: string) => Promise<ProviderModelDescriptor[]>
    // Returns a plaintext diagnostics bundle (config, runtime inputs,
    // perf, log tail). Credentials are masked / redacted. Null if the
    // handler failed. Callers typically copy-to-clipboard or save-to-file.
    exportDiagnostics: () => Promise<string | null>
  }
  agents: {
    catalog: (options?: RuntimeContextOptions) => Promise<AgentCatalog>
    list: (options?: RuntimeContextOptions) => Promise<CustomAgentSummary[]>
    runtime: () => Promise<RuntimeAgentDescriptor[]>
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
  explorer: {
    fileList: (path: string, directory?: string | null) => Promise<FileNode[]>
    fileRead: (path: string, directory?: string | null) => Promise<FileContent | null>
    fileStatus: (directory?: string | null) => Promise<FileStatus[]>
    findFiles: (options: FindFilesOptions, directory?: string | null) => Promise<string[]>
    findSymbols: (query: string, directory?: string | null) => Promise<ExplorerSymbol[]>
    findText: (pattern: string, directory?: string | null) => Promise<TextMatch[]>
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
    dashboardSummaryUpdated: (callback: () => void) => () => void
    sessionUpdated: (callback: (data: {
      id: string
      title: string | null
      parentSessionId?: string | null
      changeSummary?: SessionChangeSummary | null
      revertedMessageId?: string | null
    }) => void) => () => void
    sessionDeleted: (callback: (data: { id: string }) => void) => () => void
  }
}

// Legacy alias kept so older code / docs referencing `OpenCoworkAPI` keep
// resolving. New code should use `CoworkAPI`.
export type OpenCoworkAPI = CoworkAPI

declare global {
  interface Window {
    coworkApi: CoworkAPI
  }
}

export * from './shortcuts.js'
