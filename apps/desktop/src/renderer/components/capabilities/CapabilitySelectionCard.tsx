import type { ReactElement, ReactNode } from 'react'
import type { CapabilitySkill, CapabilityTool } from '@open-cowork/shared'
import { PluginIcon } from '../plugins/PluginIcon'
import {
  BreadthIcon,
  BuiltinIcon,
  CustomIcon,
  RuntimeIcon,
} from '../agents/agent-attribute-icons'
import { Badge, Button, Card, Icon, entityChroma, type BadgeTone } from '../ui'
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

// Structural TWIN of AgentSelectionCard's SelectionCardShell: a graphite
// surface card with a hover-only 2px identity spine keyed by entityChroma,
// a coordinated 120ms hover (border -> strong, bg -> surface-hover, no
// translate/glow/scale), an instrument-readout meta line of tabular counts
// separated by dots, and a reveal-on-intent footer.

type MetaSegment =
  | { kind: 'count'; value: number; label: string }
  | { kind: 'scope'; label: string }

type CardShellProps = {
  spineSeed: string
  typeChips: Array<{ label: string; tone?: string; Icon?: (props: { size?: number }) => ReactElement }>
  glyph: ReactNode
  title: string
  description: string
  meta: MetaSegment[]
  bodyExtra?: ReactNode
  footer?: ReactNode
  onOpen: () => void
}

function CapabilityCardShell({
  spineSeed,
  typeChips,
  glyph,
  title,
  description,
  meta,
  bodyExtra,
  footer,
  onOpen,
}: CardShellProps) {
  return (
    <Card
      variant="surface"
      padding="sm"
      hover="none"
      style={{ '--spine': entityChroma(spineSeed) } as React.CSSProperties}
      className="group relative flex flex-col gap-0 overflow-hidden !p-0 transition-colors duration-[120ms] hover:border-border-strong before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-[color-mix(in_srgb,var(--spine)_60%,transparent)] before:opacity-0 group-hover:before:opacity-100 before:transition-opacity before:duration-[120ms]"
    >
      <button
        onClick={onOpen}
        className="w-full text-start p-4 flex flex-col gap-3 group-hover:bg-surface-hover transition-colors duration-[120ms] cursor-pointer"
      >
        <div className="flex items-start gap-3">
          <div className="relative shrink-0">
            {glyph}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
              {typeChips.map((chip) => (
                <TypeChip key={chip.label} label={chip.label} tone={chip.tone} Icon={chip.Icon} />
              ))}
            </div>
            <div className="font-display text-role-card-title font-semibold text-text truncate leading-tight">
              {title}
            </div>
            <div className="text-2xs text-text-muted mt-0.5 leading-relaxed line-clamp-2">
              {description || 'No description'}
            </div>
          </div>
        </div>

        <MetaLine meta={meta} spineSeed={spineSeed} />
        {bodyExtra}
      </button>

      {footer}
    </Card>
  )
}

// Instrument-readout meta line — tabular counts and a single scope dot, dot
// separators, no pill chrome. Mirrors AgentSelectionCard's meta line.
function MetaLine({ meta, spineSeed }: { meta: MetaSegment[]; spineSeed: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-2xs text-text-muted">
      {meta.map((segment, index) => (
        <span key={`${segment.kind}:${segment.label}:${index}`} className="inline-flex items-center gap-2">
          {index > 0 ? <span className="text-text-muted/60" aria-hidden>·</span> : null}
          {segment.kind === 'count' ? (
            <span className="tabular">
              <span className="text-text-secondary font-[560]">{segment.value}</span> {segment.label}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <span
                className="w-[6px] h-[6px] rounded-full shrink-0"
                style={{ background: entityChroma(spineSeed) }}
                aria-hidden
              />
              {segment.label}
            </span>
          )}
        </span>
      ))}
    </div>
  )
}

