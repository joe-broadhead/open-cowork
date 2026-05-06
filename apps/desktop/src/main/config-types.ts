import type {
  AgentStarterTemplate,
  BrandingConfig,
  CredentialField,
  ModelInfoSnapshot,
  ProviderModelDescriptor,
} from '@open-cowork/shared'

export type ConfiguredSkill = {
  name: string
  description: string
  badge: 'Skill'
  sourceName: string
  toolIds?: string[]
}

export type ConfiguredTool = {
  id: string
  name: string
  icon?: string
  description: string
  kind: 'mcp' | 'built-in'
  namespace?: string
  patterns?: string[]
  allowPatterns?: string[]
  askPatterns?: string[]
  writeAccess?: boolean
}

export type BundleCredential = CredentialField

export type BundleHeaderSetting = {
  header: string
  key: string
  prefix?: string
}

export type BundleEnvSetting = {
  env: string
  key: string
}

export type BundleMcp = {
  name: string
  type: 'local' | 'remote'
  description: string
  authMode: 'none' | 'oauth' | 'api_token'
  packageName?: string
  command?: string[]
  url?: string
  headers?: Record<string, string>
  headerSettings?: BundleHeaderSetting[]
  envSettings?: BundleEnvSetting[]
  // UI metadata for per-MCP credential inputs. When present, the
  // Capabilities panel renders an input field per entry and persists
  // values to `integrationCredentials[mcpName][key]` — the same store
  // `envSettings` / `headerSettings` already read from. Lets bundles
  // like GitHub (PAT) or Perplexity (API key) collect their secrets
  // without each downstream fork having to build its own UI.
  credentials?: CredentialField[]
  // Opt-in: forward the app-level Google OAuth credentials into this MCP
  // via `GOOGLE_APPLICATION_CREDENTIALS`. See `CustomMcpConfig.googleAuth`
  // for the contract. Gated on `auth.mode: google-oauth` + a successful
  // login — no-op otherwise.
  googleAuth?: boolean
}

export type ConfiguredAgent = {
  name: string
  label?: string
  description: string
  instructions: string
  skillNames?: string[]
  toolIds?: string[]
  allowTools?: string[]
  askTools?: string[]
  color?: string
  hidden?: boolean
  mode?: 'primary' | 'subagent'
  // Inference tuning forwarded to SDK AgentConfig. Optional; unset fields
  // inherit the session defaults.
  model?: string
  variant?: string
  temperature?: number
  top_p?: number
  steps?: number
  options?: Record<string, unknown>
}

export type BuiltInAgentOverrideConfig = {
  disable?: boolean
  hidden?: boolean
  description?: string
  instructions?: string
  color?: string
  model?: string
  variant?: string
  temperature?: number
  top_p?: number
  steps?: number
  options?: Record<string, unknown>
}

export type CustomProviderRuntimeConfig = {
  npm: string
  name: string
  defaultModel?: string
  options?: Record<string, unknown>
  models: Record<string, Record<string, unknown>>
  credentials?: CredentialField[]
  description?: string
}

export type ConfiguredModelInfo = {
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
}

export type ConfiguredProviderDescriptor = {
  runtime?: 'builtin' | 'custom'
  name: string
  description: string
  defaultModel?: string
  options?: Record<string, unknown>
  credentials: CredentialField[]
  models: ProviderModelDescriptor[]
  // Optional dynamic-catalog hookup. When present, the app fetches the
  // endpoint, extracts models via the configured field paths, and overlays
  // them underneath the hardcoded `models[]` (which are treated as
  // featured / pinned). See `provider-catalog.ts`.
  dynamicCatalog?: {
    url: string
    responsePath?: string
    idField?: string
    nameField?: string
    descriptionField?: string
    contextLengthField?: string
    authHeader?: string
    sha256?: string
    cacheTtlMinutes?: number
  }
}

