import { describe, expect, it } from 'vitest'
import { ensureReadableTextColor } from './chart-colors'

describe('chart color helpers', () => {
  it('selects readable text colors across supported color formats', () => {
    expect(ensureReadableTextColor('#eeeeee', '#111111', '#eeeeee', '#111111')).toBe('#eeeeee')
    expect(ensureReadableTextColor('#000000', '#ffffff', '#eeeeee', '#111111')).toBe('#000000')
    expect(ensureReadableTextColor('#777777', '#777777', '#eeeeee', '#111111')).toBe('#eeeeee')
    expect(ensureReadableTextColor('#eeeeee', 'rgb(300, 300, 300)', '#eeeeee', '#111111')).toBe('#111111')
    expect(ensureReadableTextColor('#eeeeee', 'not-a-color', '#eeeeee', '#111111')).toBe('#eeeeee')
  })
})
