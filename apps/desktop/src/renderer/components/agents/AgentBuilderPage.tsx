import { useEffect, useMemo, useState } from 'react'
import type {
  AgentCatalog,
  AgentColor,
  BuiltInAgentDetail,
  CustomAgentConfig,
  CustomAgentSummary,
  RuntimeAgentDescriptor,
} from '@open-cowork/shared'
import { AgentCard } from './AgentCard'
import { getBrandName } from '../../helpers/brand'
import { t } from '../../helpers/i18n'
import { AgentStaticPreview } from './AgentStaticPreview'
import { SkillLibraryTab } from './SkillLibraryTab'
import { ToolLibraryTab } from './ToolLibraryTab'
import { InstructionsTab } from './InstructionsTab'
import {
  augmentCatalogForBuiltIn,
  linkedSkillNamesForTool,
  validateAgentDraft,
} from './agent-builder-utils'

type WorkbenchTab = 'skills' | 'tools' | 'instructions' | 'inference'

type BuilderTarget =
  | { kind: 'new'; seed?: Partial<CustomAgentConfig> | null }
  | { kind: 'custom'; agent: CustomAgentSummary }
  | { kind: 'builtin'; agent: BuiltInAgentDetail }
  | { kind: 'runtime'; agent: RuntimeAgentDescriptor }

type Props = {
  target: BuilderTarget
  catalog: AgentCatalog
  existingCustomNames: string[]
  projectDirectory: string | null
  onCancel: () => void
  onSaved: () => void
  onOpenCapabilities: () => void
}

function blankDraft(seed?: Partial<CustomAgentConfig> | null): CustomAgentConfig {
  return {
    scope: seed?.scope || 'machine',
    directory: seed?.scope === 'project' ? seed.directory || null : null,
    name: seed?.name || '',
    description: seed?.description || '',
    instructions: seed?.instructions || '',
    skillNames: Array.from(new Set(seed?.skillNames || [])),
    toolIds: Array.from(new Set(seed?.toolIds || [])),
    enabled: seed?.enabled ?? true,
    color: seed?.color || 'accent',
    avatar: seed?.avatar ?? null,
    model: seed?.model ?? null,
    variant: seed?.variant ?? null,
    temperature: seed?.temperature ?? null,
    top_p: seed?.top_p ?? null,
    steps: seed?.steps ?? null,
    options: seed?.options ?? null,
    deniedToolPatterns: Array.from(new Set(seed?.deniedToolPatterns || [])),
  }
}

function draftFromCustom(agent: CustomAgentSummary): CustomAgentConfig {
  return {
    scope: agent.scope,
    directory: agent.directory ?? null,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    skillNames: [...agent.skillNames],
    toolIds: [...agent.toolIds],
    enabled: agent.enabled,
    color: agent.color,
    avatar: agent.avatar ?? null,
    model: agent.model ?? null,
    variant: agent.variant ?? null,
    temperature: agent.temperature ?? null,
    top_p: agent.top_p ?? null,
    steps: agent.steps ?? null,
    options: agent.options ?? null,
    deniedToolPatterns: [...(agent.deniedToolPatterns || [])],
  }
}

function draftFromBuiltIn(agent: BuiltInAgentDetail): CustomAgentConfig {
  // Built-ins expose tools across three overlapping arrays — `nativeToolIds`
  // (OpenCode built-ins like websearch / webfetch / bash), `configuredToolIds`
  // (Cowork-registered MCPs), and `toolAccess` (free-form labels). Merge
  // the first two so the loadout reflects everything the agent can call.
  // Natives that aren't in the catalog are rendered via a synthetic-entry
  // overlay in `augmentCatalogForBuiltIn`.
  //
  // Built-ins whose `source` is `opencode` have an empty `instructions`
  // string because OpenCode owns their system prompt internally. Showing
  // the generic "No instructions yet — add guidance" placeholder would
  // be misleading for read-only built-ins, so we substitute an accurate
  // note about who owns the prompt.
  const instructions = agent.instructions.trim()
    ? agent.instructions
    : agent.source === 'opencode'
      ? `This agent uses OpenCode's native built-in prompt and behavior. ${getBrandName()} only shapes its tool access, visibility, and UI metadata — the instructions aren't editable here.`
      : agent.instructions
  return {
    scope: 'machine',
    directory: null,
    name: agent.name,
    description: agent.description,
    instructions,
    skillNames: [...agent.skills],
    toolIds: Array.from(new Set([...agent.nativeToolIds, ...agent.configuredToolIds])),
    enabled: !agent.disabled,
    color: (agent.color as AgentColor) || 'accent',
    model: agent.model ?? null,
    variant: agent.variant ?? null,
    temperature: agent.temperature ?? null,
    top_p: agent.top_p ?? null,
    steps: agent.steps ?? null,
    options: agent.options ?? null,
  }
}

