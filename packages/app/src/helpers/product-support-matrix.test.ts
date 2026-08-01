import { describe, expect, it } from 'vitest'
import { UI_ACCENT_PRESETS, UI_THEME_PRESETS } from '@open-cowork/shared'
import {
  PRODUCT_SUPPORT_MATRIX,
  SUPPORTED_LOCALE_COVERAGE_THRESHOLD,
  isSupportedAutomaticLocale,
  localeSupportStatus,
} from './product-support-matrix'

describe('maintained locale and appearance matrix', () => {
  it('keeps English supported and labels incomplete catalogs experimental', () => {
    expect(PRODUCT_SUPPORT_MATRIX.locales.translatedCoverage).toBeLessThan(SUPPORTED_LOCALE_COVERAGE_THRESHOLD)
    expect(localeSupportStatus('en-US')).toBe('retained')
    expect(localeSupportStatus('de-DE')).toBe('experimental')
    expect(localeSupportStatus('unknown')).toBe('removed')
    expect(isSupportedAutomaticLocale('en-US')).toBe(true)
    expect(isSupportedAutomaticLocale('de-DE')).toBe(false)
    expect(PRODUCT_SUPPORT_MATRIX.locales.usageEvidence).toMatch(/No historical locale-selection baseline/i)
    expect(PRODUCT_SUPPORT_MATRIX.locales.qaCost).toMatch(/fallback suite.*locale/i)
  })

  it('accounts for every built-in theme and accent without advertising retired choices', () => {
    expect([
      ...PRODUCT_SUPPORT_MATRIX.appearance.themes.retained,
      ...PRODUCT_SUPPORT_MATRIX.appearance.themes.removedFromPicker,
    ].sort()).toEqual(Object.keys(UI_THEME_PRESETS).sort())
    expect(PRODUCT_SUPPORT_MATRIX.appearance.accents.removedFromPicker.slice().sort())
      .toEqual(Object.keys(UI_ACCENT_PRESETS).sort())
    expect(PRODUCT_SUPPORT_MATRIX.appearance.densities.retained)
      .toEqual(['compact', 'regular', 'comfy'])
    expect(PRODUCT_SUPPORT_MATRIX.appearance.usageEvidence).toMatch(/No historical appearance-selection baseline/i)
  })
})
