import { useEffect, useMemo, useState } from 'react'
import type { AgentCatalog, AgentColor, CustomAgentConfig, CustomAgentSummary } from '@cowork/shared'
import { PluginIcon } from '../plugins/PluginIcon'

const COLOR_OPTIONS: Array<{ value: AgentColor; label: string }> = [
  { value: 'accent', label: 'Accent' },
  { value: 'primary', label: 'Primary' },
  { value: 'success', label: 'Success' },
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'secondary', label: 'Secondary' },
]

function createDraft(agent?: CustomAgentSummary | null): CustomAgentConfig {
  return {
    name: agent?.name || '',
    description: agent?.description || '',
    instructions: agent?.instructions || '',
    skillNames: [...(agent?.skillNames || [])],
    integrationIds: [...(agent?.integrationIds || [])],
    writeAccess: agent?.writeAccess || false,
    enabled: agent?.enabled !== false,
    color: agent?.color || 'accent',
  }
}

function textFieldClass() {
  return 'w-full px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border'
}

export function CustomAgentForm(props: {
  agent?: CustomAgentSummary | null
  catalog: AgentCatalog
  onCancel: () => void
  onSaved: () => void
  onOpenPlugins: () => void
}) {
  const { agent, catalog, onCancel, onSaved, onOpenPlugins } = props
  const [draft, setDraft] = useState<CustomAgentConfig>(() => createDraft(agent))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(createDraft(agent))
    setError(null)
  }, [agent])

  const selectedIntegrations = useMemo(() => {
    const integrationMap = new Map(catalog.integrations.map((integration) => [integration.id, integration]))
    return draft.integrationIds.map((id) => integrationMap.get(id)).filter(Boolean)
  }, [catalog.integrations, draft.integrationIds])

  const missingIntegrations = useMemo(() => {
    const known = new Set(catalog.integrations.map((integration) => integration.id))
    return draft.integrationIds.filter((id) => !known.has(id))
  }, [catalog.integrations, draft.integrationIds])

  const missingSkills = useMemo(() => {
    const known = new Set(catalog.skills.map((skill) => skill.name))
    return draft.skillNames.filter((name) => !known.has(name))
  }, [catalog.skills, draft.skillNames])

  const canEnableWrite = selectedIntegrations.length > 0 && selectedIntegrations.every((integration) => integration?.supportsWrite)

  useEffect(() => {
    if (!canEnableWrite && draft.writeAccess) {
      setDraft((current) => ({ ...current, writeAccess: false }))
    }
  }, [canEnableWrite, draft.writeAccess])

  const handleSave = async () => {
    if (!draft.name.trim() || !draft.description.trim()) return
    setSaving(true)
    setError(null)
    try {
      if (agent) {
        await window.cowork.agents.update(agent.name, draft)
      } else {
        await window.cowork.agents.create(draft)
      }
      onSaved()
    } catch (err: any) {
      setError(err?.message || 'Could not save sub-agent')
    } finally {
      setSaving(false)
    }
  }

  const toggleSkill = (name: string) => {
    setDraft((current) => ({
      ...current,
      skillNames: current.skillNames.includes(name)
        ? current.skillNames.filter((entry) => entry !== name)
        : [...current.skillNames, name],
    }))
  }

  const toggleIntegration = (id: string) => {
    setDraft((current) => ({
      ...current,
      integrationIds: current.integrationIds.includes(id)
        ? current.integrationIds.filter((entry) => entry !== id)
        : [...current.integrationIds, id],
    }))
  }

  const removeMissing = (kind: 'skill' | 'integration', value: string) => {
    setDraft((current) => ({
      ...current,
      skillNames: kind === 'skill' ? current.skillNames.filter((entry) => entry !== value) : current.skillNames,
      integrationIds: kind === 'integration' ? current.integrationIds.filter((entry) => entry !== value) : current.integrationIds,
    }))
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[760px] mx-auto px-8 py-8">
        <button onClick={onCancel} className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary cursor-pointer mb-6">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="7,2 3,6 7,10" /></svg>
          Agents
        </button>

        <div className="flex items-start justify-between gap-6 mb-6">
          <div>
            <h1 className="text-[18px] font-semibold text-text mb-1">{agent ? 'Edit Sub-Agent' : 'Create Sub-Agent'}</h1>
            <p className="text-[13px] text-text-secondary leading-relaxed">Build a native OpenCode sub-agent with selected skills, allowed integrations, and focused instructions.</p>
          </div>
          <button
            onClick={handleSave}
            disabled={saving || !draft.name.trim() || !draft.description.trim()}
            className="shrink-0 px-4 py-2 rounded-lg text-[13px] font-medium transition-colors cursor-pointer disabled:opacity-40"
            style={{ background: 'var(--color-accent)', color: '#fff' }}
          >
            {saving ? 'Saving…' : agent ? 'Save changes' : 'Create sub-agent'}
          </button>
        </div>

        {error ? (
          <div className="mb-4 rounded-xl border border-border-subtle px-4 py-3 text-[12px]" style={{ color: 'var(--color-red)', background: 'color-mix(in srgb, var(--color-red) 8%, transparent)' }}>
            {error}
          </div>
        ) : null}

        {agent?.issues.length ? (
          <div className="mb-4 rounded-xl border border-border-subtle px-4 py-3">
            <div className="text-[12px] font-medium text-text mb-2">Needs attention</div>
            <div className="flex flex-col gap-1 text-[11px] text-text-muted">
              {agent.issues.map((issue) => (
                <div key={`${issue.code}:${issue.message}`}>{issue.message}</div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-4 mb-6">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Name</span>
            <input
              type="text"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value.toLowerCase() }))}
              placeholder="e.g. sales-analyst"
              className={textFieldClass()}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Description</span>
            <input
              type="text"
              value={draft.description}
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
              placeholder="e.g. Analyze revenue trends and prepare evidence-backed summaries"
              className={textFieldClass()}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 mb-6">
          <span className="text-[11px] text-text-muted">Instructions</span>
          <textarea
            value={draft.instructions}
            onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))}
            rows={8}
            placeholder="Add any sub-agent-specific guidance, formatting rules, or workflow details."
            className="w-full px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border resize-y leading-relaxed"
          />
        </label>

        <div className="flex flex-wrap items-center gap-3 mb-6">
          <label className="flex items-center gap-2 text-[12px] text-text-secondary">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
            />
            Enabled
          </label>
          <label className="flex items-center gap-2 text-[12px] text-text-secondary">
            <input
              type="checkbox"
              checked={draft.writeAccess}
              disabled={!canEnableWrite}
              onChange={(event) => setDraft((current) => ({ ...current, writeAccess: event.target.checked }))}
            />
            Write-enabled
          </label>
          {!canEnableWrite ? (
            <span className="text-[11px] text-text-muted">Write mode is available only when every selected integration has a curated write profile.</span>
          ) : null}
        </div>

        <div className="mb-6">
          <div className="text-[11px] text-text-muted mb-2">Color</div>
          <div className="flex flex-wrap gap-2">
            {COLOR_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => setDraft((current) => ({ ...current, color: option.value }))}
                className={`px-3 py-1.5 rounded-lg text-[12px] border transition-colors cursor-pointer ${draft.color === option.value ? 'text-text border-border' : 'text-text-muted border-border-subtle hover:text-text-secondary hover:bg-surface-hover'}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-6">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <div className="text-[13px] font-semibold text-text">Allowed integrations</div>
              <div className="text-[11px] text-text-muted">Only enabled and configured Cowork integrations can be attached to a custom sub-agent.</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {catalog.integrations.map((integration) => {
              const selected = draft.integrationIds.includes(integration.id)
              return (
                <button
                  key={integration.id}
                  onClick={() => toggleIntegration(integration.id)}
                  className={`flex items-start gap-3 p-3 rounded-xl border text-left transition-colors cursor-pointer ${selected ? 'border-border bg-surface-hover' : 'border-border-subtle hover:bg-surface-hover'}`}
                >
                  <PluginIcon icon={integration.icon} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[12px] font-medium text-text">{integration.name}</span>
                      <span className="text-[10px] text-text-muted">{integration.supportsWrite ? 'Read + write' : 'Read-only'}</span>
                    </div>
                    <div className="text-[11px] text-text-muted leading-relaxed">{integration.description}</div>
                  </div>
                </button>
              )
            })}
          </div>
          {missingIntegrations.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {missingIntegrations.map((integrationId) => (
                <button
                  key={integrationId}
                  onClick={() => removeMissing('integration', integrationId)}
                  className="px-2 py-1 rounded-md text-[10px] border border-border-subtle text-text-muted hover:text-text-secondary cursor-pointer"
                >
                  Remove missing integration: {integrationId}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mb-6">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <div className="text-[13px] font-semibold text-text">Skills</div>
              <div className="text-[11px] text-text-muted">Pick the reusable skills this sub-agent is allowed to load.</div>
            </div>
            <button onClick={onOpenPlugins} className="text-[11px] text-accent hover:underline cursor-pointer">
              Manage custom skills
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {catalog.skills.map((skill) => {
              const selected = draft.skillNames.includes(skill.name)
              return (
                <button
                  key={skill.name}
                  onClick={() => toggleSkill(skill.name)}
                  className={`w-full flex items-start gap-3 p-3 rounded-xl border text-left transition-colors cursor-pointer ${selected ? 'border-border bg-surface-hover' : 'border-border-subtle hover:bg-surface-hover'}`}
                >
                  <div className="w-8 h-8 rounded-lg bg-surface-hover flex items-center justify-center shrink-0">
                    <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="var(--color-amber)" strokeWidth="1.3">
                      <path d="M6 1.5L7.5 4.5L10.5 5L8.25 7.25L8.75 10.5L6 9L3.25 10.5L3.75 7.25L1.5 5L4.5 4.5L6 1.5Z" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[12px] font-medium text-text">{skill.label}</span>
                      <span className="text-[10px] text-text-muted">{skill.source === 'custom' ? 'Custom skill' : 'Bundled skill'}</span>
                    </div>
                    <div className="text-[11px] text-text-muted leading-relaxed">{skill.description}</div>
                  </div>
                </button>
              )
            })}
          </div>
          {missingSkills.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {missingSkills.map((skillName) => (
                <button
                  key={skillName}
                  onClick={() => removeMissing('skill', skillName)}
                  className="px-2 py-1 rounded-md text-[10px] border border-border-subtle text-text-muted hover:text-text-secondary cursor-pointer"
                >
                  Remove missing skill: {skillName}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-[12px] text-text-secondary bg-surface-hover cursor-pointer">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving || !draft.name.trim() || !draft.description.trim()}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-white bg-accent cursor-pointer disabled:opacity-40"
          >
            {saving ? 'Saving…' : agent ? 'Save changes' : 'Create sub-agent'}
          </button>
        </div>
      </div>
    </div>
  )
}
