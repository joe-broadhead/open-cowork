import type { AgentColor, BuiltInAgentDetail, CustomAgentSummary, RuntimeAgentDescriptor } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { AgentAvatar } from './AgentAvatar'
import { AgentAttributeBar } from './AgentAttributeBar'
import {
  AutonomyIcon,
  BreadthIcon,
  BuiltinIcon,
  CustomIcon,
  RangeIcon,
  RuntimeIcon,
} from './agent-attribute-icons'
import {
  agentTone,
  computeAgentAttributes,
  computeAgentScope,
  scopeLabel,
  scopeTone,
  type AgentScope,
} from './agent-builder-utils'
import type { AgentCatalog } from '@open-cowork/shared'

// Tall portrait-style list card. Think character-selection screen:
// bigger avatar, accented halo, bold name, prominent type badge, three
// attribute meters, stat chip row, and — for customs — a footer with
// edit / delete. Hover lifts the card subtly and draws an accent ring
// matching SettingsPanel's theme picker. Clicking anywhere on the
// body opens the agent in the builder.

type TypeLabel = 'Custom' | 'Built-in' | 'Runtime'

type CommonProps = {
  name: string
  label: string
  description: string
  color: AgentColor | string | null
  avatar?: string | null
  typeLabel: TypeLabel
  scope: AgentScope
  toolCount: number
  skillCount: number
  modelLabel?: string | null
  attributes: { breadth: number; range: number; autonomy: number }
  statusNode?: React.ReactNode  // e.g. "Off" / "Needs attention" pill
  onOpen: () => void
  footer?: React.ReactNode
}

function SelectionCardShell({
  name,
  label,
  description,
  color,
  avatar,
  typeLabel,
  scope,
  toolCount,
  skillCount,
  modelLabel,
  attributes,
  statusNode,
  onOpen,
  footer,
}: CommonProps) {
  const tone = agentTone(color)
  return (
    <div
      className="group card-hover relative rounded-2xl border bg-surface flex flex-col overflow-hidden transition-[transform,box-shadow] motion-reduce:transition-none hover:-translate-y-[1px]"
      style={{
        borderColor: 'var(--color-border-subtle)',
        // `card-hover:hover` picks this up from CSS. Moving the glow
        // off a JS onMouseEnter fixes an a11y-lint flag and drops the
        // per-card JS work during pointer movement.
        ['--card-hover-shadow' as string]: `0 0 0 1px ${tone}, 0 12px 28px color-mix(in srgb, ${tone} 14%, transparent)`,
      }}
    >
      {/* Top accent strip — tints the card with the agent's color. */}
      <div
        aria-hidden="true"
        style={{
          height: 3,
          background: `linear-gradient(90deg, color-mix(in srgb, ${tone} 70%, transparent), color-mix(in srgb, ${tone} 20%, transparent))`,
        }}
      />
      <button
        onClick={onOpen}
        className="w-full text-left p-4 flex flex-col gap-3 hover:bg-surface-hover transition-colors cursor-pointer"
      >
        <div className="flex items-start gap-3">
          {/* Avatar with halo backing */}
          <div
            className="relative shrink-0 rounded-2xl p-1"
            style={{
              background: `radial-gradient(circle at 30% 30%, color-mix(in srgb, ${tone} 24%, transparent), transparent 70%)`,
            }}
          >
            <AgentAvatar name={label || name} color={color ?? undefined} src={avatar} size="lg" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
              <TypeChip typeLabel={typeLabel} />
              {statusNode}
            </div>
            <div className="text-[15px] font-semibold text-text truncate leading-tight">
              {label || name}
            </div>
            <div className="text-[11px] text-text-muted mt-0.5 leading-relaxed line-clamp-2">
              {description || t('agentCard.noDescription', 'No description')}
            </div>
          </div>
        </div>

        {/* Attribute meters */}
        <div className="flex flex-col gap-1">
          <AgentAttributeBar value={attributes.breadth} label="Expertise" icon={<BreadthIcon />} tone={tone} />
          <AgentAttributeBar value={attributes.range} label="Reach" icon={<RangeIcon />} tone={tone} />
          <AgentAttributeBar value={attributes.autonomy} label="Autonomy" icon={<AutonomyIcon />} tone={tone} />
        </div>

        {/* Stat chips */}
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-text-muted">
          <StatChip>{skillCount} skill{skillCount === 1 ? '' : 's'}</StatChip>
          <StatChip>{toolCount} tool{toolCount === 1 ? '' : 's'}</StatChip>
          <ScopeChip scope={scope} />
          {modelLabel && <StatChip mono>{modelLabel}</StatChip>}
        </div>
      </button>

      {footer}
    </div>
  )
}

// --- Type-specific adapters --------------------------------------

export function CustomSelectionCard({
  agent,
  catalog,
  onOpen,
  onDelete,
  onExport,
}: {
  agent: CustomAgentSummary
  catalog: AgentCatalog | null
  onOpen: () => void
  onDelete: () => void
  onExport: () => void
}) {
  const scope: AgentScope = catalog ? computeAgentScope(agent.toolIds, catalog) : 'read-only'
  const attributes = computeAgentAttributes({
    skillCount: agent.skillNames.length,
    toolCount: agent.toolIds.length,
    steps: agent.steps,
  })
  return (
    <SelectionCardShell
      name={agent.name}
      label={agent.name}
      description={agent.description}
      color={agent.color}
      avatar={agent.avatar}
      typeLabel="Custom"
      scope={scope}
      toolCount={agent.toolIds.length}
      skillCount={agent.skillNames.length}
      modelLabel={agent.model ? agent.model.split('/').pop()! : null}
      attributes={attributes}
      statusNode={<EnabledStatusPill enabled={agent.enabled} valid={agent.valid} />}
      onOpen={onOpen}
      footer={
        <div
          className="flex items-center justify-between px-4 py-2 border-t text-[10px] text-text-muted"
          style={{ borderColor: 'var(--color-border-subtle)', background: 'color-mix(in srgb, var(--color-elevated) 60%, transparent)' }}
        >
          <span>@{agent.name}</span>
          <div className="flex items-center gap-2">
            <button onClick={onOpen} className="hover:text-text-secondary cursor-pointer">{t('agentCard.edit', 'Edit')}</button>
            <button onClick={onExport} className="hover:text-text-secondary cursor-pointer" title={t('agentCard.exportTitle', 'Export this agent as a shareable JSON bundle')}>{t('agentCard.export', 'Export')}</button>
            <button onClick={onDelete} className="hover:text-red cursor-pointer" style={{ color: 'var(--color-text-muted)' }}>{t('common.delete', 'Delete')}</button>
          </div>
        </div>
      }
    />
  )
}

