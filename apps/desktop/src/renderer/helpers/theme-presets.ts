import type { BrandThemeDefinition } from '@open-cowork/shared'
import {
  UI_THEME_PRESETS,
  type ResolvedColorScheme,
  type ThemeTokens,
} from './theme-preset-data'

export { UI_THEME_PRESETS }
export type { ResolvedColorScheme, ThemeTokens }

// UiTheme is a registered theme id. It includes both the built-in presets
// above and any theme a downstream config appends via `branding.themes`.
// Type is `string` (not `keyof typeof UI_THEME_PRESETS`) so custom themes
// don't need a type-system patch.
export type UiTheme = string

type RegistryEntry = {
  id: string
  label: string
  description: string
  swatches: string[]
  dark: ThemeTokens
  light?: ThemeTokens
}

const themeRegistry = new Map<string, RegistryEntry>()
let defaultThemeId = 'mercury'

// Seed the registry from the hardcoded presets on module load. Downstream
// config can append or override entries after App boot.
for (const [id, theme] of Object.entries(UI_THEME_PRESETS)) {
  themeRegistry.set(id, {
    id,
    label: theme.label,
    description: theme.description,
    swatches: theme.swatches,
    dark: theme.dark,
    light: theme.light,
  })
}

export function registerExtraThemes(themes: BrandThemeDefinition[] | undefined | null) {
  if (!Array.isArray(themes)) return
  for (const theme of themes) {
    if (!theme || typeof theme.id !== 'string' || !theme.dark) continue
    themeRegistry.set(theme.id, {
      id: theme.id,
      label: theme.label || theme.id,
      description: theme.description || '',
      swatches: theme.swatches || [],
      dark: theme.dark,
      light: theme.light,
    })
  }
}

export function setDefaultThemeId(id: string | undefined | null) {
  if (id && themeRegistry.has(id)) defaultThemeId = id
}

export function getDefaultThemeId(): UiTheme {
  return defaultThemeId
}

export function isUiTheme(value: string | null | undefined): value is UiTheme {
  return Boolean(value && themeRegistry.has(value))
}

export function getThemeTokens(theme: UiTheme, scheme: ResolvedColorScheme): ThemeTokens {
  const entry = themeRegistry.get(theme) || themeRegistry.get(defaultThemeId)
  if (!entry) {
    // Should be unreachable — the built-in presets always seed the registry.
    throw new Error(`No theme registered: ${theme}`)
  }
  if (scheme === 'light') return entry.light || entry.dark
  return entry.dark
}

export function getUiThemeOptions() {
  return Array.from(themeRegistry.values()).map(({ id, label, description, swatches }) => ({
    id,
    label,
    description,
    swatches,
  }))
}
