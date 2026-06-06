import { describe, expect, it } from 'vitest'
import { UI_THEME_PRESETS } from './theme-preset-data'
import { getThemeTokens } from './theme-presets'

type HexColor = `#${string}`

function isHexColor(value: string): value is HexColor {
  return /^#[0-9a-f]{6}$/i.test(value)
}

function rgbFromHex(color: HexColor) {
  const hex = color.slice(1)
  return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
}

function linearize(channel: number) {
  return channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(color: HexColor) {
  const [red, green, blue] = rgbFromHex(color).map(linearize)
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
}

function contrastRatio(foreground: HexColor, background: HexColor) {
  const foregroundLum = relativeLuminance(foreground)
  const backgroundLum = relativeLuminance(background)
  const lighter = Math.max(foregroundLum, backgroundLum)
  const darker = Math.min(foregroundLum, backgroundLum)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('theme preset contrast', () => {
  it('keeps the complete 17-preset catalog available', () => {
    expect(Object.keys(UI_THEME_PRESETS)).toHaveLength(17)
  })

  it('uses shared built-in preset tokens without re-refining them in the runtime registry', () => {
    expect(getThemeTokens('mercury', 'dark')).toEqual(UI_THEME_PRESETS.mercury.dark)
    expect(getThemeTokens('mercury', 'light')).toEqual(UI_THEME_PRESETS.mercury.light)
  })

  it('derives complete crisp border tiers for every preset and scheme', () => {
    const failures: string[] = []

    for (const [themeId, preset] of Object.entries(UI_THEME_PRESETS)) {
      for (const scheme of ['dark', 'light'] as const) {
        const tokens = preset[scheme]
        for (const tokenName of ['border', 'borderSubtle', 'borderStrong'] as const) {
          if (!tokens[tokenName]?.trim()) {
            failures.push(`${themeId}.${scheme}.${tokenName} is missing`)
          }
        }
        if (tokens.borderStrong === tokens.border) {
          failures.push(`${themeId}.${scheme}.borderStrong must be a distinct tier`)
        }
      }
    }

    expect(failures).toEqual([])
  })

  it('keeps preset gradients dialed down after refinement', () => {
    const failures: string[] = []
    const rgbaPattern = /rgba\(\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*([0-9.]+)\s*\)/g

    for (const [themeId, preset] of Object.entries(UI_THEME_PRESETS)) {
      for (const scheme of ['dark', 'light'] as const) {
        const { bgImage } = preset[scheme]
        const alphas = Array.from(bgImage.matchAll(rgbaPattern), (match) => Number.parseFloat(match[1] || '0'))
        const tooStrong = alphas.filter((value) => Number.isFinite(value) && value > 0.08)
        if (tooStrong.length > 0) {
          failures.push(`${themeId}.${scheme}.bgImage has alpha > 0.08: ${tooStrong.join(', ')}`)
        }
      }
    }

    expect(failures).toEqual([])
  })

  it('keeps every built-in theme readable against its base color', () => {
    const failures: string[] = []
    const checks = [
      ['text', 4.5],
      ['textSecondary', 7],
      ['textMuted', 4.5],
      ['accent', 4.5],
    ] as const

    for (const [themeId, preset] of Object.entries(UI_THEME_PRESETS)) {
      for (const scheme of ['dark', 'light'] as const) {
        const tokens = preset[scheme]
        if (!isHexColor(tokens.base)) {
          failures.push(`${themeId}.${scheme}.base is not a hex color: ${tokens.base}`)
          continue
        }

        for (const [tokenName, minimum] of checks) {
          const value = tokens[tokenName]
          if (!isHexColor(value)) {
            failures.push(`${themeId}.${scheme}.${tokenName} is not a hex color: ${value}`)
            continue
          }
          const ratio = contrastRatio(value, tokens.base)
          if (ratio < minimum) {
            failures.push(`${themeId}.${scheme}.${tokenName} ${ratio.toFixed(2)} < ${minimum}`)
          }
        }

        if (!isHexColor(tokens.accent) || !isHexColor(tokens.accentForeground)) {
          failures.push(`${themeId}.${scheme}.accent/accentForeground must be hex colors`)
          continue
        }
        const accentRatio = contrastRatio(tokens.accentForeground, tokens.accent)
        if (accentRatio < 4.5) {
          failures.push(`${themeId}.${scheme}.accentForeground ${accentRatio.toFixed(2)} < 4.5`)
        }
      }
    }

    expect(failures).toEqual([])
  })
})
