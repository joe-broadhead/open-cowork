import { DEFAULT_UI_ACCENT_PRESET_ID, UI_THEME_PRESETS, accentActionFillToken, applyThemeAccent, type ThemeTokens, type UiAccentPresetId } from '@open-cowork/shared'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import {
  CLOUD_USER_SETTING_PATHS,
  CLOUD_USER_SETTING_STORAGE_PREFIX,
  cloudUserPreferenceState,
  enqueueCloudUserPreferenceSave,
  hasDurableCloudUserPreferences,
  loadCloudUserPreferences,
  nextCloudUserPreferenceSaveGeneration,
  saveCloudUserPreferences,
  type CloudUserPreferences,
} from './cloud-user-preferences-client.ts'
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

function themeSelect(ownerDocument: Document, kind: 'preset' | 'scheme' | 'accent' | 'density') {
  const id = kind === 'preset'
    ? 'cloud-theme-preset'
    : kind === 'scheme'
      ? 'cloud-theme-scheme'
      : kind === 'accent'
        ? 'cloud-theme-accent'
        : 'cloud-theme-density'
  return (ownerDocument.getElementById(id) || ownerDocument.querySelector(`[data-cloud-theme-control="${kind}"]`)) as HTMLSelectElement | null
}

function themeControlKind(select: HTMLSelectElement) {
  if (select.id === 'cloud-theme-preset' || select.dataset.cloudThemeControl === 'preset') return 'preset'
  if (select.id === 'cloud-theme-scheme' || select.dataset.cloudThemeControl === 'scheme') return 'scheme'
  if (select.id === 'cloud-theme-accent' || select.dataset.cloudThemeControl === 'accent') return 'accent'
  if (select.id === 'cloud-theme-density' || select.dataset.cloudThemeControl === 'density') return 'density'
  return null
}

function allThemeSelects(ownerDocument: Document, kind: 'preset' | 'scheme' | 'accent' | 'density') {
  const id = kind === 'preset'
    ? 'cloud-theme-preset'
    : kind === 'scheme'
      ? 'cloud-theme-scheme'
      : kind === 'accent'
        ? 'cloud-theme-accent'
        : 'cloud-theme-density'
  return Array.from(ownerDocument.querySelectorAll<HTMLSelectElement>(`#${id}, [data-cloud-theme-control="${kind}"]`))
}

function syncThemeControls(ownerDocument: Document, values: {
  presetId: string
  scheme: 'dark' | 'light'
  accentId: UiAccentPresetId
  density: CloudDensity
}) {
  for (const select of allThemeSelects(ownerDocument, 'preset')) select.value = values.presetId
  for (const select of allThemeSelects(ownerDocument, 'scheme')) select.value = values.scheme
  for (const select of allThemeSelects(ownerDocument, 'accent')) select.value = values.accentId
  for (const select of allThemeSelects(ownerDocument, 'density')) select.value = values.density
  for (const button of ownerDocument.querySelectorAll<HTMLButtonElement>('[data-cloud-theme-accent-button]')) {
    button.classList.toggle('on', button.dataset.cloudThemeAccentButton === values.accentId)
    button.setAttribute('aria-pressed', button.dataset.cloudThemeAccentButton === values.accentId ? 'true' : 'false')
  }
  for (const button of ownerDocument.querySelectorAll<HTMLButtonElement>('[data-cloud-density-button]')) {
    button.classList.toggle('on', button.dataset.cloudDensityButton === values.density)
    button.setAttribute('aria-pressed', button.dataset.cloudDensityButton === values.density ? 'true' : 'false')
  }
}

function setUserSettingToggle(button: HTMLButtonElement, checked: boolean) {
  button.setAttribute('aria-checked', checked ? 'true' : 'false')
  button.classList.toggle('on', checked)
}

function applyCloudUserSettingToggles(ownerDocument: Document, preferences: CloudUserPreferences) {
  for (const button of ownerDocument.querySelectorAll<HTMLButtonElement>('[data-cloud-user-setting]')) {
    const key = button.dataset.cloudUserSetting as keyof typeof CLOUD_USER_SETTING_PATHS | undefined
    if (!key) continue
    const path = CLOUD_USER_SETTING_PATHS[key]
    if (!path) continue
    const [group, field] = path
    const value = (preferences[group] as Record<string, boolean | undefined> | undefined)?.[field]
    if (typeof value !== 'boolean') continue
    setUserSettingToggle(button, value)
    try {
      localStorage.setItem(`${CLOUD_USER_SETTING_STORAGE_PREFIX}${key}`, value ? 'true' : 'false')
    } catch {
      // Browser-local cache is best-effort.
    }
  }
}

