import {
  getDefaultThemeId,
  getThemeTokens,
  getUserFacingThemes,
  isUiTheme,
  isUserFacingTheme,
  isUiAccentPresetId,
  accentActionFillToken,
  UI_ACCENT_PRESETS,
  type UiAccentPresetId,
  type UiTheme,
} from './theme-presets'

export { getThemeTokens, getDefaultThemeId, getUserFacingThemes, isUserFacingTheme, UI_ACCENT_PRESETS }
export type { UiTheme, UiAccentPresetId }

// "Match theme" (the default) uses each theme's own accent; the named presets are
// optional overrides.
export const THEME_MATCHED_ACCENT = 'theme' as const
export type UiAccentChoice = UiAccentPresetId | typeof THEME_MATCHED_ACCENT

export type ColorScheme = 'system' | 'dark' | 'light'
export type UiFont = 'mona' | 'system' | 'rounded' | 'serif'
export type MonoFont = 'sfmono' | 'jetbrains' | 'fira'
export type Density = 'compact' | 'regular' | 'comfy'

export type AppearancePreferences = {
  colorScheme: ColorScheme
  uiTheme: UiTheme
  accent: UiAccentChoice
  uiFont: UiFont
  monoFont: MonoFont
  density: Density
}

const STORAGE_KEYS = {
  colorScheme: 'open-cowork-color-scheme',
  uiTheme: 'open-cowork-ui-theme',
  accent: 'open-cowork-ui-accent',
  uiFont: 'open-cowork-ui-font',
  monoFont: 'open-cowork-mono-font',
  density: 'open-cowork-density',
}

const SYSTEM_QUERY = '(prefers-color-scheme: light)'

const UI_FONT_STACKS: Record<UiFont, string> = {
  mona: "'Mona Sans Variable', 'Mona Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  system: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', sans-serif",
  rounded: "'SF Pro Rounded', 'Avenir Next Rounded', 'Nunito', -apple-system, BlinkMacSystemFont, sans-serif",
  serif: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
}

const DISPLAY_FONT_STACK = "'Schibsted Grotesk Variable', 'Schibsted Grotesk', var(--font-ui)"

const MONO_FONT_STACKS: Record<MonoFont, string> = {
  sfmono: "'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', monospace",
  jetbrains: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
  fira: "'Fira Code', 'JetBrains Mono', 'SF Mono', monospace",
}


export const UI_FONT_OPTIONS: Array<{ id: UiFont; label: string }> = [
  { id: 'mona', label: 'Mona Sans' },
  { id: 'system', label: 'System' },
  { id: 'rounded', label: 'Rounded' },
  { id: 'serif', label: 'Serif' },
]

export const MONO_FONT_OPTIONS: Array<{ id: MonoFont; label: string }> = [
  { id: 'sfmono', label: 'SF Mono' },
  { id: 'jetbrains', label: 'JetBrains Mono' },
  { id: 'fira', label: 'Fira Code' },
]

export const DENSITY_OPTIONS: Array<{ id: Density; label: string }> = [
  { id: 'compact', label: 'Compact' },
  { id: 'regular', label: 'Regular' },
  { id: 'comfy', label: 'Comfy' },
]

let mediaCleanup: (() => void) | null = null

function readColorScheme(): ColorScheme {
  const stored = localStorage.getItem(STORAGE_KEYS.colorScheme)
  if (stored === 'system' || stored === 'dark' || stored === 'light') return stored
  return 'dark'
}

function readUiTheme(): UiTheme {
  const stored = localStorage.getItem(STORAGE_KEYS.uiTheme)
  return isUiTheme(stored) ? stored : getDefaultThemeId()
}

function readAccent(): UiAccentChoice {
  const stored = localStorage.getItem(STORAGE_KEYS.accent)
  // Default to "Match theme" so each theme renders with its own accent; a named
  // preset is only used when the user explicitly picks one.
  return isUiAccentPresetId(stored) ? stored : THEME_MATCHED_ACCENT
}

function readUiFont(): UiFont {
  const stored = localStorage.getItem(STORAGE_KEYS.uiFont)
  return stored === 'mona' || stored === 'rounded' || stored === 'serif' || stored === 'system'
    ? stored
    : 'mona'
}

function readMonoFont(): MonoFont {
  const stored = localStorage.getItem(STORAGE_KEYS.monoFont)
  return stored === 'jetbrains' || stored === 'fira' || stored === 'sfmono'
    ? stored
    : 'sfmono'
}

function readDensity(): Density {
  const stored = localStorage.getItem(STORAGE_KEYS.density)
  return stored === 'compact' || stored === 'regular' || stored === 'comfy'
    ? stored
    : 'regular'
}

function resolveColorScheme(colorScheme: ColorScheme) {
  return colorScheme === 'system'
    ? (window.matchMedia(SYSTEM_QUERY).matches ? 'light' : 'dark')
    : colorScheme
}

function applyResolvedColorScheme(colorScheme: ColorScheme) {
  document.documentElement.setAttribute('data-color-scheme', resolveColorScheme(colorScheme))
}