function draftFromRuntime(agent: RuntimeAgentDescriptor): CustomAgentConfig {
  return {
    scope: 'machine',
    directory: null,
    name: agent.name,
    description: agent.description || '',
    instructions: '',
    skillNames: [],
    toolIds: [],
    enabled: !agent.disabled,
    color: (agent.color as AgentColor) || 'accent',
    model: agent.model ?? null,
    variant: null,
    temperature: null,
    top_p: null,
    steps: null,
    options: null,
  }
}

// Single page serving all three agent types. For built-in and runtime
// agents we render the same card + workbench + preview layout but with
// controls disabled. Delete is hidden unless the agent is a custom.
export function AgentBuilderPage({
  target,
  catalog,
  existingCustomNames,
  projectDirectory,
  onCancel,
  onSaved,
  onOpenCapabilities,
}: Props) {
  const readOnly = target.kind !== 'new' && target.kind !== 'custom'
  const typeLabel = target.kind === 'builtin' ? 'Built-in' : target.kind === 'runtime' ? 'Runtime' : 'Custom'

  const initialDraft = useMemo(() => {
    if (target.kind === 'new') return blankDraft(target.seed)
    if (target.kind === 'custom') return draftFromCustom(target.agent)
    if (target.kind === 'builtin') return draftFromBuiltIn(target.agent)
    return draftFromRuntime(target.agent)
  }, [target])

  // For built-in agents, overlay the catalog with synthetic entries for
  // their native tools so the loadout renders properly named tiles
  // instead of amber "missing" warnings. Custom / runtime / new flows
  // use the catalog as-is.
  const effectiveCatalog = useMemo(() => {
    if (target.kind === 'builtin') {
      return augmentCatalogForBuiltIn(catalog, target.agent.nativeToolIds)
    }
    return catalog
  }, [catalog, target])

  const [draft, setDraft] = useState<CustomAgentConfig>(initialDraft)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<WorkbenchTab>('skills')
  const [projectTargetDirectory, setProjectTargetDirectory] = useState<string | null>(projectDirectory)

  useEffect(() => {
    setDraft(initialDraft)
    setError(null)
  }, [initialDraft])

  useEffect(() => {
    if (projectDirectory) setProjectTargetDirectory(projectDirectory)
  }, [projectDirectory])

  const missingTools = useMemo(() => {
    const known = new Set(effectiveCatalog.tools.map((tool) => tool.id))
    return draft.toolIds.filter((id) => !known.has(id))
  }, [effectiveCatalog.tools, draft.toolIds])

  const missingSkills = useMemo(() => {
    const known = new Set(effectiveCatalog.skills.map((skill) => skill.name))
    return draft.skillNames.filter((name) => !known.has(name))
  }, [effectiveCatalog.skills, draft.skillNames])

  const issues = useMemo(() => {
    if (readOnly) return []
    return validateAgentDraft({
      draft,
      isExisting: target.kind === 'custom',
      reservedNames: effectiveCatalog.reservedNames,
      existingNames: target.kind === 'custom'
        ? existingCustomNames.filter((name) => name !== target.agent.name)
        : existingCustomNames,
      projectTargetDirectory,
      missingToolCount: missingTools.length,
      missingSkillCount: missingSkills.length,
    })
  }, [effectiveCatalog.reservedNames, draft, existingCustomNames, missingSkills.length, missingTools.length, projectTargetDirectory, readOnly, target])

  const toggleTool = (toolId: string) => {
    const linked = linkedSkillNamesForTool(effectiveCatalog, toolId)
    setDraft((current) => {
      if (current.toolIds.includes(toolId)) {
        // Drop per-method denies belonging to this MCP so they don't
        // silently leak back in if the user re-attaches the tool later.
        const mcpPrefix = `mcp__${toolId}__`
        const nextDenies = (current.deniedToolPatterns || []).filter(
          (pattern) => !pattern.startsWith(mcpPrefix),
        )
        return {
          ...current,
          toolIds: current.toolIds.filter((id) => id !== toolId),
          skillNames: current.skillNames.filter((name) => !linked.includes(name)),
          deniedToolPatterns: nextDenies,
        }
      }
      return {
        ...current,
        toolIds: [...current.toolIds, toolId],
        skillNames: Array.from(new Set([...current.skillNames, ...linked])),
      }
    })
  }

  const toggleDeniedPattern = (pattern: string) => {
    setDraft((current) => {
      const existing = current.deniedToolPatterns || []
      return {
        ...current,
        deniedToolPatterns: existing.includes(pattern)
          ? existing.filter((entry) => entry !== pattern)
          : [...existing, pattern],
      }
    })
  }

  const toggleSkill = (skillName: string) => {
    setDraft((current) => ({
      ...current,
      skillNames: current.skillNames.includes(skillName)
        ? current.skillNames.filter((name) => name !== skillName)
        : [...current.skillNames, skillName],
    }))
  }

  const attachTools = (toolIds: string[]) => {
    setDraft((current) => ({
      ...current,
      toolIds: Array.from(new Set([...current.toolIds, ...toolIds])),
    }))
  }

  const chooseProjectDirectory = async () => {
    const selected = await window.coworkApi.dialog.selectDirectory()
    if (!selected) return
    setProjectTargetDirectory(selected)
    setDraft((current) => ({ ...current, scope: 'project', directory: selected }))
  }

  const handleSave = async () => {
    if (readOnly || issues.length > 0) return
    setSaving(true)
    setError(null)
    try {
      const payload: CustomAgentConfig = {
        ...draft,
        directory: draft.scope === 'project' ? projectTargetDirectory || null : null,
      }
      if (target.kind === 'custom') {
        await window.coworkApi.agents.update(
          { name: target.agent.name, scope: target.agent.scope, directory: target.agent.directory || null },
          payload,
        )
      } else {
        await window.coworkApi.agents.create(payload)
      }
      onSaved()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save agent')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1200px] mx-auto px-8 py-6">
        <div className="flex items-center justify-between mb-5">
          <button
            onClick={onCancel}
            className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary cursor-pointer"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <polyline points="7,2 3,6 7,10" />
            </svg>
            Agents
          </button>
          {!readOnly && (
            <div className="flex items-center gap-2">
              <button
                onClick={onCancel}
                className="px-3 py-1.5 rounded-lg text-[12px] text-text-secondary bg-surface-hover cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || issues.length > 0}
                className="px-4 py-2 rounded-lg text-[13px] font-medium transition-colors cursor-pointer disabled:opacity-40"
                style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}
              >
                {saving ? 'Saving…' : target.kind === 'custom' ? 'Save changes' : 'Create agent'}
              </button>
            </div>
          )}
          {readOnly && (
            <div
              className="text-[11px] px-3 py-1.5 rounded-full"
              style={{
                color: 'var(--color-text-muted)',
                background: 'color-mix(in srgb, var(--color-text-muted) 10%, transparent)',
              }}
            >
              {target.kind === 'builtin'
                ? 'Built-in — tune via the builtInAgents config block'
                : 'Runtime-registered — managed by SDK plugin'}
            </div>
          )}
        </div>

        {error && (
          <div
            className="mb-4 rounded-xl border px-4 py-3 text-[12px]"
            style={{
              color: 'var(--color-red)',
              background: 'color-mix(in srgb, var(--color-red) 8%, transparent)',
              borderColor: 'color-mix(in srgb, var(--color-red) 30%, var(--color-border-subtle))',
            }}
          >
            {error}
          </div>
        )}

        {issues.length > 0 && (
          <div className="mb-4 rounded-xl border border-border-subtle bg-surface px-4 py-3">
            <div className="text-[12px] font-medium text-text mb-2">{t('mcpForm.completeBeforeSave', 'Complete these before saving')}</div>
            <div className="flex flex-col gap-1 text-[11px] text-text-muted">
              {issues.map((issue) => (
                <div key={issue.code}>{issue.message}</div>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-5 mb-5">
          <AgentCard
            draft={draft}
            catalog={effectiveCatalog}
            typeLabel={typeLabel}
            readOnly={readOnly}
            onNameChange={(name) => setDraft((current) => ({ ...current, name }))}
            onDescriptionChange={(description) => setDraft((current) => ({ ...current, description }))}
            onColorChange={(color) => setDraft((current) => ({ ...current, color }))}
            onAvatarChange={(avatar) => setDraft((current) => ({ ...current, avatar }))}
            onToolRemove={(toolId) => toggleTool(toolId)}
            onSkillRemove={(skillName) => toggleSkill(skillName)}
            onEnabledChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
          />

          <div
            className="rounded-2xl border bg-surface flex flex-col overflow-hidden"
            style={{ borderColor: 'var(--color-border-subtle)' }}
          >
            <WorkbenchTabs tab={tab} onChange={setTab} />
            <div className="p-4 overflow-y-auto" style={{ maxHeight: 640 }}>
              {tab === 'tools' && (
                <ToolLibraryTab
                  catalog={effectiveCatalog}
                  selectedToolIds={draft.toolIds}
                  onToggle={toggleTool}
                  readOnly={readOnly}
                  deniedToolPatterns={draft.deniedToolPatterns || []}
                  onToggleDeniedPattern={toggleDeniedPattern}
                  projectDirectory={projectTargetDirectory}
                />
              )}
              {tab === 'skills' && (
                <SkillLibraryTab
                  catalog={effectiveCatalog}
                  selectedSkillNames={draft.skillNames}
                  selectedToolIds={draft.toolIds}
                  onToggle={toggleSkill}
                  onAutoAttachTools={attachTools}
                  readOnly={readOnly}
                />
              )}
              {tab === 'instructions' && (
                <InstructionsTab
                  value={draft.instructions}
                  onChange={(instructions) => setDraft((current) => ({ ...current, instructions }))}
                  readOnly={readOnly}
                />
              )}
              {tab === 'inference' && (
                <InferenceTab
                  draft={draft}
                  readOnly={readOnly}
                  onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
                />
              )}
            </div>
            {!readOnly && (
              <div
                className="border-t px-4 py-2 text-[10px] text-text-muted flex items-center justify-between"
                style={{ borderColor: 'var(--color-border-subtle)' }}
              >
                <span>{t('agents.openCapabilities', 'Need more tools or skills?')}</span>
                <button
                  onClick={onOpenCapabilities}
                  className="text-accent hover:underline cursor-pointer"
                >
                  Open Capabilities
                </button>
              </div>
            )}
          </div>
        </div>

        {!readOnly && (
          <ScopeRow
            draft={draft}
            projectTargetDirectory={projectTargetDirectory}
            onScopeChange={(scope) => setDraft((current) => ({ ...current, scope, directory: scope === 'project' ? projectTargetDirectory : null }))}
            onChooseDirectory={() => void chooseProjectDirectory()}
          />
        )}

        <AgentStaticPreview draft={draft} catalog={effectiveCatalog} />
      </div>
    </div>
  )
}

function WorkbenchTabs({
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

function ScopeRow({
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

function InferenceTab({
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
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-text-secondary">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
    </label>
  )
}
