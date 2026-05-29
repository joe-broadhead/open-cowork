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

export const DEFAULT_PUBLIC_BRANDING: PublicBrandingConfig = {
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
