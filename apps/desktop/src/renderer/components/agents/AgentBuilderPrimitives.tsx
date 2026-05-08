import type { ReactNode } from 'react'
import type { CustomAgentConfig } from '@open-cowork/shared'

import { t } from '../../helpers/i18n'

export type WorkbenchTab = 'skills' | 'tools' | 'instructions' | 'inference'

export function WorkbenchTabs({
  tab,
  onChange,
}: {
  tab: WorkbenchTab
  onChange: (next: WorkbenchTab) => void
}) {
  const tabs: Array<{ id: WorkbenchTab; label: string }> = [
    { id: 'skills', label: 'Skills' },
    { id: 'tools', label: 'Tools' },
    { id: 'instructions', label: 'Instructions' },
    { id: 'inference', label: 'Inference' },
  ]
  return (
    <div
      className="flex border-b"
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      {tabs.map((entry) => (
        <button
          key={entry.id}
          onClick={() => onChange(entry.id)}
          className="flex-1 px-3 py-2.5 text-[12px] font-medium cursor-pointer transition-colors"
          style={{
            color: tab === entry.id ? 'var(--color-text)' : 'var(--color-text-muted)',
            background: tab === entry.id ? 'var(--color-surface-active)' : 'transparent',
            borderBottom: tab === entry.id
              ? '2px solid var(--color-accent)'
              : '2px solid transparent',
          }}
        >
          {entry.label}
        </button>
      ))}
    </div>
  )
}

export function ScopeRow({
  draft,
  projectTargetDirectory,
  onScopeChange,
  onChooseDirectory,
}: {
  draft: CustomAgentConfig
  projectTargetDirectory: string | null
  onScopeChange: (scope: 'machine' | 'project') => void
  onChooseDirectory: () => void
}) {
  return (
    <div
      className="rounded-2xl border bg-surface p-4 mb-5"
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[12px] font-medium text-text">{t('agentBuilder.saveThisAgentIn', 'Save this agent in')}</div>
          <div className="text-[11px] text-text-muted mt-0.5">
            {draft.scope === 'project'
              ? projectTargetDirectory || 'Choose a project directory'
              : 'Machine scope — available across all your Cowork sessions'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="flex rounded-lg border overflow-hidden"
            style={{ borderColor: 'var(--color-border-subtle)' }}
          >
            <button
              onClick={() => onScopeChange('machine')}
              className="px-3 py-1.5 text-[12px] font-medium cursor-pointer"
              style={{
                color: draft.scope === 'machine' ? 'var(--color-text)' : 'var(--color-text-muted)',
                background: draft.scope === 'machine' ? 'var(--color-surface-active)' : 'transparent',
              }}
            >
              Machine
            </button>
            <button
              onClick={() => onScopeChange('project')}
              className="px-3 py-1.5 text-[12px] font-medium cursor-pointer"
              style={{
                color: draft.scope === 'project' ? 'var(--color-text)' : 'var(--color-text-muted)',
                background: draft.scope === 'project' ? 'var(--color-surface-active)' : 'transparent',
              }}
            >
              Project
            </button>
          </div>
          {draft.scope === 'project' && (
            <button
              onClick={onChooseDirectory}
              className="px-3 py-1.5 rounded-lg text-[11px] font-medium border border-border-subtle text-accent hover:bg-surface-hover cursor-pointer"
            >
              {projectTargetDirectory ? 'Change' : 'Choose directory'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function InferenceTab({
  draft,
  readOnly,
  onChange,
}: {
  draft: CustomAgentConfig
  readOnly?: boolean
  onChange: (patch: Partial<CustomAgentConfig>) => void
}) {
  const inputClass =
    'w-full px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border'
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-text-muted leading-relaxed">
        Optional overrides that control how this agent runs. Leave empty to inherit the session defaults.
      </p>
      <Field label="Model" hint="Provider/model string (e.g. openrouter/anthropic/claude-sonnet-4)">
        <input
          type="text"
          value={draft.model ?? ''}
          readOnly={readOnly}
          onChange={(event) => onChange({ model: event.target.value.trim() === '' ? null : event.target.value })}
          placeholder="openrouter/anthropic/claude-sonnet-4"
          className={inputClass}
        />
      </Field>
      <Field label="Variant" hint="Optional — reasoning / thinking modes where supported">
        <input
          type="text"
          value={draft.variant ?? ''}
          readOnly={readOnly}
          onChange={(event) => onChange({ variant: event.target.value.trim() === '' ? null : event.target.value })}
          placeholder="reasoning"
          className={inputClass}
        />
      </Field>
      <Field label="Temperature" hint="Lower = deterministic, higher = creative. Leave blank to inherit.">
        <input
          type="number"
          step="0.1"
          min="0"
          max="2"
          value={draft.temperature ?? ''}
          readOnly={readOnly}
          onChange={(event) => {
            const parsed = event.target.value === '' ? null : Number(event.target.value)
            onChange({ temperature: parsed !== null && Number.isFinite(parsed) ? parsed : null })
          }}
          placeholder="0.0 – 2.0"
          className={inputClass}
        />
      </Field>
      <Field label="Max steps" hint="Cap the agent's tool loop to prevent runaway iterations">
        <input
          type="number"
          step="1"
          min="1"
          value={draft.steps ?? ''}
          readOnly={readOnly}
          onChange={(event) => {
            const parsed = event.target.value === '' ? null : Number(event.target.value)
            onChange({ steps: parsed !== null && Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null })
          }}
          placeholder="20"
          className={inputClass}
        />
      </Field>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-text-secondary">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
    </label>
  )
}
