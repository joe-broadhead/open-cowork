import type { AgentColor } from '@open-cowork/shared'
import { agentInitials, agentChroma } from './agent-builder-utils'

type AgentAvatarProps = {
  name: string
  color?: AgentColor | string | null
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
  // Optional data URI (or remote URL). When present the image renders on
  // top of the gradient tile so the color halo still frames it. Falls
  // back to initials when missing or when the image fails to load.
  src?: string | null
}

// Size-spec lookup instead of arbitrary numbers so the font / border /
// radius all scale together.
const SIZE_CLASSES: Record<NonNullable<AgentAvatarProps['size']>, string> = {
  sm: 'w-8 h-8 text-2xs rounded-lg',
  md: 'w-10 h-10 text-sm rounded-xl',
  lg: 'w-14 h-14 text-lg rounded-[14px]',
  xl: 'w-20 h-20 text-2xl rounded-2xl',
}

// Gradient-initial avatar shared across the builder, the list grid, and
// anywhere else an agent is rendered. Deterministic from name + color so
// the same agent looks identical everywhere it appears.
//
// The gradient uses the agent's color token (mapped through agentTone) —
// light tint top-left, deeper tint bottom-right — so a neutral agent is
// faintly blue, a success agent is faintly green, etc. No randomness.
//
// When `src` is supplied the image fills the tile while the gradient
// background remains as a subtle halo framing it — keeps the agent's
// color identity even when a custom avatar is set.
export function AgentAvatar({ name, color = 'accent', size = 'md', className = '', src }: AgentAvatarProps) {
  // Identity colour lives here and only here. An opaque, graphite-darkened
  // same-hue tile (deep at the bottom so saturated hues never go loud) with a
  // crafted top specular — a confident chip that sits ON the field, not a
  // pastel wash floating over it. Initials are ink, never the hue.
  const chroma = agentChroma(color)
  return (
    <div
      className={`${SIZE_CLASSES[size]} relative flex items-center justify-center font-semibold shrink-0 select-none border overflow-hidden transition-[border-color] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] ${className}`}
      style={{
        color: 'var(--color-text)',
        background: `linear-gradient(140deg, color-mix(in srgb, ${chroma} 90%, var(--color-base)) 0%, color-mix(in srgb, ${chroma} 62%, var(--color-base)) 100%)`,
        borderColor: `color-mix(in srgb, ${chroma} 45%, transparent)`,
        boxShadow: 'inset 0 1px 0 0 color-mix(in srgb, #fff 14%, transparent)',
      }}
      aria-label={`${name} avatar`}
    >
      {src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          className="absolute inset-0 w-full h-full object-cover"
          style={{ boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-base) 55%, transparent)' }}
        />
      ) : (
        <span className="font-[640] tracking-[-0.01em]" style={{ textShadow: '0 1px 1px rgba(12,13,15,0.45)' }}>
          {agentInitials(name)}
        </span>
      )}
    </div>
  )
}
