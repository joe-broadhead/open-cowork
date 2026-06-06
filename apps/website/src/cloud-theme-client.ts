import { UI_THEME_PRESETS, type ThemeTokens } from '@open-cowork/shared'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import {
  CLOUD_THEME_STORAGE_KEY,
  DEFAULT_CLOUD_THEME_PRESET,
  isCloudThemePreset,
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
  ['accent', ['--color-accent', '--accent', '--focus']],
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

export function applyCloudThemePreset(presetId: string, scheme: 'dark' | 'light' = 'dark') {
  const resolvedPresetId = isCloudThemePreset(presetId) ? presetId : DEFAULT_CLOUD_THEME_PRESET
  const preset = UI_THEME_PRESETS[resolvedPresetId as keyof typeof UI_THEME_PRESETS]
  const tokens = scheme === 'light' ? preset.light : preset.dark
  const root = document.documentElement
  root.dataset.uiTheme = resolvedPresetId
  for (const [tokenName, cssVars] of TOKEN_CSS_VARS) {
    const value = tokens[tokenName]
    if (!value) continue
    for (const cssVar of cssVars) root.style.setProperty(cssVar, value)
  }
}

function storedCloudThemePreset() {
  try {
    const stored = localStorage.getItem(CLOUD_THEME_STORAGE_KEY)
    return isCloudThemePreset(stored) ? stored as string : DEFAULT_CLOUD_THEME_PRESET
  } catch {
    return DEFAULT_CLOUD_THEME_PRESET
  }
}

function persistCloudThemePreset(presetId: string) {
  try {
    localStorage.setItem(CLOUD_THEME_STORAGE_KEY, presetId)
  } catch {
    // Local persistence is best-effort only; the selected preset still applies for this page.
  }
}

const themeControlDocuments = new WeakSet<Document>()

function installThemeControlChangeListener(ownerDocument: Document) {
  if (themeControlDocuments.has(ownerDocument)) return
  ownerDocument.addEventListener('change', (event) => {
    const select = event.target as HTMLSelectElement | null
    if (!select || select.id !== 'cloud-theme-preset' || select.tagName !== 'SELECT') return
    if (select.disabled || select.dataset.tenantBrandingLocked === 'true') return
    const presetId = isCloudThemePreset(select.value) ? select.value : DEFAULT_CLOUD_THEME_PRESET
    select.value = presetId
    persistCloudThemePreset(presetId)
    applyCloudThemePreset(presetId)
  })
  themeControlDocuments.add(ownerDocument)
}

export function installCloudThemePresetControls(bootstrap: CloudWebClientBootstrap) {
  const select = document.getElementById('cloud-theme-preset') as HTMLSelectElement | null
  if (!select) return
  const locked = Boolean(bootstrap.theme?.tenantBrandingLocked)
  select.disabled = locked
  select.dataset.tenantBrandingLocked = locked ? 'true' : 'false'
  if (locked) {
    select.title = 'Theme is managed by this cloud workspace'
    return
  }

  const initialPreset = storedCloudThemePreset()
  select.value = initialPreset
  applyCloudThemePreset(initialPreset)
  installThemeControlChangeListener(document)
}
