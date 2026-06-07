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
  shortName?: string
  appId: string
  dataDirName: string
  helpUrl: string
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
  logoUrl?: string
  supportUrl?: string
  privacyUrl?: string
  securityUrl?: string
  legalUrl?: string
  theme?: PublicBrandingThemeTokens
  dashboard?: PublicDashboardCopyConfig
  managedOrgConnectionLabels?: ManagedOrgConnectionLabels
}

const DEFAULT_PUBLIC_BRANDING_DARK_THEME: PublicBrandingThemeTokens = {
  background: '#181516',
  surface: 'rgba(239, 220, 206, 0.06)',
  mutedSurface: '#242021',
  border: 'rgba(239, 220, 206, 0.13)',
  text: '#f0e9e1',
  mutedText: '#a8988e',
  accent: '#cfa0e6',
  accentStrong: '#e0b7f0',
  focus: 'rgba(207, 160, 230, 0.52)',
  warn: '#f0b86e',
  danger: '#ff9bb4',
  ok: '#82d3a2',
  surfaceHover: 'rgba(239, 220, 206, 0.11)',
  surfaceActive: 'rgba(207, 160, 230, 0.18)',
  borderSubtle: 'rgba(239, 220, 206, 0.06)',
  borderStrong: 'rgba(239, 220, 206, 0.22)',
  elevated: '#242021',
  textSecondary: '#d2c3b6',
  accentHover: '#e0b7f0',
  accentForeground: '#1b121d',
  green: '#82d3a2',
  amber: '#f0b86e',
  red: '#ff9bb4',
  info: '#8bc9d8',
  shadowCard: '0 1px 1px rgba(0, 0, 0, 0.30), 0 12px 28px rgba(0, 0, 0, 0.20)',
  shadowElevated: '0 2px 8px rgba(0, 0, 0, 0.34), 0 24px 60px rgba(0, 0, 0, 0.28)',
  bgImage: 'radial-gradient(120% 80% at 50% -10%, rgba(207, 160, 230, 0.07), transparent 55%), radial-gradient(80% 64% at 92% 12%, rgba(139, 201, 216, 0.045), transparent 62%)',
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
  throw new Error(`Unsupported gateway productMode ${text}. Use cloud_channel, standalone, or hybrid.`)
}

export function assertCloudChannelGatewayProductMode(productMode: GatewayProductMode) {
  if (productMode === 'cloud_channel') return
  if (productMode === 'standalone') {
    throw new Error(
      'Gateway productMode=standalone is a separate Standalone Team Gateway app. '
      + 'The current apps/gateway daemon only supports productMode=cloud_channel and must stay a Cloud client.',
    )
  }
  throw new Error(
    'Gateway productMode=hybrid is reserved for a later Cloud-connected edge/standalone design. '
    + 'The current apps/gateway daemon only supports productMode=cloud_channel.',
  )
}

export function assertStandaloneGatewayProductMode(productMode: GatewayProductMode) {
  if (productMode === 'standalone') return
  if (productMode === 'cloud_channel') {
    throw new Error(
      'Gateway productMode=cloud_channel is the Cloud Channel Gateway app. '
      + 'Standalone Gateway deployments must use productMode=standalone.',
    )
  }
  throw new Error(
    'Gateway productMode=hybrid is reserved for a later Cloud-connected edge/standalone design. '
    + 'Standalone Gateway deployments must use productMode=standalone.',
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
  cloud?: {
    baseUrl?: string
    serviceToken?: string
    allowInsecureHttp?: boolean
  }
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
    cloudRequestMs?: number
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
}

export type RuntimePermissionPolicy = 'allow' | 'ask' | 'deny'

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
  }
  agentStarterTemplates: AgentStarterTemplate[]
  toolTrace?: ToolTraceConfig
  i18n?: AppI18nConfig
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
  // Back-compat booleans retained for older renderer payloads and settings
  // migrations. New UI should use bashPermission/fileWritePermission.
  enableBash: boolean
  enableFileWrite: boolean
  runtimeConfigSource?: 'app' | 'machine'
  runtimeToolingBridgeEnabled: boolean
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
