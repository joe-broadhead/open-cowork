import type { CSSProperties } from 'react'

export type BrandMarkSize = 'sm' | 'md' | 'lg'

interface BrandMarkProps {
  /** Brand display name. Rendered beside/under the glyph when `showName` is set. */
  name?: string
  /** Glyph footprint. sm = setup header, md = login, lg = loading splash. */
  size?: BrandMarkSize
  /** Render the brand name. Defaults to false (glyph only). */
  showName?: boolean
  /** Render the name as an <h1> heading instead of a plain label. */
  headingName?: boolean
  /** Add the soft accent glow used on the loading splash. */
  glow?: boolean
  className?: string
}

const glyphSize: Record<BrandMarkSize, { box: string; rounded: string; glyph: string }> = {
  sm: { box: 'h-12 w-12', rounded: 'rounded-2xl', glyph: 'text-lg' },
  md: { box: 'h-16 w-16', rounded: 'rounded-2xl', glyph: 'text-2xl' },
  lg: { box: 'h-[72px] w-[72px]', rounded: 'rounded-[22px]', glyph: 'text-3xl' },
}

const nameSize: Record<BrandMarkSize, string> = {
  sm: 'text-lg',
  md: 'text-xl',
  lg: 'text-lg',
}

// Tinted surface + glow only kick in for the loading splash so the
// login/setup glyphs keep their flat graphite look.
const glowGlyphStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--color-elevated) 88%, var(--color-accent) 12%)',
  borderColor: 'color-mix(in srgb, var(--color-accent) 18%, var(--color-border))',
}

const glowRingStyle: CSSProperties = {
  boxShadow:
    '0 0 0 1px color-mix(in srgb, var(--color-accent) 16%, transparent), 0 0 26px color-mix(in srgb, var(--color-accent) 16%, transparent)',
}

/**
 * The shared Open Cowork brand lockup: the accent "O" glyph plus an
 * optional wordmark. Centralizes the glyph that was previously duplicated
 * inline across the login, setup, and loading screens so the three stay in
 * visual lockstep. Token colours only — never raw palette values.
 */
export function BrandMark({
  name,
  size = 'md',
  showName = false,
  headingName = false,
  glow = false,
  className,
}: BrandMarkProps) {
  const sizing = glyphSize[size]
  const glyph = (
    <div
      className={`relative flex items-center justify-center border ${sizing.box} ${sizing.rounded} ${glow ? '' : 'border-border bg-surface'}`}
      style={glow ? glowGlyphStyle : undefined}
    >
      <span className={`font-semibold text-accent ${sizing.glyph}`} aria-hidden="true">O</span>
      {glow ? (
        <span className={`absolute inset-0 animate-pulse ${sizing.rounded}`} style={glowRingStyle} />
      ) : null}
    </div>
  )

  if (!showName) {
    return <div className={className}>{glyph}</div>
  }

  return (
    <div className={`flex flex-col items-center gap-3 ${className || ''}`.trim()}>
      {glyph}
      {headingName ? (
        <h1 className={`font-semibold text-text ${nameSize[size]}`}>{name}</h1>
      ) : (
        <div className={`font-semibold text-text ${nameSize[size]}`}>{name}</div>
      )}
    </div>
  )
}
