import { useEffect, useMemo, useState } from 'react'
import type { AgentCatalog, AgentColor, CustomAgentConfig, CustomAgentSummary } from '@open-cowork/shared'
import { PluginIcon } from '../plugins/PluginIcon'

const COLOR_OPTIONS: Array<{ value: AgentColor; label: string }> = [
  { value: 'accent', label: 'Default Blue' },
  { value: 'primary', label: 'Neutral' },
  { value: 'success', label: 'Green' },
  { value: 'info', label: 'Sky' },
  { value: 'warning', label: 'Amber' },
  { value: 'secondary', label: 'Muted' },
]

const VALID_AGENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function createDraft(agent?: CustomAgentSummary | null, seed?: Partial<CustomAgentConfig> | null): CustomAgentConfig {
  return {
    scope: seed?.scope || agent?.scope || 'machine',
    directory: seed?.scope === 'project'
      ? seed.directory || null
      : agent?.scope === 'project'
        ? agent.directory || null
        : null,
    name: seed?.name || agent?.name || '',
    description: seed?.description || agent?.description || '',
    instructions: seed?.instructions || agent?.instructions || '',
    skillNames: Array.from(new Set([...(agent?.skillNames || []), ...(seed?.skillNames || [])])),
    toolIds: Array.from(new Set([...(agent?.toolIds || []), ...(seed?.toolIds || [])])),
    enabled: seed?.enabled ?? agent?.enabled !== false,
    color: seed?.color || agent?.color || 'accent',
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
        ? 'var(--color-info)'
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
  return draft.description.trim() || 'Describe what this agent is specialized to do.'
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
    color: 'var(--color-info)',
    background: 'color-mix(in srgb, var(--color-info) 12%, transparent)',
  }
}

function linkedSkillNamesForTool(catalog: AgentCatalog, toolId: string) {
  return catalog.skills
    .filter((skill) => (skill.toolIds || []).includes(toolId))
    .map((skill) => skill.name)
}

