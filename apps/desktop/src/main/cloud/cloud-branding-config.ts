import { derivePublicBrandingThemeTokens, PUBLIC_BRANDING_THEME_TOKEN_KEYS, type PublicBrandingConfig } from '@open-cowork/shared'
import { DEFAULT_CONFIG, type OpenCoworkConfig } from '../config-types.ts'
import { type Env, envValue } from './cloud-config-parse.ts'

// Public-branding config resolution, extracted from cloud/app.ts. Cleans and
// merges operator branding from config + env + JSON into a safe, defaulted
// PublicBrandingConfig (URL allowlisting, key allowlisting, theme token
// derivation). Self-contained: no app-bootstrap dependencies.

function parsePublicBrandingJson(env: Env) {
  const raw = envValue(env, 'OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Partial<PublicBrandingConfig>
      : {}
  } catch (error) {
    throw new Error(`Invalid OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}

function cleanBrandingObject(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => typeof entry === 'string' && entry.trim())
      .map(([key, entry]) => [key, String(entry).trim()]),
  )
}

function safePublicBrandingUrl(value: unknown, allowMailto = false) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return undefined
  try {
    const url = new URL(text)
    if (url.protocol === 'https:') return url.toString()
    if (allowMailto && url.protocol === 'mailto:') return url.toString()
  } catch {
    return undefined
  }
  return undefined
}

const PUBLIC_BRANDING_THEME_KEYS = new Set<keyof NonNullable<PublicBrandingConfig['theme']>>(PUBLIC_BRANDING_THEME_TOKEN_KEYS)
const PUBLIC_BRANDING_DASHBOARD_KEYS = new Set<keyof NonNullable<PublicBrandingConfig['dashboard']>>([
  'title',
  'subtitle',
  'signInTitle',
  'signInBody',
  'byokDescription',
  'connectionsDescription',
  'gatewayDescription',
  'billingDescription',
  'usageDescription',
])
const PUBLIC_BRANDING_LABEL_KEYS = new Set<keyof NonNullable<PublicBrandingConfig['managedOrgConnectionLabels']>>([
  'desktopToken',
  'gatewayToken',
  'apiToken',
  'cloudUrl',
])

function pickBrandingStrings<T extends object>(value: unknown, allowedKeys: Set<keyof T>): Partial<T> {
  const strings = cleanBrandingObject(value)
  return Object.fromEntries(
    Object.entries(strings).filter(([key]) => allowedKeys.has(key as keyof T)),
  ) as Partial<T>
}

function cleanPublicBrandingEntry(entry: Partial<PublicBrandingConfig>) {
  const cleaned: Partial<PublicBrandingConfig> = {}
  if (typeof entry.productName === 'string' && entry.productName.trim()) cleaned.productName = entry.productName.trim()
  if (typeof entry.shortName === 'string' && entry.shortName.trim()) cleaned.shortName = entry.shortName.trim()
  const urls: Array<[keyof PublicBrandingConfig, boolean]> = [
    ['logoUrl', false],
    ['supportUrl', true],
    ['privacyUrl', false],
    ['securityUrl', false],
    ['legalUrl', false],
  ]
  for (const [key, allowMailto] of urls) {
    const safeUrl = safePublicBrandingUrl(entry[key], allowMailto)
    if (safeUrl) cleaned[key] = safeUrl
  }
  const theme = pickBrandingStrings<NonNullable<PublicBrandingConfig['theme']>>(entry.theme, PUBLIC_BRANDING_THEME_KEYS)
  const dashboard = pickBrandingStrings<NonNullable<PublicBrandingConfig['dashboard']>>(entry.dashboard, PUBLIC_BRANDING_DASHBOARD_KEYS)
  const labels = pickBrandingStrings<NonNullable<PublicBrandingConfig['managedOrgConnectionLabels']>>(
    entry.managedOrgConnectionLabels,
    PUBLIC_BRANDING_LABEL_KEYS,
  )
  if (Object.keys(theme).length > 0) cleaned.theme = theme
  if (Object.keys(dashboard).length > 0) cleaned.dashboard = dashboard
  if (Object.keys(labels).length > 0) cleaned.managedOrgConnectionLabels = labels
  return cleaned
}

function mergePublicBranding(...entries: Array<Partial<PublicBrandingConfig> | undefined>): PublicBrandingConfig {
  const merged = entries.reduce<PublicBrandingConfig>((current, entry) => {
    if (!entry) return current
    const cleanEntry = cleanPublicBrandingEntry(entry)
    const theme = derivePublicBrandingThemeTokens(cleanBrandingObject(cleanEntry.theme))
    return {
      ...current,
      ...cleanEntry,
      theme: {
        ...(current.theme || {}),
        ...theme,
      },
      dashboard: {
        ...(current.dashboard || {}),
        ...cleanBrandingObject(cleanEntry.dashboard),
      },
      managedOrgConnectionLabels: {
        ...(current.managedOrgConnectionLabels || {}),
        ...cleanBrandingObject(cleanEntry.managedOrgConnectionLabels),
      },
    }
  }, { ...DEFAULT_CONFIG.cloud.publicBranding })
  return {
    ...merged,
    productName: merged.productName?.trim() || DEFAULT_CONFIG.cloud.publicBranding.productName,
    shortName: merged.shortName?.trim() || DEFAULT_CONFIG.cloud.publicBranding.shortName,
  }
}

export function resolveCloudPublicBranding(config: OpenCoworkConfig, env: Env = process.env): PublicBrandingConfig {
  return mergePublicBranding(
    DEFAULT_CONFIG.cloud.publicBranding,
    config.cloud.publicBranding,
    parsePublicBrandingJson(env),
    {
      productName: envValue(env, 'OPEN_COWORK_CLOUD_BRAND_NAME') || undefined,
      shortName: envValue(env, 'OPEN_COWORK_CLOUD_BRAND_SHORT_NAME') || undefined,
      logoUrl: envValue(env, 'OPEN_COWORK_CLOUD_BRAND_LOGO_URL') || undefined,
      supportUrl: envValue(env, 'OPEN_COWORK_CLOUD_SUPPORT_URL') || undefined,
      privacyUrl: envValue(env, 'OPEN_COWORK_CLOUD_PRIVACY_URL') || undefined,
      securityUrl: envValue(env, 'OPEN_COWORK_CLOUD_SECURITY_URL') || undefined,
      legalUrl: envValue(env, 'OPEN_COWORK_CLOUD_LEGAL_URL') || undefined,
    },
  )
}
