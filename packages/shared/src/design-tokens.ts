import type { BrandThemeTokens, PublicBrandingThemeTokens } from './app-config.js'

export const DEFAULT_ACCENT_PRESET_ID = 'azure'

export const DESIGN_ACCENT_PRESETS = {
  azure: {
    label: 'Azure',
    accent: '#7c8cf8',
    accent2: '#b06ff7',
  },
  indigo: {
    label: 'Indigo',
    accent: '#6f8cc4',
    accent2: '#8aa3d6',
  },
  plum: {
    label: 'Plum',
    accent: '#8b7cf0',
    accent2: '#a594f5',
  },
  teal: {
    label: 'Teal',
    accent: '#3f9a8f',
    accent2: '#5bb4a8',
  },
  amber: {
    label: 'Amber',
    accent: '#e0913a',
    accent2: '#f0a955',
  },
  rose: {
    label: 'Rose',
    accent: '#d6587e',
    accent2: '#e87b9c',
  },
} as const

export type DesignAccentPresetId = keyof typeof DESIGN_ACCENT_PRESETS

export function isDesignAccentPresetId(value: string | null | undefined): value is DesignAccentPresetId {
  return Boolean(value && Object.prototype.hasOwnProperty.call(DESIGN_ACCENT_PRESETS, value))
}

function accentSoftToken() {
  return 'color-mix(in srgb,var(--accent) 15%,transparent)'
}

function accentLineToken() {
  return 'color-mix(in srgb,var(--accent) 38%,transparent)'
}

export function accentForegroundForColor(accent: string) {
  const whiteContrast = contrastRatio('#ffffff', accent)
  const blackContrast = contrastRatio('#000000', accent)
  if (whiteContrast === null || blackContrast === null) return '#ffffff'
  return whiteContrast >= blackContrast ? '#ffffff' : '#000000'
}

function hexFromRgb(red: number, green: number, blue: number) {
  return `#${[red, green, blue]
    .map((channel) => Math.round(clampColorChannel(channel)).toString(16).padStart(2, '0'))
    .join('')}`
}

function contrastRatio(foreground: string, background: string) {
  const foregroundLum = cssColorLuminance(foreground)
  const backgroundLum = cssColorLuminance(background)
  if (foregroundLum === null || backgroundLum === null) return null
  const lighter = Math.max(foregroundLum, backgroundLum)
  const darker = Math.min(foregroundLum, backgroundLum)
  return (lighter + 0.05) / (darker + 0.05)
}

function mixHexToward(source: string, target: '#000000' | '#ffffff', sourceWeight: number) {
  const sourceRgb = hexRgb(source)
  const targetRgb = hexRgb(target)
  if (!sourceRgb || !targetRgb) return source
  return hexFromRgb(
    sourceRgb[0] * sourceWeight + targetRgb[0] * (1 - sourceWeight),
    sourceRgb[1] * sourceWeight + targetRgb[1] * (1 - sourceWeight),
    sourceRgb[2] * sourceWeight + targetRgb[2] * (1 - sourceWeight),
  )
}

function overlayActionStop(color: string, foreground: '#000000' | '#ffffff', overlayAlpha: number) {
  const target = foreground === '#000000' ? '#ffffff' : '#000000'
  return mixHexToward(color, target, 1 - overlayAlpha)
}

function minActionContrast(foreground: '#000000' | '#ffffff', backgrounds: readonly string[], overlayAlpha: number) {
  const ratios = backgrounds.map((background) => contrastRatio(
    foreground,
    overlayActionStop(background, foreground, overlayAlpha),
  ))
  if (ratios.some((ratio) => ratio === null)) return 0
  return Math.min(...(ratios as number[]))
}