export function CustomAgentForm(props: {
  agent?: CustomAgentSummary | null
  initialDraft?: Partial<CustomAgentConfig> | null
  catalog: AgentCatalog
  existingAgentNames?: string[]
  projectDirectory?: string | null
  onCancel: () => void
  onSaved: () => void
  onOpenCapabilities: () => void
}) {
  const { agent, initialDraft, catalog, existingAgentNames = [], projectDirectory, onCancel, onSaved, onOpenCapabilities } = props
  const [draft, setDraft] = useState<CustomAgentConfig>(() => createDraft(agent, initialDraft))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [projectTargetDirectory, setProjectTargetDirectory] = useState<string | null>(projectDirectory || null)
  const [scopedCatalog, setScopedCatalog] = useState<AgentCatalog | null>(null)
  const [scopedExistingNames, setScopedExistingNames] = useState<string[]>(existingAgentNames)

  useEffect(() => {
    setDraft(createDraft(agent, initialDraft))
    setError(null)
  }, [agent, initialDraft])

  useEffect(() => {
    if (projectDirectory) {
      setProjectTargetDirectory(projectDirectory)
    }
  }, [projectDirectory])

  useEffect(() => {
    const options = draft.scope === 'project' && projectTargetDirectory
      ? { directory: projectTargetDirectory }
      : undefined

    window.openCowork.agents.catalog(options).then(setScopedCatalog).catch(() => setScopedCatalog(catalog))
    window.openCowork.agents.list(options).then((entries) => {
      setScopedExistingNames((entries || []).map((entry) => entry.name))
    }).catch(() => setScopedExistingNames(existingAgentNames))
  }, [catalog, draft.scope, existingAgentNames, projectTargetDirectory])

  const activeCatalog = scopedCatalog || catalog

  const toolMap = useMemo(
    () => new Map(activeCatalog.tools.map((tool) => [tool.id, tool])),
    [activeCatalog.tools],
  )

  const skillMap = useMemo(
    () => new Map(activeCatalog.skills.map((skill) => [skill.name, skill])),
    [activeCatalog.skills],
  )

  const selectedTools = useMemo(
    () => draft.toolIds.map((id) => toolMap.get(id)).filter(Boolean),
    [draft.toolIds, toolMap],
  )

  const selectedSkills = useMemo(
    () => draft.skillNames.map((name) => skillMap.get(name)).filter(Boolean),
    [draft.skillNames, skillMap],
  )

  const missingTools = useMemo(() => {
    const known = new Set(activeCatalog.tools.map((tool) => tool.id))
    return draft.toolIds.filter((id) => !known.has(id))
  }, [activeCatalog.tools, draft.toolIds])

  const missingSkills = useMemo(() => {
    const known = new Set(activeCatalog.skills.map((skill) => skill.name))
    return draft.skillNames.filter((name) => !known.has(name))
  }, [activeCatalog.skills, draft.skillNames])

  const reservedExamples = useMemo(() => activeCatalog.reservedNames.slice(0, 6).join(', '), [activeCatalog.reservedNames])

  const hasWriteCapabilities = selectedTools.some((tool) => tool?.supportsWrite)
  const normalizedName = draft.name.trim().toLowerCase()
  const localIssues = useMemo(() => {
    const issues: string[] = []
    if (!normalizedName) {
      issues.push('Add an agent id so it can be invoked and routed to.')
    } else if (!VALID_AGENT_NAME.test(normalizedName)) {
      issues.push('Use lowercase letters, numbers, and hyphens only for the agent id.')
    }
    if (activeCatalog.reservedNames.includes(normalizedName)) {
      issues.push(`"${normalizedName}" is reserved by Open Cowork or OpenCode.`)
    }
    if (!agent && normalizedName && scopedExistingNames.includes(normalizedName)) {
      issues.push(`A custom agent named "${normalizedName}" already exists.`)
    }
    if (!draft.description.trim()) {
      issues.push('Add a short description so Open Cowork knows when to use this agent.')
    }
    if (draft.scope === 'project' && !projectTargetDirectory) {
      issues.push('Choose a project directory for this project-scoped agent.')
    }
    if (missingTools.length > 0 || missingSkills.length > 0) {
      issues.push('Remove unavailable tools or skills before saving this agent.')
    }
    return issues
  }, [activeCatalog.reservedNames, agent, draft.description, draft.scope, missingSkills.length, missingTools.length, normalizedName, projectTargetDirectory, scopedExistingNames])

  const chooseProjectDirectory = async () => {
    const selected = await window.openCowork.dialog.selectDirectory()
    if (!selected) return
    setProjectTargetDirectory(selected)
    setDraft((current) => ({ ...current, scope: 'project', directory: selected }))
  }

  const handleSave = async () => {
    if (localIssues.length > 0) return
    setSaving(true)
    setError(null)
    try {
      if (agent) {
        await window.openCowork.agents.update({
          name: agent.name,
          scope: agent.scope,
          directory: agent.directory || null,
        }, {
          ...draft,
          directory: draft.scope === 'project' ? projectTargetDirectory || null : null,
        })
      } else {
        await window.openCowork.agents.create({
          ...draft,
          directory: draft.scope === 'project' ? projectTargetDirectory || null : null,
        })
      }
      onSaved()
    } catch (err: any) {
      setError(err?.message || 'Could not save agent')
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

  const toggleTool = (id: string) => {
    const linkedSkills = linkedSkillNamesForTool(activeCatalog, id)
    setDraft((current) => ({
      ...current,
      ...(current.toolIds.includes(id)
        ? {
            toolIds: current.toolIds.filter((entry) => entry !== id),
            skillNames: current.skillNames.filter((entry) => !linkedSkills.includes(entry)),
          }
        : {
            toolIds: [...current.toolIds, id],
            skillNames: Array.from(new Set([...current.skillNames, ...linkedSkills])),
          }),
    }))
  }

  const removeMissing = (kind: 'skill' | 'tool', value: string) => {
    setDraft((current) => ({
      ...current,
      skillNames: kind === 'skill' ? current.skillNames.filter((entry) => entry !== value) : current.skillNames,
      toolIds: kind === 'tool' ? current.toolIds.filter((entry) => entry !== value) : current.toolIds,
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
            <h1 className="text-[18px] font-semibold text-text mb-1">{agent ? 'Edit agent' : 'Create agent'}</h1>
            <p className="text-[13px] text-text-secondary leading-relaxed">
              Build a focused OpenCode agent by choosing the tools it can use, the skills it may load, and the instructions it should follow.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-[12px] text-text-secondary bg-surface-hover cursor-pointer">Cancel</button>
            <button
              onClick={handleSave}
              disabled={saving || localIssues.length > 0}
              className="px-4 py-2 rounded-lg text-[13px] font-medium transition-colors cursor-pointer disabled:opacity-40"
              style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}
            >
              {saving ? 'Saving…' : agent ? 'Save changes' : 'Create agent'}
            </button>
          </div>
        </div>

        {error ? (
          <div className="mb-4 rounded-xl border border-border-subtle px-4 py-3 text-[12px]" style={{ color: 'var(--color-red)', background: 'color-mix(in srgb, var(--color-red) 8%, transparent)' }}>
            {error}
          </div>
        ) : null}

        {localIssues.length > 0 ? (
          <div className="mb-4 rounded-xl border border-border-subtle px-4 py-3">
            <div className="text-[12px] font-medium text-text mb-2">Complete these before saving</div>
            <div className="flex flex-col gap-1 text-[11px] text-text-muted">
              {localIssues.map((issue) => (
                <div key={issue}>{issue}</div>
              ))}
            </div>
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
              <div className="text-[14px] font-semibold text-text mb-3">How to design a good agent</div>
              <div className="grid grid-cols-3 gap-3">
                {conceptCard('Tools', 'Choose the specific MCP or built-in tools this agent is allowed to use.')}
                {conceptCard('Skills', 'Choose reusable workflows and instructions it is allowed to load while it works.')}
                {conceptCard('Instructions', 'Add the specific tone, priorities, and output format you want from this agent.')}
              </div>
              <div className="mt-4 rounded-xl border border-border-subtle bg-elevated px-3.5 py-3 text-[11px] text-text-muted leading-relaxed">
                This form configures a real OpenCode agent directly with tool access, skill access, and instructions.
              </div>
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              {sectionHeading(1, 'Identity', 'Give the agent a clear job title and explain when Open Cowork should use it.')}
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
                  <span className="text-[10px] text-text-muted">This helps Open Cowork route work to the right agent.</span>
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-4 mb-4">
                <div className="flex flex-col gap-1 min-w-[240px]">
                  <span className="text-[11px] text-text-muted">Save this agent in</span>
                  <div className="flex rounded-lg border border-border-subtle overflow-hidden">
                    <button
                      onClick={() => setDraft((current) => ({ ...current, scope: 'machine', directory: null }))}
                      className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer ${draft.scope === 'machine' ? 'bg-surface-active text-text' : 'text-text-muted'}`}
                    >
                      Cowork only (private)
                    </button>
                    <button
                      onClick={() => setDraft((current) => ({ ...current, scope: 'project', directory: projectTargetDirectory || null }))}
                      className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer ${draft.scope === 'project' ? 'bg-surface-active text-text' : 'text-text-muted'}`}
                    >
                      Project (Cowork only)
                    </button>
                  </div>
                  <span className="text-[10px] text-text-muted">
                    {draft.scope === 'project'
                      ? (projectTargetDirectory || 'Choose a project directory to save this agent into Cowork’s private project agent directory.')
                      : 'Saved into Cowork’s private machine agent directory. This stays separate from your normal CLI OpenCode machine config.'}
                  </span>
                  {draft.scope === 'project' ? (
                    <button
                      onClick={() => void chooseProjectDirectory()}
                      className="mt-2 w-fit px-3 py-1.5 rounded-lg text-[11px] font-medium border border-border-subtle text-accent hover:bg-surface-hover cursor-pointer"
                    >
                      {projectTargetDirectory ? 'Change directory' : 'Choose directory'}
                    </button>
                  ) : null}
                </div>

                <label className="flex items-center gap-2 text-[12px] text-text-secondary">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
                  />
                  Show this agent in chat with @{previewName(draft)}
                </label>
              </div>

              <div>
                <div className="text-[11px] text-text-muted mb-1">Chat label tone</div>
                <div className="text-[11px] text-text-muted mb-2">
                  Use this to visually distinguish the agent in chat and task cards. It does not change permissions or behavior.
                </div>
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
              {sectionHeading(2, 'Tools', 'Choose which tools this agent can use. These are the actual permission boundary for MCP and built-in actions.')}
              <div className="mb-4 rounded-xl border border-border-subtle bg-elevated px-3.5 py-3 text-[11px] text-text-muted leading-relaxed">
                Keep this narrow. A strong agent usually has one or two tools and a clear job instead of broad access to everything.
              </div>

              {activeCatalog.tools.length === 0 ? (
                <div className="text-[12px] text-text-muted py-4 text-center rounded-xl border border-border-subtle border-dashed">
                  No tools are available yet. Add a custom MCP tool from Capabilities.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {activeCatalog.tools.map((tool) => {
                    const selected = draft.toolIds.includes(tool.id)
                    return (
                      <button
                        key={tool.id}
                        onClick={() => toggleTool(tool.id)}
                        className={`flex items-start gap-3 p-3 rounded-xl border text-left transition-colors cursor-pointer ${selected ? 'border-border bg-surface-hover' : 'border-border-subtle hover:bg-surface-hover'}`}
                      >
                        <PluginIcon icon={tool.icon} size={32} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[12px] font-medium text-text">{tool.name}</span>
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={pillStyle(tool.supportsWrite ? 'writeEnabled' : 'readOnly')}>
                              {tool.supportsWrite ? 'Read + write' : 'Read only'}
                            </span>
                            {tool.source === 'builtin' ? (
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={pillStyle('readOnly')}>
                                Built-in
                              </span>
                            ) : null}
                          </div>
                          <div className="text-[11px] text-text-muted leading-relaxed">{tool.description}</div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}

              {missingTools.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {missingTools.map((toolId) => (
                    <button
                      key={toolId}
                      onClick={() => removeMissing('tool', toolId)}
                      className="px-2 py-1 rounded-md text-[10px] border border-border-subtle text-text-muted hover:text-text-secondary cursor-pointer"
                    >
                      Remove missing tool: {toolId}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              {sectionHeading(3, 'Skills', 'Choose which reusable workflows this agent is allowed to load when it works.')}
              <div className="flex items-center justify-between gap-3 mb-4">
                <div className="text-[11px] text-text-muted">
                  Some tools suggest matching skills automatically. You can turn any of them off if you want a narrower agent.
                </div>
                <button onClick={onOpenCapabilities} className="text-[11px] text-accent hover:underline cursor-pointer">
                  Manage custom skills
                </button>
              </div>

              {activeCatalog.skills.length === 0 ? (
                <div className="text-[12px] text-text-muted py-4 text-center rounded-xl border border-border-subtle border-dashed">
                  No skills are available yet. Add a custom skill bundle from Capabilities.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {activeCatalog.skills.map((skill) => {
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
                            {skill.origin === 'opencode' ? (
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={pillStyle('enabled')}>
                                {skill.scope === 'project' ? 'Project' : skill.scope === 'machine' ? 'Machine' : 'OpenCode'}
                              </span>
                            ) : skill.source === 'custom' ? (
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={pillStyle('warning')}>
                                Custom
                              </span>
                            ) : (
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={pillStyle('readOnly')}>
                                Bundled
                              </span>
                            )}
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
              {sectionHeading(4, 'Instructions', 'Tell the agent how to behave, what to prioritize, and how to format its output.')}
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
              <div className="text-[12px] font-semibold text-text mb-3">Agent preview</div>
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
                  <div className="text-text-secondary mb-1">How Open Cowork will route to it</div>
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
                  <div className="text-text-secondary mb-1">Tools it can use</div>
                  {selectedTools.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {selectedTools.map((tool) => (
                        <span key={tool!.id} className="px-2 py-1 rounded-md border border-border-subtle text-[10px] text-text-secondary">
                          {tool!.name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div>No tools selected yet.</div>
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
              <div className="text-[12px] font-semibold text-text mb-2">How Open Cowork will use this</div>
              <div className="flex flex-col gap-2 text-[11px] text-text-muted leading-relaxed">
                <div>1. Open Cowork can delegate work to this agent when the description and instructions match the task.</div>
                <div>2. If it is in chat, users can invoke it directly with @{previewName(draft)}.</div>
                <div>3. Tools give it actions. Skills give it reusable workflows. Instructions shape how it responds.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
