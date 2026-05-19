import type {
  WorkflowDetail,
  WorkflowListPayload,
  WorkflowRun,
} from './workflow.js'
import type {
  CapabilitySkill,
  CapabilitySkillBundle,
  CapabilityTool,
} from './capabilities.js'
import type {
  RuntimeNotification,
  SessionChangeSummary,
  SessionChildInfo,
  SessionComposerPreferences,
  SessionFileDiff,
  SessionInfo,
  SessionPromptOptions,
  SessionPatch,
  SessionView,
  TodoItem,
} from './session.js'
import type {
  PerfSnapshot,
  RuntimeContextOptions,
  RuntimeInputDiagnostics,
  RuntimeLoadingStatus,
  RuntimeStatus,
  RuntimeToolDescriptor,
  RecentProject,
  ToolListOptions,
} from './runtime.js'
import type {
  AppMetadata,
  AppSettings,
  AuthState,
  EffectiveAppSettings,
  PublicAppConfig,
} from './app-config.js'
import type {
  ChartSaveArtifactRequest,
  SessionArtifact,
  SessionArtifactAttachment,
  SessionArtifactExportRequest,
  SessionArtifactRequest,
} from './artifacts.js'
import type {
  AgentCatalog,
  BuiltInAgentDetail,
  CustomAgentConfig,
  CustomAgentSummary,
  CustomMcpConfig,
  CustomMcpTestResult,
  CustomSkillConfig,
  RuntimeAgentDescriptor,
  ScopedArtifactRef,
} from './custom-content.js'
import type {
  DestructiveConfirmationGrant,
  DestructiveConfirmationRequest,
} from './destructive-actions.js'
import type {
  McpStatus,
  PermissionRequest,
} from './events.js'
import type {
  ExplorerSymbol,
  FileContent,
  FileNode,
  FileStatus,
  FindFilesOptions,
  TextMatch,
} from './explorer.js'
import type {
  ModelInfoSnapshot,
  ProviderAuthAuthorization,
  ProviderAuthMethod,
  ProviderModelDescriptor,
  RuntimeProviderDescriptor,
} from './providers.js'
import type {
  SandboxCleanupResult,
  SandboxStorageStats,
  SkillImportSelection,
} from './workspace.js'
import type {
  ThreadFacetSummary,
  ThreadSearchQuery,
  ThreadSearchResult,
  ThreadSmartFilter,
  ThreadSmartFilterInput,
  ThreadTag,
  ThreadTagInput,
} from './threads.js'
import type {
  UpdateCheckResult,
  UpdateInstallCapability,
  UpdateInstallEvent,
  UpdateInstallStatus,
} from './updates.js'

export * from './app-config.js'
export * from './agent-validation.js'
export * from './artifacts.js'
export * from './capabilities.js'
export * from './custom-content.js'
export * from './destructive-actions.js'
export * from './events.js'
export * from './explorer.js'
export * from './providers.js'
export * from './runtime.js'
export * from './session.js'
export * from './shortcuts.js'
export * from './skill-validation.js'
export * from './threads.js'
export * from './tool-trace.js'
export * from './updates.js'
export * from './workspace.js'
export * from './workflow.js'

