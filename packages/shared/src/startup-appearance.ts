import type { BrandingConfig, BrandThemeDefinition } from './app-config.js'
import {
  UI_THEME_PRESETS,
  refineThemeTokens,
  type ResolvedColorScheme,
  type ThemeTokens,
} from './theme-preset-data.js'

export type StartupColorSchemePreference = ResolvedColorScheme | 'system'

export interface StartupAppearancePreferences {
  colorScheme?: StartupColorSchemePreference | null
  themeId?: string | null
}

export interface StartupAppearance {
  colorScheme: ResolvedColorScheme
  themeId: string
  tokens: ThemeTokens
}

export interface StartupSurfaceState extends StartupAppearance {
  brandName: string
}

type StartupBranding = Pick<BrandingConfig, 'defaultTheme' | 'themes'>

type StartupThemeDefinition = {
  dark: ThemeTokens
  light?: ThemeTokens
}

export const STARTUP_THEME_CSS_PROPERTIES = {
  base: '--color-base',
  surface: '--color-surface',
  surfaceHover: '--color-surface-hover',
  surfaceActive: '--color-surface-active',
  elevated: '--color-elevated',
  border: '--color-border',
  borderSubtle: '--color-border-subtle',
  borderStrong: '--color-border-strong',
  text: '--color-text',
  textSecondary: '--color-text-secondary',
  textMuted: '--color-text-muted',
  accent: '--color-accent',
  accent2: '--color-accent-2',
  accentSoft: '--accent-soft',
  accentLine: '--accent-line',
  accentHover: '--color-accent-hover',
  green: '--color-green',
  amber: '--color-amber',
  red: '--color-red',
  info: '--color-info',
  accentForeground: '--color-accent-foreground',
  accentText: '--accent-text',
  accentActionForeground: '--accent-action-foreground',
  shadowCard: '--shadow-card',
  shadowElevated: '--shadow-elevated',
  bgImage: '--bg-image',
} as const satisfies Record<keyof ThemeTokens, string>

const DEFAULT_STARTUP_THEME_ID = 'mercury'
const STARTUP_SURFACE_STATE_QUERY_KEY = 'startup-state'
const MAX_STARTUP_BRAND_NAME_BYTES = 512
const MAX_STARTUP_THEME_VALUE_BYTES = 4 * 1024

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function customThemeDefinition(theme: BrandThemeDefinition): StartupThemeDefinition {
  return {
    dark: refineThemeTokens(theme.dark, 'dark'),
    light: theme.light ? refineThemeTokens(theme.light, 'light') : undefined,
  }
}

function findTheme(branding: StartupBranding, id: string | null | undefined) {
  if (!id) return null
  const custom = branding.themes?.find((theme) => theme?.id === id && theme.dark)
  if (custom) return customThemeDefinition(custom)
  return UI_THEME_PRESETS[id as keyof typeof UI_THEME_PRESETS] || null
}

/**
 * Resolve the pre-React paint from the same built-in/downstream theme data used
 * by the renderer. A downstream definition overrides a built-in with the same
 * id, matching the renderer registry contract.
 */
export function resolveStartupAppearance(options: {
  branding: StartupBranding
  preferences?: StartupAppearancePreferences | null
  systemColorScheme: ResolvedColorScheme
}): StartupAppearance {
  const requestedThemeId = options.preferences?.themeId?.trim()
  const configuredDefaultThemeId = options.branding.defaultTheme?.trim()
  const themeId = (
    (requestedThemeId && findTheme(options.branding, requestedThemeId) ? requestedThemeId : null)
    || (configuredDefaultThemeId && findTheme(options.branding, configuredDefaultThemeId) ? configuredDefaultThemeId : null)
    || DEFAULT_STARTUP_THEME_ID
  )
  const theme = findTheme(options.branding, themeId) || UI_THEME_PRESETS[DEFAULT_STARTUP_THEME_ID]
  const preference = options.preferences?.colorScheme
  const colorScheme = preference === 'light' || preference === 'dark'
    ? preference
    : preference === 'system'
      ? options.systemColorScheme
      : 'dark'

  return {
    colorScheme,
    themeId,
    tokens: colorScheme === 'light' ? theme.light || theme.dark : theme.dark,
  }
}

export function serializeStartupSurfaceState(state: StartupSurfaceState) {
  return JSON.stringify(state)
}

export function startupSurfaceQuery(state: StartupSurfaceState) {
  return { [STARTUP_SURFACE_STATE_QUERY_KEY]: serializeStartupSurfaceState(state) }
}

function isStartupSurfaceState(value: unknown): value is StartupSurfaceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.brandName !== 'string' || !record.brandName.trim()) return false
  if (byteLength(record.brandName) > MAX_STARTUP_BRAND_NAME_BYTES) return false
  if (record.colorScheme !== 'light' && record.colorScheme !== 'dark') return false
  if (typeof record.themeId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(record.themeId)) return false
  if (!record.tokens || typeof record.tokens !== 'object' || Array.isArray(record.tokens)) return false

  const tokens = record.tokens as Record<string, unknown>
  return Object.keys(STARTUP_THEME_CSS_PROPERTIES).every((key) => {
    const token = tokens[key]
    return typeof token === 'string'
      && token.trim().length > 0
      && byteLength(token) <= MAX_STARTUP_THEME_VALUE_BYTES
  })
}

export function parseStartupSurfaceState(search: string) {
  try {
    const serialized = new URLSearchParams(search).get(STARTUP_SURFACE_STATE_QUERY_KEY)
    if (!serialized) return null
    const parsed: unknown = JSON.parse(serialized)
    return isStartupSurfaceState(parsed) ? parsed : null
  } catch {
    return null
  }
}
