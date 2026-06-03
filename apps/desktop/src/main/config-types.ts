import { DEFAULT_TOOL_TRACE_RULES, type ToolTraceConfig } from '@open-cowork/shared'
import type {
  AgentStarterTemplate,
  BrandingConfig,
  CapabilityBundleManifest,
  CloudProjectSourceInput,
  CredentialField,
  GatewayDeploymentConfig,
  ModelInfoSnapshot,
  ProviderModelDescriptor,
  PublicBrandingConfig,
  UpdateReleaseSourceAuthKind,
  UpdateReleaseSourceKind,
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
  defaultAccess?: boolean
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
  // Optional downstream-authored troubleshooting text shown with API-token
  // preflight failures. Example: GitHub PAT scopes, SSO authorization, or
  // enterprise policy checks.
  credentialHelp?: string
  // Opt-in for downstream-hosted remote MCPs that intentionally live on
  // private DNS/IP ranges, such as an internal GCS or intranet MCP. Cloud
  // metadata endpoints remain blocked by the URL policy even when this is true.
  allowPrivateNetwork?: boolean
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
  smallModel?: string
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
  runtimeActivation?: 'implicit' | 'config'
  name: string
  description: string
  defaultModel?: string
  smallModel?: string
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

export type UpdateReleaseSourceConfig =
  | {
    kind: Extract<UpdateReleaseSourceKind, 'github-releases'>
    label?: string
    owner?: string
    repo?: string
    channel?: string
    auth?: {
      kind: Extract<UpdateReleaseSourceAuthKind, 'none' | 'github-token'>
      token?: string
    }
  }
  | {
    kind: Extract<UpdateReleaseSourceKind, 'generic-http'>
    label?: string
    url: string
    channel?: string
    auth?: {
      kind: Extract<UpdateReleaseSourceAuthKind, 'none' | 'static-headers'>
      headers?: Record<string, string>
    }
  }
  | {
    kind: Extract<UpdateReleaseSourceKind, 'gcs'>
    label?: string
    bucket: string
    prefix?: string
    channel?: string
    auth?: {
      kind: Extract<UpdateReleaseSourceAuthKind, 'google-oauth'>
      requiredScopes?: string[]
    } | {
      kind: Extract<UpdateReleaseSourceAuthKind, 'signed-url-broker'>
      brokerUrl: string
      requiredScopes?: string[]
    }
  }

export type CloudRole = 'all-in-one' | 'web' | 'worker' | 'scheduler'

export type CloudFeatureKey =
  | 'chat'
  | 'agents'
  | 'artifacts'
  | 'threadIndex'
  | 'workflows'
  | 'webhooks'
  | 'settings'
  | 'customSkills'
  | 'customAgents'
  | 'customMcps'

export type CloudFeatureConfig = Record<CloudFeatureKey, boolean>

export type CloudRuntimePolicyConfig = {
  configSource: 'app'
  launcher: 'node'
  allowMachineRuntimeConfig: boolean
  allowLocalStdioMcps: boolean
  allowHostProjectDirectories: boolean
  allowRemoteApprovalResponses: boolean
  allowedLocalMcpNames: string[]
  allowedHostProjectDirectories: string[]
}

export type CloudProjectSourcePolicyConfig = {
  git: {
    enabled: boolean
    allowedHosts: string[]
    allowedRepositories: string[]
    allowFileUrls: boolean
  }
  uploadedSnapshots: {
    enabled: boolean
    maxFiles: number
    maxBytes: number
  }
  managedWorkspaces: {
    enabled: boolean
  }
}

export type CloudProfileConfig = {
  label?: string
  description?: string
  agents?: string[]
  tools?: string[]
  mcps?: string[]
  features?: Partial<CloudFeatureConfig>
  runtime?: Partial<CloudRuntimePolicyConfig>
  defaultProjectSource?: CloudProjectSourceInput | null
}

export type CloudAuthConfig = {
  mode: 'none' | 'header' | 'oidc'
  signupMode?: 'disabled' | 'closed' | 'invite' | 'domain' | 'open'
  headerSecret?: string
  headerSecretRef?: string
  headerAllowUnsigned?: boolean
  headerMaxSignatureAgeMs?: number
  issuerUrl?: string
  clientId?: string
  clientSecretRef?: string
  callbackPath?: string
  cookieSecretRef?: string
  allowedEmailDomains?: string[]
  allowSelfServiceSignup?: boolean
  apiTokens?: {
    defaultTtlMs?: number
    maxTtlMs?: number
    allowedScopes?: string[]
  }
}

export type CloudStorageConfig = {
  controlPlane: {
    kind: 'local' | 'postgres'
    urlRef?: string
  }
  objectStore: {
    kind: 'filesystem' | 's3' | 'gcs' | 'azure-blob' | 'digitalocean-spaces' | 'minio'
    bucket?: string
    region?: string
    endpoint?: string
    prefix?: string
    credentialsRef?: string
  }
}

export type CloudRateLimitConfig = {
  enabled: boolean
  windowMs: number
  maxRequests: number
}

export type CloudAuthBackoffConfig = {
  enabled: boolean
  windowMs: number
  maxFailures: number
  backoffMs: number
}

export type CloudAbuseConfig = {
  enabled: boolean
  maxConcurrentSessionsPerOrg: number | null
  maxConcurrentWorkflowRunsPerOrg: number | null
  maxActiveWorkersPerOrg: number | null
  maxQueuedCommandsPerOrg: number | null
  maxQueueAgeMs: number | null
  maxPromptsPerHour: number | null
  maxWorkflowRunsPerHour: number | null
  maxGatewayPromptsPerHour: number | null
  maxWorkerMinutesPerHour: number | null
  maxGatewayDeliveriesPerHour: number | null
  maxGatewayChannelBindingsPerOrg: number | null
  maxArtifactBytesPerDay: number | null
  httpRateLimit: CloudRateLimitConfig
  authBackoff: CloudAuthBackoffConfig
}

export type CloudBillingProvider = 'none' | 'stub' | 'stripe'

export type CloudSubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete'

export type CloudBillingEntitlements = {
  features?: Partial<CloudFeatureConfig>
  allowedProfiles?: string[] | null
  allowedProviders?: string[] | null
  maxConcurrentSessionsPerOrg?: number | null
  maxConcurrentWorkflowRunsPerOrg?: number | null
  maxActiveWorkersPerOrg?: number | null
  maxQueuedCommandsPerOrg?: number | null
  maxQueueAgeMs?: number | null
  maxPromptsPerHour?: number | null
  maxWorkflowRunsPerHour?: number | null
  maxGatewayPromptsPerHour?: number | null
  maxWorkerMinutesPerHour?: number | null
  maxGatewayDeliveriesPerHour?: number | null
  maxGatewayChannelBindingsPerOrg?: number | null
  maxArtifactBytesPerDay?: number | null
  allowNewSessions?: boolean
  allowPrompts?: boolean
  allowWorkers?: boolean
}

export type CloudBillingPlanConfig = {
  label?: string
  stripePriceId?: string
  entitlements?: CloudBillingEntitlements
}

export type CloudBillingConfig = {
  enabled: boolean
  provider: CloudBillingProvider
  defaultPlanKey: string
  plans: Record<string, CloudBillingPlanConfig>
  stripe?: {
    apiKeyRef?: string
    webhookSecretRef?: string
    defaultPriceId?: string
    successUrl?: string
    cancelUrl?: string
    portalReturnUrl?: string
  }
}

export type CloudDesktopConnectionConfig = {
  baseUrl: string
  label?: string
}

export type CloudDesktopConfig = {
  enabled: boolean
  allowUserAddedConnections: boolean
  preconfiguredConnections: CloudDesktopConnectionConfig[]
  requireManagedOrg: boolean
  cacheMode: 'full' | 'metadata-only' | 'disabled'
  cacheEncryptionFallback: 'metadata-only' | 'disabled' | 'fail-startup'
}

export type CloudConfig = {
  role: CloudRole
  profiles: Record<string, CloudProfileConfig>
  defaultProfile: string
  publicBranding: PublicBrandingConfig
  auth: CloudAuthConfig
  storage: CloudStorageConfig
  runtime: CloudRuntimePolicyConfig
  projectSources: CloudProjectSourcePolicyConfig
  features: CloudFeatureConfig
  abuse: CloudAbuseConfig
  billing: CloudBillingConfig
}

export const OPEN_COWORK_CONFIG_CONTRACT_VERSION = 1

export type OpenCoworkConfig = {
  contractVersion: typeof OPEN_COWORK_CONFIG_CONTRACT_VERSION
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
  updates?: {
    enabled?: boolean
    manualFallbackUrl?: string
    releaseSource?: UpdateReleaseSourceConfig
  }
  tools: ConfiguredTool[]
  skills: ConfiguredSkill[]
  mcps: BundleMcp[]
  agents: ConfiguredAgent[]
  // Reviewed capability-bundle manifests that may contribute runtime-visible
  // skills, MCPs, providers, workflows, native helpers, or OpenCode plugins.
  // Startup runs a fail-closed product-mode preflight before these resources
  // are allowed anywhere near the OpenCode runtime.
  capabilityBundles?: CapabilityBundleManifest[]
  // Per-built-in overrides keyed by agent name (build / plan / general /
  // explore). Lets a downstream disable an agent or retune its model/
  // prompt/inference without modifying the upstream app.
  builtInAgents?: Record<string, BuiltInAgentOverrideConfig>
  // Extra starter templates appended to the built-in set shown in the
  // "New agent" picker. Downstream forks can ship their own templates
  // (e.g. "Nike Brand Writer") without touching renderer source.
  agentStarterTemplates?: AgentStarterTemplate[]
  // Ordered rules for summarizing runtime tool calls in chat. Downstream
  // forks can add brand/tool-specific groups without patching renderer code.
  toolTrace?: ToolTraceConfig
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
  cloud: CloudConfig
  cloudDesktop: CloudDesktopConfig
  gateway: GatewayDeploymentConfig
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

const DEFAULT_CLOUD_FEATURES: CloudFeatureConfig = {
  chat: true,
  agents: true,
  artifacts: true,
  threadIndex: true,
  workflows: true,
  webhooks: false,
  settings: true,
  customSkills: true,
  customAgents: true,
  customMcps: true,
}

const DEFAULT_CLOUD_RUNTIME: CloudRuntimePolicyConfig = {
  configSource: 'app',
  launcher: 'node',
  allowMachineRuntimeConfig: false,
  allowLocalStdioMcps: false,
  allowHostProjectDirectories: false,
  allowRemoteApprovalResponses: false,
  allowedLocalMcpNames: [],
  allowedHostProjectDirectories: [],
}

const DEFAULT_CLOUD_PROJECT_SOURCES: CloudProjectSourcePolicyConfig = {
  git: {
    enabled: true,
    allowedHosts: ['github.com', 'gitlab.com'],
    allowedRepositories: [],
    allowFileUrls: false,
  },
  uploadedSnapshots: {
    enabled: true,
    maxFiles: 2000,
    maxBytes: 25 * 1024 * 1024,
  },
  managedWorkspaces: {
    enabled: false,
  },
}

const DEFAULT_CLOUD_ABUSE: CloudAbuseConfig = {
  enabled: true,
  maxConcurrentSessionsPerOrg: 100,
  maxConcurrentWorkflowRunsPerOrg: 50,
  maxActiveWorkersPerOrg: 20,
  maxQueuedCommandsPerOrg: 1000,
  maxQueueAgeMs: 30 * 60 * 1000,
  maxPromptsPerHour: 600,
  maxWorkflowRunsPerHour: 200,
  maxGatewayPromptsPerHour: 300,
  maxWorkerMinutesPerHour: 1200,
  maxGatewayDeliveriesPerHour: 1000,
  maxGatewayChannelBindingsPerOrg: 25,
  maxArtifactBytesPerDay: 10 * 1024 * 1024 * 1024,
  httpRateLimit: {
    enabled: true,
    windowMs: 60 * 1000,
    maxRequests: 600,
  },
  authBackoff: {
    enabled: true,
    windowMs: 60 * 1000,
    maxFailures: 10,
    backoffMs: 60 * 1000,
  },
}

const DEFAULT_CLOUD_BILLING: CloudBillingConfig = {
  enabled: false,
  provider: 'none',
  defaultPlanKey: 'self-host',
  plans: {
    'self-host': {
      label: 'Self-host',
      entitlements: {
        allowNewSessions: true,
        allowPrompts: true,
        allowWorkers: true,
      },
    },
  },
}

const DEFAULT_CLOUD_PUBLIC_BRANDING: PublicBrandingConfig = {
  productName: 'Open Cowork Cloud',
  shortName: 'OC',
  supportUrl: '',
  privacyUrl: '',
  securityUrl: '',
  legalUrl: '',
  theme: {
    background: '#f5f6f3',
    surface: '#ffffff',
    mutedSurface: '#ecefed',
    border: '#d8ddd7',
    text: '#18211c',
    mutedText: '#66736b',
    accent: '#2d6b56',
    accentStrong: '#1f503f',
    focus: 'rgba(45, 107, 86, 0.28)',
    warn: '#8a5a14',
    danger: '#9d3630',
    ok: '#1f6b46',
  },
  dashboard: {
    title: 'Workspace',
    subtitle: 'Cloud control plane state for this signed-in org.',
    signInTitle: 'Sign in',
    signInBody: 'Use the configured cloud auth provider to open your org dashboard.',
    byokDescription: 'Provider keys are write-only. The dashboard stores status metadata only.',
    connectionsDescription: 'Issue scoped tokens for desktop and gateway clients. Plaintext is shown once.',
    gatewayDescription: 'Headless agents route chat channels into cloud sessions.',
    billingDescription: 'Manage hosted plan state and entitlements for this org.',
    usageDescription: 'Recent metering events for this org.',
  },
  managedOrgConnectionLabels: {
    desktopToken: 'Desktop token',
    gatewayToken: 'Gateway token',
    apiToken: 'API token',
    cloudUrl: 'Cloud URL',
  },
}

const DEFAULT_CLOUD_DESKTOP: CloudDesktopConfig = {
  enabled: true,
  allowUserAddedConnections: true,
  preconfiguredConnections: [],
  requireManagedOrg: false,
  cacheMode: 'full',
  cacheEncryptionFallback: 'metadata-only',
}

const DEFAULT_GATEWAY_CONFIG: GatewayDeploymentConfig = {
  branding: DEFAULT_CLOUD_PUBLIC_BRANDING,
  cloud: {
    allowInsecureHttp: false,
  },
  server: {
    host: '127.0.0.1',
    port: 8790,
    publicBaseUrl: null,
    adminToken: null,
    trustProxyHeaders: false,
    trustedProxyCidrs: [],
  },
  mode: 'self-host',
  logging: {
    level: 'info',
  },
  metrics: {
    enabled: false,
  },
  diagnostics: {
    enabled: false,
  },
  providers: [],
}

export const DEFAULT_CONFIG: OpenCoworkConfig = {
  contractVersion: OPEN_COWORK_CONFIG_CONTRACT_VERSION,
  allowedEnvPlaceholders: [],
  branding: {
    name: 'Cowork',
    shortName: 'Cowork',
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
  updates: {
    enabled: true,
  },
  tools: [],
  skills: [],
  mcps: [],
  agents: [],
  capabilityBundles: [],
  toolTrace: {
    rules: DEFAULT_TOOL_TRACE_RULES,
    additionalRules: [],
  },
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
  cloud: {
    role: 'all-in-one',
    defaultProfile: 'full',
    publicBranding: DEFAULT_CLOUD_PUBLIC_BRANDING,
    auth: {
      mode: 'none',
      signupMode: 'open',
      allowSelfServiceSignup: true,
      apiTokens: {
        defaultTtlMs: 90 * 24 * 60 * 60 * 1000,
        maxTtlMs: 365 * 24 * 60 * 60 * 1000,
        allowedScopes: ['desktop', 'gateway', 'admin', 'operator'],
      },
    },
    storage: {
      controlPlane: {
        kind: 'local',
      },
      objectStore: {
        kind: 'filesystem',
      },
    },
    runtime: DEFAULT_CLOUD_RUNTIME,
    projectSources: DEFAULT_CLOUD_PROJECT_SOURCES,
    features: DEFAULT_CLOUD_FEATURES,
    abuse: DEFAULT_CLOUD_ABUSE,
    billing: DEFAULT_CLOUD_BILLING,
    profiles: {
      full: {
        label: 'Full app',
        description: 'Expose the complete Open Cowork product surface while keeping cloud runtime hardening enabled.',
        features: DEFAULT_CLOUD_FEATURES,
        runtime: DEFAULT_CLOUD_RUNTIME,
      },
      'focused-agent': {
        label: 'Focused agent',
        description: 'Expose only an allowlisted agent and its approved tools for single-purpose deployments.',
        agents: [],
        tools: [],
        mcps: [],
        features: {
          ...DEFAULT_CLOUD_FEATURES,
          workflows: false,
          webhooks: false,
          settings: false,
          customSkills: false,
          customAgents: false,
          customMcps: false,
        },
        runtime: DEFAULT_CLOUD_RUNTIME,
      },
      custom: {
        label: 'Custom',
        description: 'Use deployer-supplied allowlists and feature flags.',
        features: DEFAULT_CLOUD_FEATURES,
        runtime: DEFAULT_CLOUD_RUNTIME,
      },
    },
  },
  cloudDesktop: DEFAULT_CLOUD_DESKTOP,
  gateway: DEFAULT_GATEWAY_CONFIG,
}
