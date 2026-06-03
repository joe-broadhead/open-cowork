import { describe, expect, it } from 'vitest'
import { applyAppearancePreferences, getAppearancePreferences, UI_FONT_OPTIONS } from './theme'

describe('appearance typography defaults', () => {
  it('defaults the interface font to Mona Sans and exposes the display font token', () => {
    expect(getAppearancePreferences().uiFont).toBe('mona')
    expect(UI_FONT_OPTIONS[0]).toEqual({ id: 'mona', label: 'Mona Sans' })

    applyAppearancePreferences()

    expect(document.documentElement.style.getPropertyValue('--font-ui')).toContain('Mona Sans')
    expect(document.documentElement.style.getPropertyValue('--font-display')).toContain('Hubot Sans')
  })

  it('keeps existing interface font overrides available', () => {
    window.localStorage.setItem('open-cowork-ui-font', 'rounded')

    applyAppearancePreferences()

    expect(getAppearancePreferences().uiFont).toBe('rounded')
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toContain('SF Pro Rounded')
    expect(document.documentElement.style.getPropertyValue('--font-display')).toContain('Hubot Sans')
  })
})