function collectCloudUserPreferences(ownerDocument: Document, locked: boolean): CloudUserPreferences {
  const current = resolveThemeSelection(ownerDocument)
  const preferences: CloudUserPreferences = {
    theme: {
      ...(locked ? {} : {
        presetId: current.presetId,
        scheme: current.scheme,
        accentId: current.accentId,
      }),
      density: current.density,
    },
    notifications: {},
    privacy: {},
  }
  for (const button of ownerDocument.querySelectorAll<HTMLButtonElement>('[data-cloud-user-setting]')) {
    const key = button.dataset.cloudUserSetting as keyof typeof CLOUD_USER_SETTING_PATHS | undefined
    if (!key) continue
    const path = CLOUD_USER_SETTING_PATHS[key]
    if (!path) continue
    const [group, field] = path
    const target = preferences[group] as Record<string, boolean | undefined>
    target[field] = button.getAttribute('aria-checked') === 'true'
  }
  return preferences
}

function persistCurrentCloudUserPreferences(ownerDocument: Document, bootstrap: CloudWebClientBootstrap, locked: boolean) {
  if (hasDurableCloudUserPreferences(bootstrap) && !cloudUserPreferenceState(ownerDocument).hydrationComplete) {
    return Promise.resolve(false)
  }
  return enqueueCloudUserPreferenceSave(ownerDocument, async () => {
    const nextPreferences = collectCloudUserPreferences(ownerDocument, locked)
    const saved = await saveCloudUserPreferences(bootstrap, nextPreferences)
    if (saved) cloudUserPreferenceState(ownerDocument).lastSavedPreferences = nextPreferences
    return saved
  })
}

function resolveThemeSelection(ownerDocument: Document) {
  const presetSelect = themeSelect(ownerDocument, 'preset')
  const schemeSelect = themeSelect(ownerDocument, 'scheme')
  const accentSelect = themeSelect(ownerDocument, 'accent')
  const densitySelect = themeSelect(ownerDocument, 'density')
  return {
    presetId: isCloudThemePreset(presetSelect?.value) ? presetSelect!.value : DEFAULT_CLOUD_THEME_PRESET,
    scheme: isCloudThemeScheme(schemeSelect?.value) ? schemeSelect!.value : DEFAULT_CLOUD_THEME_SCHEME,
    accentId: isCloudThemeAccentPreset(accentSelect?.value) ? accentSelect!.value as UiAccentPresetId : DEFAULT_UI_ACCENT_PRESET_ID,
    density: isCloudDensity(densitySelect?.value) ? densitySelect!.value : DEFAULT_CLOUD_THEME_DENSITY,
  }
}

