import type { BrandThemeTokens, PublicBrandingThemeTokens } from './app-config.js'

export const DEFAULT_DARK_BRAND_THEME: BrandThemeTokens = {
  base: '#1b1b26',
  surface: 'rgba(141, 164, 245, 0.04)',
  surfaceHover: 'rgba(141, 164, 245, 0.08)',
  surfaceActive: 'rgba(141, 164, 245, 0.15)',
  elevated: '#23232f',
  border: 'rgba(180, 194, 250, 0.07)',
  borderSubtle: 'rgba(180, 194, 250, 0.035)',
  text: '#e8e9f3',
  textSecondary: '#b0b3c6',
  textMuted: '#8a8da0',
  accent: '#8da4f5',
  accentHover: '#a7b6f8',
  green: '#7fcfa0',
  amber: '#fcb07a',
  red: '#fc92b4',
  info: '#82cadc',
  accentForeground: '#0f0f18',
  shadowCard: '0 1px 2px rgba(0, 0, 0, 0.22), 0 10px 28px rgba(0, 0, 0, 0.18)',
  shadowElevated: '0 2px 6px rgba(0, 0, 0, 0.28), 0 22px 56px rgba(0, 0, 0, 0.24)',
  bgImage: 'radial-gradient(120% 80% at 50% -10%, rgba(141, 164, 245, 0.08), transparent 55%)',
}

export const PUBLIC_BRANDING_THEME_TOKEN_KEYS = [
  'background',
  'surface',
  'mutedSurface',
  'border',
  'text',
  'mutedText',
  'accent',
  'accentStrong',
  'focus',
  'warn',
  'danger',
  'ok',
  'surfaceHover',
  'surfaceActive',
  'borderSubtle',
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

export function brandThemeToPublicBrandingTheme(theme: BrandThemeTokens): PublicBrandingThemeTokens {
  return {
    background: theme.base,
    surface: theme.surface,
    mutedSurface: theme.elevated,
    border: theme.border,
    text: theme.text,
    mutedText: theme.textMuted,
    accent: theme.accent,
    accentStrong: theme.accentHover,
    focus: 'rgba(141, 164, 245, 0.55)',
    warn: theme.amber,
    danger: theme.red,
    ok: theme.green,
    surfaceHover: theme.surfaceHover,
    surfaceActive: theme.surfaceActive,
    borderSubtle: theme.borderSubtle,
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
  const match = value.match(new RegExp(`^${name}a?\\(\\s*([^)]+?)\\s*\\)$`, 'i'))
  if (!match) return null
  const body = match[1] || ''
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
  assign('textSecondary', derived.mutedText)
  assign('accentHover', derived.accentStrong || derived.accent)
  assign('accentForeground', token(derived.accent) ? '#fff' : undefined)
  assign('green', derived.ok)
  assign('amber', derived.warn)
  assign('red', derived.danger)

  return derived
}

export const DESIGN_TOKENS = {
  color: DEFAULT_DARK_BRAND_THEME,
  fontFamily: {
    ui: "'Mona Sans Variable', 'Mona Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    display: "'Hubot Sans Variable', 'Hubot Sans', var(--font-ui)",
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
    8: '32px',
    10: '40px',
    12: '48px',
  },
  radius: {
    xs: '6px',
    sm: '8px',
    md: '10px',
    lg: '14px',
    xl: '18px',
    full: '9999px',
  },
  shadow: {
    card: DEFAULT_DARK_BRAND_THEME.shadowCard,
    elevated: DEFAULT_DARK_BRAND_THEME.shadowElevated,
  },
  ease: {
    out: 'cubic-bezier(0.2, 0, 0, 1)',
    emphasized: 'cubic-bezier(0.3, 0, 0, 1)',
  },
  duration: {
    1: '120ms',
    2: '180ms',
    3: '240ms',
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
  iconSize: {
    sm: '16px',
    md: '20px',
    lg: '24px',
  },
  borderWidth: {
    1: '1px',
  },
} as const

function tokenEntries(tokens = DESIGN_TOKENS): Array<[string, string]> {
  return [
    ['--color-base', tokens.color.base],
    ['--color-surface', tokens.color.surface],
    ['--color-surface-hover', tokens.color.surfaceHover],
    ['--color-surface-active', tokens.color.surfaceActive],
    ['--color-elevated', tokens.color.elevated],
    ['--color-border', tokens.color.border],
    ['--color-border-subtle', tokens.color.borderSubtle],
    ['--color-text', tokens.color.text],
    ['--color-text-secondary', tokens.color.textSecondary],
    ['--color-text-muted', tokens.color.textMuted],
    ['--color-accent', tokens.color.accent],
    ['--color-accent-hover', tokens.color.accentHover],
    ['--color-green', tokens.color.green],
    ['--color-amber', tokens.color.amber],
    ['--color-red', tokens.color.red],
    ['--color-info', tokens.color.info],
    ['--color-accent-foreground', tokens.color.accentForeground],
    ['--font-ui', tokens.fontFamily.ui],
    ['--font-display', tokens.fontFamily.display],
    ['--font-mono', tokens.fontFamily.mono],
    ...Object.entries(tokens.text).map(([name, value]) => [`--text-${name}`, value] as [string, string]),
    ...Object.entries(tokens.lineHeight).map(([name, value]) => [`--lh-${name}`, value] as [string, string]),
    ...Object.entries(tokens.space).map(([name, value]) => [`--space-${name}`, value] as [string, string]),
    ...Object.entries(tokens.radius).map(([name, value]) => [`--radius-${name}`, value] as [string, string]),
    ['--shadow-card', tokens.shadow.card],
    ['--shadow-elevated', tokens.shadow.elevated],
    ['--bg-image', tokens.color.bgImage],
    ...Object.entries(tokens.ease).map(([name, value]) => [`--ease-${name}`, value] as [string, string]),
    ...Object.entries(tokens.duration).map(([name, value]) => [`--dur-${name}`, value] as [string, string]),
    ...Object.entries(tokens.z).map(([name, value]) => [`--z-${name}`, value] as [string, string]),
    ...Object.entries(tokens.controlHeight).map(([name, value]) => [`--control-h-${name}`, value] as [string, string]),
    ...Object.entries(tokens.borderWidth).map(([name, value]) => [`--border-width-${name}`, value] as [string, string]),
    ...Object.entries(tokens.iconSize).map(([name, value]) => [`--icon-size-${name}`, value] as [string, string]),
  ]
}

export function emitRootTokensCss(tokens = DESIGN_TOKENS): string {
  return [
    ':root {',
    ...tokenEntries(tokens).map(([name, value]) => `  ${name}: ${value};`),
    '}',
  ].join('\n')
}
