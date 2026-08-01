import {
  refineThemeTokens,
  UI_THEME_PRESETS,
  accentActionFillToken,
  applyThemeAccent,
  type BrandThemeDefinition,
  type ResolvedColorScheme,
  type UiAccentPresetId,
  type ThemeTokens,
} from '@open-cowork/shared'

export { accentActionFillToken }
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

// Open Cowork maintains one product identity. Older palettes remain registry
// compatibility data for downstream configs, not public selector options.
const USER_FACING_THEME_ORDER: string[] = ['mercury']
const USER_FACING_THEME_IDS = new Set<string>(USER_FACING_THEME_ORDER)

export function isUserFacingTheme(value: string | null | undefined): value is UiTheme {
  return Boolean(
    value
    && (USER_FACING_THEME_IDS.has(value) || value === defaultThemeId)
    && themeRegistry.has(value),
  )
}

// The user-facing themes in display order, with their label + swatches for the picker.
export function getUserFacingThemes(): Array<{ id: string; label: string; swatches: string[] }> {
  return Array.from(new Set([...USER_FACING_THEME_ORDER, defaultThemeId]))
    .filter((id) => themeRegistry.has(id))
    .map((id) => {
      const theme = themeRegistry.get(id)!
      return { id, label: theme.label, swatches: theme.swatches }
    })
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
