// Tiny hand-drawn attribute + type icons for the agent cards. Kept in
// one module so the visual set stays consistent (same stroke weight,
// same optical size, same corner radii). Matches PluginIcon's inline
// SVG convention — no external icon dependency.

type IconProps = {
  size?: number
  className?: string
}

const STROKE = 1.4

function iconProps({ size = 14, className = '' }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: STROKE,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  }
}

// Breadth — stacked layers (skills compose on top of each other).
export function BreadthIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M8 2l5.5 2.5L8 7 2.5 4.5z" />
      <path d="M2.5 8 8 10.5 13.5 8" />
      <path d="M2.5 11.5 8 14l5.5-2.5" />
    </svg>
  )
}

// Range — target / concentric rings (how far the agent reaches across
// tools).
export function RangeIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="3" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" />
    </svg>
  )
}

// Autonomy — compass / direction arrow (how far the agent can go on
// its own before returning).
export function AutonomyIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M11 5 L6 8 8 11 11 5 z" fill="currentColor" stroke="none" />
    </svg>
  )
}

// Type-chip glyphs — small and uniform, paired with the type label
// pill on the selection card.
export function CustomIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 11L11 4l1.5 1.5L5.5 12.5z" />
      <path d="M3.5 12.5 5 14" />
    </svg>
  )
}

export function BuiltinIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.5 8.5 7 10l3.5-4" />
    </svg>
  )
}

export function RuntimeIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.5v3.5l2.5 1.5" />
    </svg>
  )
}
