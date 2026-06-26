import type { AgentColor, BuiltInAgentDetail, CustomAgentSummary, RuntimeAgentDescriptor } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { AgentAvatar } from './AgentAvatar'
import {
  BuiltinIcon,
  CustomIcon,
  RuntimeIcon,
} from './agent-attribute-icons'
import {
  computeAgentScope,
  scopeLabel,
  type AgentScope,
} from './agent-builder-utils'
import type { AgentCatalog } from '@open-cowork/shared'
import { Badge, Button, Card, type BadgeTone } from '../ui'

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
      hover="lift"
      className="group flex flex-col gap-0 overflow-hidden !p-0"
    >
      <button
        onClick={onOpen}
        className="w-full text-start p-4 flex flex-col gap-3 hover:bg-surface-hover transition-colors cursor-pointer"
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

        {/* Stat chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="neutral">{skillCount} skill{skillCount === 1 ? '' : 's'}</Badge>
          <Badge tone="neutral">{toolCount} tool{toolCount === 1 ? '' : 's'}</Badge>
          <Badge tone={scopeBadgeTone(scope)}>{scopeLabel(scope)}</Badge>
          {modelLabel && <Badge tone="muted" className="font-mono">{modelLabel}</Badge>}
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
          <Button variant="ghost" size="sm" onClick={onExport} title={t('agentCard.exportTitle', 'Export this agent as a shareable JSON bundle')}>{t('agentCard.export', 'Export')}</Button>
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

function typeChipTone(typeLabel: TypeLabel): BadgeTone {
  return typeLabel === 'Custom' ? 'accent' : typeLabel === 'Built-in' ? 'neutral' : 'info'
}

function TypeChip({ typeLabel }: { typeLabel: TypeLabel }) {
  const Icon = typeLabel === 'Custom'
    ? CustomIcon
    : typeLabel === 'Built-in'
      ? BuiltinIcon
      : RuntimeIcon
  return (
    <Badge tone={typeChipTone(typeLabel)} className="uppercase">
      <Icon size={10} />
      {typeLabel}
    </Badge>
  )
}

function scopeBadgeTone(scope: AgentScope): BadgeTone {
  return scope === 'read-only' ? 'success' : scope === 'standard' ? 'info' : 'warning'
}

function EnabledStatusPill({ enabled, valid }: { enabled: boolean; valid: boolean }) {
  if (!valid) {
    return <Badge tone="warning" className="uppercase">Needs attention</Badge>
  }
  return (
    <Badge tone={enabled ? 'success' : 'muted'} className="uppercase">
      {enabled ? 'In chat' : 'Off'}
    </Badge>
  )
}

function ModeStatusPill({ mode, disabled, hidden }: { mode: 'primary' | 'subagent'; disabled: boolean; hidden: boolean }) {
  if (disabled) return <DisabledPill />
  const label = mode === 'primary' ? 'Top-level' : hidden ? 'Internal' : 'Sub-agent'
  return <Badge tone="neutral" className="uppercase">{label}</Badge>
}

function DisabledPill() {
  return <Badge tone="warning" className="uppercase">Disabled</Badge>
}

function CardFooter({ mention, children }: { mention: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2 border-t border-border-subtle bg-elevated/60">
      <span className="text-2xs text-text-muted truncate">@{mention}</span>
      <div className="flex items-center gap-1">{children}</div>
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
