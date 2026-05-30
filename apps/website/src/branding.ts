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

export function resolvePublicBranding(input?: PublicBrandingConfig | null): PublicBrandingConfig {
  return {
    ...DEFAULT_WEBSITE_PUBLIC_BRANDING,
    ...(input || {}),
    productName: input?.productName?.trim() || DEFAULT_WEBSITE_PUBLIC_BRANDING.productName,
    shortName: input?.shortName?.trim() || DEFAULT_WEBSITE_PUBLIC_BRANDING.shortName,
    logoUrl: safeBrandingUrl(input?.logoUrl) || DEFAULT_WEBSITE_PUBLIC_BRANDING.logoUrl,
    supportUrl: safeBrandingUrl(input?.supportUrl, true) || DEFAULT_WEBSITE_PUBLIC_BRANDING.supportUrl,
    privacyUrl: safeBrandingUrl(input?.privacyUrl) || DEFAULT_WEBSITE_PUBLIC_BRANDING.privacyUrl,
    securityUrl: safeBrandingUrl(input?.securityUrl) || DEFAULT_WEBSITE_PUBLIC_BRANDING.securityUrl,
    legalUrl: safeBrandingUrl(input?.legalUrl) || DEFAULT_WEBSITE_PUBLIC_BRANDING.legalUrl,
    theme: {
      ...(DEFAULT_WEBSITE_PUBLIC_BRANDING.theme || {}),
      ...cleanObjectStrings(input?.theme),
    },
    dashboard: {
      ...(DEFAULT_WEBSITE_PUBLIC_BRANDING.dashboard || {}),
      ...cleanObjectStrings(input?.dashboard),
    },
    managedOrgConnectionLabels: {
      ...(DEFAULT_WEBSITE_PUBLIC_BRANDING.managedOrgConnectionLabels || {}),
      ...cleanObjectStrings(input?.managedOrgConnectionLabels),
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
