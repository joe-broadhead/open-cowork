import {
  DEFAULT_UI_ACCENT_PRESET_ID,
  UI_ACCENT_PRESETS,
  refineThemeTokens,
  UI_THEME_PRESETS,
  accentActionFillToken,
  applyThemeAccent,
  isUiAccentPresetId,
  type BrandThemeDefinition,
  type ResolvedColorScheme,
  type UiAccentPresetId,
  type ThemeTokens,
} from '@open-cowork/shared'

export {
  DEFAULT_UI_ACCENT_PRESET_ID,
  UI_ACCENT_PRESETS,
  UI_THEME_PRESETS,
  accentActionFillToken,
  isUiAccentPresetId,
}
export type { ResolvedColorScheme, ThemeTokens, UiAccentPresetId }

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
      dark: refineThemeTokens(theme.dark, 'dark'),
      light: theme.light ? refineThemeTokens(theme.light, 'light') : undefined,
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

// Open Cowork ships a single branded identity — Mercury — surfaced as the
// Mercury (dark) and Day (light) color schemes. The remaining presets stay in the
// registry as data (and as a getThemeTokens fallback) but are never user-facing or
// applied: the code-editor theme list belongs to a dev tool, not a branded People OS.
const USER_FACING_THEME_IDS = new Set<string>(['mercury'])

export function isUserFacingTheme(value: string | null | undefined): value is UiTheme {
  return Boolean(value && USER_FACING_THEME_IDS.has(value) && themeRegistry.has(value))
}

export function getThemeTokens(theme: UiTheme, scheme: ResolvedColorScheme, accentId?: UiAccentPresetId | null): ThemeTokens {
  const entry = themeRegistry.get(theme) || themeRegistry.get(defaultThemeId)
  if (!entry) {
    // Should be unreachable — the built-in presets always seed the registry.
    throw new Error(`No theme registered: ${theme}`)
  }
  const tokens = scheme === 'light' ? entry.light || entry.dark : entry.dark
  return accentId ? applyThemeAccent(tokens, accentId) : tokens
}