export type OpenCoworkConfig = {
  allowedEnvPlaceholders: string[]
  branding: BrandingConfig
  auth: {
    mode: 'none' | 'google-oauth'
    googleOAuth?: {
      clientId: string
      clientSecret?: string
      scopes?: string[]
    }
  }
  providers: {
    available: string[]
    descriptors?: Record<string, ConfiguredProviderDescriptor>
    defaultProvider: string | null
    defaultModel: string | null
    modelInfo?: Record<string, ConfiguredModelInfo>
    custom?: Record<string, CustomProviderRuntimeConfig>
  }
  tools: ConfiguredTool[]
  skills: ConfiguredSkill[]
  mcps: BundleMcp[]
  agents: ConfiguredAgent[]
  // Per-built-in overrides keyed by agent name (build / plan / general /
  // explore). Lets a downstream disable an agent or retune its model/
  // prompt/inference without modifying the upstream app.
  builtInAgents?: Record<string, BuiltInAgentOverrideConfig>
  // Extra starter templates appended to the built-in set shown in the
  // "New agent" picker. Downstream forks can ship their own templates
  // (e.g. "Nike Brand Writer") without touching renderer source.
  agentStarterTemplates?: AgentStarterTemplate[]
  permissions: {
    bash: 'allow' | 'ask' | 'deny'
    fileWrite: 'allow' | 'ask' | 'deny'
    task: 'allow' | 'ask' | 'deny'
    web: 'allow' | 'ask' | 'deny'
    webSearch: boolean
  }
  compaction: {
    // Enable automatic compaction when context is full. Default true.
    auto: boolean
    // Prune stale tool outputs during compaction. Default true.
    prune: boolean
    // Token buffer the runtime reserves so compaction can happen before
    // the context window overflows. Default 10_000.
    reserved: number
    // Optional overrides for the dedicated compaction agent that OpenCode
    // uses to summarize the session. Matches SDK Config.agent.compaction.
    agent?: {
      model?: string
      prompt?: string
      temperature?: number
    }
  }
  // Optional translation + locale overlay. Downstream forks set
  // `i18n.locale` to e.g. "de-DE" so Intl.NumberFormat / Intl.DateTimeFormat
  // produce locale-appropriate output, and `i18n.strings` to a
  // catalog of key→translation pairs. Unset entries fall back to the
  // inline English default in the renderer source.
  i18n?: {
    locale?: string
    strings?: Record<string, string>
  }
  // Optional remote telemetry forwarder. Upstream leaves `enabled:
  // false` (the default) — all event tracking stays local on disk.
  // Downstream forks shipping to a company internal install can point
  // `endpoint` at their own collector (PostHog, Mixpanel, a custom
  // http endpoint) and every tracked event is POSTed as JSON. The
  // `headers` map passes through verbatim — use it for auth tokens
  // rendered from env placeholders at config-load time.
  telemetry?: {
    enabled?: boolean
    endpoint?: string
    headers?: Record<string, string>
  }
}

// Re-export the shared type under the config-loader's historical name so
// existing call sites continue to compile. The shape is identical — this
// is the same data structure that `model:info` IPC returns and that the
// renderer consumes.
export type ModelFallbackInfo = ModelInfoSnapshot

export const DEFAULT_CONFIG: OpenCoworkConfig = {
  allowedEnvPlaceholders: [],
  branding: {
    name: 'Cowork',
    appId: 'com.example.cowork',
    dataDirName: 'cowork',
    helpUrl: '',
    projectNamespace: 'opencowork',
    defaultTheme: 'mercury',
    themes: [],
  },
  auth: {
    mode: 'none',
  },
  providers: {
    available: [],
    descriptors: {},
    defaultProvider: null,
    defaultModel: null,
    modelInfo: {},
    custom: {},
  },
  tools: [],
  skills: [],
  mcps: [],
  agents: [],
  permissions: {
    bash: 'ask',
    fileWrite: 'ask',
    task: 'allow',
    web: 'allow',
    webSearch: true,
  },
  compaction: {
    auto: true,
    prune: true,
    reserved: 10_000,
  },
}
