import { describe, expect, it } from 'vitest'
import { applyAppearancePreferences, getAppearancePreferences, saveAppearancePreferences, UI_FONT_OPTIONS } from './theme'
import { isUserFacingTheme } from './theme-presets'

describe('branded theme identity (Studio brief §2)', () => {
  it('exposes only Mercury as a user-facing theme; the code-editor presets stay hidden', () => {
    // Mercury (surfaced as the Mercury/Day color schemes) is the single shipped
    // identity. The bundled code-editor presets remain as migration data but must
    // never be user-facing — re-exposing one would fail this guard.
    expect(isUserFacingTheme('mercury')).toBe(true)
    for (const devToolPreset of ['tokyostorm', 'gruvbox', 'nord', 'dracula', 'synthwave', 'frappe', 'ayu', 'kanagawa']) {
      expect(isUserFacingTheme(devToolPreset)).toBe(false)
    }
    expect(isUserFacingTheme(null)).toBe(false)
    expect(isUserFacingTheme(undefined)).toBe(false)
  })
})

describe('appearance theme defaults', () => {
  it('defaults first-run appearance to Mercury with the Azure accent', () => {
    expect(getAppearancePreferences().uiTheme).toBe('mercury')
    expect(getAppearancePreferences().accent).toBe('azure')

    applyAppearancePreferences()

    expect(document.documentElement.dataset.uiTheme).toBe('mercury')
    expect(document.documentElement.dataset.uiAccent).toBe('azure')
    expect(document.documentElement.style.getPropertyValue('--color-base')).toBe('#14141e')
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#7c8cf8')
    expect(document.documentElement.style.getPropertyValue('--accent-2')).toBe('#b06ff7')
    expect(document.documentElement.style.getPropertyValue('--accent-text')).toBe('#b06ff7')
    expect(document.documentElement.style.getPropertyValue('--accent-action-foreground')).toBe('#000000')
    expect(document.documentElement.style.getPropertyValue('--accent-gradient')).toBe('linear-gradient(150deg,var(--accent-2),var(--accent))')
    expect(document.documentElement.style.getPropertyValue('--accent-action-fill')).toBe('linear-gradient(rgba(255,255,255,0),rgba(255,255,255,0)), var(--accent-gradient)')
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
