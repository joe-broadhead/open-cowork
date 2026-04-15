type Rgba = {
  r: number
  g: number
  b: number
  a: number
}

function clampChannel(value: number) {
  return Math.max(0, Math.min(255, value))
}

function parseHex(value: string): Rgba | null {
  const hex = value.replace('#', '').trim()
  if (![3, 4, 6, 8].includes(hex.length)) return null

  const read = (start: number, size: number) => {
    const slice = hex.slice(start, start + size)
    return Number.parseInt(size === 1 ? `${slice}${slice}` : slice, 16)
  }

  if (hex.length === 3 || hex.length === 4) {
    const r = read(0, 1)
    const g = read(1, 1)
    const b = read(2, 1)
    const a = hex.length === 4 ? read(3, 1) / 255 : 1
    return { r, g, b, a }
  }

  const r = read(0, 2)
  const g = read(2, 2)
  const b = read(4, 2)
  const a = hex.length === 8 ? read(6, 2) / 255 : 1
  return { r, g, b, a }
}

function parseRgb(value: string): Rgba | null {
  const match = value.match(/rgba?\(([^)]+)\)/i)
  if (!match) return null
  const parts = match[1].split(',').map((part) => part.trim())
  if (parts.length < 3) return null

  const r = clampChannel(Number.parseFloat(parts[0]))
  const g = clampChannel(Number.parseFloat(parts[1]))
  const b = clampChannel(Number.parseFloat(parts[2]))
  const a = parts[3] !== undefined ? Math.max(0, Math.min(1, Number.parseFloat(parts[3]))) : 1

  if (![r, g, b, a].every((entry) => Number.isFinite(entry))) return null
  return { r, g, b, a }
}

export function parseCssColor(value: string | null | undefined): Rgba | null {
  if (!value) return null
  const input = value.trim()
  if (!input) return null
  if (input.startsWith('#')) return parseHex(input)
  if (input.startsWith('rgb')) return parseRgb(input)
  return null
}

function channelToLinear(value: number) {
  const normalized = value / 255
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(color: Rgba | null) {
  if (!color) return null
  return (
    0.2126 * channelToLinear(color.r)
    + 0.7152 * channelToLinear(color.g)
    + 0.0722 * channelToLinear(color.b)
  )
}

export function contrastRatio(foreground: string | null | undefined, background: string | null | undefined) {
  const fg = relativeLuminance(parseCssColor(foreground))
  const bg = relativeLuminance(parseCssColor(background))
  if (fg === null || bg === null) return null
  const lighter = Math.max(fg, bg)
  const darker = Math.min(fg, bg)
  return (lighter + 0.05) / (darker + 0.05)
}

export function pickReadableTextColor(
  background: string | null | undefined,
  light = '#f5f7ff',
  dark = '#141824',
) {
  const luminance = relativeLuminance(parseCssColor(background))
  if (luminance === null) return light
  return luminance > 0.58 ? dark : light
}

export function ensureReadableTextColor(
  preferred: string | null | undefined,
  background: string | null | undefined,
  light = '#f5f7ff',
  dark = '#141824',
) {
  const ratio = contrastRatio(preferred, background)
  if (ratio !== null && ratio >= 4.5 && preferred) return preferred
  return pickReadableTextColor(background, light, dark)
}
