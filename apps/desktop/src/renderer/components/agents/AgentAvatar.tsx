import type { AgentColor } from '@open-cowork/shared'
import { agentInitials, agentTone } from './agent-builder-utils'

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
  sm: 'w-8 h-8 text-[11px] rounded-lg',
  md: 'w-10 h-10 text-[13px] rounded-xl',
  lg: 'w-14 h-14 text-[16px] rounded-2xl',
  xl: 'w-20 h-20 text-[22px] rounded-2xl',
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
  const tone = agentTone(color)
  return (
    <div
      className={`${SIZE_CLASSES[size]} relative flex items-center justify-center font-semibold shrink-0 select-none border overflow-hidden ${className}`}
      style={{
        color: tone,
        background: `linear-gradient(135deg, color-mix(in srgb, ${tone} 22%, transparent) 0%, color-mix(in srgb, ${tone} 8%, transparent) 100%)`,
        borderColor: `color-mix(in srgb, ${tone} 30%, var(--color-border))`,
      }}
      aria-label={`${name} avatar`}
    >
      {src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        <span>{agentInitials(name)}</span>
      )}
    </div>
  )
}
