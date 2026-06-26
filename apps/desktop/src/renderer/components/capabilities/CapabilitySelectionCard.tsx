import type { ReactElement, ReactNode } from 'react'
import type { CapabilitySkill, CapabilityTool } from '@open-cowork/shared'
import { PluginIcon } from '../plugins/PluginIcon'
import {
  BreadthIcon,
  BuiltinIcon,
  CustomIcon,
  RuntimeIcon,
} from '../agents/agent-attribute-icons'
import { Badge, Button, type BadgeTone } from '../ui'
import type { CapabilityLinkedTool } from './capabilities-page-support.ts'

// Maps the legacy `var(--color-*)` tone strings carried on chips to the
// canonical Badge tones so every pill shares the shared pill material.
function badgeToneForCssTone(tone: string | undefined): BadgeTone {
  if (!tone) return 'neutral'
  if (tone.includes('accent')) return 'accent'
  if (tone.includes('amber')) return 'warning'
  if (tone.includes('info')) return 'info'
  if (tone.includes('green')) return 'success'
  if (tone.includes('red')) return 'danger'
  if (tone.includes('text-muted')) return 'muted'
  return 'neutral'
}

// Mirrors AgentSelectionCard's visual language so Tools and Skills feel
// like siblings to the agent cards in the list grid: top accent strip,
// tinted halo behind the glyph, type chip with a small icon, stat chip
// row, and a hover ring + lift.

type ToneKey = 'builtin' | 'mcp' | 'custom' | 'skill-builtin' | 'skill-custom'

function toneForKey(key: ToneKey): string {
  switch (key) {
    case 'builtin': return 'var(--color-text-secondary)'
    case 'mcp': return 'var(--color-accent)'
    case 'custom': return 'var(--color-amber)'
    case 'skill-builtin': return 'var(--color-accent)'
    case 'skill-custom': return 'var(--color-amber)'
  }
}

type CardShellProps = {
  toneKey: ToneKey
  typeChips: Array<{ label: string; tone?: string; Icon?: (props: { size?: number }) => ReactElement }>
  glyph: ReactNode
  title: string
  description: string
  stats: Array<{ label: string; value: string; tone?: string }>
  bodyExtra?: ReactNode
  footer?: ReactNode
  onOpen: () => void
}

function CapabilityCardShell({
  toneKey,
  typeChips,
  glyph,
  title,
  description,
  stats,
  bodyExtra,
  footer,
  onOpen,
}: CardShellProps) {
  const tone = toneForKey(toneKey)
  return (
    <div
      className="group card-hover relative rounded-2xl border bg-surface flex flex-col overflow-hidden transition-[transform,box-shadow] motion-reduce:transition-none hover:-translate-y-[1px]"
      style={{
        borderColor: 'var(--color-border-subtle)',
        // CSS-driven hover glow (see globals.css .card-hover:hover).
        ['--card-hover-shadow' as string]: `0 0 0 1px ${tone}, 0 12px 28px color-mix(in srgb, ${tone} 14%, transparent)`,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          height: 3,
          background: `linear-gradient(90deg, color-mix(in srgb, ${tone} 70%, transparent), color-mix(in srgb, ${tone} 20%, transparent))`,
        }}
      />
      <button
        onClick={onOpen}
        className="w-full text-start p-4 flex flex-col gap-3 hover:bg-surface-hover transition-colors cursor-pointer"
      >
        <div className="flex items-start gap-3">
          <div
            className="relative shrink-0 rounded-2xl p-1"
            style={{
              background: `radial-gradient(circle at 30% 30%, color-mix(in srgb, ${tone} 24%, transparent), transparent 70%)`,
            }}
          >
            {glyph}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
              {typeChips.map((chip) => (
                <TypeChip key={chip.label} label={chip.label} tone={chip.tone} Icon={chip.Icon} />
              ))}
            </div>
            <div className="text-lg font-semibold text-text truncate leading-tight">
              {title}
            </div>
            <div className="text-2xs text-text-muted mt-0.5 leading-relaxed line-clamp-2">
              {description || 'No description'}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-2xs text-text-muted">
          {stats.map((stat) => (
            <StatChip key={stat.label} tone={stat.tone}>
              <span className="font-medium">{stat.value}</span>
              <span className="ms-1">{stat.label}</span>
            </StatChip>
          ))}
        </div>
        {bodyExtra}
      </button>

      {footer}
    </div>
  )
}

function TypeChip({
  label,
  tone = 'var(--color-text-secondary)',
  Icon,
}: {
  label: string
  tone?: string
  Icon?: (props: { size?: number }) => ReactElement
}) {
  return (
    <Badge tone={badgeToneForCssTone(tone)} className="inline-flex items-center gap-1">
      {Icon ? <Icon size={10} /> : null}
      {label}
    </Badge>
  )
}

function StatChip({ children, tone }: { children: ReactNode; tone?: string }) {
  return (
    <Badge tone={tone ? badgeToneForCssTone(tone) : 'muted'}>
      {children}
    </Badge>
  )
}

// --- Tool card --------------------------------------------------

