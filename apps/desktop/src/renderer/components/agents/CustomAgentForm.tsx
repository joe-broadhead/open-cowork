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
    enabled: agent?.enabled !== false,
    color: agent?.color || 'accent',
  }
}

function textFieldClass() {
  return 'w-full px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border'
}

function sectionHeading(step: number, title: string, subtitle: string) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold border border-border-subtle text-text-muted bg-elevated">
          {step}
        </span>
        <h2 className="text-[14px] font-semibold text-text">{title}</h2>
      </div>
      <p className="text-[12px] text-text-muted leading-relaxed">{subtitle}</p>
    </div>
  )
}

function conceptCard(title: string, body: string) {
  return (
    <div className="rounded-xl border border-border-subtle bg-elevated px-3.5 py-3">
      <div className="text-[12px] font-medium text-text mb-1">{title}</div>
      <div className="text-[11px] text-text-muted leading-relaxed">{body}</div>
    </div>
  )
}

function colorChipStyle(color: AgentColor) {
  const tone = color === 'success'
    ? 'var(--color-green)'
    : color === 'warning'
      ? 'var(--color-amber)'
      : color === 'info'
        ? 'var(--color-blue, #4da3ff)'
        : color === 'secondary'
          ? 'var(--color-text-secondary)'
          : color === 'primary'
            ? 'var(--color-text)'
            : 'var(--color-accent)'

  return {
    color: tone,
    background: `color-mix(in srgb, ${tone} 12%, transparent)`,
    borderColor: `color-mix(in srgb, ${tone} 18%, var(--color-border))`,
  }
}

function previewName(draft: CustomAgentConfig) {
  return draft.name.trim() || 'new-agent'
}

function previewDescription(draft: CustomAgentConfig) {
  return draft.description.trim() || 'Describe what this sub-agent is specialized to do.'
}

function pillStyle(kind: 'readOnly' | 'writeEnabled' | 'enabled' | 'disabled' | 'warning') {
  if (kind === 'writeEnabled' || kind === 'enabled') {
    return {
      color: 'var(--color-green)',
      background: 'color-mix(in srgb, var(--color-green) 12%, transparent)',
    }
  }

  if (kind === 'warning') {
    return {
      color: 'var(--color-amber)',
      background: 'color-mix(in srgb, var(--color-amber) 12%, transparent)',
    }
  }

  if (kind === 'disabled') {
    return {
      color: 'var(--color-text-muted)',
      background: 'color-mix(in srgb, var(--color-text-muted) 12%, transparent)',
    }
  }

  return {
    color: 'var(--color-blue, #4da3ff)',
    background: 'color-mix(in srgb, var(--color-blue, #4da3ff) 12%, transparent)',
  }
}

