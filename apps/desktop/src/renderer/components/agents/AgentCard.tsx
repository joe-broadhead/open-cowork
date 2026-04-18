import { useRef, useState } from 'react'
import type { AgentCatalog, AgentColor, CustomAgentConfig } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { AgentAvatar } from './AgentAvatar'
import { AgentAttributeBar } from './AgentAttributeBar'
import { AvatarEditor } from './AvatarEditor'
import { PluginIcon } from '../plugins/PluginIcon'
import {
  AutonomyIcon,
  BreadthIcon,
  RangeIcon,
} from './agent-attribute-icons'
import {
  agentTone,
  computeAgentAttributes,
  computeAgentScope,
  inferAgentOutputStyle,
  scopeLabel,
  scopeTone,
  type AgentScope,
} from './agent-builder-utils'

// Portrait card shown on the left of the builder. Top = avatar + name +
// description + type chip. Middle = 2x3 stats grid. Bottom = loadout
// (skills as pills, tools as icon tiles). All three sections live-update
// as the user picks things from the workbench on the right.

type Props = {
  draft: CustomAgentConfig
  catalog: AgentCatalog
  typeLabel: 'Custom' | 'Built-in' | 'Runtime'
  readOnly?: boolean
  onNameChange?: (name: string) => void
  onDescriptionChange?: (description: string) => void
  onColorChange?: (color: AgentColor) => void
  onAvatarChange?: (avatar: string | null) => void
  onToolRemove?: (toolId: string) => void
  onSkillRemove?: (skillName: string) => void
  onEnabledChange?: (enabled: boolean) => void
}

