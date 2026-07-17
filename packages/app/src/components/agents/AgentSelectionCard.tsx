import type { AgentColor, BuiltInAgentDetail, CustomAgentSummary, RuntimeAgentDescriptor } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { AgentAvatar } from './AgentAvatar'
import {
  BuiltinIcon, CustomIcon, RuntimeIcon, } from './agent-attribute-icons'
import {
  agentChroma, computeAgentScope, scopeLabel, scopeTone, AgentScope, } from './agent-builder-utils'
import type { AgentCatalog } from '@open-cowork/shared'
import { Badge, Button, Card } from '@open-cowork/ui'

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
  return (
    <Card
      variant="surface"
      padding="sm"
      hover="none"
      style={{ '--spine': agentChroma(color) } as React.CSSProperties}
      className="group relative flex flex-col gap-0 overflow-hidden !p-0 transition-colors duration-[120ms] hover:border-border-strong before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-[color-mix(in_srgb,var(--spine)_60%,transparent)] before:opacity-0 group-hover:before:opacity-100 before:transition-opacity before:duration-[120ms]"
    >
      <button
        onClick={onOpen}
        className="w-full text-start p-4 flex flex-col gap-3 group-hover:bg-surface-hover transition-colors duration-[120ms] cursor-pointer"
      >
        <div className="flex items-start gap-3">
          <AgentAvatar name={label || name} color={color ?? undefined} src={avatar} size="lg" className="shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
              <TypeChip typeLabel={typeLabel} />
              {statusNode}
            </div>
            <div className="font-display text-role-card-title font-semibold text-text truncate leading-tight">
              {label || name}
            </div>
            <div className="text-2xs text-text-muted mt-0.5 leading-relaxed line-clamp-2">
              {description || t('agentCard.noDescription', 'No description')}
            </div>
          </div>
        </div>

        {/* Instrument-readout meta line — tabular counts + a single scope dot, no
            pill chrome. The one colour here is a 6px scope dot. */}
        <div className="flex items-center gap-2 text-2xs text-text-muted">
          <span className="tabular">
            <span className="text-text-secondary font-[560]">{skillCount}</span> skill{skillCount === 1 ? '' : 's'}
          </span>
          <span className="text-text-muted/60" aria-hidden>·</span>
          <span className="tabular">
            <span className="text-text-secondary font-[560]">{toolCount}</span> tool{toolCount === 1 ? '' : 's'}
          </span>
          <span className="text-text-muted/60" aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <span className="w-[6px] h-[6px] rounded-full shrink-0" style={{ background: scopeTone(scope) }} aria-hidden />
            {scopeLabel(scope)}
          </span>
          {modelLabel && (
            <>
              <span className="text-text-muted/60" aria-hidden>·</span>
              <span className="font-mono truncate">{modelLabel}</span>
            </>
          )}
        </div>
      </button>

      {footer}
    </Card>
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
        <CardFooter mention={agent.name}>
          {onStartChat && agent.enabled && agent.valid && agent.mode === 'primary' && (
            <Button variant="ghost" size="sm" onClick={onStartChat}>{t('agentCard.startChat', 'Start chat')}</Button>
          )}
          {onTest && agent.enabled && agent.valid && agent.mode !== 'primary' && (
            <Button variant="ghost" size="sm" onClick={onTest}>{t('agentCard.test', 'Test')}</Button>
          )}
          <Button variant="ghost" size="sm" onClick={onOpen}>{t('agentCard.edit', 'Edit')}</Button>
          <Button variant="ghost" size="sm" onClick={onExport} title={t('agentCard.exportTitle', 'Export this coworker as a shareable JSON bundle')}>{t('agentCard.export', 'Export')}</Button>
          <Button variant="ghost" size="sm" onClick={onDelete}>{t('common.delete', 'Delete')}</Button>
        </CardFooter>
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

// Type is structural metadata, not colour — one mono-outline recipe, differentiated
// only by its glyph.
function TypeChip({ typeLabel }: { typeLabel: TypeLabel }) {
  const ChipIcon = typeLabel === 'Custom'
    ? CustomIcon
    : typeLabel === 'Built-in'
      ? BuiltinIcon
      : RuntimeIcon
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px text-2xs uppercase tracking-[0.06em] text-text-muted">
      <ChipIcon size={10} />
      {typeLabel}
    </span>
  )
}

// Dot + label — the mono replacement for filled status pills. Colour touches only
// the 6px dot, never a fill.
function StatusDotLabel({ color = 'var(--color-text-muted)', label }: { color?: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-2xs uppercase tracking-[0.06em] text-text-muted">
      <span className="w-[6px] h-[6px] rounded-full shrink-0" style={{ background: color }} aria-hidden />
      {label}
    </span>
  )
}

function EnabledStatusPill({ enabled, valid }: { enabled: boolean; valid: boolean }) {
  // An alert that SHOULD catch the eye keeps its tonal chip.
  if (!valid) {
    return <Badge tone="warning" className="uppercase">Needs attention</Badge>
  }
  // "In chat" is the ONE accent moment on the card: this coworker is live with you.
  if (enabled) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-2xs uppercase tracking-[0.06em] text-accent"
        style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}
      >
        <span className="w-[5px] h-[5px] rounded-full shrink-0" style={{ background: 'var(--color-accent)' }} aria-hidden />
        In chat
      </span>
    )
  }
  return <StatusDotLabel label="Off" />
}

function ModeStatusPill({ mode, disabled, hidden }: { mode: 'primary' | 'subagent'; disabled: boolean; hidden: boolean }) {
  if (disabled) return <DisabledPill />
  const label = mode === 'primary' ? 'Top-level' : hidden ? 'Internal' : 'Sub-agent'
  return <StatusDotLabel label={label} />
}

function DisabledPill() {
  return <StatusDotLabel color="var(--color-amber)" label="Disabled" />
}

// Footer actions reveal on intent — a calm resting card, affordances arrive when
// you reach for them. The @mention stays always-visible (identity, not action).
function CardFooter({ mention, children }: { mention: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-1.5 border-t border-border-subtle bg-elevated/60">
      <span className="text-2xs text-text-muted truncate">@{mention}</span>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150">{children}</div>
    </div>
  )
}

function CardTestFooter({ name, onTest }: { name: string; onTest: () => void }) {
  return (
    <CardFooter mention={name}>
      <Button variant="ghost" size="sm" onClick={onTest}>{t('agentCard.test', 'Test')}</Button>
    </CardFooter>
  )
}
