import type {
  AutomationAutonomyPolicy,
  AutomationDetail,
  AutomationDraft,
  AutomationExecutionMode,
  AutomationListPayload,
  AutomationRun,
  AutomationSurface,
} from './automation.js'
import type {
  DashboardSummary,
  DashboardTimeRangeKey,
  RuntimeNotification,
  SessionChangeSummary,
  SessionChildInfo,
  SessionFileDiff,
  SessionInfo,
  SessionPatch,
  SessionView,
  TodoItem,
} from './session.js'
import type {
  PerfSnapshot,
  RuntimeContextOptions,
  RuntimeInputDiagnostics,
  RuntimeStatus,
  RuntimeToolDescriptor,
  ToolListOptions,
} from './runtime.js'

export * from './automation.js'
export * from './runtime.js'
export * from './session.js'

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

export interface ChartArtifactSource {
  format: 'vega' | 'vega-lite'
  spec: Record<string, unknown>
  title?: string
}

export interface SessionArtifact {
  id: string
  toolId: string
  toolName: string
  filePath: string
  filename: string
  order: number
  taskRunId?: string | null
  mime?: string
  chart?: ChartArtifactSource | null
}

export interface SessionArtifactAttachment {
  mime: string
  url: string
  filename: string
  chart?: ChartArtifactSource | null
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
  chart?: ChartArtifactSource | null
}

export type DestructiveAction =
  | 'session.delete'
  | 'agent.remove'
  | 'mcp.remove'
  | 'skill.remove'
  | 'app.reset'

export type DestructiveConfirmationRequest =
  | {
      action: 'session.delete'
      sessionId: string
    }
  | {
      action: 'agent.remove' | 'mcp.remove' | 'skill.remove'
      target: ScopedArtifactRef
    }
  | {
      // Resets every piece of on-disk state owned by the app:
      // user-data dir (settings, logs, session-registry), sandbox
      // workspaces, and safeStorage credentials. Singleton action —
      // no target or scope.
      action: 'app.reset'
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
  error?: string
}

export const MCP_AUTH_REQUIRED_STATUSES = [
  'needs_auth',
  'needs_client_registration',
  'auth_required',
] as const

export function isMcpAuthRequiredStatus(status?: string | null) {
  return typeof status === 'string'
    && (MCP_AUTH_REQUIRED_STATUSES as readonly string[]).includes(status)
}

export type CustomMcpPermissionMode = 'ask' | 'allow'

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
  // Agent permission posture for this custom MCP. Missing/`ask` means
  // assigned agents can see the MCP but OpenCode still asks before tool
  // calls. `allow` is an explicit trust decision: selected agents receive
  // allow patterns for this MCP's methods, while denied method patterns
  // still override it.
  permissionMode?: CustomMcpPermissionMode
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
  surface?: AutomationSurface
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
  cacheWritePer1M?: number
}

export interface ModelInfoSnapshot {
  pricing: Record<string, ModelPricing>
  contextLimits: Record<string, number>
}

export interface ProviderModelDescriptor {
  id: string
  name: string
  description?: string
  limit?: {
    context?: number
    output?: number
  }
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
  }
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
  // Populated from OpenCode's live provider catalog when available.
  // Used to prefer the runtime's native default instead of guessing
  // from a sorted model list.
  defaultModel?: string
  // `true` means OpenCode reports this provider as authenticated /
  // connected in its provider.list response. `false` means OpenCode
  // knows the provider but does not currently have usable auth.
  connected?: boolean
}

export type ProviderAuthPrompt =
  | {
    type: 'text'
    key: string
    message: string
    placeholder?: string
    when?: {
      key: string
      op: 'eq' | 'neq'
      value: string
    }
  }
  | {
    type: 'select'
    key: string
    message: string
    options: Array<{
      label: string
      value: string
      hint?: string
    }>
    when?: {
      key: string
      op: 'eq' | 'neq'
      value: string
    }
  }

export interface ProviderAuthMethod {
  type: 'oauth' | 'api'
  label: string
  prompts?: ProviderAuthPrompt[]
}

export interface ProviderAuthAuthorization {
  url: string
  method: 'auto' | 'code'
  instructions: string
}

