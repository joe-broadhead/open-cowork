import {
  getThemeTokens,
  isUiTheme,
  type UiTheme,
  UI_THEME_OPTIONS,
} from './theme-presets'

export { getThemeTokens, UI_THEME_OPTIONS }
export type { UiTheme }

export type ColorScheme = 'system' | 'dark' | 'light'
export type UiFont = 'system' | 'rounded' | 'serif'
export type MonoFont = 'sfmono' | 'jetbrains' | 'fira'

export type AppearancePreferences = {
  colorScheme: ColorScheme
  uiTheme: UiTheme
  uiFont: UiFont
  monoFont: MonoFont
}

const STORAGE_KEYS = {
  colorScheme: 'open-cowork-color-scheme',
  uiTheme: 'open-cowork-ui-theme',
  uiFont: 'open-cowork-ui-font',
  monoFont: 'open-cowork-mono-font',
}

const LEGACY_THEME_KEYS = ['open-cowork-theme', 'cowork-theme']
const LEGACY_THEME_MAP: Record<string, UiTheme> = {
  mercury: 'mercury',
  ocean: 'tokyostorm',
  tokyonight: 'tokyostorm',
  graphite: 'nord',
  forest: 'everforest',
  sunrise: 'gruvbox',
  catppuccin: 'frappe',
}

const SYSTEM_QUERY = '(prefers-color-scheme: light)'

const UI_FONT_STACKS: Record<UiFont, string> = {
  system: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', sans-serif",
  rounded: "'SF Pro Rounded', 'Avenir Next Rounded', 'Nunito', -apple-system, BlinkMacSystemFont, sans-serif",
  serif: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
}

const MONO_FONT_STACKS: Record<MonoFont, string> = {
  sfmono: "'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', monospace",
  jetbrains: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
  fira: "'Fira Code', 'JetBrains Mono', 'SF Mono', monospace",
}


export const UI_FONT_OPTIONS: Array<{ id: UiFont; label: string }> = [
  { id: 'system', label: 'System' },
  { id: 'rounded', label: 'Rounded' },
  { id: 'serif', label: 'Serif' },
]

export const MONO_FONT_OPTIONS: Array<{ id: MonoFont; label: string }> = [
  { id: 'sfmono', label: 'SF Mono' },
  { id: 'jetbrains', label: 'JetBrains Mono' },
  { id: 'fira', label: 'Fira Code' },
]

let mediaCleanup: (() => void) | null = null

function readLegacyColorScheme(): ColorScheme | null {
  for (const key of LEGACY_THEME_KEYS) {
    const value = localStorage.getItem(key)
    if (value === 'dark' || value === 'light') return value
  }
  return null
}

function readColorScheme(): ColorScheme {
  const stored = localStorage.getItem(STORAGE_KEYS.colorScheme)
  if (stored === 'system' || stored === 'dark' || stored === 'light') return stored
  return readLegacyColorScheme() || 'dark'
}

function readUiTheme(): UiTheme {
  const stored = localStorage.getItem(STORAGE_KEYS.uiTheme)
  if (isUiTheme(stored)) return stored
  if (stored && stored in LEGACY_THEME_MAP) return LEGACY_THEME_MAP[stored]
  return 'mercury'
}

function readUiFont(): UiFont {
  const stored = localStorage.getItem(STORAGE_KEYS.uiFont)
  return stored === 'rounded' || stored === 'serif' || stored === 'system'
    ? stored
    : 'system'
}

function readMonoFont(): MonoFont {
  const stored = localStorage.getItem(STORAGE_KEYS.monoFont)
  return stored === 'jetbrains' || stored === 'fira' || stored === 'sfmono'
    ? stored
    : 'sfmono'
}

function resolveColorScheme(colorScheme: ColorScheme) {
  return colorScheme === 'system'
    ? (window.matchMedia(SYSTEM_QUERY).matches ? 'light' : 'dark')
    : colorScheme
}

function applyResolvedColorScheme(colorScheme: ColorScheme) {
  document.documentElement.setAttribute('data-color-scheme', resolveColorScheme(colorScheme))
}

function applyThemeVariables(theme: UiTheme, colorScheme: ColorScheme) {
  const root = document.documentElement
  const tokens = getThemeTokens(theme, resolveColorScheme(colorScheme))

  root.style.setProperty('--color-base', tokens.base)
  root.style.setProperty('--color-surface', tokens.surface)
  root.style.setProperty('--color-surface-hover', tokens.surfaceHover)
  root.style.setProperty('--color-surface-active', tokens.surfaceActive)
  root.style.setProperty('--color-elevated', tokens.elevated)
  root.style.setProperty('--color-border', tokens.border)
  root.style.setProperty('--color-border-subtle', tokens.borderSubtle)
  root.style.setProperty('--color-text', tokens.text)
  root.style.setProperty('--color-text-secondary', tokens.textSecondary)
  root.style.setProperty('--color-text-muted', tokens.textMuted)
  root.style.setProperty('--color-accent', tokens.accent)
  root.style.setProperty('--color-accent-hover', tokens.accentHover)
  root.style.setProperty('--color-green', tokens.green)
  root.style.setProperty('--color-amber', tokens.amber)
  root.style.setProperty('--color-red', tokens.red)
  root.style.setProperty('--color-info', tokens.info)
  root.style.setProperty('--color-accent-foreground', tokens.accentForeground)
  root.style.setProperty('--shadow-card', tokens.shadowCard)
  root.style.setProperty('--shadow-elevated', tokens.shadowElevated)
  root.style.setProperty('--bg-image', tokens.bgImage)
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
    applyThemeVariables(preferences.uiTheme, 'system')
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
    uiFont: readUiFont(),
    monoFont: readMonoFont(),
  }
}

export function applyAppearancePreferences(preferences = getAppearancePreferences()) {
  const root = document.documentElement
  root.setAttribute('data-ui-theme', preferences.uiTheme)
  root.style.setProperty('--font-ui', UI_FONT_STACKS[preferences.uiFont])
  root.style.setProperty('--font-mono', MONO_FONT_STACKS[preferences.monoFont])
  applyResolvedColorScheme(preferences.colorScheme)
  applyThemeVariables(preferences.uiTheme, preferences.colorScheme)
  attachSystemColorSchemeListener(preferences)
  return preferences
}

export function saveAppearancePreferences(preferences: Partial<AppearancePreferences>) {
  const current = getAppearancePreferences()
  const next = { ...current, ...preferences }
  localStorage.setItem(STORAGE_KEYS.colorScheme, next.colorScheme)
  localStorage.setItem(STORAGE_KEYS.uiTheme, next.uiTheme)
  localStorage.setItem(STORAGE_KEYS.uiFont, next.uiFont)
  localStorage.setItem(STORAGE_KEYS.monoFont, next.monoFont)
  applyAppearancePreferences(next)
  return next
}
