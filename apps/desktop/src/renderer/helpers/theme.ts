export type ColorScheme = 'system' | 'dark' | 'light'
export type UiTheme = 'ocean' | 'graphite' | 'forest' | 'sunrise' | 'mercury'
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

export const UI_THEME_OPTIONS: Array<{ id: UiTheme; label: string; description: string }> = [
  { id: 'mercury', label: 'Mercury', description: 'Indigo-ink dark theme inspired by OpenCode’s Mercury palette.' },
  { id: 'ocean', label: 'Ocean', description: 'Crisp blue accent with the default glass palette.' },
  { id: 'graphite', label: 'Graphite', description: 'Low-saturation steel tones for a quieter workspace.' },
  { id: 'forest', label: 'Forest', description: 'Green accents for investigation and operations-heavy work.' },
  { id: 'sunrise', label: 'Sunrise', description: 'Warm amber-orange palette for a brighter command center.' },
]

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
  return stored === 'graphite' || stored === 'forest' || stored === 'sunrise' || stored === 'ocean' || stored === 'mercury'
    ? stored
    : 'mercury'
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

function applyResolvedColorScheme(colorScheme: ColorScheme) {
  const root = document.documentElement
  const resolved = colorScheme === 'system'
    ? (window.matchMedia(SYSTEM_QUERY).matches ? 'light' : 'dark')
    : colorScheme
  root.setAttribute('data-color-scheme', resolved)
}

function attachSystemColorSchemeListener(colorScheme: ColorScheme) {
  if (mediaCleanup) {
    mediaCleanup()
    mediaCleanup = null
  }

  if (colorScheme !== 'system') return

  const media = window.matchMedia(SYSTEM_QUERY)
  const listener = () => applyResolvedColorScheme('system')
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
  attachSystemColorSchemeListener(preferences.colorScheme)
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