function installThemeControlChangeListener(ownerDocument: Document, bootstrap: CloudWebClientBootstrap, locked: boolean) {
  if (themeControlDocuments.has(ownerDocument)) return
  ownerDocument.addEventListener('change', (event) => {
    const select = event.target as HTMLSelectElement | null
    if (!select || select.tagName !== 'SELECT') return
    const controlKind = themeControlKind(select)
    if (!controlKind) return
    for (const peer of allThemeSelects(ownerDocument, controlKind)) peer.value = select.value
    if (controlKind === 'density') {
      const density = isCloudDensity(select.value) ? select.value : DEFAULT_CLOUD_THEME_DENSITY
      persistCloudDensity(density)
      applyCloudDensity(density)
      syncThemeControls(ownerDocument, { ...resolveThemeSelection(ownerDocument), density })
      persistCurrentCloudUserPreferences(ownerDocument, bootstrap, locked)
      return
    }
    if (select.disabled || select.dataset.tenantBrandingLocked === 'true') return
    const { presetId, scheme, accentId, density } = resolveThemeSelection(ownerDocument)
    persistCloudThemePreset(presetId)
    persistCloudThemeScheme(scheme)
    persistCloudThemeAccent(accentId)
    applyCloudThemePreset(presetId, scheme, accentId)
    syncThemeControls(ownerDocument, { presetId, scheme, accentId, density })
    persistCurrentCloudUserPreferences(ownerDocument, bootstrap, locked)
  })
  ownerDocument.addEventListener('click', (event) => {
    const target = event.target as Element | null
    const settingsTargetButton = target?.closest<HTMLButtonElement>('[data-cloud-settings-target]')
    if (settingsTargetButton) {
      const targetId = settingsTargetButton.dataset.cloudSettingsTarget
      if (!targetId) return
      const section = ownerDocument.getElementById(targetId)
      section?.scrollIntoView?.({ block: 'start' })
      return
    }
    const accentButton = target?.closest<HTMLButtonElement>('[data-cloud-theme-accent-button]')
    if (accentButton) {
      const lockedContainer = accentButton.closest('[data-tenant-branding-locked="true"]')
      if (lockedContainer) return
      const accentId = accentButton.dataset.cloudThemeAccentButton
      if (!isCloudThemeAccentPreset(accentId)) return
      const current = resolveThemeSelection(ownerDocument)
      persistCloudThemeAccent(accentId as UiAccentPresetId)
      applyCloudThemePreset(current.presetId, current.scheme, accentId)
      syncThemeControls(ownerDocument, { ...current, accentId: accentId as UiAccentPresetId })
      persistCurrentCloudUserPreferences(ownerDocument, bootstrap, locked)
      return
    }
    const densityButton = target?.closest<HTMLButtonElement>('[data-cloud-density-button]')
    if (densityButton) {
      const density = densityButton.dataset.cloudDensityButton
      if (!isCloudDensity(density)) return
      persistCloudDensity(density)
      applyCloudDensity(density)
      syncThemeControls(ownerDocument, { ...resolveThemeSelection(ownerDocument), density })
      persistCurrentCloudUserPreferences(ownerDocument, bootstrap, locked)
      return
    }
    const userSetting = target?.closest<HTMLButtonElement>('[data-cloud-user-setting]')
    if (userSetting) {
      const key = userSetting.dataset.cloudUserSetting
      if (!key) return
      const storageKey = `${CLOUD_USER_SETTING_STORAGE_PREFIX}${key}`
      const previous = userSetting.getAttribute('aria-checked') === 'true'
      let previousStored: string | null = null
      try {
        previousStored = localStorage.getItem(storageKey)
      } catch {
        previousStored = null
      }
      const next = userSetting.getAttribute('aria-checked') !== 'true'
      setUserSettingToggle(userSetting, next)
      const saveGeneration = nextCloudUserPreferenceSaveGeneration(ownerDocument)
      if (!hasDurableCloudUserPreferences(bootstrap)) {
        try {
          localStorage.setItem(storageKey, next ? 'true' : 'false')
        } catch {
          // Browser-local settings are best-effort.
        }
        return
      }
      void persistCurrentCloudUserPreferences(ownerDocument, bootstrap, locked).then((saved) => {
        if (saved) {
          try {
            localStorage.setItem(storageKey, next ? 'true' : 'false')
          } catch {
            // Browser-local settings are best-effort; the current UI state still updates.
          }
          return
        }
        if (cloudUserPreferenceState(ownerDocument).saveGeneration !== saveGeneration) return
        setUserSettingToggle(userSetting, previous)
        try {
          if (previousStored === null) localStorage.removeItem(storageKey)
          else localStorage.setItem(storageKey, previousStored)
        } catch {
          // Browser-local cache restoration is best-effort.
        }
      })
    }
  })
  themeControlDocuments.add(ownerDocument)
}

function applyStoredUserSettingToggles(ownerDocument: Document) {
  for (const button of ownerDocument.querySelectorAll<HTMLButtonElement>('[data-cloud-user-setting]')) {
    const key = button.dataset.cloudUserSetting
    if (!key) continue
    let checked = button.dataset.defaultChecked === 'true'
    try {
      const stored = localStorage.getItem(`${CLOUD_USER_SETTING_STORAGE_PREFIX}${key}`)
      if (stored === 'true' || stored === 'false') checked = stored === 'true'
    } catch {
      // Browser-local settings are best-effort.
    }
    setUserSettingToggle(button, checked)
  }
}