function TypeChip({
  label,
  tone = 'var(--color-text-secondary)',
  Icon: ChipIcon,
}: {
  label: string
  tone?: string
  Icon?: (props: { size?: number }) => ReactElement
}) {
  return (
    <Badge tone={badgeToneForCssTone(tone)} className="inline-flex items-center gap-1">
      {ChipIcon ? <ChipIcon size={10} /> : null}
      {label}
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
  const originChip = buildToolOriginChip(tool)
  const extraChips: Array<{ label: string; tone?: string; Icon?: (props: { size?: number }) => ReactElement }> = []
  if (isCustom) {
    extraChips.push({
      label: 'Custom',
      tone: 'var(--color-text-secondary)',
      Icon: CustomIcon,
    })
  }
  const meta: MetaSegment[] = [
    { kind: 'count', value: methodsCount, label: methodsCount === 1 ? 'method' : 'methods' },
    { kind: 'count', value: tool.agentNames.length, label: tool.agentNames.length === 1 ? 'coworker' : 'coworkers' },
  ]
  if (linkedSkills.length > 0) {
    meta.push({ kind: 'count', value: linkedSkills.length, label: linkedSkills.length === 1 ? 'skill' : 'skills' })
  }
  if (tool.scope) {
    meta.push({ kind: 'scope', label: tool.scope === 'project' ? 'Project' : 'Machine' })
  }
  return (
    <CapabilityCardShell
      spineSeed={tool.name || tool.id}
      typeChips={[originChip, ...extraChips]}
      glyph={<PluginIcon icon={tool.icon || tool.namespace || tool.id} size={44} />}
      title={tool.name}
      description={tool.description}
      meta={meta}
      bodyExtra={linkedSkills.length > 0 ? <LinkedSkillPills skills={linkedSkills} /> : undefined}
      footer={
        isCustom && onRemove ? (
          <CardRemoveFooter mention={tool.namespace || tool.id} onRemove={onRemove} />
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
    return { label: 'MCP', tone: 'var(--color-text-secondary)', Icon: RuntimeIcon }
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
  const chips: Array<{ label: string; tone?: string; Icon?: (props: { size?: number }) => ReactElement }> = [
    isCustom
      ? { label: 'Custom', tone: 'var(--color-text-secondary)', Icon: CustomIcon }
      : { label: 'Built-in', tone: 'var(--color-text-secondary)', Icon: BreadthIcon },
  ]
  const toolCount = (skill.toolIds || []).length
  const meta: MetaSegment[] = [
    { kind: 'count', value: toolCount, label: toolCount === 1 ? 'tool' : 'tools' },
    { kind: 'count', value: skill.agentNames.length, label: skill.agentNames.length === 1 ? 'coworker' : 'coworkers' },
  ]
  if (skill.scope) {
    meta.push({ kind: 'scope', label: skill.scope === 'project' ? 'Project' : 'Machine' })
  }
  return (
    <CapabilityCardShell
      spineSeed={skill.label || skill.name}
      typeChips={chips}
      glyph={
        <div
          className="entity-tile rounded-xl flex items-center justify-center shrink-0"
          style={{ width: 44, height: 44, '--entity-chroma': entityChroma(skill.label || skill.name) } as React.CSSProperties}
          aria-hidden="true"
        >
          <Icon name="sparkles" size={20} />
        </div>
      }
      title={skill.label}
      description={skill.description}
      meta={meta}
      bodyExtra={linkedTools.length > 0 ? <LinkedToolPills tools={linkedTools} /> : undefined}
      footer={
        isCustom && onRemove ? (
          <CardRemoveFooter mention={skill.name} onRemove={onRemove} />
        ) : null
      }
      onOpen={onOpen}
    />
  )
}

// Footer remove action reveals on intent — a calm resting card, the affordance
// arrives when reached for. The identity mention stays always visible.
function CardRemoveFooter({ mention, onRemove }: { mention: string; onRemove: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-1.5 border-t border-border-subtle bg-elevated/60">
      <span className="text-2xs text-text-muted truncate">{mention}</span>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
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
    </div>
  )
}

function LinkedSkillPills({ skills }: { skills: CapabilitySkill[] }) {
  const visible = skills.slice(0, 4)
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((skill) => (
        <Badge key={skill.name} tone="muted">
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
        <Badge key={tool.id} tone="muted">
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