function applyThemeVariables(theme: UiTheme, colorScheme: ColorScheme, accent: UiAccentChoice) {
  const root = document.documentElement
  // "Match theme" (null override) → the theme's own accent; a named preset overrides it.
  const accentOverride = accent === THEME_MATCHED_ACCENT ? null : accent
  const tokens = getThemeTokens(theme, resolveColorScheme(colorScheme), accentOverride)

  root.style.setProperty('--color-base', tokens.base)
  root.style.setProperty('--color-surface', tokens.surface)
  root.style.setProperty('--color-surface-hover', tokens.surfaceHover)
  root.style.setProperty('--color-surface-active', tokens.surfaceActive)
  root.style.setProperty('--color-elevated', tokens.elevated)
  root.style.setProperty('--color-border', tokens.border)
  root.style.setProperty('--color-border-subtle', tokens.borderSubtle)
  root.style.setProperty('--color-border-strong', tokens.borderStrong || tokens.border)
  root.style.setProperty('--color-text', tokens.text)
  root.style.setProperty('--color-text-secondary', tokens.textSecondary)
  root.style.setProperty('--color-text-muted', tokens.textMuted)
  root.style.setProperty('--color-accent', tokens.accent)
  root.style.setProperty('--color-accent-2', tokens.accent2)
  root.style.setProperty('--color-accent-hover', tokens.accentHover)
  root.style.setProperty('--color-green', tokens.green)
  root.style.setProperty('--color-amber', tokens.amber)
  root.style.setProperty('--color-red', tokens.red)
  root.style.setProperty('--color-info', tokens.info)
  root.style.setProperty('--color-accent-foreground', tokens.accentForeground)
  root.style.setProperty('--shadow-card', tokens.shadowCard)
  root.style.setProperty('--shadow-elevated', tokens.shadowElevated)
  root.style.setProperty('--bg-image', tokens.bgImage)
  root.style.setProperty('--accent', tokens.accent)
  root.style.setProperty('--accent-2', tokens.accent2)
  root.style.setProperty('--accent-text', tokens.accentText)
  root.style.setProperty('--accent-action-foreground', tokens.accentActionForeground)
  root.style.setProperty('--accent-action-fill', accentActionFillToken(tokens.accent, tokens.accent2))
  root.style.setProperty('--accent-soft', tokens.accentSoft)
  root.style.setProperty('--accent-line', tokens.accentLine)
  root.style.setProperty('--accent-gradient', 'linear-gradient(150deg,var(--accent-2),var(--accent))')
}

function attachSystemColorSchemeListener(preferences: AppearancePreferences) {
  if (mediaCleanup) {
    mediaCleanup()
    mediaCleanup = null
  }

  if (preferences.colorScheme !== 'system') return

  const media = window.matchMedia(SYSTEM_QUERY)
  const listener = () => {
    applyResolvedColorScheme('system')
    applyThemeVariables(preferences.uiTheme, 'system', preferences.accent)
  }
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', listener)
    mediaCleanup = () => media.removeEventListener('change', listener)
    return
  }

  media.addListener(listener)
  mediaCleanup = () => media.removeListener(listener)
}

export function getAppearancePreferences(): AppearancePreferences {
  return {
    colorScheme: readColorScheme(),
    uiTheme: readUiTheme(),
    accent: readAccent(),
    uiFont: readUiFont(),
    monoFont: readMonoFont(),
    density: readDensity(),
  }
}

export function applyAppearancePreferences(preferences = getAppearancePreferences()) {
  const root = document.documentElement
  root.setAttribute('data-ui-theme', preferences.uiTheme)
  root.setAttribute('data-ui-accent', preferences.accent)
  root.setAttribute('data-density', preferences.density)
  root.style.setProperty('--font-ui', UI_FONT_STACKS[preferences.uiFont])
  root.style.setProperty('--font-display', DISPLAY_FONT_STACK)
  root.style.setProperty('--font-mono', MONO_FONT_STACKS[preferences.monoFont])
  applyResolvedColorScheme(preferences.colorScheme)
  applyThemeVariables(preferences.uiTheme, preferences.colorScheme, preferences.accent)
  attachSystemColorSchemeListener(preferences)
  return preferences
}

export function saveAppearancePreferences(preferences: Partial<AppearancePreferences>) {
  const current = getAppearancePreferences()
  const next = { ...current, ...preferences }
  localStorage.setItem(STORAGE_KEYS.colorScheme, next.colorScheme)
  localStorage.setItem(STORAGE_KEYS.uiTheme, next.uiTheme)
  localStorage.setItem(STORAGE_KEYS.accent, next.accent)
  localStorage.setItem(STORAGE_KEYS.uiFont, next.uiFont)
  localStorage.setItem(STORAGE_KEYS.monoFont, next.monoFont)
  localStorage.setItem(STORAGE_KEYS.density, next.density)
  applyAppearancePreferences(next)
  return next
}
