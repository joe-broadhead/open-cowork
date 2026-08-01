import { describe, expect, it } from 'vitest'
import { UI_THEME_PRESETS } from '@open-cowork/shared'
import {
  applyAppearancePreferences,
  getAppearancePreferences,
  isNonDefaultAppearanceVariantChange,
  saveAppearancePreferences,
  UI_FONT_OPTIONS,
} from './theme'
import {
  getUserFacingThemes,
  isUserFacingTheme,
  registerExtraThemes,
  setDefaultThemeId,
} from './theme-presets'

describe('appearance theme presets', () => {
  it('exposes only the maintained Mercury product theme', () => {
    expect(isUserFacingTheme('mercury')).toBe(true)
    for (const themeId of ['nord', 'rosepine', 'dracula', 'kanagawa', 'everforest']) {
      expect(isUserFacingTheme(themeId)).toBe(false)
    }
    expect(isUserFacingTheme('matrix')).toBe(false)
    expect(isUserFacingTheme('not-a-real-theme')).toBe(false)
    expect(isUserFacingTheme(null)).toBe(false)
    expect(isUserFacingTheme(undefined)).toBe(false)
  })

  it('keeps a downstream configured default available alongside Mercury', () => {
    registerExtraThemes([{
      id: 'acme-default',
      label: 'Acme Default',
      description: 'Downstream product default',
      swatches: ['#112233', '#445566'],
      dark: UI_THEME_PRESETS.mercury.dark,
      light: UI_THEME_PRESETS.mercury.light,
    }])
    setDefaultThemeId('acme-default')
    try {
      expect(isUserFacingTheme('acme-default')).toBe(true)
      expect(getUserFacingThemes().map(({ id, label }) => ({ id, label }))).toEqual([
        { id: 'mercury', label: 'Mercury' },
        { id: 'acme-default', label: 'Acme Default' },
      ])
    } finally {
      setDefaultThemeId('mercury')
    }
  })
})

describe('appearance theme defaults', () => {
  it('defaults first-run appearance to Mercury with the theme-matched accent', () => {
    expect(getAppearancePreferences().uiTheme).toBe('mercury')
    expect(getAppearancePreferences().accent).toBe('theme')

    applyAppearancePreferences()

    expect(document.documentElement.dataset.uiTheme).toBe('mercury')
    expect(document.documentElement.dataset.uiAccent).toBe('theme')
    expect(document.documentElement.style.getPropertyValue('--color-base')).toBe('#0d0e11')
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#8290ff')
    expect(document.documentElement.style.getPropertyValue('--accent-2')).toBe('#9aa8ff')
    expect(document.documentElement.style.getPropertyValue('--accent-text')).toBe('#9aa8ff')
    expect(document.documentElement.style.getPropertyValue('--accent-action-foreground')).toBe('#000000')
    expect(document.documentElement.style.getPropertyValue('--accent-gradient')).toBe('linear-gradient(150deg,var(--accent-2),var(--accent))')
    expect(document.documentElement.style.getPropertyValue('--accent-action-fill')).toBe('linear-gradient(rgba(255,255,255,0),rgba(255,255,255,0)), var(--accent-gradient)')
  })

  it('migrates retired picker choices to maintained defaults', () => {
    window.localStorage.setItem('open-cowork-ui-theme', 'nord')
    window.localStorage.setItem('open-cowork-ui-accent', 'azure')

    expect(getAppearancePreferences()).toMatchObject({ uiTheme: 'mercury', accent: 'theme' })
    expect(window.localStorage.getItem('open-cowork-ui-theme')).toBe('mercury')
    expect(window.localStorage.getItem('open-cowork-ui-accent')).toBe('theme')
  })
})

describe('appearance typography defaults', () => {
  it('defaults the interface font to Mona Sans and exposes the Schibsted display font token', () => {
    expect(getAppearancePreferences().uiFont).toBe('mona')
    expect(UI_FONT_OPTIONS[0]).toEqual({ id: 'mona', label: 'Mona Sans' })

    applyAppearancePreferences()

    expect(document.documentElement.style.getPropertyValue('--font-ui')).toContain('Mona Sans')
    expect(document.documentElement.style.getPropertyValue('--font-display')).toContain('Schibsted Grotesk')
  })

  it('keeps existing interface font overrides available', () => {
    window.localStorage.setItem('open-cowork-ui-font', 'rounded')

    applyAppearancePreferences()

    expect(getAppearancePreferences().uiFont).toBe('rounded')
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toContain('SF Pro Rounded')
    expect(document.documentElement.style.getPropertyValue('--font-display')).toContain('Schibsted Grotesk')
  })
})

describe('appearance density', () => {
  it('only classifies non-default retained theme and density choices as value variants', () => {
    expect(isNonDefaultAppearanceVariantChange({ uiTheme: 'nord' })).toBe(false)
    expect(isNonDefaultAppearanceVariantChange({ density: 'compact' })).toBe(true)
    expect(isNonDefaultAppearanceVariantChange({ density: 'comfy' })).toBe(true)
    expect(isNonDefaultAppearanceVariantChange({ uiTheme: 'mercury' })).toBe(false)
    expect(isNonDefaultAppearanceVariantChange({ density: 'regular' })).toBe(false)
    expect(isNonDefaultAppearanceVariantChange({ colorScheme: 'light' })).toBe(false)
  })

  it('defaults to regular density and persists compact/comfy choices', () => {
    expect(getAppearancePreferences().density).toBe('regular')

    applyAppearancePreferences()
    expect(document.documentElement.dataset.density).toBe('regular')

    const compact = saveAppearancePreferences({ density: 'compact' })
    expect(compact.density).toBe('compact')
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(window.localStorage.getItem('open-cowork-density')).toBe('compact')

    const comfy = saveAppearancePreferences({ density: 'comfy' })
    expect(comfy.density).toBe('comfy')
    expect(document.documentElement.dataset.density).toBe('comfy')
    expect(window.localStorage.getItem('open-cowork-density')).toBe('comfy')
  })
})