export function BuiltInSelectionCard({
  agent,
  onOpen,
}: {
  agent: BuiltInAgentDetail
  onOpen: () => void
}) {
  const attributes = computeAgentAttributes({
    skillCount: agent.skills.length,
    toolCount: agent.toolAccess.length,
    steps: agent.steps ?? null,
  })
  return (
    <SelectionCardShell
      name={agent.name}
      label={agent.label}
      description={agent.description}
      color={agent.color}
      avatar={agent.avatar}
      typeLabel="Built-in"
      scope="read-only"
      toolCount={agent.toolAccess.length}
      skillCount={agent.skills.length}
      modelLabel={agent.model ? agent.model.split('/').pop()! : null}
      attributes={attributes}
      statusNode={<ModeStatusPill mode={agent.mode} disabled={agent.disabled} hidden={agent.hidden} />}
      onOpen={onOpen}
    />
  )
}

export function RuntimeSelectionCard({
  agent,
  onOpen,
}: {
  agent: RuntimeAgentDescriptor
  onOpen: () => void
}) {
  const attributes = computeAgentAttributes({
    skillCount: 0,
    toolCount: 0,
    steps: null,
  })
  return (
    <SelectionCardShell
      name={agent.name}
      label={agent.name}
      description={agent.description || 'SDK-registered agent (no Cowork-side metadata).'}
      color={agent.color || 'info'}
      typeLabel="Runtime"
      scope="read-only"
      toolCount={0}
      skillCount={0}
      modelLabel={agent.model ? agent.model.split('/').pop()! : null}
      attributes={attributes}
      statusNode={agent.disabled ? <DisabledPill /> : null}
      onOpen={onOpen}
    />
  )
}

// --- Sub-components ----------------------------------------------

function TypeChip({ typeLabel }: { typeLabel: TypeLabel }) {
  const tone = typeLabel === 'Custom'
    ? 'var(--color-accent)'
    : typeLabel === 'Built-in'
      ? 'var(--color-text-secondary)'
      : 'var(--color-info)'
  const Icon = typeLabel === 'Custom'
    ? CustomIcon
    : typeLabel === 'Built-in'
      ? BuiltinIcon
      : RuntimeIcon
  return (
    <span
      className="inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded font-semibold"
      style={{
        color: tone,
        background: `color-mix(in srgb, ${tone} 12%, transparent)`,
      }}
    >
      <Icon size={10} />
      {typeLabel}
    </span>
  )
}

function StatChip({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <span
      className={`px-1.5 py-0.5 rounded-md ${mono ? 'font-mono' : ''}`}
      style={{
        background: 'color-mix(in srgb, var(--color-text-muted) 8%, transparent)',
        border: '1px solid var(--color-border-subtle)',
      }}
    >
      {children}
    </span>
  )
}

function ScopeChip({ scope }: { scope: AgentScope }) {
  const tone = scopeTone(scope)
  return (
    <span
      className="px-1.5 py-0.5 rounded-md font-medium"
      style={{
        color: tone,
        background: `color-mix(in srgb, ${tone} 12%, transparent)`,
      }}
    >
      {scopeLabel(scope)}
    </span>
  )
}

function EnabledStatusPill({ enabled, valid }: { enabled: boolean; valid: boolean }) {
  if (!valid) {
    return (
      <span
        className="text-[9px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded font-semibold"
        style={{
          color: 'var(--color-amber)',
          background: 'color-mix(in srgb, var(--color-amber) 12%, transparent)',
        }}
      >
        Needs attention
      </span>
    )
  }
  return (
    <span
      className="text-[9px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded font-semibold"
      style={{
        color: enabled ? 'var(--color-green)' : 'var(--color-text-muted)',
        background: enabled
          ? 'color-mix(in srgb, var(--color-green) 12%, transparent)'
          : 'color-mix(in srgb, var(--color-text-muted) 12%, transparent)',
      }}
    >
      {enabled ? 'In chat' : 'Off'}
    </span>
  )
}

function ModeStatusPill({ mode, disabled, hidden }: { mode: 'primary' | 'subagent'; disabled: boolean; hidden: boolean }) {
  if (disabled) return <DisabledPill />
  const label = mode === 'primary' ? 'Top-level' : hidden ? 'Internal' : 'Sub-agent'
  return (
    <span
      className="text-[9px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded font-semibold"
      style={{
        color: 'var(--color-text-secondary)',
        background: 'color-mix(in srgb, var(--color-text-muted) 10%, transparent)',
      }}
    >
      {label}
    </span>
  )
}

function DisabledPill() {
  return (
    <span
      className="text-[9px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded font-semibold"
      style={{
        color: 'var(--color-text-muted)',
        background: 'color-mix(in srgb, var(--color-text-muted) 12%, transparent)',
      }}
    >
      Disabled
    </span>
  )
}