function formatOverlayAlpha(value: number) {
  return value === 0 ? '0' : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

function accentActionPlanForColors(accent: string, accent2: string | undefined) {
  const backgrounds = [accent, accent2 || accent]
  const candidateFor = (foreground: '#000000' | '#ffffff') => {
    for (let step = 0; step <= 40; step += 1) {
      const overlayAlpha = step / 100
      const score = minActionContrast(foreground, backgrounds, overlayAlpha)
      if (score >= 4.5) return { foreground, overlayAlpha, score }
    }
    return { foreground, overlayAlpha: 0.4, score: minActionContrast(foreground, backgrounds, 0.4) }
  }
  const white = candidateFor('#ffffff')
  const black = candidateFor('#000000')
  if (white.score === 0 || black.score === 0) {
    return {
      foreground: accentForegroundForColor(accent) as '#000000' | '#ffffff',
      overlayAlpha: 0.01,
    }
  }
  // Honor the brand ink: the action fill is a solid accent button, so the text
  // colour should follow the accent's own contrast (white on a dark accent,
  // black on a light one) rather than whichever colour reaches the WCAG target
  // with the least overlay. A small overlay then keeps the chosen ink readable
  // across the gradient, so the result stays accessible while looking on-brand.
  const preferredForeground = accentForegroundForColor(accent) as '#000000' | '#ffffff'
  const preferred = preferredForeground === '#ffffff' ? white : black
  const alternate = preferredForeground === '#ffffff' ? black : white
  if (preferred.score >= 4.5) return preferred
  if (alternate.score >= 4.5) return alternate
  return preferred.score >= alternate.score ? preferred : alternate
}

export function accentActionForegroundForColors(accent: string, accent2: string | undefined) {
  return accentActionPlanForColors(accent, accent2).foreground
}

export function accentActionFillToken(
  accent: string = DESIGN_ACCENT_PRESETS[DEFAULT_ACCENT_PRESET_ID].accent,
  accent2: string | undefined = DESIGN_ACCENT_PRESETS[DEFAULT_ACCENT_PRESET_ID].accent2,
) {
  const plan = accentActionPlanForColors(accent, accent2)
  const overlayColor = plan.foreground === '#000000' ? '255,255,255' : '0,0,0'
  const overlayAlpha = formatOverlayAlpha(plan.overlayAlpha)
  return `linear-gradient(rgba(${overlayColor},${overlayAlpha}),rgba(${overlayColor},${overlayAlpha})), var(--accent-gradient)`
}

export function accentActionBackgroundStopsForColors(accent: string, accent2: string | undefined) {
  const plan = accentActionPlanForColors(accent, accent2)
  return [accent, accent2 || accent].map((background) => overlayActionStop(background, plan.foreground, plan.overlayAlpha))
}

export function accentActionContrastForColors(accent: string, accent2: string | undefined) {
  const plan = accentActionPlanForColors(accent, accent2)
  const backgrounds = accentActionBackgroundStopsForColors(accent, accent2)
  const ratios = backgrounds.map((background) => contrastRatio(plan.foreground, background))
  if (ratios.some((ratio) => ratio === null)) return null
  return {
    foreground: plan.foreground,
    backgrounds,
    minContrast: Math.min(...(ratios as number[])),
  }
}

export function accentTextForBackground(accent: string, accent2: string | undefined, background: string) {
  const backgroundLum = cssColorLuminance(background)
  const preferred = backgroundLum !== null && backgroundLum > 0.55
    ? accent
    : (accent2 || accent)
  const preferredContrast = contrastRatio(preferred, background)
  if (preferredContrast !== null && preferredContrast >= 4.5) return preferred

  const target = backgroundLum !== null && backgroundLum > 0.55 ? '#000000' : '#ffffff'
  for (let weight = 0.99; weight >= 0.35; weight -= 0.01) {
    const candidate = mixHexToward(preferred, target, weight)
    const ratio = contrastRatio(candidate, background)
    if (ratio !== null && ratio >= 4.5) return candidate
  }

  return preferred
}

export function designAccentTokens(presetId: DesignAccentPresetId = DEFAULT_ACCENT_PRESET_ID) {
  const preset = DESIGN_ACCENT_PRESETS[presetId]
  return {
    accent: preset.accent,
    accent2: preset.accent2,
    accentHover: preset.accent2,
    accentForeground: accentForegroundForColor(preset.accent),
    accentActionForeground: accentActionForegroundForColors(preset.accent, preset.accent2),
    accentSoft: accentSoftToken(),
    accentLine: accentLineToken(),
  }
}

export function applyDesignAccentTokens<T extends BrandThemeTokens>(
  theme: T,
  presetId: DesignAccentPresetId = DEFAULT_ACCENT_PRESET_ID,
): T & ReturnType<typeof designAccentTokens> {
  return {
    ...theme,
    ...designAccentTokens(presetId),
  }
}

export const DEFAULT_DARK_BRAND_THEME: BrandThemeTokens = {
  base: '#0c0d0f',
  surface: '#141619',
  surfaceHover: '#1a1d21',
  surfaceActive: 'color-mix(in srgb, #2f6bf0 16%, #1a1d21)',
  elevated: '#1f2329',
  border: '#2d3137',
  borderSubtle: '#23262b',
  borderStrong: '#3b4047',
  text: '#eceef1',
  textSecondary: '#9aa1aa',
  textMuted: '#828a94',
  accent: '#2f6bf0',
  accent2: '#5a8cf5',
  accentSoft: accentSoftToken(),
  accentLine: accentLineToken(),
  accentHover: '#5a8cf5',
  green: '#3f9a8f',
  amber: '#e0913a',
  red: '#d6587e',
  info: '#6f8cc4',
  accentForeground: '#ffffff',
  shadowCard: '0 1px 2px rgba(0, 0, 0, 0.42), 0 12px 30px rgba(0, 0, 0, 0.46)',
  shadowElevated: '0 2px 8px rgba(0, 0, 0, 0.5), 0 24px 60px rgba(0, 0, 0, 0.58)',
  bgImage: 'none',
}

export const DEFAULT_LIGHT_BRAND_THEME: BrandThemeTokens = {
  base: '#f3efe7',
  surface: '#fbf8f2',
  surfaceHover: '#f5f1e8',
  surfaceActive: 'color-mix(in srgb, #2f6bf0 10%, #f5f1e8)',
  elevated: '#ffffff',
  border: '#d3cabb',
  borderSubtle: '#e3dccf',
  borderStrong: '#c2b8a6',
  text: '#2a2520',
  textSecondary: '#6a6258',
  textMuted: '#746b61',
  accent: '#2f6bf0',
  accent2: '#5a8cf5',
  accentSoft: accentSoftToken(),
  accentLine: accentLineToken(),
  accentHover: '#5a8cf5',
  green: '#3f9a8f',
  amber: '#e0913a',
  red: '#d6587e',
  info: '#6f8cc4',
  accentForeground: '#ffffff',
  shadowCard: '0 1px 1px rgba(42, 37, 32, 0.08), 0 10px 24px rgba(42, 37, 32, 0.08)',
  shadowElevated: '0 2px 6px rgba(42, 37, 32, 0.10), 0 20px 48px rgba(42, 37, 32, 0.12)',
  bgImage: 'none',
}

export const PUBLIC_BRANDING_THEME_TOKEN_KEYS = [
  'background',
  'surface',
  'mutedSurface',
  'border',
  'text',
  'mutedText',
  'accent',
  'accent2',
  'accentSoft',
  'accentLine',
  'accentStrong',
  'focus',
  'warn',
  'danger',
  'ok',
  'surfaceHover',
  'surfaceActive',
  'borderSubtle',
  'borderStrong',
  'elevated',
  'textSecondary',
  'accentHover',
  'accentForeground',
  'green',
  'amber',
  'red',
  'info',
  'shadowCard',
  'shadowElevated',
  'bgImage',
] as const satisfies readonly (keyof PublicBrandingThemeTokens)[]

function hexRgb(value: string) {
  const match = value.match(/^#([0-9a-f]{6})$/i)
  if (!match) return null
  const hex = match[1] || ''
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ] as const
}

function focusToken(theme: BrandThemeTokens) {
  const rgb = hexRgb(theme.accent)
  if (!rgb) return 'rgba(47, 107, 240, 0.52)'
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.52)`
}

export function brandThemeToPublicBrandingTheme(theme: BrandThemeTokens): PublicBrandingThemeTokens {
  return {
    background: theme.base,
    surface: theme.surface,
    mutedSurface: theme.elevated,
    border: theme.border,
    text: theme.text,
    mutedText: theme.textMuted,
    accent: theme.accent,
    accent2: theme.accent2,
    accentSoft: theme.accentSoft,
    accentLine: theme.accentLine,
    accentStrong: theme.accentHover,
    focus: focusToken(theme),
    warn: theme.amber,
    danger: theme.red,
    ok: theme.green,
    surfaceHover: theme.surfaceHover,
    surfaceActive: theme.surfaceActive,
    borderSubtle: theme.borderSubtle,
    borderStrong: theme.borderStrong || theme.border,
    elevated: theme.elevated,
    textSecondary: theme.textSecondary,
    accentHover: theme.accentHover,
    accentForeground: theme.accentForeground,
    green: theme.green,
    amber: theme.amber,
    red: theme.red,
    info: theme.info,
    shadowCard: theme.shadowCard,
    shadowElevated: theme.shadowElevated,
    bgImage: theme.bgImage,
  }
}

export const DEFAULT_DARK_PUBLIC_BRANDING_THEME = brandThemeToPublicBrandingTheme(DEFAULT_DARK_BRAND_THEME)

export const LEGACY_LIGHT_PUBLIC_BRANDING_THEME: PublicBrandingThemeTokens = {
  background: '#f5f6f3',
  surface: '#ffffff',
  mutedSurface: '#ecefed',
  border: '#d8ddd7',
  borderStrong: '#b9c4bc',
  text: '#18211c',
  mutedText: '#66736b',
  accent: '#2d6b56',
  accentStrong: '#1f503f',
  focus: 'rgba(45, 107, 86, 0.28)',
  warn: '#8a5a14',
  danger: '#9d3630',
  ok: '#1f6b46',
  bgImage: 'none',
  shadowCard: '0 8px 24px rgba(24, 33, 28, 0.08)',
  shadowElevated: '0 16px 40px rgba(24, 33, 28, 0.12)',
}

const CSS_NAMED_COLORS: Record<string, string> = {
  aliceblue: '#f0f8ff',
  antiquewhite: '#faebd7',
  aqua: '#00ffff',
  aquamarine: '#7fffd4',
  azure: '#f0ffff',
  beige: '#f5f5dc',
  bisque: '#ffe4c4',
  black: '#000000',
  blanchedalmond: '#ffebcd',
  blue: '#0000ff',
  blueviolet: '#8a2be2',
  brown: '#a52a2a',
  burlywood: '#deb887',
  cadetblue: '#5f9ea0',
  chartreuse: '#7fff00',
  chocolate: '#d2691e',
  coral: '#ff7f50',
  cornflowerblue: '#6495ed',
  cornsilk: '#fff8dc',
  crimson: '#dc143c',
  cyan: '#00ffff',
  darkblue: '#00008b',
  darkcyan: '#008b8b',
  darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9',
  darkgreen: '#006400',
  darkgrey: '#a9a9a9',
  darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b',
  darkolivegreen: '#556b2f',
  darkorange: '#ff8c00',
  darkorchid: '#9932cc',
  darkred: '#8b0000',
  darksalmon: '#e9967a',
  darkseagreen: '#8fbc8f',
  darkslateblue: '#483d8b',
  darkslategray: '#2f4f4f',
  darkslategrey: '#2f4f4f',
  darkturquoise: '#00ced1',
  darkviolet: '#9400d3',
  deeppink: '#ff1493',
  deepskyblue: '#00bfff',
  dimgray: '#696969',
  dimgrey: '#696969',
  dodgerblue: '#1e90ff',
  firebrick: '#b22222',
  floralwhite: '#fffaf0',
  forestgreen: '#228b22',
  fuchsia: '#ff00ff',
  gainsboro: '#dcdcdc',
  ghostwhite: '#f8f8ff',
  gold: '#ffd700',
  goldenrod: '#daa520',
  gray: '#808080',
  green: '#008000',
  greenyellow: '#adff2f',
  grey: '#808080',
  honeydew: '#f0fff0',
  hotpink: '#ff69b4',
  indianred: '#cd5c5c',
  indigo: '#4b0082',
  ivory: '#fffff0',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  lavenderblush: '#fff0f5',
  lawngreen: '#7cfc00',
  lemonchiffon: '#fffacd',
  lightblue: '#add8e6',
  lightcoral: '#f08080',
  lightcyan: '#e0ffff',
  lightgoldenrodyellow: '#fafad2',
  lightgray: '#d3d3d3',
  lightgreen: '#90ee90',
  lightgrey: '#d3d3d3',
  lightpink: '#ffb6c1',
  lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa',
  lightskyblue: '#87cefa',
  lightslategray: '#778899',
  lightslategrey: '#778899',
  lightsteelblue: '#b0c4de',
  lightyellow: '#ffffe0',
  lime: '#00ff00',
  limegreen: '#32cd32',
  linen: '#faf0e6',
  magenta: '#ff00ff',
  maroon: '#800000',
  mediumaquamarine: '#66cdaa',
  mediumblue: '#0000cd',
  mediumorchid: '#ba55d3',
  mediumpurple: '#9370db',
  mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee',
  mediumspringgreen: '#00fa9a',
  mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585',
  midnightblue: '#191970',
  mintcream: '#f5fffa',
  mistyrose: '#ffe4e1',
  moccasin: '#ffe4b5',
  navajowhite: '#ffdead',
  navy: '#000080',
  oldlace: '#fdf5e6',
  olive: '#808000',
  olivedrab: '#6b8e23',
  orange: '#ffa500',
  orangered: '#ff4500',
  orchid: '#da70d6',
  palegoldenrod: '#eee8aa',
  palegreen: '#98fb98',
  paleturquoise: '#afeeee',
  palevioletred: '#db7093',
  papayawhip: '#ffefd5',
  peachpuff: '#ffdab9',
  peru: '#cd853f',
  pink: '#ffc0cb',
  plum: '#dda0dd',
  powderblue: '#b0e0e6',
  purple: '#800080',
  rebeccapurple: '#663399',
  red: '#ff0000',
  rosybrown: '#bc8f8f',
  royalblue: '#4169e1',
  saddlebrown: '#8b4513',
  salmon: '#fa8072',
  sandybrown: '#f4a460',
  seagreen: '#2e8b57',
  seashell: '#fff5ee',
  sienna: '#a0522d',
  silver: '#c0c0c0',
  skyblue: '#87ceeb',
  slateblue: '#6a5acd',
  slategray: '#708090',
  slategrey: '#708090',
  snow: '#fffafa',
  springgreen: '#00ff7f',
  steelblue: '#4682b4',
  tan: '#d2b48c',
  teal: '#008080',
  thistle: '#d8bfd8',
  tomato: '#ff6347',
  transparent: '#00000000',
  turquoise: '#40e0d0',
  violet: '#ee82ee',
  wheat: '#f5deb3',
  white: '#ffffff',
  whitesmoke: '#f5f5f5',
  yellow: '#ffff00',
  yellowgreen: '#9acd32',
}

function channelLuminance(rawChannel: number) {
  const raw = rawChannel / 255
  return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(red: number, green: number, blue: number) {
  return 0.2126 * channelLuminance(red) + 0.7152 * channelLuminance(green) + 0.0722 * channelLuminance(blue)
}

function clampColorChannel(value: number) {
  return Math.max(0, Math.min(255, value))
}

function parseAlpha(value: string | undefined) {
  if (!value) return 1
  const alpha = value.trim().endsWith('%')
    ? Number.parseFloat(value) / 100
    : Number.parseFloat(value)
  return Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1
}

function parseRgbChannel(value: string) {
  const trimmed = value.trim()
  const channel = trimmed.endsWith('%')
    ? (Number.parseFloat(trimmed) / 100) * 255
    : Number.parseFloat(trimmed)
  return Number.isFinite(channel) ? clampColorChannel(channel) : null
}

function parseHexColor(value: string) {
  const match = value.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
  if (!match) return null
  const hex = match[1]
  if (!hex) return null
  const isShort = hex.length === 3 || hex.length === 4
  const pairs = isShort
    ? hex.split('').map((part) => part + part)
    : hex.match(/[0-9a-f]{2}/gi)
  if (!pairs || pairs.length < 3) return null
  const red = Number.parseInt(pairs[0] || '00', 16)
  const green = Number.parseInt(pairs[1] || '00', 16)
  const blue = Number.parseInt(pairs[2] || '00', 16)
  const alpha = pairs[3] ? Number.parseInt(pairs[3], 16) / 255 : 1
  return { red, green, blue, alpha }
}

function parseRgbColor(value: string) {
  const args = colorFunctionArgs(value, 'rgb')
  if (!args || args.length < 3 || args.length > 4) return null
  const red = parseRgbChannel(args[0] || '')
  const green = parseRgbChannel(args[1] || '')
  const blue = parseRgbChannel(args[2] || '')
  if (red === null || green === null || blue === null) return null
  return { red, green, blue, alpha: parseAlpha(args[3]) }
}

function colorFunctionArgs(value: string, name: string) {
  // Bound the input and use a linear pattern: the previous `\s*([^)]+?)\s*` overlapped the
  // surrounding whitespace with the lazy body, giving catastrophic backtracking on a long run
  // of spaces (operator branding tokens reach this). `[^)]*` then `\)$` is deterministic; trim
  // in code. `name` is always a literal ('rgb'/'hsl'), never user input.
  if (value.length > 256) return null
  const match = value.match(new RegExp(`^${name}a?\\(([^)]*)\\)$`, 'i'))
  if (!match) return null
  const body = (match[1] || '').trim()
  if (body.includes('/')) return null
  return (body.includes(',') ? body.split(',') : body.trim().split(/\s+/))
    .map((part) => part.trim())
    .filter(Boolean)
}

function parseHslHue(value: string) {
  const trimmed = value.trim().toLowerCase()
  const match = trimmed.match(/^([+-]?(?:\d+|\d*\.\d+))(deg|grad|rad|turn)?$/)
  if (!match) return null
  const raw = Number.parseFloat(match[1] || '')
  if (!Number.isFinite(raw)) return null
  const unit = match[2] || 'deg'
  const degrees = unit === 'turn'
    ? raw * 360
    : unit === 'rad'
      ? raw * (180 / Math.PI)
      : unit === 'grad'
        ? raw * 0.9
        : raw
  return ((degrees % 360) + 360) % 360
}

function parsePercentage(value: string) {
  const trimmed = value.trim()
  if (!trimmed.endsWith('%')) return null
  const percentage = Number.parseFloat(trimmed)
  return Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : null
}

function parseHslColor(value: string) {
  const args = colorFunctionArgs(value, 'hsl')
  if (!args || args.length < 3 || args.length > 4) return null
  const hue = parseHslHue(args[0] || '')
  const saturation = parsePercentage(args[1] || '')
  const lightness = parsePercentage(args[2] || '')
  if (hue === null || saturation === null || lightness === null) return null
  const chroma = (1 - Math.abs((2 * lightness) / 100 - 1)) * (saturation / 100)
  const segment = hue / 60
  const x = chroma * (1 - Math.abs((segment % 2) - 1))
  const [redPrime, greenPrime, bluePrime] = segment < 1
    ? [chroma, x, 0]
    : segment < 2
      ? [x, chroma, 0]
      : segment < 3
        ? [0, chroma, x]
        : segment < 4
          ? [0, x, chroma]
          : segment < 5
            ? [x, 0, chroma]
            : [chroma, 0, x]
  const match = lightness / 100 - chroma / 2
  return {
    red: clampColorChannel((redPrime + match) * 255),
    green: clampColorChannel((greenPrime + match) * 255),
    blue: clampColorChannel((bluePrime + match) * 255),
    alpha: parseAlpha(args[3]),
  }
}

function parseNamedColor(value: string) {
  const named = CSS_NAMED_COLORS[value.toLowerCase()]
  return named ? parseHexColor(named) : null
}

export function cssColorLuminance(value: string | undefined) {
  const color = value?.trim()
  if (!color) return null
  const parsed = parseHexColor(color) || parseRgbColor(color) || parseHslColor(color) || parseNamedColor(color)
  if (!parsed) return null
  const alpha = parsed.alpha
  const red = clampColorChannel(parsed.red * alpha)
  const green = clampColorChannel(parsed.green * alpha)
  const blue = clampColorChannel(parsed.blue * alpha)
  return relativeLuminance(red, green, blue)
}

export function isPublicBrandingColorToken(value: string | undefined) {
  return cssColorLuminance(value) !== null
}

export function isLegacyLightPublicBrandingTheme(theme: PublicBrandingThemeTokens): boolean {
  return [theme.background, theme.surface, theme.mutedSurface]
    .some((value) => {
      const luminance = cssColorLuminance(value)
      return luminance !== null && luminance > 0.55
    })
}

export function derivePublicBrandingThemeTokens(theme: PublicBrandingThemeTokens): PublicBrandingThemeTokens {
  const derived: PublicBrandingThemeTokens = { ...theme }
  const token = (value: string | undefined) => typeof value === 'string' && value.trim() ? value : undefined
  const assign = (key: keyof PublicBrandingThemeTokens, value: string | undefined) => {
    if (token(derived[key])) return
    const next = token(value)
    if (next) derived[key] = next
  }
  const hasLegacyLightSurface = isLegacyLightPublicBrandingTheme(theme)

  if (hasLegacyLightSurface) {
    assign('background', LEGACY_LIGHT_PUBLIC_BRANDING_THEME.background)
    assign('surface', LEGACY_LIGHT_PUBLIC_BRANDING_THEME.surface)
    assign('mutedSurface', LEGACY_LIGHT_PUBLIC_BRANDING_THEME.mutedSurface)
    assign('border', LEGACY_LIGHT_PUBLIC_BRANDING_THEME.border)
    assign('text', LEGACY_LIGHT_PUBLIC_BRANDING_THEME.text)
    assign('mutedText', LEGACY_LIGHT_PUBLIC_BRANDING_THEME.mutedText)
    assign('accent', LEGACY_LIGHT_PUBLIC_BRANDING_THEME.accent)
    assign('accentStrong', LEGACY_LIGHT_PUBLIC_BRANDING_THEME.accentStrong)
    assign('focus', LEGACY_LIGHT_PUBLIC_BRANDING_THEME.focus)
    assign('warn', LEGACY_LIGHT_PUBLIC_BRANDING_THEME.warn)
    assign('danger', LEGACY_LIGHT_PUBLIC_BRANDING_THEME.danger)
    assign('ok', LEGACY_LIGHT_PUBLIC_BRANDING_THEME.ok)
    assign('bgImage', LEGACY_LIGHT_PUBLIC_BRANDING_THEME.bgImage)
    assign('shadowCard', LEGACY_LIGHT_PUBLIC_BRANDING_THEME.shadowCard)
    assign('shadowElevated', LEGACY_LIGHT_PUBLIC_BRANDING_THEME.shadowElevated)
  }

  assign('elevated', derived.surface || derived.mutedSurface)
  assign('surfaceHover', derived.mutedSurface || derived.surface)
  assign('surfaceActive', derived.mutedSurface || derived.surface)
  assign('borderSubtle', derived.border)
  assign('borderStrong', derived.border)
  assign('textSecondary', derived.mutedText)
  assign('accent2', derived.accentStrong || derived.accentHover || derived.accent)
  assign('accentSoft', token(derived.accent) ? accentSoftToken() : undefined)
  assign('accentLine', token(derived.accent) ? accentLineToken() : undefined)
  assign('accentHover', derived.accentStrong || derived.accent)
  assign('accentForeground', token(derived.accent) ? accentForegroundForColor(derived.accent as string) : undefined)
  assign('green', derived.ok)
  assign('amber', derived.warn)
  assign('red', derived.danger)

  return derived
}

export const DESIGN_TOKENS = {
  color: DEFAULT_DARK_BRAND_THEME,
  fontFamily: {
    ui: "'Mona Sans Variable', 'Mona Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    display: "'Schibsted Grotesk Variable', 'Schibsted Grotesk', var(--font-ui)",
    editorial: "'Iowan Old Style', 'New York', Georgia, serif",
    mono: "'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', monospace",
  },
  text: {
    '2xs': '11px',
    xs: '12px',
    sm: '13px',
    md: '14px',
    lg: '16px',
    xl: '19px',
    '2xl': '24px',
    '3xl': '30px',
    hero: '38px',
  },
  lineHeight: {
    '2xs': '14px',
    xs: '16px',
    sm: '18px',
    md: '21px',
    lg: '24px',
    xl: '26px',
    '2xl': '30px',
    '3xl': '36px',
    hero: '42px',
  },
  space: {
    1: '4px',
    2: '8px',
    3: '12px',
    4: '16px',
    5: '20px',
    6: '24px',
    7: '28px',
    8: '32px',
    9: '36px',
    10: '40px',
    12: '48px',
  },
  tracking: {
    tight: '-0.01em',
    display: '-0.02em',
  },
  radius: {
    xs: '6px',
    sm: '8px',
    md: '10px',
    lg: '14px',
    xl: '18px',
    '2xl': '20px',
    '3xl': '28px',
    full: '9999px',
  },
  shadow: {
    1: '0 1px 2px rgba(0,0,0,.42), 0 2px 6px rgba(0,0,0,.28)',
    card: DEFAULT_DARK_BRAND_THEME.shadowCard,
    elevated: DEFAULT_DARK_BRAND_THEME.shadowElevated,
  },
  elevation: {
    popover: 'var(--shadow-3)',
  },
  specular: {
    default: 'inset 0 1px 0 color-mix(in srgb, #fff 7%, transparent)',
    strong: 'inset 0 1px 0 color-mix(in srgb, #fff 11%, transparent)',
  },
  glass: {
    bg: 'color-mix(in srgb, var(--color-elevated) 72%, transparent)',
    blur: 'blur(22px) saturate(1.5)',
    border: 'color-mix(in srgb, var(--color-accent) 24%, transparent)',
  },
  glow: {
    accent: '0 0 0 1px color-mix(in srgb, var(--color-accent) 50%, transparent), 0 0 18px color-mix(in srgb, var(--color-accent) 32%, transparent)',
    soft: '0 0 24px color-mix(in srgb, var(--color-accent) 22%, transparent)',
  },
  ring: {
    focus: '0 0 0 2px color-mix(in srgb, var(--color-accent) 60%, transparent), 0 0 16px color-mix(in srgb, var(--color-accent) 30%, transparent)',
    selected: 'inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 70%, transparent)',
  },
  ease: {
    out: 'cubic-bezier(0.2, 0, 0, 1)',
    emphasized: 'cubic-bezier(0.3, 0, 0, 1)',
    spring: 'cubic-bezier(0.16, 1, 0.3, 1)',
  },
  duration: {
    1: '120ms',
    2: '180ms',
    3: '240ms',
    4: '420ms',
  },
  z: {
    sticky: '10',
    dropdown: '40',
    overlay: '50',
    modal: '60',
    toast: '70',
    command: '80',
    tooltip: '90',
  },
  controlHeight: {
    sm: '28px',
    md: '32px',
    lg: '40px',
    xl: '48px',
  },
  studio: {
    shellSidebarW: '268px',
    shellRailW: '72px',
    topbarH: '64px',
    inspectorW: '360px',
    composerMinH: '148px',
    taskLaneW: '320px',
  },
  density: {
    compactGap: '13px',
    compactPad: '7px',
    regularGap: '18px',
    regularPad: '10px',
    comfyGap: '24px',
    comfyPad: '14px',
  },
  coworker: {
    lead: 'var(--color-accent)',
    strategist: 'var(--color-info)',
    builder: 'var(--color-green)',
    reviewer: 'var(--color-amber)',
    operator: 'var(--color-red)',
    neutral: 'var(--color-text-secondary)',
  },
  lane: {
    planning: 'var(--color-accent)',
    delegated: 'var(--color-info)',
    review: 'var(--color-amber)',
    approval: 'var(--color-red)',
    artifact: 'var(--color-green)',
  },
  review: {
    proposed: 'var(--color-info)',
    accepted: 'var(--color-green)',
    blocked: 'var(--color-red)',
  },
  iconSize: {
    sm: '16px',
    md: '20px',
    lg: '24px',
  },
  borderWidth: {
    1: '1px',
  },
  primitive: {
    tooltipMaxW: 'calc((var(--space-12) * 5) + var(--space-5))',
    popoverMaxH: 'calc((var(--space-12) * 6) + var(--space-8))',
    dialogMaxH: 'calc(var(--space-12) * 15)',
    dialogWSm: 'calc((var(--space-10) * 10) + var(--space-5))',
    dialogWMd: 'calc((var(--space-12) * 11) + var(--space-8))',
    dialogWLg: 'calc((var(--space-12) * 15) + var(--space-10))',
  },
  measure: {
    default: '840px',
    wide: '1200px',
  },
} as const

export const DESIGN_DENSITY_IDS = ['compact', 'regular', 'comfy'] as const
export type DesignDensityId = typeof DESIGN_DENSITY_IDS[number]

const DENSITY_TOKEN_NAMES = {
  compact: { gap: 'compactGap', pad: 'compactPad' },
  regular: { gap: 'regularGap', pad: 'regularPad' },
  comfy: { gap: 'comfyGap', pad: 'comfyPad' },
} as const satisfies Record<DesignDensityId, {
  gap: keyof typeof DESIGN_TOKENS.density
  pad: keyof typeof DESIGN_TOKENS.density
}>

function tokenEntries(tokens = DESIGN_TOKENS): Array<[string, string]> {
  return [
    ['--color-base', tokens.color.base],
    ['--color-surface', tokens.color.surface],
    ['--color-surface-hover', tokens.color.surfaceHover],
    ['--color-surface-active', tokens.color.surfaceActive],
    ['--color-elevated', tokens.color.elevated],
    ['--color-border', tokens.color.border],
    ['--color-border-subtle', tokens.color.borderSubtle],
    ['--color-border-strong', tokens.color.borderStrong || tokens.color.border],
    ['--color-text', tokens.color.text],
    ['--color-text-secondary', tokens.color.textSecondary],
    ['--color-text-muted', tokens.color.textMuted],
    ['--color-accent', tokens.color.accent],
    ['--color-accent-2', tokens.color.accent2 || tokens.color.accentHover],
    ['--color-accent-hover', tokens.color.accentHover],
    ['--color-green', tokens.color.green],
    ['--color-amber', tokens.color.amber],
    ['--color-red', tokens.color.red],
    ['--color-info', tokens.color.info],
    ['--color-accent-foreground', tokens.color.accentForeground],
    ['--font-ui', tokens.fontFamily.ui],
    ['--font-display', tokens.fontFamily.display],
    ['--font-editorial', tokens.fontFamily.editorial],
    ['--font-mono', tokens.fontFamily.mono],
    ...Object.entries(tokens.text).map(([name, value]) => [`--text-${name}`, value] as [string, string]),
    ...Object.entries(tokens.lineHeight).map(([name, value]) => [`--lh-${name}`, value] as [string, string]),
    ...Object.entries(tokens.space).map(([name, value]) => [`--space-${name}`, value] as [string, string]),
    ...Object.entries(tokens.tracking).map(([name, value]) => [`--tracking-${name}`, value] as [string, string]),
    ...Object.entries(tokens.radius).map(([name, value]) => [`--radius-${name}`, value] as [string, string]),
    ['--shadow-1', tokens.shadow[1]],
    ['--shadow-2', 'var(--shadow-card)'],
    ['--shadow-3', 'var(--shadow-elevated)'],
    ['--shadow-card', tokens.shadow.card],
    ['--shadow-elevated', tokens.shadow.elevated],
    ['--bg-image', tokens.color.bgImage],
    ['--accent', tokens.color.accent],
    ['--accent-2', tokens.color.accent2 || tokens.color.accentHover],
    ['--accent-text', accentTextForBackground(tokens.color.accent, tokens.color.accent2 || tokens.color.accentHover, tokens.color.base)],
    ['--accent-action-foreground', accentActionForegroundForColors(tokens.color.accent, tokens.color.accent2 || tokens.color.accentHover)],
    ['--accent-action-fill', accentActionFillToken(tokens.color.accent, tokens.color.accent2 || tokens.color.accentHover)],
    ['--accent-soft', tokens.color.accentSoft || accentSoftToken()],
    ['--accent-line', tokens.color.accentLine || accentLineToken()],
    ['--accent-gradient', 'linear-gradient(150deg,var(--accent-2),var(--accent))'],
    ['--elevation-popover', tokens.elevation.popover],
    ['--specular', tokens.specular.default],
    ['--specular-strong', tokens.specular.strong],
    ['--glass-bg', tokens.glass.bg],
    ['--glass-blur', tokens.glass.blur],
    ['--glass-border', tokens.glass.border],
    ['--glow-accent', tokens.glow.accent],
    ['--glow-soft', tokens.glow.soft],
    ['--ring-focus', tokens.ring.focus],
    ['--ring-selected', tokens.ring.selected],
    ...Object.entries(tokens.ease).map(([name, value]) => [`--ease-${name}`, value] as [string, string]),
    ...Object.entries(tokens.duration).map(([name, value]) => [`--dur-${name}`, value] as [string, string]),
    ...Object.entries(tokens.z).map(([name, value]) => [`--z-${name}`, value] as [string, string]),
    ...Object.entries(tokens.controlHeight).map(([name, value]) => [`--control-h-${name}`, value] as [string, string]),
    ...Object.entries(tokens.studio).map(([name, value]) => [`--studio-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value] as [string, string]),
    ...Object.entries(tokens.density).map(([name, value]) => [`--density-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value] as [string, string]),
    ['--row-pad', tokens.density.regularPad],
    ['--gap', tokens.density.regularGap],
    ...Object.entries(tokens.coworker).map(([name, value]) => [`--coworker-${name}`, value] as [string, string]),
    ...Object.entries(tokens.lane).map(([name, value]) => [`--lane-${name}`, value] as [string, string]),
    ...Object.entries(tokens.review).map(([name, value]) => [`--review-${name}`, value] as [string, string]),
    ...Object.entries(tokens.borderWidth).map(([name, value]) => [`--border-width-${name}`, value] as [string, string]),
    ...Object.entries(tokens.iconSize).map(([name, value]) => [`--icon-size-${name}`, value] as [string, string]),
    ['--primitive-tooltip-max-w', tokens.primitive.tooltipMaxW],
    ['--primitive-popover-max-h', tokens.primitive.popoverMaxH],
    ['--primitive-dialog-max-h', tokens.primitive.dialogMaxH],
    ['--primitive-dialog-w-sm', tokens.primitive.dialogWSm],
    ['--primitive-dialog-w-md', tokens.primitive.dialogWMd],
    ['--primitive-dialog-w-lg', tokens.primitive.dialogWLg],
    ['--measure', tokens.measure.default],
    ['--measure-wide', tokens.measure.wide],
  ]
}

function densitySelectorEntries(tokens = DESIGN_TOKENS): string[] {
  return DESIGN_DENSITY_IDS.flatMap((density) => {
    const names = DENSITY_TOKEN_NAMES[density]
    return [
      `:root[data-density="${density}"] {`,
      `  --row-pad: ${tokens.density[names.pad]};`,
      `  --gap: ${tokens.density[names.gap]};`,
      '}',
    ]
  })
}

export function emitRootTokensCss(tokens = DESIGN_TOKENS): string {
  return [
    ':root {',
    ...tokenEntries(tokens).map(([name, value]) => `  ${name}: ${value};`),
    '}',
    ...densitySelectorEntries(tokens),
  ].join('\n')
}