export function ToolSelectionCard({
  tool,
  methodsCount,
  isCustom,
  linkedSkills = [],
  onOpen,
  onRemove,
}: {
  tool: CapabilityTool
  methodsCount: number
  isCustom: boolean
  linkedSkills?: CapabilitySkill[]
  onOpen: () => void
  onRemove?: () => void
}) {
  const toneKey: ToneKey = isCustom
    ? 'custom'
    : tool.kind === 'mcp' ? 'mcp' : 'builtin'
  const originChip = buildToolOriginChip(tool)
  const extraChips: Array<{ label: string; tone?: string; Icon?: (props: { size?: number }) => ReactElement }> = []
  if (isCustom) {
    extraChips.push({
      label: 'Custom',
      tone: 'var(--color-amber)',
      Icon: CustomIcon,
    })
  }
  return (
    <CapabilityCardShell
      toneKey={toneKey}
      typeChips={[originChip, ...extraChips]}
      glyph={<PluginIcon icon={tool.icon || tool.namespace || tool.id} size={44} />}
      title={tool.name}
      description={tool.description}
      stats={[
        { label: methodsCount === 1 ? 'method' : 'methods', value: String(methodsCount) },
        { label: tool.agentNames.length === 1 ? 'coworker' : 'coworkers', value: String(tool.agentNames.length) },
        ...(linkedSkills.length > 0 ? [{ label: linkedSkills.length === 1 ? 'skill' : 'skills', value: String(linkedSkills.length), tone: 'var(--color-amber)' }] : []),
        ...(tool.scope ? [{ label: tool.scope === 'project' ? 'Project' : 'Machine', value: '' }] : []),
      ].filter((entry) => entry.label !== '' || entry.value !== '')}
      bodyExtra={linkedSkills.length > 0 ? <LinkedSkillPills skills={linkedSkills} /> : undefined}
      footer={
        isCustom && onRemove ? (
          <div
            className="flex items-center justify-between px-4 py-2 border-t text-2xs text-text-muted"
            style={{
              borderColor: 'var(--color-border-subtle)',
              background: 'color-mix(in srgb, var(--color-elevated) 60%, transparent)',
            }}
          >
            <span className="truncate">{tool.namespace || tool.id}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.stopPropagation()
                onRemove()
              }}
              className="shrink-0"
            >
              Remove
            </Button>
          </div>
        ) : null
      }
      onOpen={onOpen}
    />
  )
}

function buildToolOriginChip(tool: CapabilityTool): {
  label: string
  tone: string
  Icon: (props: { size?: number }) => ReactElement
} {
  if (tool.origin === 'opencode') {
    return { label: 'OpenCode', tone: 'var(--color-info)', Icon: RuntimeIcon }
  }
  if (tool.kind === 'mcp') {
    return { label: 'MCP', tone: 'var(--color-accent)', Icon: RuntimeIcon }
  }
  return { label: 'Built-in', tone: 'var(--color-text-secondary)', Icon: BuiltinIcon }
}

// --- Skill card -------------------------------------------------

export function SkillSelectionCard({
  skill,
  isCustom,
  linkedTools = [],
  onOpen,
  onRemove,
}: {
  skill: CapabilitySkill
  isCustom: boolean
  linkedTools?: CapabilityLinkedTool[]
  onOpen: () => void
  onRemove?: () => void
}) {
  const toneKey: ToneKey = isCustom ? 'skill-custom' : 'skill-builtin'
  const chips: Array<{ label: string; tone?: string; Icon?: (props: { size?: number }) => ReactElement }> = [
    isCustom
      ? { label: 'Custom', tone: 'var(--color-amber)', Icon: CustomIcon }
      : { label: 'Built-in', tone: 'var(--color-accent)', Icon: BreadthIcon },
  ]
  if (skill.scope) {
    chips.push({
      label: skill.scope === 'project' ? 'Project' : 'Machine',
      tone: 'var(--color-text-muted)',
    })
  }
  const toolCount = (skill.toolIds || []).length
  return (
    <CapabilityCardShell
      toneKey={toneKey}
      typeChips={chips}
      glyph={
        <div
          className="rounded-xl bg-elevated border border-border flex items-center justify-center shrink-0"
          style={{
            width: 44,
            height: 44,
            color: toneForKey(toneKey),
          }}
        >
          <BreadthIcon size={22} />
        </div>
      }
      title={skill.label}
      description={skill.description}
      stats={[
        { label: toolCount === 1 ? 'tool' : 'tools', value: String(toolCount) },
        { label: skill.agentNames.length === 1 ? 'coworker' : 'coworkers', value: String(skill.agentNames.length) },
      ]}
      bodyExtra={linkedTools.length > 0 ? <LinkedToolPills tools={linkedTools} /> : undefined}
      footer={
        isCustom && onRemove ? (
          <div
            className="flex items-center justify-between px-4 py-2 border-t text-2xs text-text-muted"
            style={{
              borderColor: 'var(--color-border-subtle)',
              background: 'color-mix(in srgb, var(--color-elevated) 60%, transparent)',
            }}
          >
            <span className="truncate">{skill.name}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.stopPropagation()
                onRemove()
              }}
              className="shrink-0"
            >
              Remove
            </Button>
          </div>
        ) : null
      }
      onOpen={onOpen}
    />
  )
}

function LinkedSkillPills({ skills }: { skills: CapabilitySkill[] }) {
  const visible = skills.slice(0, 4)
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((skill) => (
        <Badge key={skill.name} tone="warning">
          {skill.label}
        </Badge>
      ))}
      {skills.length > visible.length ? (
        <Badge tone="muted">
          +{skills.length - visible.length}
        </Badge>
      ) : null}
    </div>
  )
}

function LinkedToolPills({ tools }: { tools: CapabilityLinkedTool[] }) {
  const visible = tools.slice(0, 4)
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((tool) => (
        <Badge key={tool.id} tone="info">
          {tool.name}
        </Badge>
      ))}
      {tools.length > visible.length ? (
        <Badge tone="muted">
          +{tools.length - visible.length}
        </Badge>
      ) : null}
    </div>
  )
}