export function AgentCard({
  draft,
  catalog,
  typeLabel,
  readOnly,
  onNameChange,
  onDescriptionChange,
  onColorChange,
  onAvatarChange,
  onToolRemove,
  onSkillRemove,
  onEnabledChange,
}: Props) {
  const scope = computeAgentScope(draft.toolIds, catalog)
  const toolMap = new Map(catalog.tools.map((tool) => [tool.id, tool]))
  const skillMap = new Map(catalog.skills.map((skill) => [skill.name, skill]))
  const avatarButtonRef = useRef<HTMLButtonElement>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const avatarInteractive = !readOnly && (onAvatarChange || onColorChange)
  const tone = agentTone(draft.color)
  const attributes = computeAgentAttributes({
    skillCount: draft.skillNames.length,
    toolCount: draft.toolIds.length,
    steps: draft.steps,
  })
  const outputStyle = inferAgentOutputStyle(draft.instructions)

  return (
    <div
      className="rounded-2xl border bg-surface flex flex-col overflow-hidden"
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      {/* Top accent strip — same language as the selection cards so
          the agent's colour reads consistently between list and
          builder. */}
      <div
        aria-hidden="true"
        style={{
          height: 3,
          background: `linear-gradient(90deg, color-mix(in srgb, ${tone} 70%, transparent), color-mix(in srgb, ${tone} 20%, transparent))`,
        }}
      />
      <div
        className="p-5 pb-4 flex items-start gap-4"
        style={{
          background: `radial-gradient(circle at 10% 0%, color-mix(in srgb, ${tone} 10%, transparent), transparent 55%)`,
        }}
      >
        {avatarInteractive ? (
          <button
            ref={avatarButtonRef}
            type="button"
            onClick={() => setEditorOpen(true)}
            aria-label={t('agentCard.editAvatar', 'Edit agent avatar')}
            className="relative cursor-pointer transition-transform hover:scale-[1.02] rounded-2xl"
          >
            <AgentAvatar name={draft.name || 'New agent'} color={draft.color} src={draft.avatar} size="xl" />
            <span
              className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full border flex items-center justify-center"
              style={{
                background: 'var(--color-elevated)',
                borderColor: 'var(--color-border-subtle)',
                color: 'var(--color-text-muted)',
              }}
              aria-hidden="true"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2l2 2-8 8H4v-2z" />
              </svg>
            </span>
          </button>
        ) : (
          <AgentAvatar name={draft.name || 'New agent'} color={draft.color} src={draft.avatar} size="xl" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <TypeBadge label={typeLabel} />
            {typeLabel === 'Custom' && (
              <EnableToggle enabled={draft.enabled} readOnly={readOnly} onChange={onEnabledChange} />
            )}
          </div>
          {readOnly ? (
            <div className="text-[16px] font-semibold text-text truncate">{draft.name || 'New agent'}</div>
          ) : (
            <input
              value={draft.name}
              onChange={(event) => onNameChange?.(event.target.value.toLowerCase())}
              placeholder={t('agentCard.idPlaceholder', 'agent-id')}
              className="w-full text-[16px] font-semibold text-text bg-transparent border-none outline-none focus:bg-elevated rounded px-1 -mx-1"
            />
          )}
          {readOnly ? (
            <div className="text-[12px] text-text-muted mt-0.5 leading-relaxed line-clamp-2">
              {draft.description || 'No description'}
            </div>
          ) : (
            <input
              value={draft.description}
              onChange={(event) => onDescriptionChange?.(event.target.value)}
              placeholder={t('agentCard.descriptionPlaceholder', 'What is this agent specialised to do?')}
              className="w-full text-[12px] text-text-muted mt-0.5 bg-transparent border-none outline-none focus:bg-elevated rounded px-1 -mx-1"
            />
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 px-5 pb-3">
        <StatTile label="Model" value={draft.model ? draft.model.split('/').pop()! : 'Default'} />
        <StatTile label="Temperature" value={typeof draft.temperature === 'number' ? draft.temperature.toFixed(1) : '—'} />
        <StatTile label="Steps" value={typeof draft.steps === 'number' ? String(draft.steps) : '—'} />
        <StatTile label="Skills" value={String(draft.skillNames.length)} />
        <StatTile label="Tools" value={String(draft.toolIds.length)} />
        <ScopeTile scope={scope} />
      </div>

      <div className="px-5 pb-4 flex flex-col gap-1">
        <AgentAttributeBar value={attributes.breadth} label="Expertise" icon={<BreadthIcon />} tone={tone} />
        <AgentAttributeBar value={attributes.range} label="Reach" icon={<RangeIcon />} tone={tone} />
        <AgentAttributeBar value={attributes.autonomy} label="Autonomy" icon={<AutonomyIcon />} tone={tone} />
      </div>

      <div
        className="border-t px-5 py-4 flex flex-col gap-3"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <LoadoutSection label="Skills">
          {draft.skillNames.length === 0 ? (
            <EmptyHint text="No skills — attach from the workbench" />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {draft.skillNames.map((name) => {
                const skill = skillMap.get(name)
                return (
                  <SkillPill
                    key={name}
                    label={skill?.label || name}
                    missing={!skill}
                    onRemove={readOnly ? undefined : () => onSkillRemove?.(name)}
                  />
                )
              })}
            </div>
          )}
        </LoadoutSection>

        <LoadoutSection label="Tools">
          {draft.toolIds.length === 0 ? (
            <EmptyHint text="No tools — pick from the workbench" />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {draft.toolIds.map((id) => {
                const tool = toolMap.get(id)
                return (
                  <ToolTile
                    key={id}
                    icon={tool?.icon || 'tool'}
                    label={tool?.name || id}
                    missing={!tool}
                    onRemove={readOnly ? undefined : () => onToolRemove?.(id)}
                  />
                )
              })}
            </div>
          )}
        </LoadoutSection>

        <RecipeStrip
          skillCount={draft.skillNames.length}
          toolCount={draft.toolIds.length}
          outputStyle={outputStyle}
          tone={tone}
        />
      </div>

      {editorOpen && (
        <AvatarEditor
          name={draft.name || 'New agent'}
          color={draft.color}
          src={draft.avatar}
          anchorRect={avatarButtonRef.current?.getBoundingClientRect() || null}
          onClose={() => setEditorOpen(false)}
          onAvatarChange={(next) => onAvatarChange?.(next)}
          onColorChange={(next) => onColorChange?.(next)}
        />
      )}
    </div>
  )
}

function TypeBadge({ label }: { label: 'Custom' | 'Built-in' | 'Runtime' }) {
  const tone = label === 'Custom'
    ? 'var(--color-accent)'
    : label === 'Built-in'
      ? 'var(--color-text-secondary)'
      : 'var(--color-info)'
  return (
    <span
      className="text-[9px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded font-medium"
      style={{
        color: tone,
        background: `color-mix(in srgb, ${tone} 12%, transparent)`,
      }}
    >
      {label}
    </span>
  )
}

function EnableToggle({
  enabled,
  readOnly,
  onChange,
}: {
  enabled: boolean
  readOnly?: boolean
  onChange?: (next: boolean) => void
}) {
  return (
    <button
      onClick={() => !readOnly && onChange?.(!enabled)}
      disabled={readOnly}
      className="text-[9px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded font-medium cursor-pointer disabled:cursor-default"
      style={{
        color: enabled ? 'var(--color-green)' : 'var(--color-text-muted)',
        background: enabled
          ? 'color-mix(in srgb, var(--color-green) 12%, transparent)'
          : 'color-mix(in srgb, var(--color-text-muted) 12%, transparent)',
      }}
      title={enabled ? t('agentCard.enabledTitle', 'Visible in chat') : t('agentCard.disabledTitle', "Disabled — won't appear in chat")}
    >
      {enabled ? 'In chat' : 'Off'}
    </button>
  )
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-lg px-2.5 py-2 border"
      style={{
        background: 'var(--color-elevated)',
        borderColor: 'var(--color-border-subtle)',
      }}
    >
      <div className="text-[9px] uppercase tracking-[0.08em] text-text-muted">{label}</div>
      <div className="text-[12px] font-medium text-text truncate mt-0.5" title={value}>{value}</div>
    </div>
  )
}

function ScopeTile({ scope }: { scope: AgentScope }) {
  const tone = scopeTone(scope)
  return (
    <div
      className="rounded-lg px-2.5 py-2 border transition-colors"
      style={{
        background: `color-mix(in srgb, ${tone} 10%, var(--color-elevated))`,
        borderColor: `color-mix(in srgb, ${tone} 24%, var(--color-border-subtle))`,
      }}
      title={`Access footprint: ${scopeLabel(scope)}`}
    >
      <div className="text-[9px] uppercase tracking-[0.08em]" style={{ color: tone }}>Scope</div>
      <div className="text-[12px] font-medium mt-0.5" style={{ color: tone }}>
        {scopeLabel(scope)}
      </div>
    </div>
  )
}

function LoadoutSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-1.5">{label}</div>
      {children}
    </div>
  )
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="text-[11px] text-text-muted italic">{text}</div>
  )
}

