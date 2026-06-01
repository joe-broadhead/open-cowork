import type { PublicBrandingConfig } from '@open-cowork/shared'
import { escapeHtml } from './html-utils.ts'

export const DEFAULT_WEBSITE_PUBLIC_BRANDING: PublicBrandingConfig = {
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

const PUBLIC_BRANDING_THEME_KEYS = new Set<keyof NonNullable<PublicBrandingConfig['theme']>>([
  'background',
  'surface',
  'mutedSurface',
  'border',
  'text',
  'mutedText',
  'accent',
  'accentStrong',
  'focus',
  'warn',
  'danger',
  'ok',
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
  const theme = pickObjectStrings<NonNullable<PublicBrandingConfig['theme']>>(input.theme, PUBLIC_BRANDING_THEME_KEYS)
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
      ...(cleaned.theme || {}),
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

export function publicBrandingCss(branding: PublicBrandingConfig) {
  const theme = branding.theme || {}
  const cssToken = (value: string | undefined) => value && /^[#A-Za-z0-9(),.%\s-]+$/.test(value) ? value : undefined
  const tokens: Record<string, string | undefined> = {
    '--bg': cssToken(theme.background),
    '--surface': cssToken(theme.surface),
    '--muted-surface': cssToken(theme.mutedSurface),
    '--line': cssToken(theme.border),
    '--text': cssToken(theme.text),
    '--muted': cssToken(theme.mutedText),
    '--accent': cssToken(theme.accent),
    '--accent-strong': cssToken(theme.accentStrong),
    '--focus': cssToken(theme.focus),
    '--warn': cssToken(theme.warn),
    '--danger': cssToken(theme.danger),
    '--ok': cssToken(theme.ok),
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