export interface CoworkAPI {
  auth: {
    status: () => Promise<AuthState>
    login: () => Promise<AuthState>
    logout: () => Promise<AuthState>
  }
  session: {
    create: (directory?: string) => Promise<SessionInfo>
    activate: (sessionId: string, options?: { force?: boolean }) => Promise<SessionView>
    prompt: (sessionId: string, text: string, attachments?: Array<{ mime: string; url: string; filename?: string }>, agent?: string, options?: SessionPromptOptions) => Promise<void>
    setComposerPreferences: (sessionId: string, preferences: SessionComposerPreferences) => Promise<SessionInfo | null>
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
    requestDestructive: (request: DestructiveConfirmationRequest) => Promise<DestructiveConfirmationGrant | null>
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
    logout: (providerId: string) => Promise<boolean>
  }
  runtime: {
    status: () => Promise<RuntimeStatus>
    awaitInitialization: () => Promise<RuntimeLoadingStatus>
    // User-initiated OpenCode runtime restart, called from the
    // offline banner. Returns the post-reboot status so the banner
    // can update without a second round-trip.
    restart: () => Promise<RuntimeStatus>
  }
  projects: {
    list: () => Promise<RecentProject[]>
    switchByIndex: (index: number) => Promise<SessionInfo | null>
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
    runtimeInputs: () => Promise<RuntimeInputDiagnostics>
    refreshProviderCatalog: (providerId: string) => Promise<ProviderModelDescriptor[]>
    // Returns a plaintext diagnostics bundle (config, runtime inputs,
    // perf, log tail). Credentials are masked / redacted. Null if the
    // handler failed. Callers typically copy-to-clipboard or save-to-file.
    exportDiagnostics: () => Promise<string | null>
    // Queries the configured releases endpoint (GitHub by default). A
    // `disabled` status means the build's helpUrl doesn't resolve to a
    // known host; the renderer just doesn't surface an update hint.
    checkUpdates: () => Promise<UpdateCheckResult>
    // Wipes user-data dir + sandbox workspaces and relaunches. Behind
    // a destructive confirmation token; call confirm.requestDestructive
    // with `{ action: 'app.reset' }` first to get the token.
    reset: (confirmationToken: string) => Promise<{
      removedPaths: string[]
      failedPaths?: Array<{ label: string; path: string; error: string }>
    }>
  }
  updates: {
    installCapability: () => Promise<UpdateInstallCapability>
    checkInstallable: () => Promise<UpdateInstallStatus>
    download: () => Promise<UpdateInstallStatus>
    quitAndInstall: () => Promise<UpdateInstallStatus>
    onInstallEvent: (callback: (event: UpdateInstallEvent) => void) => () => void
  }
  workflows: {
    list: () => Promise<WorkflowListPayload>
    get: (workflowId: string) => Promise<WorkflowDetail | null>
    startDraft: (directory?: string | null) => Promise<SessionInfo>
    runNow: (workflowId: string) => Promise<WorkflowRun | null>
    pause: (workflowId: string) => Promise<WorkflowDetail | null>
    resume: (workflowId: string) => Promise<WorkflowDetail | null>
    archive: (workflowId: string) => Promise<WorkflowDetail | null>
    regenerateWebhookSecret: (workflowId: string) => Promise<WorkflowDetail | null>
  }
  threads: {
    search: (query?: ThreadSearchQuery) => Promise<ThreadSearchResult>
    facets: (query?: ThreadSearchQuery) => Promise<ThreadFacetSummary>
    tags: {
      list: () => Promise<ThreadTag[]>
      create: (input: ThreadTagInput) => Promise<ThreadTag>
      update: (tagId: string, input: ThreadTagInput) => Promise<ThreadTag | null>
      delete: (tagId: string) => Promise<boolean>
      apply: (sessionIds: string[], tagIds: string[]) => Promise<boolean>
      remove: (sessionIds: string[], tagIds: string[]) => Promise<boolean>
    }
    smartFilters: {
      list: () => Promise<ThreadSmartFilter[]>
      create: (input: ThreadSmartFilterInput) => Promise<ThreadSmartFilter>
      update: (filterId: string, input: ThreadSmartFilterInput) => Promise<ThreadSmartFilter | null>
      delete: (filterId: string) => Promise<boolean>
    }
    suggestions: {
      accept: (suggestionId: string) => Promise<boolean>
      edit: (suggestionId: string, input: { label: string }) => Promise<boolean>
      dismiss: (suggestionId: string) => Promise<boolean>
    }
    reindex: (sessionIds?: string[]) => Promise<boolean>
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
    tools: (options?: ToolListOptions) => Promise<CapabilityTool[]>
    tool: (id: string, options?: ToolListOptions) => Promise<CapabilityTool | null>
    skills: (options?: RuntimeContextOptions) => Promise<CapabilitySkill[]>
    skillBundle: (skillName: string, options?: RuntimeContextOptions) => Promise<CapabilitySkillBundle | null>
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
    importSkillDirectory: (selectionToken: string, target: ScopedArtifactRef) => Promise<CustomSkillConfig | null>
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
    runtimeLoadingStatus: (callback: (status: RuntimeLoadingStatus) => void) => () => void
    sessionUpdated: (callback: (data: {
      id: string
      title: string | null
      parentSessionId?: string | null
      changeSummary?: SessionChangeSummary | null
      revertedMessageId?: string | null
      composerModelId?: string | null
      composerReasoningVariant?: string | null
    }) => void) => () => void
    sessionDeleted: (callback: (data: { id: string }) => void) => () => void
    workflowUpdated: (callback: () => void) => () => void
  }
}

declare global {
  interface Window {
    coworkApi: CoworkAPI
  }
}
