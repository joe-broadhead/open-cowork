import { DEFAULT_UI_ACCENT_PRESET_ID, UI_THEME_PRESETS, accentActionFillToken, applyThemeAccent, type ThemeTokens, type UiAccentPresetId } from '@open-cowork/shared'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import {
  CLOUD_THEME_ACCENT_STORAGE_KEY,
  CLOUD_THEME_DENSITY_STORAGE_KEY,
  CLOUD_THEME_SCHEME_STORAGE_KEY,
  CLOUD_THEME_STORAGE_KEY,
  DEFAULT_CLOUD_THEME_DENSITY,
  DEFAULT_CLOUD_THEME_ACCENT_PRESET,
  DEFAULT_CLOUD_THEME_PRESET,
  DEFAULT_CLOUD_THEME_SCHEME,
  isCloudDensity,
  isCloudThemeAccentPreset,
  isCloudThemePreset,
  isCloudThemeScheme,
  type CloudDensity,
} from './cloud-theme.ts'

const TOKEN_CSS_VARS: Array<[keyof ThemeTokens, string[]]> = [
  ['base', ['--color-base', '--bg']],
  ['surface', ['--color-surface']],
  ['surfaceHover', ['--color-surface-hover']],
  ['surfaceActive', ['--color-surface-active']],
  ['elevated', ['--color-elevated', '--surface', '--muted-surface']],
  ['border', ['--color-border', '--line']],
  ['borderSubtle', ['--color-border-subtle']],
  ['borderStrong', ['--color-border-strong']],
  ['text', ['--color-text', '--text']],
  ['textSecondary', ['--color-text-secondary']],
  ['textMuted', ['--color-text-muted', '--muted']],
  ['accent', ['--color-accent', '--accent']],
  ['accent2', ['--color-accent-2', '--accent-2']],
  ['accentText', ['--accent-text']],
  ['accentActionForeground', ['--accent-action-foreground']],
  ['accentSoft', ['--accent-soft']],
  ['accentLine', ['--accent-line']],
  ['accentHover', ['--color-accent-hover', '--accent-strong']],
  ['accentForeground', ['--color-accent-foreground']],
  ['green', ['--color-green', '--ok']],
  ['amber', ['--color-amber', '--warn']],
  ['red', ['--color-red', '--danger']],
  ['info', ['--color-info']],
  ['shadowCard', ['--shadow-card', '--shadow']],
  ['shadowElevated', ['--shadow-elevated']],
  ['bgImage', ['--bg-image']],
]