export interface RuntimeProviderDescriptor {
  id?: string
  name?: string
  models?: Record<string, unknown>
  defaultModel?: string
  connected?: boolean
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

export type BrandingSidebarTopVariant = 'icon' | 'text' | 'icon-text' | 'logo' | 'logo-text'
export type BrandingSidebarMediaFit = 'vertical' | 'horizontal'
export type BrandingSidebarMediaAlign = 'start' | 'center' | 'end'

export interface BrandingSidebarTopConfig {
  variant?: BrandingSidebarTopVariant
  icon?: string
  logoAsset?: string
  logoUrl?: string
  logoDataUrl?: string
  mediaSize?: number
  mediaFit?: BrandingSidebarMediaFit
  mediaAlign?: BrandingSidebarMediaAlign
  title?: string
  subtitle?: string
  ariaLabel?: string
}

export interface BrandingSidebarLowerConfig {
  text?: string
  secondaryText?: string
  linkLabel?: string
  linkUrl?: string
}

export interface BrandingSidebarConfig {
  top?: BrandingSidebarTopConfig
  lower?: BrandingSidebarLowerConfig
}

export interface BrandingHomeConfig {
  greeting?: string
  subtitle?: string
  composerPlaceholder?: string
  suggestionLabel?: string
  statusReadyLabel?: string
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
  // Optional UI copy/brand surfaces for downstream distributions. These stay
  // product-layer only and do not alter OpenCode runtime config or behavior.
  sidebar?: BrandingSidebarConfig
  home?: BrandingHomeConfig
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

// Optional per-install i18n overlay. Downstream forks targeting a
// non-English market populate `strings` with translations keyed on the
// catalog identifiers used by `useI18n()` in the renderer. Unset
// entries fall back to the English default inline in the source. A
// full catalog is NOT required — shipping with a few critical strings
// translated and the rest in English is a legitimate partial state.
// `locale` flows into `Intl.NumberFormat` / `Intl.DateTimeFormat` so
// costs, token counts, and timestamps render in the user's regional
// format.
export interface AppI18nConfig {
  locale?: string
  strings?: Record<string, string>
}

export interface AppMetadata {
  version: string
  preview: boolean
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
  // Optional translation + locale overlay. Absent / empty objects are
  // treated as "English default formatting" — the renderer falls back
  // to inline English strings and the host locale for Intl.
  i18n?: AppI18nConfig
}

export interface AppSettings {
  selectedProviderId: string | null
  selectedModelId: string | null
  providerCredentials: Record<string, Record<string, string>>
  integrationCredentials: Record<string, Record<string, string>>
  // Per-bundled-MCP opt-in flag. `true` = user has explicitly enabled
  // this integration (will register in OpenCode and attempt connection).
  // `false` = user has explicitly disabled. `undefined` = defer to
  // implicit readiness heuristic (credentials present, signed in, etc.).
  integrationEnabled: Record<string, boolean>
  enableBash: boolean
  enableFileWrite: boolean
  runtimeToolingBridgeEnabled: boolean
  automationLaunchAtLogin: boolean
  automationRunInBackground: boolean
  automationDesktopNotifications: boolean
  automationQuietHoursStart: string | null
  automationQuietHoursEnd: string | null
  defaultAutomationAutonomyPolicy: AutomationAutonomyPolicy
  defaultAutomationExecutionMode: AutomationExecutionMode
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
    logout: () => Promise<AuthState>
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
    children: (sessionId: string) => Promise<SessionChildInfo[]>
    diff: (sessionId: string, messageId?: string) => Promise<SessionFileDiff[]>
    fileSnippet: (request: { sessionId: string; filePath: string; startLine: number; endLine: number }) => Promise<string[]>
    todo: (sessionId: string) => Promise<TodoItem[]>
  }
  permission: {
    respond: (id: string, allowed: boolean, sessionId?: string | null) => Promise<void>
  }
  question: {
    reply: (sessionId: string, requestId: string, answers: string[][]) => Promise<void>
    reject: (sessionId: string, requestId: string) => Promise<void>
  }
  settings: {
    // Returns credentials masked ('••••••••' for set values). Safe default
    // for any consumer that only needs non-secret fields.
    get: () => Promise<EffectiveAppSettings>
    // Scoped unmasked reads for credential editor surfaces. The renderer
    // never receives the full effective settings object with every secret.
    getProviderCredentials: (providerId: string) => Promise<Record<string, string>>
    getIntegrationCredentials: (integrationId: string) => Promise<Record<string, string>>
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
    readAttachment: (request: SessionArtifactRequest) => Promise<SessionArtifactAttachment>
    storageStats: () => Promise<SandboxStorageStats>
    cleanup: (mode: SandboxCleanupResult['mode']) => Promise<SandboxCleanupResult>
  }
  confirm: {
    requestDestructive: (request: DestructiveConfirmationRequest) => Promise<DestructiveConfirmationGrant>
  }
  clipboard: {
    writeText: (text: string) => Promise<boolean>
  }
  model: {
    info: () => Promise<ModelInfoSnapshot>
  }
  tools: {
    list: (options?: ToolListOptions) => Promise<RuntimeToolDescriptor[]>
  }
  command: {
    list: () => Promise<Array<{ name: string; description?: string; source?: string }>>
    run: (sessionId: string, name: string) => Promise<boolean>
  }
  provider: {
    list: () => Promise<RuntimeProviderDescriptor[]>
    authMethods: () => Promise<Record<string, ProviderAuthMethod[]>>
    authorize: (
      providerId: string,
      method: number,
      inputs?: Record<string, string>,
    ) => Promise<ProviderAuthAuthorization | null>
    callback: (providerId: string, method: number, code?: string) => Promise<boolean>
  }
  runtime: {
    status: () => Promise<RuntimeStatus>
    // User-initiated OpenCode runtime restart, called from the
    // offline banner. Returns the post-reboot status so the banner
    // can update without a second round-trip.
    restart: () => Promise<RuntimeStatus>
  }
  diagnostics: {
    perf: () => Promise<PerfSnapshot>
    // Fire-and-forget. Called by the renderer's error boundary so
    // render panics land in the sanitized diagnostics bundle. Payload
    // fields are all strings so log sanitizer runs uniformly.
    reportRendererError: (payload: { message: string; stack?: string; componentStack?: string; view?: string }) => void
  }
  app: {
    metadata: () => Promise<AppMetadata>
    config: () => Promise<PublicAppConfig>
    builtinAgents: () => Promise<BuiltInAgentDetail[]>
    dashboardSummary: (range?: DashboardTimeRangeKey) => Promise<DashboardSummary>
    runtimeInputs: () => Promise<RuntimeInputDiagnostics>
    refreshProviderCatalog: (providerId: string) => Promise<ProviderModelDescriptor[]>
    // Returns a plaintext diagnostics bundle (config, runtime inputs,
    // perf, log tail). Credentials are masked / redacted. Null if the
    // handler failed. Callers typically copy-to-clipboard or save-to-file.
    exportDiagnostics: () => Promise<string | null>
    // Queries the configured releases endpoint (GitHub by default). A
    // `disabled` status means the build's helpUrl doesn't resolve to a
    // known host; the renderer just doesn't surface an update hint.
    checkUpdates: () => Promise<
      | { status: 'ok'; currentVersion: string; latestVersion: string; hasUpdate: boolean; releaseUrl: string }
      | { status: 'error'; currentVersion: string; message: string }
      | { status: 'disabled'; currentVersion: string; message: string }
    >
    // Wipes user-data dir + sandbox workspaces and relaunches. Behind
    // a destructive confirmation token; call confirm.requestDestructive
    // with `{ action: 'app.reset' }` first to get the token.
    reset: (confirmationToken: string) => Promise<{ removedPaths: string[] }>
  }
  automation: {
    list: () => Promise<AutomationListPayload>
    get: (automationId: string) => Promise<AutomationDetail | null>
    create: (draft: AutomationDraft) => Promise<AutomationDetail>
    update: (automationId: string, draft: Partial<AutomationDraft>) => Promise<AutomationDetail | null>
    pause: (automationId: string) => Promise<AutomationDetail | null>
    resume: (automationId: string) => Promise<AutomationDetail | null>
    archive: (automationId: string) => Promise<AutomationDetail | null>
    runNow: (automationId: string) => Promise<AutomationRun | null>
    retryRun: (runId: string) => Promise<AutomationRun | null>
    cancelRun: (runId: string) => Promise<boolean>
    previewBrief: (automationId: string) => Promise<AutomationDetail | null>
    approveBrief: (automationId: string) => Promise<AutomationDetail | null>
    inboxRespond: (itemId: string, response: string) => Promise<boolean>
    inboxDismiss: (itemId: string) => Promise<boolean>
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
    skillBundleFile: (skillName: string, filePath: string, options?: RuntimeContextOptions) => Promise<string | null>
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
    authLogout: (callback: () => void) => () => void
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
    automationUpdated: (callback: () => void) => () => void
  }
}

declare global {
  interface Window {
    coworkApi: CoworkAPI
  }
}

export * from './shortcuts.js'