function SkillPill({ label, missing, onRemove }: { label: string; missing?: boolean; onRemove?: () => void }) {
  const tone = missing ? 'var(--color-amber)' : 'var(--color-accent)'
  return (
    <span
      className="agent-loadout-snap inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium"
      style={{
        color: tone,
        background: `color-mix(in srgb, ${tone} 12%, transparent)`,
      }}
    >
      {label}
      {onRemove && (
        <button
          onClick={onRemove}
          className="text-[9px] leading-none cursor-pointer hover:opacity-80"
          aria-label={t('agentCard.removeLabel', 'Remove {{label}}', { label })}
        >
          ×
        </button>
      )}
    </span>
  )
}

function ToolTile({ icon, label, missing, onRemove }: { icon: string; label: string; missing?: boolean; onRemove?: () => void }) {
  return (
    <div
      className="agent-loadout-snap inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 relative group"
      style={{
        borderColor: missing ? 'color-mix(in srgb, var(--color-amber) 40%, var(--color-border-subtle))' : 'var(--color-border-subtle)',
        background: missing ? 'color-mix(in srgb, var(--color-amber) 6%, transparent)' : 'var(--color-elevated)',
      }}
      title={missing ? t('agentCard.missingTool', 'Missing tool: {{label}}', { label }) : label}
    >
      <PluginIcon icon={icon} size={18} />
      <span className="text-[11px] text-text-secondary truncate max-w-[100px]">{label}</span>
      {onRemove && (
        <button
          onClick={onRemove}
          className="text-[10px] leading-none text-text-muted hover:text-text opacity-0 group-hover:opacity-100 cursor-pointer"
          aria-label={t('agentCard.removeLabel', 'Remove {{label}}', { label })}
        >
          ×
        </button>
      )}
    </div>
  )
}

function RecipeStrip({
  skillCount,
  toolCount,
  outputStyle,
  tone,
}: {
  skillCount: number
  toolCount: number
  outputStyle: string
  tone: string
}) {
  return (
    <div
      className="text-[10px] text-text-muted rounded-lg px-2.5 py-1.5 border flex items-center gap-1.5 flex-wrap"
      style={{
        background: `color-mix(in srgb, ${tone} 5%, var(--color-elevated))`,
        borderColor: `color-mix(in srgb, ${tone} 18%, var(--color-border-subtle))`,
      }}
    >
      <span>{skillCount} skill{skillCount === 1 ? '' : 's'}</span>
      <span aria-hidden="true">·</span>
      <span>{toolCount} tool{toolCount === 1 ? '' : 's'}</span>
      <span aria-hidden="true" style={{ color: tone }}>→</span>
      <span>produces</span>
      <span className="font-medium" style={{ color: tone }}>{outputStyle}</span>
    </div>
  )
}
