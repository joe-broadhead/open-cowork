import type {
  ProviderDescriptor,
} from './providers.js'
import type {
  ToolTraceConfig,
} from './tool-trace.js'

export const SMALL_MODEL_USE_MAIN = '__open_cowork_use_main_model__'

export interface BrandThemeTokens {
  base: string
  surface: string
  surfaceHover: string
  surfaceActive: string
  elevated: string
  border: string
  borderSubtle: string
  borderStrong?: string
  text: string
  textSecondary: string
  textMuted: string
  accent: string
  accent2?: string
  accentSoft?: string
  accentLine?: string
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
export type BrandingSidebarMediaFit = 'bounded' | 'vertical' | 'horizontal'
export type BrandingSidebarMediaAlign = 'start' | 'center' | 'end'

export interface BrandingSidebarTopConfig {
  variant?: BrandingSidebarTopVariant
  icon?: string
  logoAsset?: string
  logoUrl?: string
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
  shortName?: string
  appId: string
  dataDirName: string
  helpUrl: string
  // Base URL the in-app "read docs" links resolve `docs/*.md` paths against. Defaults
  // to the upstream repo for the public app; downstream builders point it at their own
  // docs so no upstream identity is hardcoded into a deployment.
  docsBaseUrl?: string
  // Branding-relative path (under the `branding/` asset dir, e.g. "app-icon.png") to the
  // OS window/dock icon shown by the running desktop app. Falls back to the bundled default
  // when unset. Installer/bundle icons are set at build time (see APP_ICON_* env in the dist
  // script) since they must be baked into the binary.
  appIcon?: string
  supportUrl?: string
  privacyUrl?: string
  securityUrl?: string
  legalUrl?: string
  projectNamespace?: string
  defaultTheme?: string
  themes?: BrandThemeDefinition[]
  sidebar?: BrandingSidebarConfig
  home?: BrandingHomeConfig
}

export interface PublicBrandingThemeTokens {
  background?: string
  surface?: string
  mutedSurface?: string
  border?: string
  text?: string
  mutedText?: string
  accent?: string
  accent2?: string
  accentSoft?: string
  accentLine?: string
  accentStrong?: string
  focus?: string
  warn?: string
  danger?: string
  ok?: string
  surfaceHover?: string
  surfaceActive?: string
  borderSubtle?: string
  borderStrong?: string
  elevated?: string
  textSecondary?: string
  accentHover?: string
  accentForeground?: string
  green?: string
  amber?: string
  red?: string
  info?: string
  shadowCard?: string
  shadowElevated?: string
  bgImage?: string
}

export interface PublicDashboardCopyConfig {
  title?: string
  subtitle?: string
  signInTitle?: string
  signInBody?: string
  byokDescription?: string
  connectionsDescription?: string
  gatewayDescription?: string
  billingDescription?: string
  usageDescription?: string
}

export interface ManagedOrgConnectionLabels {
  desktopToken?: string
  gatewayToken?: string
  apiToken?: string
  cloudUrl?: string
}

export interface PublicBrandingConfig {
  productName: string
  shortName?: string
  /** Meta description + Open Graph/Twitter description for the public web shell. */
  description?: string
  logoUrl?: string
  /** Favicon URL (https). Falls back to the logo, then a generated accent mark. */
  faviconUrl?: string
  /** Open Graph / Twitter card image URL (https). Falls back to the logo. */
  ogImageUrl?: string
  supportUrl?: string
  privacyUrl?: string
  securityUrl?: string
  legalUrl?: string
  theme?: PublicBrandingThemeTokens
  dashboard?: PublicDashboardCopyConfig
  managedOrgConnectionLabels?: ManagedOrgConnectionLabels
}

const DEFAULT_PUBLIC_BRANDING_DARK_THEME: PublicBrandingThemeTokens = {
  background: '#0c0d0f',
  surface: '#141619',
  mutedSurface: '#1f2329',
  border: '#2d3137',
  text: '#eceef1',
  mutedText: '#828a94',
  accent: '#2f6bf0',
  accent2: '#5a8cf5',
  accentSoft: 'color-mix(in srgb,var(--accent) 15%,transparent)',
  accentLine: 'color-mix(in srgb,var(--accent) 38%,transparent)',
  accentStrong: '#5a8cf5',
  focus: 'rgba(47, 107, 240, 0.52)',
  warn: '#e0913a',
  danger: '#d6587e',
  ok: '#3f9a8f',
  surfaceHover: '#1a1d21',
  surfaceActive: 'color-mix(in srgb, #2f6bf0 16%, #1a1d21)',
  borderSubtle: '#23262b',
  borderStrong: '#3b4047',
  elevated: '#1f2329',
  textSecondary: '#9aa1aa',
  accentHover: '#5a8cf5',
  accentForeground: '#ffffff',
  green: '#3f9a8f',
  amber: '#e0913a',
  red: '#d6587e',
  info: '#6f8cc4',
  shadowCard: '0 1px 2px rgba(0, 0, 0, 0.42), 0 12px 30px rgba(0, 0, 0, 0.46)',
  shadowElevated: '0 2px 8px rgba(0, 0, 0, 0.5), 0 24px 60px rgba(0, 0, 0, 0.58)',
  // Flat Mercury base (Phase 0 Fix #1) — must mirror the canonical dark theme
  // (DEFAULT_DARK_PUBLIC_BRANDING_THEME); the design-tokens-sync test asserts equality.
  bgImage: 'none',
}

export const GATEWAY_PRODUCT_MODES = [
  'cloud_channel',
  'standalone',
  'hybrid',
] as const

export type GatewayProductMode = typeof GATEWAY_PRODUCT_MODES[number]

export function resolveGatewayProductMode(envValue: unknown, configValue: unknown): GatewayProductMode {
  const productMode = parseGatewayProductMode(envValue) || parseGatewayProductMode(configValue) || 'cloud_channel'
  assertCloudChannelGatewayProductMode(productMode)
  return productMode
}

export function resolveStandaloneGatewayProductMode(envValue: unknown, configValue: unknown): GatewayProductMode {
  const productMode = parseGatewayProductMode(envValue) || parseGatewayProductMode(configValue) || 'standalone'
  assertStandaloneGatewayProductMode(productMode)
  return productMode
}

export function parseGatewayProductMode(value: unknown): GatewayProductMode | null {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return null
  if (text === 'cloud_channel' || text === 'standalone' || text === 'hybrid') return text
  throw new Error(`Unsupported gateway productMode ${text}. Valid values: cloud_channel (apps/channel-gateway), standalone (apps/standalone-gateway), hybrid (reserved).`)
}

export function assertCloudChannelGatewayProductMode(productMode: GatewayProductMode) {
  if (productMode === 'cloud_channel') return
  // JOE-897: fail-closed messages name the correct binary / env family.
  if (productMode === 'standalone') {
    throw new Error(
      'OPEN_COWORK_GATEWAY_PRODUCT_MODE=standalone (or gateway.productMode=standalone) is not supported by '
      + 'apps/channel-gateway (Cloud Channel Gateway binary). Use apps/standalone-gateway with '
      + 'OPEN_COWORK_STANDALONE_GATEWAY_* configuration instead. apps/channel-gateway only accepts productMode=cloud_channel.',
    )
  }
  throw new Error(
    'OPEN_COWORK_GATEWAY_PRODUCT_MODE=hybrid (or gateway.productMode=hybrid) is reserved for a future design. '
    + 'The Cloud Channel Gateway binary (apps/channel-gateway) only accepts productMode=cloud_channel. '
    + 'For private execution authority use apps/standalone-gateway (OPEN_COWORK_STANDALONE_GATEWAY_*).',
  )
}

export function assertStandaloneGatewayProductMode(productMode: GatewayProductMode) {
  if (productMode === 'standalone') return
  // JOE-897: name the correct binary / env family in fail-closed messages.
  if (productMode === 'cloud_channel') {
    throw new Error(
      'productMode=cloud_channel is owned by the Cloud Channel Gateway binary (apps/channel-gateway, '
      + 'OPEN_COWORK_GATEWAY_*). Standalone Gateway (apps/standalone-gateway, OPEN_COWORK_STANDALONE_GATEWAY_*) '
      + 'only accepts productMode=standalone.',
    )
  }
  throw new Error(
    'productMode=hybrid is reserved for a future design. Standalone Gateway (apps/standalone-gateway, '
    + 'OPEN_COWORK_STANDALONE_GATEWAY_*) only accepts productMode=standalone.',
  )
}

export type GatewayDeploymentMode = 'self-host' | 'managed'
export type GatewayDeploymentLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'
export type GatewayDeploymentProviderKind =
  | 'fake'
  | 'telegram'
  | 'slack'
  | 'email'
  | 'webhook'
  | 'discord'
  | 'whatsapp'
  | 'signal'
  | 'cli'

export interface GatewayDeploymentProviderConfig {
  id?: string
  kind: GatewayDeploymentProviderKind
  enabled?: boolean
  channelBindingId: string
  externalWorkspaceId?: string | null
  defaultAgent?: string | null
  credentials?: Record<string, string>
  settings?: Record<string, unknown>
}

export interface GatewayDeploymentConfig {
  instanceId?: string
  branding?: Partial<PublicBrandingConfig>
  productMode?: GatewayProductMode
  server?: {
    host?: string
    port?: number
    publicBaseUrl?: string | null
    adminToken?: string | null
    allowLoopbackOperatorBypass?: boolean
    maxRequestBodyBytes?: number
    trustProxyHeaders?: boolean
    trustedProxyCidrs?: string[]
  }
  mode?: GatewayDeploymentMode
  logging?: {
    level?: GatewayDeploymentLogLevel
  }
  metrics?: {
    enabled?: boolean
  }
  diagnostics?: {
    enabled?: boolean
  }
  timeouts?: {
    webhookDeliveryMs?: number
    smtpMs?: number
    shutdownDrainMs?: number
  }
  providers?: GatewayDeploymentProviderConfig[]
}

export const DEFAULT_PUBLIC_BRANDING: PublicBrandingConfig = {
  productName: 'Open Cowork Cloud',
  shortName: 'OC',
  supportUrl: '',
  privacyUrl: '',
  securityUrl: '',
  legalUrl: '',
  theme: DEFAULT_PUBLIC_BRANDING_DARK_THEME,
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

export interface AgentStarterTemplate {
  id: string
  label: string
  description: string
  color: string
  mode?: 'primary' | 'subagent'
  instructions: string
  temperature?: number | null
  steps?: number | null
  toolIds?: string[]
  skillNames?: string[]
}

// Optional per-install i18n overlay. Downstream forks can provide a partial
// catalog plus locale for Intl formatting; missing strings fall back to English.
export interface AppI18nConfig {
  locale?: string
  strings?: Record<string, string>
}

export interface AppMetadata {
  version: string
  preview: boolean
  surface: 'desktop' | 'browser'
}

export type RuntimePermissionPolicy = 'allow' | 'ask' | 'deny'

// Per-deployment desktop feature flags. A key set to false hides the area from
// the sidebar and blocks its route. Primary thesis surfaces default ON when
// omitted; secondary Studio surfaces default OFF until explicitly enabled
// (progressive disclosure — JOE-849).
export type DesktopFeatureKey =
  | 'projects'
  | 'knowledge'
  | 'approvals'
  | 'team'
  | 'playbooks'
  | 'channels'
  | 'tools'
  | 'artifacts'
  | 'voice'

/** Primary nav thesis: Chat/Team/Tools/Projects/Playbooks (+ Home/Settings). */
export const DESKTOP_PRIMARY_FEATURE_KEYS = [
  'projects',
  'team',
  'playbooks',
  'tools',
] as const satisfies readonly DesktopFeatureKey[]

/**
 * Secondary Studio surfaces — default-off until polished or opted in via
 * `features.<key>: true` in open-cowork.config.json.
 */
export const DESKTOP_SECONDARY_FEATURE_KEYS = [
  'knowledge',
  'approvals',
  'channels',
  'artifacts',
  'voice',
] as const satisfies readonly DesktopFeatureKey[]

const DESKTOP_SECONDARY_FEATURE_SET: ReadonlySet<DesktopFeatureKey> = new Set(
  DESKTOP_SECONDARY_FEATURE_KEYS,
)

export type DesktopFeatureFlags = Partial<Record<DesktopFeatureKey, boolean>>

export function isDesktopFeatureEnabled(features: DesktopFeatureFlags | undefined, key: DesktopFeatureKey): boolean {
  const explicit = features?.[key]
  if (explicit !== undefined) return explicit === true
  // Omitted secondary keys stay hidden; primary keys stay visible.
  return !DESKTOP_SECONDARY_FEATURE_SET.has(key)
}

/**
 * Soft readiness warnings when secondary Studio flags are enabled without the
 * operational prerequisites purity expects (JOE-1063). Never hard-fails config
 * load — progressive disclosure remains opt-in; doctor/docs surface these.
 */
export function desktopFeatureEnablementWarnings(
  features: DesktopFeatureFlags | undefined,
): string[] {
  if (!features) return []
  const warnings: string[] = []
  if (features.channels === true) {
    warnings.push(
      'features.channels is enabled: Channel bindings need a Cloud workspace + Channel Gateway; Local shows restricted empty Channels UI.',
    )
  }
  if (features.approvals === true) {
    warnings.push(
      'features.approvals is enabled: multi-thread queue is available; Always-allow is intentionally not wired as a no-op policy.',
    )
  }
  if (features.knowledge === true) {
    warnings.push(
      'features.knowledge is enabled: in-app Knowledge is not the Wiki product; do not register cowork-wiki MCP unless intentionally linking the sibling.',
    )
  }
  if (features.artifacts === true) {
    warnings.push(
      'features.artifacts is enabled: inspect/export stay redaction-safe; bodies are never auto-fetched.',
    )
  }
  if (features.voice === true) {
    warnings.push(
      'features.voice is enabled: private realtime voice is Desktop Local only (Aurum STT + sibling TTS in the voice host); Cloud Web and remote authorities stay not_supported.',
    )
  }
  return warnings
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
  permissions: {
    bash: RuntimePermissionPolicy
    fileWrite: RuntimePermissionPolicy
    task: RuntimePermissionPolicy
    web: RuntimePermissionPolicy
    webSearch: boolean
  }
  agentStarterTemplates: AgentStarterTemplate[]
  toolTrace?: ToolTraceConfig
  i18n?: AppI18nConfig
  features?: DesktopFeatureFlags
}

export interface AppSettings {
  _schemaVersion?: number
  selectedProviderId: string | null
  selectedModelId: string | null
  selectedSmallModelId?: string | null
  providerCredentials: Record<string, Record<string, string>>
  integrationCredentials: Record<string, Record<string, string>>
  integrationEnabled: Record<string, boolean>
  bashPermission: RuntimePermissionPolicy
  fileWritePermission: RuntimePermissionPolicy
  webPermission: RuntimePermissionPolicy
  webSearchEnabled: boolean
  taskPermission: RuntimePermissionPolicy
  externalDirectoryPermission: RuntimePermissionPolicy
  mcpPermission: RuntimePermissionPolicy
  requireApprovalBeforeSending: boolean
  notificationVoiceReplies: boolean
  notificationSmartSuggestions: boolean
  notificationDailyDigest: boolean
  notificationSounds: boolean
  privacyKeepConversationHistory: boolean
  privacyShareAnonymizedUsage: boolean
  runtimeConfigSource?: 'app' | 'machine'
  runtimeToolingBridgeEnabled: boolean
  windowZoomFactor: number
  workflowLaunchAtLogin: boolean
  workflowRunInBackground: boolean
  workflowDesktopNotifications: boolean
  workflowQuietHoursStart: string | null
  workflowQuietHoursEnd: string | null
}

export interface EffectiveAppSettings extends AppSettings {
  effectiveProviderId: string | null
  effectiveModel: string | null
  effectiveSmallModel?: string | null
}

export interface AuthState {
  authenticated: boolean
  email: string | null
}