function applyLoadedCloudUserPreferences(ownerDocument: Document, preferences: CloudUserPreferences, locked: boolean) {
  const current = resolveThemeSelection(ownerDocument)
  const density = preferences.theme?.density || current.density
  persistCloudDensity(density)
  applyCloudDensity(density)

  if (!locked) {
    const presetId = preferences.theme?.presetId || current.presetId
    const scheme = preferences.theme?.scheme || current.scheme
    const accentId = preferences.theme?.accentId || current.accentId
    persistCloudThemePreset(presetId)
    persistCloudThemeScheme(scheme)
    persistCloudThemeAccent(accentId)
    applyCloudThemePreset(presetId, scheme, accentId)
    syncThemeControls(ownerDocument, { presetId, scheme, accentId, density })
  } else {
    syncThemeControls(ownerDocument, {
      presetId: DEFAULT_CLOUD_THEME_PRESET,
      scheme: DEFAULT_CLOUD_THEME_SCHEME,
      accentId: DEFAULT_CLOUD_THEME_ACCENT_PRESET,
      density,
    })
  }

  applyCloudUserSettingToggles(ownerDocument, preferences)
}

async function hydrateCloudUserPreferences(ownerDocument: Document, bootstrap: CloudWebClientBootstrap, locked: boolean) {
  const preferences = await loadCloudUserPreferences(bootstrap)
  const state = cloudUserPreferenceState(ownerDocument)
  state.hydrationComplete = true
  if (!preferences) return
  state.lastSavedPreferences = preferences
  applyLoadedCloudUserPreferences(ownerDocument, preferences, locked)
}

export function installCloudThemePresetControls(bootstrap: CloudWebClientBootstrap) {
  const select = document.getElementById('cloud-theme-preset') as HTMLSelectElement | null
  const schemeSelect = document.getElementById('cloud-theme-scheme') as HTMLSelectElement | null
  const accentSelect = document.getElementById('cloud-theme-accent') as HTMLSelectElement | null
  if (!select) return
  const locked = Boolean(bootstrap.theme?.tenantBrandingLocked)
  cloudUserPreferenceState(document)
  for (const control of [select, schemeSelect, accentSelect]) {
    if (!control) continue
    control.disabled = locked
    control.dataset.tenantBrandingLocked = locked ? 'true' : 'false'
  }
  const bootstrapDensity = isCloudDensity(bootstrap.theme?.defaultDensity)
    ? bootstrap.theme.defaultDensity
    : DEFAULT_CLOUD_THEME_DENSITY
  const initialDensity = storedCloudDensity(bootstrapDensity)
  applyCloudDensity(initialDensity)
  installThemeControlChangeListener(document, bootstrap, locked)
  applyStoredUserSettingToggles(document)

  if (locked) {
    select.title = 'Theme is managed by this cloud workspace'
    if (schemeSelect) schemeSelect.title = select.title
    if (accentSelect) accentSelect.title = select.title
    syncThemeControls(document, {
      presetId: DEFAULT_CLOUD_THEME_PRESET,
      scheme: DEFAULT_CLOUD_THEME_SCHEME,
      accentId: DEFAULT_CLOUD_THEME_ACCENT_PRESET,
      density: initialDensity,
    })
    void hydrateCloudUserPreferences(document, bootstrap, locked)
    return
  }

  const initialPreset = storedCloudThemePreset(bootstrap.theme?.defaultPreset || DEFAULT_CLOUD_THEME_PRESET)
  const initialScheme = storedCloudThemeScheme(bootstrap.theme?.defaultScheme || DEFAULT_CLOUD_THEME_SCHEME)
  const initialAccent = storedCloudThemeAccent(bootstrap.theme?.defaultAccent || DEFAULT_CLOUD_THEME_ACCENT_PRESET)
  applyCloudThemePreset(initialPreset, initialScheme, initialAccent)
  syncThemeControls(document, {
    presetId: initialPreset,
    scheme: initialScheme,
    accentId: initialAccent,
    density: initialDensity,
  })
  void hydrateCloudUserPreferences(document, bootstrap, locked)
}