function linkedSkillNamesForIntegration(catalog: AgentCatalog, integrationId: string) {
  return catalog.skills
    .filter((skill) => skill.integrationId === integrationId)
    .map((skill) => skill.name)
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

  const integrationMap = useMemo(
    () => new Map(catalog.integrations.map((integration) => [integration.id, integration])),
    [catalog.integrations],
  )

  const skillMap = useMemo(
    () => new Map(catalog.skills.map((skill) => [skill.name, skill])),
    [catalog.skills],
  )

  const selectedIntegrations = useMemo(
    () => draft.integrationIds.map((id) => integrationMap.get(id)).filter(Boolean),
    [draft.integrationIds, integrationMap],
  )

  const selectedSkills = useMemo(
    () => draft.skillNames.map((name) => skillMap.get(name)).filter(Boolean),
    [draft.skillNames, skillMap],
  )

  const missingIntegrations = useMemo(() => {
    const known = new Set(catalog.integrations.map((integration) => integration.id))
    return draft.integrationIds.filter((id) => !known.has(id))
  }, [catalog.integrations, draft.integrationIds])

  const missingSkills = useMemo(() => {
    const known = new Set(catalog.skills.map((skill) => skill.name))
    return draft.skillNames.filter((name) => !known.has(name))
  }, [catalog.skills, draft.skillNames])

  const reservedExamples = useMemo(() => catalog.reservedNames.slice(0, 6).join(', '), [catalog.reservedNames])

  const hasWriteCapabilities = selectedIntegrations.some((integration) => integration?.supportsWrite)

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
    const linkedSkills = linkedSkillNamesForIntegration(catalog, id)
    setDraft((current) => ({
      ...current,
      ...(current.integrationIds.includes(id)
        ? {
            integrationIds: current.integrationIds.filter((entry) => entry !== id),
            skillNames: current.skillNames.filter((entry) => !linkedSkills.includes(entry)),
          }
        : {
            integrationIds: [...current.integrationIds, id],
            skillNames: Array.from(new Set([...current.skillNames, ...linkedSkills])),
          }),
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
      <div className="max-w-[980px] mx-auto px-8 py-8">
        <button onClick={onCancel} className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary cursor-pointer mb-6">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="7,2 3,6 7,10" /></svg>
          Agents
        </button>

        <div className="flex items-start justify-between gap-6 mb-6">
          <div>
            <h1 className="text-[18px] font-semibold text-text mb-1">{agent ? 'Edit sub-agent' : 'Create sub-agent'}</h1>
            <p className="text-[13px] text-text-secondary leading-relaxed">
              Build a focused OpenCode sub-agent by picking what it can access, which skills it may load, and how it should behave.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-[12px] text-text-secondary bg-surface-hover cursor-pointer">Cancel</button>
            <button
              onClick={handleSave}
              disabled={saving || !draft.name.trim() || !draft.description.trim()}
              className="px-4 py-2 rounded-lg text-[13px] font-medium transition-colors cursor-pointer disabled:opacity-40"
              style={{ background: 'var(--color-accent)', color: '#fff' }}
            >
              {saving ? 'Saving…' : agent ? 'Save changes' : 'Create sub-agent'}
            </button>
          </div>
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

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-5">
          <div className="flex flex-col gap-5">
            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              <div className="text-[14px] font-semibold text-text mb-3">How to design a good sub-agent</div>
              <div className="grid grid-cols-3 gap-3">
                {conceptCard('Integrations', 'Choose where the sub-agent can act. These become the MCP tools it is allowed to use.')}
                {conceptCard('Skills', 'Choose reusable workflows and instructions it is allowed to load while it works.')}
                {conceptCard('Instructions', 'Add the specific tone, priorities, and output format you want from this sub-agent.')}
              </div>
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              {sectionHeading(1, 'Identity', 'Give the sub-agent a clear job title and explain when Cowork should use it.')}
              <div className="grid grid-cols-2 gap-4 mb-4">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-text-muted">Agent ID</span>
                  <input
                    type="text"
                    value={draft.name}
                    onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value.toLowerCase() }))}
                    placeholder="e.g. sales-analyst"
                    className={textFieldClass()}
                  />
                  <span className="text-[10px] text-text-muted">Used in chat as @{previewName(draft)}. Reserved IDs like {reservedExamples} cannot be reused.</span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-text-muted">Description</span>
                  <input
                    type="text"
                    value={draft.description}
                    onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                    placeholder="e.g. Analyze revenue trends and produce concise summaries"
                    className={textFieldClass()}
                  />
                  <span className="text-[10px] text-text-muted">This helps Cowork route work to the right sub-agent.</span>
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-4 mb-4">
                <label className="flex items-center gap-2 text-[12px] text-text-secondary">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
                  />
                  Show this sub-agent in chat with @{previewName(draft)}
                </label>
              </div>

              <div>
                <div className="text-[11px] text-text-muted mb-1">Agent color</div>
                <div className="text-[11px] text-text-muted mb-2">This only changes how the agent label looks in chat and task cards.</div>
                <div className="flex flex-wrap gap-2">
                  {COLOR_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => setDraft((current) => ({ ...current, color: option.value }))}
                      className="px-3 py-1.5 rounded-lg text-[12px] border transition-colors cursor-pointer"
                      style={draft.color === option.value
                        ? colorChipStyle(option.value)
                        : {
                            color: 'var(--color-text-muted)',
                            background: 'transparent',
                            borderColor: 'var(--color-border-subtle)',
                          }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              {sectionHeading(2, 'Access', 'Choose which integrations this sub-agent can use. These determine the MCP tools it is allowed to call.')}
              <div className="mb-4 rounded-xl border border-border-subtle bg-elevated px-3.5 py-3 text-[11px] text-text-muted leading-relaxed">
                Keep this narrow. A strong sub-agent usually has one or two apps and a clear job instead of broad access to everything.
              </div>

              {catalog.integrations.length === 0 ? (
                <div className="text-[12px] text-text-muted py-4 text-center rounded-xl border border-border-subtle border-dashed">
                  No eligible integrations are enabled right now. Turn on built-in plugins first.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {catalog.integrations.map((integration) => {
                    const selected = draft.integrationIds.includes(integration.id)
                    return (
                      <button
                        key={integration.id}
                        onClick={() => toggleIntegration(integration.id)}
                        className={`flex items-start gap-3 p-3 rounded-xl border text-left transition-colors cursor-pointer ${selected ? 'border-border bg-surface-hover' : 'border-border-subtle hover:bg-surface-hover'}`}
                      >
                        <PluginIcon icon={integration.icon} size={32} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[12px] font-medium text-text">{integration.name}</span>
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={pillStyle(integration.supportsWrite ? 'writeEnabled' : 'readOnly')}>
                              {integration.supportsWrite ? 'Read + write' : 'Read only'}
                            </span>
                          </div>
                          <div className="text-[11px] text-text-muted leading-relaxed">{integration.description}</div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}

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

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              {sectionHeading(3, 'Skills', 'Choose which reusable workflows this sub-agent is allowed to load when it works.')}
              <div className="flex items-center justify-between gap-3 mb-4">
                <div className="text-[11px] text-text-muted">
                  When you add an app, its linked skills start selected automatically. You can turn any of them off if you want a narrower worker.
                </div>
                <button onClick={onOpenPlugins} className="text-[11px] text-accent hover:underline cursor-pointer">
                  Manage custom skills
                </button>
              </div>

              {catalog.skills.length === 0 ? (
                <div className="text-[12px] text-text-muted py-4 text-center rounded-xl border border-border-subtle border-dashed">
                  No skills are available yet. Add a custom skill or enable a plugin that bundles skills.
                </div>
              ) : (
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
                            {skill.source === 'custom' ? (
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={pillStyle('warning')}>
                                Custom
                              </span>
                            ) : skill.integrationId ? (
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={pillStyle('readOnly')}>
                                From app
                              </span>
                            ) : null}
                          </div>
                          <div className="text-[11px] text-text-muted leading-relaxed">{skill.description}</div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}

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

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              {sectionHeading(4, 'Instructions', 'Tell the sub-agent how to behave, what to prioritize, and how to format its output.')}
              <div className="mb-4 rounded-xl border border-border-subtle bg-elevated px-3.5 py-3 text-[11px] text-text-muted leading-relaxed">
                Good instructions are specific and operational. Tell the agent what to optimize for, what to avoid, and what the final answer should look like.
              </div>
              <textarea
                value={draft.instructions}
                onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))}
                rows={10}
                placeholder="Examples:
- Summarize findings as 3 bullets plus evidence.
- Prefer official docs over blogs.
- Never send email directly; draft only.
- Ask for approval before any external write."
                className="w-full px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border resize-y leading-relaxed"
              />
            </div>
          </div>

          <div className="xl:sticky xl:top-6 self-start flex flex-col gap-4">
            <div className="rounded-xl border border-border-subtle bg-surface p-4">
              <div className="text-[12px] font-semibold text-text mb-3">Sub-agent preview</div>
              <div className="rounded-xl border border-border-subtle bg-elevated p-4 mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-1 rounded-md text-[11px] font-medium border" style={colorChipStyle(draft.color)}>
                    {previewName(draft)}
                  </span>
                  <span className="px-2 py-1 rounded-md text-[10px] font-medium" style={pillStyle(draft.enabled ? 'enabled' : 'disabled')}>
                    {draft.enabled ? 'In chat' : 'Off'}
                  </span>
                </div>
                <div className="text-[11px] text-text-secondary mb-1">Mention with @{previewName(draft)}</div>
                <div className="text-[11px] text-text-muted leading-relaxed">{previewDescription(draft)}</div>
              </div>

              <div className="flex flex-col gap-3 text-[11px] text-text-muted">
                <div>
                  <div className="text-text-secondary mb-1">How Cowork will route to it</div>
                  <div className="text-text-muted leading-relaxed">
                    {previewDescription(draft)}
                  </div>
                </div>
                <div>
                  <div className="text-text-secondary mb-1">Access level</div>
                  <span className="px-2 py-1 rounded-md text-[10px] font-medium" style={pillStyle(hasWriteCapabilities ? 'writeEnabled' : 'readOnly')}>
                    {hasWriteCapabilities ? 'Read + write' : 'Read only'}
                  </span>
                </div>
                <div>
                  <div className="text-text-secondary mb-1">Apps it can use</div>
                  {selectedIntegrations.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {selectedIntegrations.map((integration) => (
                        <span key={integration!.id} className="px-2 py-1 rounded-md border border-border-subtle text-[10px] text-text-secondary">
                          {integration!.name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div>No integrations selected yet.</div>
                  )}
                </div>
                <div>
                  <div className="text-text-secondary mb-1">Skills it can load</div>
                  {selectedSkills.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {selectedSkills.map((skill) => (
                        <span key={skill!.name} className="px-2 py-1 rounded-md border border-border-subtle text-[10px] text-text-secondary">
                          {skill!.label}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div>No skills selected yet.</div>
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-4">
              <div className="text-[12px] font-semibold text-text mb-2">How Cowork will use this</div>
              <div className="flex flex-col gap-2 text-[11px] text-text-muted leading-relaxed">
                <div>1. Cowork can delegate work to this sub-agent when the description and instructions match the task.</div>
                <div>2. If it is in chat, users can invoke it directly with @{previewName(draft)}.</div>
                <div>3. Apps give it tools. Skills give it reusable workflows. Instructions shape how it responds.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
