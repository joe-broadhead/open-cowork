import { describe, expect, it } from 'vitest'
import { applyAppearancePreferences, getAppearancePreferences, saveAppearancePreferences, UI_FONT_OPTIONS } from './theme'

describe('appearance theme defaults', () => {
  it('defaults first-run appearance to Mercury with the Azure accent', () => {
    expect(getAppearancePreferences().uiTheme).toBe('mercury')
    expect(getAppearancePreferences().accent).toBe('azure')

    applyAppearancePreferences()

    expect(document.documentElement.dataset.uiTheme).toBe('mercury')
    expect(document.documentElement.dataset.uiAccent).toBe('azure')
    expect(document.documentElement.style.getPropertyValue('--color-base')).toBe('#0c0d0f')
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#2f6bf0')
    expect(document.documentElement.style.getPropertyValue('--accent-2')).toBe('#5a8cf5')
    expect(document.documentElement.style.getPropertyValue('--accent-text')).toBe('#5a8cf5')
    expect(document.documentElement.style.getPropertyValue('--accent-action-foreground')).toBe('#000000')
    expect(document.documentElement.style.getPropertyValue('--accent-gradient')).toBe('linear-gradient(150deg,var(--accent-2),var(--accent))')
    expect(document.documentElement.style.getPropertyValue('--accent-action-fill')).toBe('linear-gradient(rgba(255,255,255,0.01),rgba(255,255,255,0.01)), var(--accent-gradient)')
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
