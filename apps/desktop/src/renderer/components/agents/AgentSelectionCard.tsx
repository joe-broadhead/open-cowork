import type { AgentColor, BuiltInAgentDetail, CustomAgentSummary, RuntimeAgentDescriptor } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { AgentAvatar } from './AgentAvatar'
import {
  BuiltinIcon,
  CustomIcon,
  RuntimeIcon,
} from './agent-attribute-icons'
import {
  agentTone,
  computeAgentScope,
  scopeLabel,
  scopeTone,
  type AgentScope,
} from './agent-builder-utils'
import type { AgentCatalog } from '@open-cowork/shared'

// Roster card for the Agents page. It keeps the character-select
// feeling through avatar, color, and compact stats, but leaves deep
// profile meters to the builder so the list stays scannable.

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
        className="w-full text-start p-4 flex flex-col gap-3 hover:bg-surface-hover transition-colors cursor-pointer"
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
  onStartChat,
  onTest,
}: {
  agent: CustomAgentSummary
  catalog: AgentCatalog | null
  onOpen: () => void
  onDelete: () => void
  onExport: () => void
  onStartChat?: () => void
  onTest?: () => void
}) {
  const scope: AgentScope = catalog ? computeAgentScope(agent.toolIds, catalog, agent.permissionOverrides) : 'read-only'
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
      statusNode={<EnabledStatusPill enabled={agent.enabled} valid={agent.valid} />}
      onOpen={onOpen}
      footer={
        <div
          className="flex items-center justify-between px-4 py-2 border-t text-[10px] text-text-muted"
          style={{ borderColor: 'var(--color-border-subtle)', background: 'color-mix(in srgb, var(--color-elevated) 60%, transparent)' }}
        >
          <span>@{agent.name}</span>
          <div className="flex items-center gap-2">
            {onStartChat && agent.enabled && agent.valid && agent.mode === 'primary' && (
              <button onClick={onStartChat} className="hover:text-accent cursor-pointer">{t('agentCard.startChat', 'Start chat')}</button>
            )}
            {onTest && agent.enabled && agent.valid && agent.mode !== 'primary' && (
              <button onClick={onTest} className="hover:text-accent cursor-pointer">{t('agentCard.test', 'Test')}</button>
            )}
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
  onTest,
}: {
  agent: BuiltInAgentDetail
  onOpen: () => void
  onTest?: () => void
}) {
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
      statusNode={<ModeStatusPill mode={agent.mode} disabled={agent.disabled} hidden={agent.hidden} />}
      onOpen={onOpen}
      footer={onTest && !agent.disabled && !agent.hidden && agent.mode !== 'primary' ? (
        <CardTestFooter name={agent.name} onTest={onTest} />
      ) : undefined}
    />
  )
}

export function RuntimeSelectionCard({
  agent,
  onOpen,
  onTest,
}: {
  agent: RuntimeAgentDescriptor
  onOpen: () => void
  onTest?: () => void
}) {
  const toolCount = agent.toolCount ?? agent.toolIds?.length ?? 0
  return (
    <SelectionCardShell
      name={agent.name}
      label={agent.name}
      description={agent.description || 'SDK-registered agent (no Cowork-side metadata).'}
      color={agent.color || 'info'}
      typeLabel="Runtime"
      scope={agent.writeAccess ? 'standard' : 'read-only'}
      toolCount={toolCount}
      skillCount={0}
      modelLabel={agent.model ? agent.model.split('/').pop()! : null}
      statusNode={agent.disabled ? <DisabledPill /> : null}
      onOpen={onOpen}
      footer={onTest && !agent.disabled && agent.mode !== 'primary' ? (
        <CardTestFooter name={agent.name} onTest={onTest} />
      ) : undefined}
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

function CardTestFooter({ name, onTest }: { name: string; onTest: () => void }) {
  return (
    <div
      className="flex items-center justify-between px-4 py-2 border-t text-[10px] text-text-muted"
      style={{ borderColor: 'var(--color-border-subtle)', background: 'color-mix(in srgb, var(--color-elevated) 60%, transparent)' }}
    >
      <span>@{name}</span>
      <button onClick={onTest} className="hover:text-accent cursor-pointer">{t('agentCard.test', 'Test')}</button>
    </div>
  )
}
