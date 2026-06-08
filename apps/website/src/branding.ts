import {
  DEFAULT_DARK_PUBLIC_BRANDING_THEME,
  accentActionFillToken,
  accentActionForegroundForColors,
  accentForegroundForColor,
  accentTextForBackground,
  derivePublicBrandingThemeTokens,
  isLegacyLightPublicBrandingTheme,
  isPublicBrandingColorToken,
  LEGACY_LIGHT_PUBLIC_BRANDING_THEME,
  PUBLIC_BRANDING_THEME_TOKEN_KEYS,
  type PublicBrandingConfig,
} from '@open-cowork/shared'
import { escapeHtml } from './html-utils.ts'

export const DEFAULT_WEBSITE_PUBLIC_BRANDING: PublicBrandingConfig = {
  productName: 'Open Cowork Cloud',
  shortName: 'OC',
  supportUrl: '',
  privacyUrl: '',
  securityUrl: '',
  legalUrl: '',
  theme: DEFAULT_DARK_PUBLIC_BRANDING_THEME,
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

function cleanObjectStrings(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => typeof entry === 'string' && entry.trim())
    .map(([key, entry]) => [key, String(entry).trim()]))
}

function safeBrandingUrl(value: unknown, allowMailto = false) {
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
const PUBLIC_BRANDING_THEME_COMPLEX_CSS_KEYS = new Set<keyof NonNullable<PublicBrandingConfig['theme']>>([
  'shadowCard',
  'shadowElevated',
  'bgImage',
  'surfaceActive',
  'accentSoft',
  'accentLine',
])
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

function pickObjectStrings<T extends object>(value: unknown, allowedKeys: Set<keyof T>): Partial<T> {
  const strings = cleanObjectStrings(value)
  return Object.fromEntries(
    Object.entries(strings).filter(([key]) => allowedKeys.has(key as keyof T)),
  ) as Partial<T>
}

function publicBrandingCssToken(value: string | undefined) {
  return value && /^[#A-Za-z0-9(),.%\s-]+$/.test(value) ? value : undefined
}

function publicBrandingColorToken(value: string | undefined) {
  const token = publicBrandingCssToken(value)
  return token && isPublicBrandingColorToken(token) ? token : undefined
}

function cleanPublicBrandingTheme(value: unknown) {
  const theme = pickObjectStrings<NonNullable<PublicBrandingConfig['theme']>>(value, PUBLIC_BRANDING_THEME_KEYS)
  return Object.fromEntries(
    Object.entries(theme).filter(([key, entry]) => {
      if (PUBLIC_BRANDING_THEME_COMPLEX_CSS_KEYS.has(key as keyof NonNullable<PublicBrandingConfig['theme']>)) {
        return Boolean(publicBrandingCssToken(entry))
      }
      return Boolean(publicBrandingColorToken(entry))
    }),
  ) as Partial<NonNullable<PublicBrandingConfig['theme']>>
}

function cleanPublicBranding(input?: PublicBrandingConfig | null): Partial<PublicBrandingConfig> {
  if (!input) return {}
  const cleaned: Partial<PublicBrandingConfig> = {}
  if (typeof input.productName === 'string' && input.productName.trim()) cleaned.productName = input.productName.trim()
  if (typeof input.shortName === 'string' && input.shortName.trim()) cleaned.shortName = input.shortName.trim()
  const logoUrl = safeBrandingUrl(input.logoUrl)
  const supportUrl = safeBrandingUrl(input.supportUrl, true)
  const privacyUrl = safeBrandingUrl(input.privacyUrl)
  const securityUrl = safeBrandingUrl(input.securityUrl)
  const legalUrl = safeBrandingUrl(input.legalUrl)
  if (logoUrl) cleaned.logoUrl = logoUrl
  if (supportUrl) cleaned.supportUrl = supportUrl
  if (privacyUrl) cleaned.privacyUrl = privacyUrl
  if (securityUrl) cleaned.securityUrl = securityUrl
  if (legalUrl) cleaned.legalUrl = legalUrl
  const theme = cleanPublicBrandingTheme(input.theme)
  const dashboard = pickObjectStrings<NonNullable<PublicBrandingConfig['dashboard']>>(input.dashboard, PUBLIC_BRANDING_DASHBOARD_KEYS)
  const labels = pickObjectStrings<NonNullable<PublicBrandingConfig['managedOrgConnectionLabels']>>(
    input.managedOrgConnectionLabels,
    PUBLIC_BRANDING_LABEL_KEYS,
  )
  if (Object.keys(theme).length > 0) cleaned.theme = theme
  if (Object.keys(dashboard).length > 0) cleaned.dashboard = dashboard
  if (Object.keys(labels).length > 0) cleaned.managedOrgConnectionLabels = labels
  return cleaned
}

export function resolvePublicBranding(input?: PublicBrandingConfig | null): PublicBrandingConfig {
  const cleaned = cleanPublicBranding(input)
  const cleanedTheme = cleaned.theme ? derivePublicBrandingThemeTokens(cleaned.theme) : undefined
  return {
    ...DEFAULT_WEBSITE_PUBLIC_BRANDING,
    ...cleaned,
    productName: cleaned.productName || DEFAULT_WEBSITE_PUBLIC_BRANDING.productName,
    shortName: cleaned.shortName || DEFAULT_WEBSITE_PUBLIC_BRANDING.shortName,
    logoUrl: cleaned.logoUrl || DEFAULT_WEBSITE_PUBLIC_BRANDING.logoUrl,
    supportUrl: cleaned.supportUrl || DEFAULT_WEBSITE_PUBLIC_BRANDING.supportUrl,
    privacyUrl: cleaned.privacyUrl || DEFAULT_WEBSITE_PUBLIC_BRANDING.privacyUrl,
    securityUrl: cleaned.securityUrl || DEFAULT_WEBSITE_PUBLIC_BRANDING.securityUrl,
    legalUrl: cleaned.legalUrl || DEFAULT_WEBSITE_PUBLIC_BRANDING.legalUrl,
    theme: {
      ...(DEFAULT_WEBSITE_PUBLIC_BRANDING.theme || {}),
      ...(cleanedTheme || {}),
    },
    dashboard: {
      ...(DEFAULT_WEBSITE_PUBLIC_BRANDING.dashboard || {}),
      ...(cleaned.dashboard || {}),
    },
    managedOrgConnectionLabels: {
      ...(DEFAULT_WEBSITE_PUBLIC_BRANDING.managedOrgConnectionLabels || {}),
      ...(cleaned.managedOrgConnectionLabels || {}),
    },
  }
}

export function hasPublicBrandingThemeOverride(input?: PublicBrandingConfig | null): boolean {
  const cleanedTheme = cleanPublicBrandingTheme(input?.theme)
  if (Object.keys(cleanedTheme).length === 0) return false

  const derivedTheme = derivePublicBrandingThemeTokens(cleanedTheme)
  return PUBLIC_BRANDING_THEME_TOKEN_KEYS.some((key) => {
    return derivedTheme[key] !== undefined && derivedTheme[key] !== DEFAULT_DARK_PUBLIC_BRANDING_THEME[key]
  })
}

export function publicBrandingCss(branding: PublicBrandingConfig) {
  const theme = branding.theme || {}
  const cssToken = publicBrandingCssToken
  const colorToken = publicBrandingColorToken
  const defaultTheme = DEFAULT_DARK_PUBLIC_BRANDING_THEME
  const legacySurfaceOverride = colorToken(theme.surface) && theme.surface !== defaultTheme.surface && theme.elevated === defaultTheme.elevated
  const legacyLightOverride = legacySurfaceOverride && isLegacyLightPublicBrandingTheme(theme)
  const legacyLightFallback: NonNullable<PublicBrandingConfig['theme']> = legacyLightOverride
    ? LEGACY_LIGHT_PUBLIC_BRANDING_THEME
    : {}
  const elevated = legacySurfaceOverride
    ? colorToken(theme.surface)
    : colorToken(theme.elevated || theme.mutedSurface || theme.surface)
  const accent = colorToken(theme.accent)
  const accentHover = colorToken(
    theme.accentHover === defaultTheme.accentHover && theme.accentStrong && theme.accentStrong !== defaultTheme.accentStrong
      ? theme.accentStrong
      : theme.accentHover || theme.accentStrong || theme.accent,
  )
  const accent2 = colorToken(theme.accent2 || accentHover)
  const accentForeground = colorToken(theme.accentForeground) || (accent ? accentForegroundForColor(accent) : undefined)
  const accentActionForeground = accent
    ? accentActionForegroundForColors(accent, accent2 || accentHover)
    : accentForeground
  const warn = colorToken(legacyLightOverride && theme.warn === defaultTheme.warn ? legacyLightFallback.warn : theme.warn)
  const danger = colorToken(legacyLightOverride && theme.danger === defaultTheme.danger ? legacyLightFallback.danger : theme.danger)
  const ok = colorToken(legacyLightOverride && theme.ok === defaultTheme.ok ? legacyLightFallback.ok : theme.ok)
  const green = colorToken(legacyLightOverride && theme.green === defaultTheme.green ? legacyLightFallback.ok : theme.green || ok)
  const amber = colorToken(legacyLightOverride && theme.amber === defaultTheme.amber ? legacyLightFallback.warn : theme.amber || warn)
  const red = colorToken(legacyLightOverride && theme.red === defaultTheme.red ? legacyLightFallback.danger : theme.red || danger)
  const focus = colorToken(legacyLightOverride && theme.focus === defaultTheme.focus ? legacyLightFallback.focus : theme.focus)
  const shadowCard = cssToken(legacyLightOverride && theme.shadowCard === defaultTheme.shadowCard ? legacyLightFallback.shadowCard : theme.shadowCard)
  const shadowElevated = cssToken(legacyLightOverride && theme.shadowElevated === defaultTheme.shadowElevated ? legacyLightFallback.shadowElevated : theme.shadowElevated)
  const bgImage = cssToken(legacyLightOverride && theme.bgImage === defaultTheme.bgImage ? legacyLightFallback.bgImage : theme.bgImage)
  const accentText = accent && accent2
    ? accentTextForBackground(accent, accent2, colorToken(theme.background) || defaultTheme.background || '#0c0d0f')
    : undefined
  const accentSoft = cssToken(theme.accentSoft) || 'color-mix(in srgb,var(--accent) 15%,transparent)'
  const accentLine = cssToken(theme.accentLine) || 'color-mix(in srgb,var(--accent) 38%,transparent)'
  const tokens: Record<string, string | undefined> = {
    '--color-base': colorToken(theme.background),
    '--color-surface': colorToken(theme.surface),
    '--color-surface-hover': colorToken(theme.surfaceHover),
    '--color-surface-active': cssToken(theme.surfaceActive),
    '--color-elevated': elevated,
    '--color-border': colorToken(theme.border),
    '--color-border-subtle': colorToken(theme.borderSubtle),
    '--color-border-strong': colorToken(theme.borderStrong || theme.border),
    '--color-text': colorToken(theme.text),
    '--color-text-secondary': colorToken(theme.textSecondary),
    '--color-text-muted': colorToken(theme.mutedText),
    '--color-accent': accent,
    '--color-accent-2': accent2,
    '--color-accent-hover': accentHover,
    '--color-accent-foreground': accentForeground,
    '--color-green': green,
    '--color-amber': amber,
    '--color-red': red,
    '--color-info': colorToken(theme.info),
    '--shadow-card': shadowCard,
    '--shadow-elevated': shadowElevated,
    '--bg-image': bgImage,
    '--bg': colorToken(theme.background),
    '--surface': elevated || colorToken(theme.surface),
    '--muted-surface': colorToken(theme.mutedSurface) || elevated,
    '--line': colorToken(theme.border),
    '--text': colorToken(theme.text),
    '--muted': colorToken(theme.mutedText),
    '--accent': accent,
    '--accent-2': accent2,
    '--accent-text': accentText || 'var(--accent-2)',
    '--accent-action-foreground': accentActionForeground,
    '--accent-action-fill': accentActionFillToken(accent, accent2 || accentHover),
    '--accent-soft': accentSoft,
    '--accent-line': accentLine,
    '--accent-gradient': 'linear-gradient(150deg,var(--accent-2),var(--accent))',
    '--accent-strong': accentHover,
    '--focus': focus,
    '--warn': warn || amber,
    '--danger': danger || red,
    '--ok': ok || green,
  }
  return Object.entries(tokens)
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([key, value]) => `      ${key}: ${escapeHtml(value || '')};`)
    .join('\n')
}

export function brandLogoMarkup(branding: PublicBrandingConfig) {
  if (branding.logoUrl) {
    return `<img class="brand-logo" src="${escapeHtml(branding.logoUrl)}" alt="" aria-hidden="true">`
  }
  return `<div class="mark" aria-hidden="true">${escapeHtml(branding.shortName || 'OC')}</div>`
}

export function brandLinksMarkup(branding: PublicBrandingConfig) {
  const links = [
    ['Support', branding.supportUrl],
    ['Privacy', branding.privacyUrl],
    ['Security', branding.securityUrl],
    ['Legal', branding.legalUrl],
  ].filter(([, url]) => typeof url === 'string' && url.trim())
  if (!links.length) return ''
  return `<div class="brand-links">${links.map(([label, url]) => `<a href="${escapeHtml(url || '')}" rel="noreferrer" target="_blank">${escapeHtml(label || '')}</a>`).join('')}</div>`
}
