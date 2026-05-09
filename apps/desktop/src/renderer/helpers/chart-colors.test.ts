import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  ensureReadableTextColor,
  parseCssColor,
  pickReadableTextColor,
  relativeLuminance,
} from './chart-colors'

describe('chart color helpers', () => {
  it('parses supported hex colors', () => {
    expect(parseCssColor('#0f8')).toEqual({ r: 0, g: 255, b: 136, a: 1 })
    expect(parseCssColor('#0f8c')).toEqual({ r: 0, g: 255, b: 136, a: 0.8 })
    expect(parseCssColor('#003366')).toEqual({ r: 0, g: 51, b: 102, a: 1 })

    const parsed = parseCssColor('#00336680')
    expect(parsed).toMatchObject({ r: 0, g: 51, b: 102 })
    expect(parsed?.a).toBeCloseTo(0.502, 3)
  })

  it('parses and clamps rgb colors', () => {
    expect(parseCssColor('rgb(300, -20, 12.6)')).toEqual({ r: 255, g: 0, b: 12.6, a: 1 })
    expect(parseCssColor('rgba(8, 16, 32, 1.4)')).toEqual({ r: 8, g: 16, b: 32, a: 1 })
    expect(parseCssColor('rgba(8, 16, 32, -0.2)')).toEqual({ r: 8, g: 16, b: 32, a: 0 })
  })

  it('rejects invalid or unsupported color values', () => {
    expect(parseCssColor(null)).toBeNull()
    expect(parseCssColor('')).toBeNull()
    expect(parseCssColor('blue')).toBeNull()
    expect(parseCssColor('#12')).toBeNull()
    expect(parseCssColor('rgba(10, bad, 20, 1)')).toBeNull()
  })

  it('computes luminance and contrast ratios', () => {
    expect(relativeLuminance(parseCssColor('#000000'))).toBeCloseTo(0)
    expect(relativeLuminance(parseCssColor('#ffffff'))).toBeCloseTo(1)
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21)
    expect(contrastRatio('not-a-color', '#ffffff')).toBeNull()
  })

  it('selects readable text colors and preserves readable preferences', () => {
    expect(pickReadableTextColor('#ffffff', '#eeeeee', '#111111')).toBe('#111111')
    expect(pickReadableTextColor('#111111', '#eeeeee', '#111111')).toBe('#eeeeee')
    expect(pickReadableTextColor('not-a-color', '#eeeeee', '#111111')).toBe('#eeeeee')

    expect(ensureReadableTextColor('#000000', '#ffffff', '#eeeeee', '#111111')).toBe('#000000')
    expect(ensureReadableTextColor('#777777', '#777777', '#eeeeee', '#111111')).toBe('#eeeeee')
  })
})