function focusTokenForAccent(accent: string) {
  const match = accent.match(/^#([0-9a-f]{6})$/i)
  if (!match) return accent
  const hex = match[1] || ''
  const red = Number.parseInt(hex.slice(0, 2), 16)
  const green = Number.parseInt(hex.slice(2, 4), 16)
  const blue = Number.parseInt(hex.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, 0.52)`
}

export function applyCloudThemePreset(presetId: string, scheme: 'dark' | 'light' = 'dark', accentId?: string) {
  const resolvedPresetId = isCloudThemePreset(presetId) ? presetId : DEFAULT_CLOUD_THEME_PRESET
  const resolvedScheme = isCloudThemeScheme(scheme) ? scheme : DEFAULT_CLOUD_THEME_SCHEME
  const accentSelect = document.getElementById('cloud-theme-accent') as HTMLSelectElement | null
  const selectedAccent = accentId || accentSelect?.value
  const resolvedAccent = isCloudThemeAccentPreset(selectedAccent) ? selectedAccent as UiAccentPresetId : DEFAULT_CLOUD_THEME_ACCENT_PRESET
  const preset = UI_THEME_PRESETS[resolvedPresetId as keyof typeof UI_THEME_PRESETS]
  const tokens = applyThemeAccent(resolvedScheme === 'light' ? preset.light : preset.dark, resolvedAccent)
  const root = document.documentElement
  root.dataset.uiTheme = resolvedPresetId
  root.dataset.colorScheme = resolvedScheme
  root.dataset.uiAccent = resolvedAccent
  root.style.colorScheme = resolvedScheme
  for (const [tokenName, cssVars] of TOKEN_CSS_VARS) {
    const value = tokens[tokenName]
    if (!value) continue
    for (const cssVar of cssVars) root.style.setProperty(cssVar, value)
  }
  root.style.setProperty('--focus', focusTokenForAccent(tokens.accent))
  root.style.setProperty('--accent-gradient', 'linear-gradient(150deg,var(--accent-2),var(--accent))')
  root.style.setProperty('--accent-action-fill', accentActionFillToken(tokens.accent, tokens.accent2))
}

export function applyCloudDensity(density: string | null | undefined) {
  document.documentElement.dataset.density = isCloudDensity(density) ? density : DEFAULT_CLOUD_THEME_DENSITY
}

function storedCloudThemePreset(defaultPreset = DEFAULT_CLOUD_THEME_PRESET) {
  try {
    const stored = localStorage.getItem(CLOUD_THEME_STORAGE_KEY)
    return isCloudThemePreset(stored) ? stored as string : defaultPreset
  } catch {
    return defaultPreset
  }
}

function persistCloudThemePreset(presetId: string) {
  try {
    localStorage.setItem(CLOUD_THEME_STORAGE_KEY, presetId)
  } catch {
    // Local persistence is best-effort only; the selected preset still applies for this page.
  }
}

function storedCloudThemeScheme(defaultScheme: 'dark' | 'light' = DEFAULT_CLOUD_THEME_SCHEME) {
  try {
    const stored = localStorage.getItem(CLOUD_THEME_SCHEME_STORAGE_KEY)
    return isCloudThemeScheme(stored) ? stored : defaultScheme
  } catch {
    return defaultScheme
  }
}

function persistCloudThemeScheme(scheme: 'dark' | 'light') {
  try {
    localStorage.setItem(CLOUD_THEME_SCHEME_STORAGE_KEY, scheme)
  } catch {
    // Local persistence is best-effort only; the selected mode still applies for this page.
  }
}

function storedCloudThemeAccent(defaultAccent = DEFAULT_CLOUD_THEME_ACCENT_PRESET) {
  try {
    const stored = localStorage.getItem(CLOUD_THEME_ACCENT_STORAGE_KEY)
    return isCloudThemeAccentPreset(stored) ? stored as UiAccentPresetId : defaultAccent as UiAccentPresetId
  } catch {
    return defaultAccent as UiAccentPresetId
  }
}

function persistCloudThemeAccent(accentId: UiAccentPresetId) {
  try {
    localStorage.setItem(CLOUD_THEME_ACCENT_STORAGE_KEY, accentId)
  } catch {
    // Local persistence is best-effort only; the selected accent still applies for this page.
  }
}

function storedCloudDensity(defaultDensity: CloudDensity = DEFAULT_CLOUD_THEME_DENSITY) {
  try {
    const stored = localStorage.getItem(CLOUD_THEME_DENSITY_STORAGE_KEY)
    return isCloudDensity(stored) ? stored : defaultDensity
  } catch {
    return defaultDensity
  }
}

function persistCloudDensity(density: CloudDensity) {
  try {
    localStorage.setItem(CLOUD_THEME_DENSITY_STORAGE_KEY, density)
  } catch {
    // Local persistence is best-effort only; the selected density still applies for this page.
  }
}

const themeControlDocuments = new WeakSet<Document>()

function installThemeControlChangeListener(ownerDocument: Document) {
  if (themeControlDocuments.has(ownerDocument)) return
  ownerDocument.addEventListener('change', (event) => {
    const select = event.target as HTMLSelectElement | null
    if (!select || select.tagName !== 'SELECT') return
    if (!['cloud-theme-preset', 'cloud-theme-scheme', 'cloud-theme-accent', 'cloud-theme-density'].includes(select.id)) return
    if (select.id === 'cloud-theme-density') {
      const density = isCloudDensity(select.value) ? select.value : DEFAULT_CLOUD_THEME_DENSITY
      select.value = density
      persistCloudDensity(density)
      applyCloudDensity(density)
      return
    }
    if (select.disabled || select.dataset.tenantBrandingLocked === 'true') return
    const presetSelect = ownerDocument.getElementById('cloud-theme-preset') as HTMLSelectElement | null
    const schemeSelect = ownerDocument.getElementById('cloud-theme-scheme') as HTMLSelectElement | null
    const accentSelect = ownerDocument.getElementById('cloud-theme-accent') as HTMLSelectElement | null
    const presetId = isCloudThemePreset(presetSelect?.value) ? presetSelect!.value : DEFAULT_CLOUD_THEME_PRESET
    const scheme = isCloudThemeScheme(schemeSelect?.value) ? schemeSelect!.value : DEFAULT_CLOUD_THEME_SCHEME
    const accentId = isCloudThemeAccentPreset(accentSelect?.value) ? accentSelect!.value as UiAccentPresetId : DEFAULT_UI_ACCENT_PRESET_ID
    if (presetSelect) presetSelect.value = presetId
    if (schemeSelect) schemeSelect.value = scheme
    if (accentSelect) accentSelect.value = accentId
    persistCloudThemePreset(presetId)
    persistCloudThemeScheme(scheme)
    persistCloudThemeAccent(accentId)
    applyCloudThemePreset(presetId, scheme, accentId)
  })
  themeControlDocuments.add(ownerDocument)
}

export function installCloudThemePresetControls(bootstrap: CloudWebClientBootstrap) {
  const select = document.getElementById('cloud-theme-preset') as HTMLSelectElement | null
  const schemeSelect = document.getElementById('cloud-theme-scheme') as HTMLSelectElement | null
  const accentSelect = document.getElementById('cloud-theme-accent') as HTMLSelectElement | null
  const densitySelect = document.getElementById('cloud-theme-density') as HTMLSelectElement | null
  if (!select) return
  const locked = Boolean(bootstrap.theme?.tenantBrandingLocked)
  for (const control of [select, schemeSelect, accentSelect]) {
    if (!control) continue
    control.disabled = locked
    control.dataset.tenantBrandingLocked = locked ? 'true' : 'false'
  }
  const bootstrapDensity = isCloudDensity(bootstrap.theme?.defaultDensity)
    ? bootstrap.theme.defaultDensity
    : DEFAULT_CLOUD_THEME_DENSITY
  const initialDensity = storedCloudDensity(bootstrapDensity)
  if (densitySelect) densitySelect.value = initialDensity
  applyCloudDensity(initialDensity)
  installThemeControlChangeListener(document)

  if (locked) {
    select.title = 'Theme is managed by this cloud workspace'
    if (schemeSelect) schemeSelect.title = select.title
    if (accentSelect) accentSelect.title = select.title
    return
  }

  const initialPreset = storedCloudThemePreset(bootstrap.theme?.defaultPreset || DEFAULT_CLOUD_THEME_PRESET)
  const initialScheme = storedCloudThemeScheme(bootstrap.theme?.defaultScheme || DEFAULT_CLOUD_THEME_SCHEME)
  const initialAccent = storedCloudThemeAccent(bootstrap.theme?.defaultAccent || DEFAULT_CLOUD_THEME_ACCENT_PRESET)
  select.value = initialPreset
  if (schemeSelect) schemeSelect.value = initialScheme
  if (accentSelect) accentSelect.value = initialAccent
  applyCloudThemePreset(initialPreset, initialScheme, initialAccent)
}
