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
