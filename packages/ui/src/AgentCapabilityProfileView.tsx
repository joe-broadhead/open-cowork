import type { ComponentPropsWithoutRef } from 'react'
import type { AgentCapabilityProfile } from '@open-cowork/shared'
import { cn } from './utils.js'

export type AgentCapabilityProfileViewProps = ComponentPropsWithoutRef<'section'> & {
  profile: AgentCapabilityProfile
  compact?: boolean
}

function radarPoint(index: number, radius: number, centerX = 96, centerY = 76) {
  const angle = (-90 + index * 72) * (Math.PI / 180)
  return {
    x: centerX + Math.cos(angle) * radius,
    y: centerY + Math.sin(angle) * radius,
  }
}

function formatPoints(points: Array<{ x: number; y: number }>) {
  return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
}

export function AgentCapabilityProfileView({
  profile,
  compact = false,
  className,
  ...props
}: AgentCapabilityProfileViewProps) {
  const radius = compact ? 44 : 52
  const centerX = 96
  const centerY = 76
  const shapePoints = profile.axes.map((axis, index) => (
    radarPoint(index, radius * Math.max(0, Math.min(1, axis.value / 5)), centerX, centerY)
  ))

  return (
    <section
      {...props}
      className={cn('agent-capability-profile', compact && 'agent-capability-profile--compact', className)}
      aria-label={`Agent capability profile: ${profile.score} out of 100, ${profile.label}`}
    >
      <div className="agent-capability-profile__header">
        <div>
          <div className="agent-capability-profile__eyebrow">Capability profile</div>
          <div className="agent-capability-profile__label">{profile.label}</div>
        </div>
        <div className="agent-capability-profile__score" aria-label={`${profile.score} out of 100`}>
          <span>{profile.score}</span>
          <small>/100</small>
        </div>
      </div>
      <svg
        className="agent-capability-profile__radar"
        viewBox="0 0 192 152"
        role="img"
        aria-label={profile.axes.map((axis) => `${axis.label} ${axis.value.toFixed(1)} of 5`).join(', ')}
      >
        {[0.25, 0.5, 0.75, 1].map((factor) => (
          <polygon
            key={factor}
            className="agent-capability-profile__ring"
            points={formatPoints(profile.axes.map((_, index) => radarPoint(index, radius * factor, centerX, centerY)))}
          />
        ))}
        {profile.axes.map((axis, index) => {
          const point = radarPoint(index, radius, centerX, centerY)
          const label = radarPoint(index, radius + 16, centerX, centerY)
          const anchor = Math.abs(label.x - centerX) < 4 ? 'middle' : label.x < centerX ? 'end' : 'start'
          return (
            <g key={axis.id}>
              <line className="agent-capability-profile__axis" x1={centerX} y1={centerY} x2={point.x} y2={point.y} />
              <text
                className="agent-capability-profile__axis-label"
                x={label.x}
                y={label.y}
                textAnchor={anchor}
                dominantBaseline="middle"
              >
                {axis.label}
              </text>
            </g>
          )
        })}
        <polygon className="agent-capability-profile__shape" points={formatPoints(shapePoints)} />
        {shapePoints.map((point, index) => (
          <circle key={profile.axes[index]!.id} className="agent-capability-profile__dot" cx={point.x} cy={point.y} r="2.4" />
        ))}
      </svg>
      <div className="agent-capability-profile__legend">
        {profile.axes.map((axis) => (
          <div key={axis.id} className="agent-capability-profile__legend-row" title={axis.description}>
            <span>{axis.label}</span>
            <span aria-hidden="true" className="agent-capability-profile__meter">
              <i style={{ width: `${Math.max(0, Math.min(100, (axis.value / 5) * 100))}%` }} />
            </span>
            <span>{axis.raw}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
