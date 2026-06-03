import { useEffect, useMemo, useState } from 'react'
import type {
  AgentCatalog,
  CustomAgentConfig,
} from '@open-cowork/shared'
import { AgentCard } from './AgentCard'
import { AgentAvatar } from './AgentAvatar'
import { t } from '../../helpers/i18n'
import { AgentStaticPreview } from './AgentStaticPreview'
import { AgentCapabilitiesTab } from './AgentCapabilitiesTab'
import { InstructionsTab } from './InstructionsTab'
import { InferenceTab, ScopeRow, WorkbenchTabs, type WorkbenchTab } from './AgentBuilderPrimitives'
import { buildInitialAgentDraft, type BuilderTarget } from './agent-builder-drafts'
import {
  applyTemplate,
  augmentCatalogForBuiltIn,
  linkedSkillNamesForTool,
  validateAgentDraft,
  type AgentTemplate,
} from './agent-builder-utils'
import { Badge, Button, Card, Icon } from '../ui'
import { getStarterTemplates } from './starter-templates'

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

  const startBlank = () => {
    if (target.kind !== 'new') return
    setDraft(buildInitialAgentDraft({ kind: 'new', seed: null }))
    setTab('instructions')
  }

  const applyStarter = (template: AgentTemplate) => {
    if (target.kind !== 'new') return
    setDraft(buildInitialAgentDraft({
      kind: 'new',
      seed: applyTemplate(template, effectiveCatalog),
    }))
    setTab('instructions')
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
      <div className="feature-page-shell">
        <div className="flex items-center justify-between mb-5">
          <Button
            onClick={onCancel}
            variant="ghost"
            size="sm"
            leftIcon="chevron-left"
          >
            Agents
          </Button>
          {!readOnly && (
            <div className="flex items-center gap-2">
              <Button
                onClick={onCancel}
                variant="ghost"
                size="sm"
              >
                Cancel
              </Button>
              <Button
                onClick={() => void handleSave()}
                disabled={issues.length > 0}
                loading={saving}
                variant="primary"
                size="md"
              >
                {target.kind === 'custom' ? 'Save changes' : 'Create agent'}
              </Button>
              <Button
                onClick={() => void handleSave({ testAfterSave: true })}
                disabled={saving || issues.length > 0 || draft.enabled === false}
                variant="secondary"
                size="md"
                title={draft.enabled === false ? 'Enable this agent before testing it in chat.' : 'Save and insert an @mention into a new thread.'}
              >
                Save & Test
              </Button>
            </div>
          )}
          {readOnly && (
            <div className="flex items-center gap-2">
              {onTestAgent && canTestReadOnlyAgent && draft.enabled !== false && (
                <Button
                  onClick={() => onTestAgent(draft.name, projectTargetDirectory)}
                  variant="secondary"
                  size="sm"
                  title="Insert this agent as an @mention in a fresh chat thread."
                >
                  Test in chat
                </Button>
              )}
              <Badge tone="neutral">
                {target.kind === 'builtin'
                  ? 'Built-in — tune via the builtInAgents config block'
                  : 'Runtime-registered — managed by SDK plugin'}
              </Badge>
            </div>
          )}
        </div>

        {error && (
          <div
            className="mb-4 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-[12px] text-red-100"
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

        {target.kind === 'new' && (
          <StarterTemplatePanel
            catalog={effectiveCatalog}
            onStartBlank={startBlank}
            onApplyTemplate={applyStarter}
          />
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

          <div className="flex flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface">
            <WorkbenchTabs tab={tab} onChange={setTab} />
            <div className="max-h-[640px] overflow-y-auto p-4">
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
              <div className="flex items-center justify-between border-t border-border-subtle px-4 py-2 text-[10px] text-text-muted">
                <span>{t('agents.openCapabilities', 'Need more tools or skills?')}</span>
                <Button
                  onClick={onOpenCapabilities}
                  variant="ghost"
                  size="sm"
                  rightIcon="chevron-right"
                >
                  Open Tools & Skills
                </Button>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}

function StarterTemplatePanel({
  catalog,
  onStartBlank,
  onApplyTemplate,
}: {
  catalog: AgentCatalog
  onStartBlank: () => void
  onApplyTemplate: (template: AgentTemplate) => void
}) {
  const templates = getStarterTemplates()
  return (
    <section className="mb-5">
      <div className="mb-3">
        <h2 className="font-display text-role-section-title font-bold text-text">{t('agentTemplate.title', 'Start a new agent')}</h2>
        <p className="mt-1 text-[12px] text-text-muted">
          {t('agentTemplate.inlineSubtitle', 'Pick a starter or keep the blank draft; everything remains editable below.')}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card interactive padding="md" className="text-start" onClick={onStartBlank}>
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-dashed border-border-subtle text-text-muted">
              <Icon name="plus" size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-text">{t('agentTemplate.startBlank', 'Start from blank')}</div>
              <div className="mt-1 text-[11px] leading-relaxed text-text-muted">
                {t('agentTemplate.startBlankHint', 'No pre-selected tools or instructions — design the agent from scratch.')}
              </div>
            </div>
          </div>
        </Card>
        {templates.map((template) => {
          const seed = applyTemplate(template, catalog)
          const availableHints = [
            seed.toolIds?.length ? t('agentTemplate.toolHints', '{{count}} tool hint(s)', { count: String(seed.toolIds.length) }) : null,
            seed.skillNames?.length ? t('agentTemplate.skillHints', '{{count}} skill hint(s)', { count: String(seed.skillNames.length) }) : null,
          ].filter(Boolean)
          return (
            <Card key={template.id} interactive padding="md" className="text-start" onClick={() => onApplyTemplate(template)}>
              <div className="flex items-start gap-3">
                <AgentAvatar name={template.label} color={template.color} size="lg" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-text">{template.label}</div>
                  <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-text-muted">{template.description}</div>
                  {availableHints.length ? (
                    <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-text-muted">
                      {availableHints.map((hint) => <span key={hint}>{hint}</span>)}
                    </div>
                  ) : null}
                </div>
              </div>
            </Card>
          )
        })}
      </div>
      <div className="mt-3">
        <Button variant="ghost" size="sm" onClick={onStartBlank} leftIcon="plus">
          {t('agentTemplate.keepBlank', 'Keep blank draft')}
        </Button>
      </div>
    </section>
  )
}
