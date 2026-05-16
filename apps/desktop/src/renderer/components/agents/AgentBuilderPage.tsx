import { useEffect, useMemo, useState } from 'react'
import type {
  AgentCatalog,
  CustomAgentConfig,
} from '@open-cowork/shared'
import { AgentCard } from './AgentCard'
import { t } from '../../helpers/i18n'
import { AgentStaticPreview } from './AgentStaticPreview'
import { AgentCapabilitiesTab } from './AgentCapabilitiesTab'
import { InstructionsTab } from './InstructionsTab'
import { InferenceTab, ScopeRow, WorkbenchTabs, type WorkbenchTab } from './AgentBuilderPrimitives'
import { buildInitialAgentDraft, type BuilderTarget } from './agent-builder-drafts'
import {
  augmentCatalogForBuiltIn,
  linkedSkillNamesForTool,
  validateAgentDraft,
} from './agent-builder-utils'

type Props = {
  target: BuilderTarget
  catalog: AgentCatalog
  existingCustomNames: string[]
  projectDirectory: string | null
  onCancel: () => void
  onSaved: (testAgent?: { name: string; directory?: string | null }) => void
  onTestAgent?: (agentName: string, directory?: string | null) => void
  onOpenCapabilities: () => void
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
  onTestAgent,
  onOpenCapabilities,
}: Props) {
  const readOnly = target.kind !== 'new' && target.kind !== 'custom'
  const typeLabel = target.kind === 'builtin' ? 'Built-in' : target.kind === 'runtime' ? 'Runtime' : 'Custom'
  const canTestReadOnlyAgent = target.kind === 'builtin'
    ? target.agent.mode !== 'primary' && !target.agent.hidden && !target.agent.disabled
    : target.kind === 'runtime'
      ? target.agent.mode !== 'primary' && !target.agent.disabled
      : false

  const initialDraft = useMemo(() => {
    return buildInitialAgentDraft(target)
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
  const [tab, setTab] = useState<WorkbenchTab>('instructions')
  const [projectTargetDirectory, setProjectTargetDirectory] = useState<string | null>(projectDirectory)

  useEffect(() => {
    setDraft(initialDraft)
    setError(null)
  }, [initialDraft])

  useEffect(() => {
    if (projectDirectory) setProjectTargetDirectory(projectDirectory)
  }, [projectDirectory])

  const issues = useMemo(() => {
    if (readOnly) return []
    return validateAgentDraft({
      draft,
      reservedNames: effectiveCatalog.reservedNames,
      existingNames: target.kind === 'custom'
        ? existingCustomNames.filter((name) => name !== target.agent.name)
        : existingCustomNames,
      projectTargetDirectory,
      availableToolIds: effectiveCatalog.tools.map((tool) => tool.id),
      availableSkillNames: effectiveCatalog.skills.map((skill) => skill.name),
    })
  }, [effectiveCatalog, draft, existingCustomNames, projectTargetDirectory, readOnly, target])

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

  const handleSave = async (options: { testAfterSave?: boolean } = {}) => {
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
      onSaved(options.testAfterSave
        ? {
            name: payload.name,
            directory: payload.scope === 'project' ? payload.directory : projectTargetDirectory,
          }
        : undefined)
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
                onClick={() => void handleSave()}
                disabled={saving || issues.length > 0}
                className="px-4 py-2 rounded-lg text-[13px] font-medium transition-colors cursor-pointer disabled:opacity-40"
                style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}
              >
                {saving ? 'Saving…' : target.kind === 'custom' ? 'Save changes' : 'Create agent'}
              </button>
              <button
                onClick={() => void handleSave({ testAfterSave: true })}
                disabled={saving || issues.length > 0 || draft.enabled === false}
                className="px-3 py-2 rounded-lg text-[12px] font-medium transition-colors cursor-pointer disabled:opacity-40 border border-border-subtle text-text-secondary hover:bg-surface-hover"
                title={draft.enabled === false ? 'Enable this agent before testing it in chat.' : 'Save and insert an @mention into a new thread.'}
              >
                Save & Test
              </button>
            </div>
          )}
          {readOnly && (
            <div className="flex items-center gap-2">
              {onTestAgent && canTestReadOnlyAgent && draft.enabled !== false && (
                <button
                  onClick={() => onTestAgent(draft.name, projectTargetDirectory)}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-medium border border-border-subtle text-accent hover:bg-surface-hover cursor-pointer"
                  title="Insert this agent as an @mention in a fresh chat thread."
                >
                  Test in chat
                </button>
              )}
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

        {!readOnly && (
          <ScopeRow
            draft={draft}
            projectTargetDirectory={projectTargetDirectory}
            onScopeChange={(scope) => setDraft((current) => ({ ...current, scope, directory: scope === 'project' ? projectTargetDirectory : null }))}
            onChooseDirectory={() => void chooseProjectDirectory()}
          />
        )}

        <div className="grid grid-cols-1 xl:grid-cols-[380px_minmax(0,1fr)] gap-5 mb-5">
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
              {tab === 'capabilities' && (
                <AgentCapabilitiesTab
                  catalog={effectiveCatalog}
                  selectedSkillNames={draft.skillNames}
                  selectedToolIds={draft.toolIds}
                  onToggleSkill={toggleSkill}
                  onToggleTool={toggleTool}
                  onAutoAttachTools={attachTools}
                  readOnly={readOnly}
                  deniedToolPatterns={draft.deniedToolPatterns || []}
                  onToggleDeniedPattern={toggleDeniedPattern}
                  projectDirectory={projectTargetDirectory}
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
              {tab === 'preview' && (
                <AgentStaticPreview draft={draft} catalog={effectiveCatalog} />
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
                  Open Tools & Skills
                </button>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
