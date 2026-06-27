import { useEffect, useMemo, useState } from 'react'
import type {
  AgentCatalog,
  CustomAgentConfig,
  CustomAgentPermissionOverride,
  ProviderModelDescriptor,
  PublicAppConfig,
} from '@open-cowork/shared'
import {
  computeAgentCapabilityProfile,
} from '@open-cowork/shared'
import { AgentCard } from './AgentCard'
import { AgentAvatar } from './AgentAvatar'
import { t } from '../../helpers/i18n'
import { AgentStaticPreview } from './AgentStaticPreview'
import { AgentCapabilitiesTab } from './AgentCapabilitiesTab'
import { InstructionsTab } from './InstructionsTab'
import {
  InferenceTab,
  ScopeRow,
  WorkbenchTabs,
  resolveAgentBuilderModelSelection,
  type WorkbenchTab,
} from './AgentBuilderPrimitives'
import { AgentPermissionEditor } from './AgentPermissionEditor'
import { buildInitialAgentDraft, type BuilderTarget } from './agent-builder-drafts'
import {
  applyTemplate,
  augmentCatalogForBuiltIn,
  linkedSkillNamesForTool,
  validateAgentDraft,
  type AgentTemplate,
} from './agent-builder-utils'
import { Badge, Button, Card, Icon, SegmentedControl } from '../ui'
import { ConfirmDialog } from '../ConfirmDialog'
import { getStarterTemplates } from './starter-templates'

type Props = {
  target: BuilderTarget
  catalog: AgentCatalog
  appConfig?: PublicAppConfig | null
  existingCustomNames: string[]
  projectDirectory: string | null
  onCancel: () => void
  onSaved: (testAgent?: { name: string; directory?: string | null }) => void
  onTestAgent?: (agentName: string, directory?: string | null) => void
  onOpenCapabilities: () => void
}

type BuilderStep = 'role' | 'abilities' | 'brain' | 'permissions'

const BUILDER_STEPS: Array<{ id: BuilderStep; label: string; detail: string }> = [
  { id: 'role', label: 'Role', detail: 'Mission and starting role' },
  { id: 'abilities', label: 'Abilities', detail: 'Skills and connections' },
  { id: 'brain', label: 'Brain', detail: 'Model and behaviour' },
  { id: 'permissions', label: 'Permissions', detail: 'OpenCode guardrails' },
]

// Single page serving all three agent types. For built-in and runtime
// agents we render the same card + workbench + preview layout but with
// controls disabled. Delete is hidden unless the agent is a custom.
export function AgentBuilderPage({
  target,
  catalog,
  appConfig,
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
  // their native tools so the selected-capabilities summary renders named tiles
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
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false)
  const [tab, setTab] = useState<WorkbenchTab>('capabilities')
  const [step, setStep] = useState<BuilderStep>('role')
  const [projectTargetDirectory, setProjectTargetDirectory] = useState<string | null>(projectDirectory)
  const providers = useMemo(() => appConfig?.providers.available || [], [appConfig?.providers.available])
  const defaultProviderId = appConfig?.providers.defaultProvider || null
  const [catalogOverrides, setCatalogOverrides] = useState<Record<string, ProviderModelDescriptor[]>>({})
  const selectedModel = useMemo(
    () => resolveAgentBuilderModelSelection(draft.model, providers, defaultProviderId, catalogOverrides).model,
    [catalogOverrides, defaultProviderId, draft.model, providers],
  )
  const capabilityProfile = useMemo(
    () => computeAgentCapabilityProfile(draft, selectedModel),
    [draft, selectedModel],
  )

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
  const saveAndTestDisabledReason = draft.mode === 'primary'
    ? t('agents.builder.primaryCannotMentionTest', 'Lead coworkers start chats directly and cannot be tested through an @mention.')
    : draft.enabled === false
      ? t('agents.builder.enableBeforeTest', 'Enable this coworker before testing it in chat.')
      : null

  // Editable flows track whether the draft has diverged from what we loaded so
  // an Escape or Cancel can warn before discarding instead of silently dropping
  // work. Read-only flows are never dirty.
  const isDirty = !readOnly && !saving && draft !== initialDraft
  const requestCancel = () => {
    if (isDirty) {
      setConfirmDiscardOpen(true)
      return
    }
    onCancel()
  }

  // Escape routes through the same cancel guard as the Cancel/back buttons:
  // discard immediately when there is nothing unsaved, otherwise warn first.
  // Mirrors the close-on-Escape pattern in TaskDrillIn/DiffViewer.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (confirmDiscardOpen) return
      if (isDirty) {
        setConfirmDiscardOpen(true)
        return
      }
      onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [confirmDiscardOpen, isDirty, onCancel])

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

  const refreshProviderCatalog = async (providerId: string) => {
    return window.coworkApi.app.refreshProviderCatalog(providerId)
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
    setStep('role')
  }

  const applyStarter = (template: AgentTemplate) => {
    if (target.kind !== 'new') return
    setDraft(buildInitialAgentDraft({
      kind: 'new',
      seed: applyTemplate(template, effectiveCatalog),
    }))
    setStep('role')
  }

  const handleSave = async (options: { testAfterSave?: boolean } = {}) => {
    if (readOnly || issues.length > 0) return
    setSaving(true)
    setError(null)
    try {
      const draftPayload = { ...draft }
      delete draftPayload.permissionOverrides
      const permissionOverrides = draft.permissionOverrides
      const payload: CustomAgentConfig = {
        ...draftPayload,
        directory: draft.scope === 'project' ? projectTargetDirectory || null : null,
        mode: draft.mode === 'primary' ? 'primary' : 'subagent',
        ...(permissionOverrides !== undefined ? { permissionOverrides } : {}),
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
            onClick={requestCancel}
            variant="ghost"
            size="sm"
            leftIcon="chevron-left"
          >
            {t('agents.builder.backToTeam', 'Team')}
          </Button>
          {!readOnly && (
            // The sole primary save lives in the sticky footer action bar below.
            // Up here we only keep Cancel and the secondary Save & Test, which has
            // no footer equivalent, so two primaries never fight for attention.
            <div className="flex items-center gap-2">
              <Button
                onClick={requestCancel}
                variant="ghost"
                size="sm"
              >
                {t('agents.builder.cancel', 'Cancel')}
              </Button>
              <Button
                onClick={() => void handleSave({ testAfterSave: true })}
                disabled={saving || issues.length > 0 || Boolean(saveAndTestDisabledReason)}
                variant="secondary"
                size="md"
                title={saveAndTestDisabledReason || t('agents.builder.saveAndMention', 'Save and insert an @mention into a new chat.')}
              >
                {t('agents.builder.saveAndTest', 'Save & Test')}
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
                  title={t('agents.builder.testInChatTitle', 'Insert this coworker as an @mention in a fresh chat.')}
                >
                  Test in chat
                </Button>
              )}
              <Badge tone="neutral">
                {target.kind === 'builtin'
                  ? 'Built-in - tune via the builtInAgents config block'
                  : 'Runtime-registered - managed by SDK plugin'}
              </Badge>
            </div>
          )}
        </div>

        {error && (
          <div
            className="mb-4 rounded-xl border border-red/30 bg-red/10 px-4 py-3 text-xs text-red"
          >
            {error}
          </div>
        )}

        {issues.length > 0 && (
          <div className="mb-4 rounded-xl border border-border-subtle bg-surface px-4 py-3">
            <div className="text-xs font-medium text-text mb-2">{t('mcpForm.completeBeforeSave', 'Complete these before saving')}</div>
            <div className="flex flex-col gap-1 text-2xs text-text-muted">
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
            capabilityProfile={capabilityProfile}
            readinessIssues={issues}
            selectedModelName={selectedModel?.name || selectedModel?.id || null}
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
            {readOnly ? (
              <WorkbenchTabs tab={tab} onChange={setTab} />
            ) : (
              <BuilderStepNav step={step} onChange={setStep} />
            )}
            <div className="max-h-[640px] overflow-y-auto p-4">
              {!readOnly && step === 'role' && (
                <RoleStep
                  targetKind={target.kind}
                  catalog={effectiveCatalog}
                  draft={draft}
                  onStartBlank={startBlank}
                  onApplyTemplate={applyStarter}
                  onInstructionsChange={(instructions) => setDraft((current) => ({ ...current, instructions }))}
                />
              )}
              {!readOnly && step === 'abilities' && (
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
              {!readOnly && step === 'brain' && (
                <BrainStep
                  draft={draft}
                  providers={providers}
                  defaultProviderId={defaultProviderId}
                  catalogOverrides={catalogOverrides}
                  refreshProviderCatalog={refreshProviderCatalog}
                  onProviderCatalogRefresh={(providerId, models) => {
                    setCatalogOverrides((current) => ({ ...current, [providerId]: models }))
                  }}
                  onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
                />
              )}
              {!readOnly && step === 'permissions' && (
                <PermissionsStep
                  draft={draft}
                  onPermissionOverridesChange={(permissionOverrides) => {
                    setDraft((current) => ({ ...current, permissionOverrides }))
                  }}
                  readOnly={readOnly}
                  catalog={effectiveCatalog}
                />
              )}
              {readOnly && tab === 'capabilities' && (
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
              {readOnly && tab === 'instructions' && (
                <InstructionsTab
                  value={draft.instructions}
                  onChange={(instructions) => setDraft((current) => ({ ...current, instructions }))}
                  readOnly={readOnly}
                />
              )}
              {readOnly && tab === 'inference' && (
                <InferenceTab
                  draft={draft}
                  readOnly={readOnly}
                  providers={providers}
                  defaultProviderId={defaultProviderId}
                  catalogOverrides={catalogOverrides}
                  onProviderCatalogRefresh={(providerId, models) => {
                    setCatalogOverrides((current) => ({ ...current, [providerId]: models }))
                  }}
                  onRefreshProviderCatalog={refreshProviderCatalog}
                  onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
                />
              )}
              {readOnly && tab === 'preview' && (
                <AgentStaticPreview draft={draft} catalog={effectiveCatalog} />
              )}
            </div>
            {!readOnly && (
              // Sticky footer action bar: the single primary Save lives here and
              // stays reachable on every step, so it never competes with a
              // duplicate top-bar save. Step navigation sits to its left.
              <div className="sticky bottom-0 z-10 flex items-center justify-between gap-2 border-t border-border-subtle bg-surface px-4 py-2 text-2xs text-text-muted">
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => {
                      const currentIndex = BUILDER_STEPS.findIndex((entry) => entry.id === step)
                      const previous = BUILDER_STEPS[Math.max(0, currentIndex - 1)]
                      if (previous) setStep(previous.id)
                    }}
                    disabled={step === 'role'}
                    variant="ghost"
                    size="sm"
                    leftIcon="chevron-left"
                  >
                    {t('agents.builder.back', 'Back')}
                  </Button>
                  {step === 'abilities' ? (
                    <Button
                      onClick={onOpenCapabilities}
                      variant="ghost"
                      size="sm"
                      rightIcon="chevron-right"
                    >
                      {t('agents.builder.openToolsAndSkills', 'Open Tools & Skills')}
                    </Button>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {step !== 'permissions' ? (
                    <Button
                      onClick={() => {
                        const currentIndex = BUILDER_STEPS.findIndex((entry) => entry.id === step)
                        const next = BUILDER_STEPS[Math.min(BUILDER_STEPS.length - 1, currentIndex + 1)]
                        if (next) setStep(next.id)
                      }}
                      variant="secondary"
                      size="sm"
                      rightIcon="chevron-right"
                    >
                      {t('agents.builder.continue', 'Continue')}
                    </Button>
                  ) : null}
                  <Button
                    onClick={() => void handleSave()}
                    disabled={issues.length > 0}
                    loading={saving}
                    variant="primary"
                    size="sm"
                  >
                    {target.kind === 'custom' ? t('agents.builder.saveChanges', 'Save changes') : t('agents.builder.hireCoworker', 'Hire coworker')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

      </div>
      <ConfirmDialog
        open={confirmDiscardOpen}
        title={t('agents.builder.discardTitle', 'Discard unsaved changes?')}
        body={t('agents.builder.discardBody', 'Your edits to this coworker have not been saved. Leaving now will discard them.')}
        confirmLabel={t('agents.builder.discardConfirm', 'Discard changes')}
        cancelLabel={t('agents.builder.discardCancel', 'Keep editing')}
        onConfirm={() => {
          setConfirmDiscardOpen(false)
          onCancel()
        }}
        onCancel={() => setConfirmDiscardOpen(false)}
      />
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
        <p className="mt-1 text-xs text-text-muted">
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
              <div className="text-sm font-semibold text-text">{t('agentTemplate.startBlank', 'Start from blank')}</div>
              <div className="mt-1 text-2xs leading-relaxed text-text-muted">
                {t('agentTemplate.startBlankHint', 'No pre-selected tools or instructions - design the agent from scratch.')}
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
                  <div className="text-sm font-semibold text-text">{template.label}</div>
                  <div className="mt-1 line-clamp-2 text-2xs leading-relaxed text-text-muted">{template.description}</div>
                  {availableHints.length ? (
                    <div className="mt-2 flex flex-wrap gap-2 text-2xs text-text-muted">
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

function BuilderStepNav({
  step,
  onChange,
}: {
  step: BuilderStep
  onChange: (next: BuilderStep) => void
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-border-subtle bg-elevated p-2">
      {BUILDER_STEPS.map((entry, index) => {
        const active = step === entry.id
        return (
          <button
            key={entry.id}
            type="button"
            onClick={() => onChange(entry.id)}
            aria-label={entry.label}
            className="flex min-w-[140px] flex-1 items-center gap-2 rounded-xl px-3 py-2 text-start transition-colors"
            style={{
              background: active ? 'var(--color-surface)' : 'transparent',
              color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
              boxShadow: active ? 'var(--shadow-card)' : 'none',
            }}
          >
            <span
              className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-2xs font-bold"
              style={{
                background: active ? 'var(--color-accent)' : 'var(--color-surface)',
                color: active ? 'var(--color-accent-foreground)' : 'var(--color-text-muted)',
                border: active ? '1px solid transparent' : '1px solid var(--color-border-subtle)',
              }}
            >
              {index + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-semibold">{entry.label}</span>
              <span className="block truncate text-2xs opacity-80">{entry.detail}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function RoleStep({
  targetKind,
  catalog,
  draft,
  onStartBlank,
  onApplyTemplate,
  onInstructionsChange,
}: {
  targetKind: BuilderTarget['kind']
  catalog: AgentCatalog
  draft: CustomAgentConfig
  onStartBlank: () => void
  onApplyTemplate: (template: AgentTemplate) => void
  onInstructionsChange: (instructions: string) => void
}) {
  return (
    <div className="flex flex-col gap-5">
      {targetKind === 'new' ? (
        <StarterTemplatePanel
          catalog={catalog}
          onStartBlank={onStartBlank}
          onApplyTemplate={onApplyTemplate}
        />
      ) : null}
      <div>
        <div className="mb-2">
          <h2 className="text-sm font-semibold text-text">Mission instructions</h2>
          <p className="mt-1 text-2xs leading-relaxed text-text-muted">
            This is the system prompt OpenCode runs with. Keep it concrete: responsibilities, boundaries, process, and output shape.
          </p>
        </div>
        <InstructionsTab
          value={draft.instructions}
          onChange={onInstructionsChange}
        />
      </div>
    </div>
  )
}

function BrainStep({
  draft,
  providers,
  defaultProviderId,
  catalogOverrides,
  refreshProviderCatalog,
  onProviderCatalogRefresh,
  onChange,
}: {
  draft: CustomAgentConfig
  providers: PublicAppConfig['providers']['available']
  defaultProviderId: string | null
  catalogOverrides: Record<string, ProviderModelDescriptor[]>
  refreshProviderCatalog: (providerId: string) => Promise<ProviderModelDescriptor[]>
  onProviderCatalogRefresh: (providerId: string, models: ProviderModelDescriptor[]) => void
  onChange: (patch: Partial<CustomAgentConfig>) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <ModeSelector
        value={draft.mode === 'primary' ? 'primary' : 'subagent'}
        onChange={(mode) => onChange({ mode })}
      />
      <InferenceTab
        draft={draft}
        providers={providers}
        defaultProviderId={defaultProviderId}
        catalogOverrides={catalogOverrides}
        onProviderCatalogRefresh={onProviderCatalogRefresh}
        onRefreshProviderCatalog={refreshProviderCatalog}
        onChange={onChange}
      />
    </div>
  )
}

function ModeSelector({
  value,
  onChange,
}: {
  value: 'primary' | 'subagent'
  onChange: (mode: 'primary' | 'subagent') => void
}) {
  const options: Array<{ value: 'primary' | 'subagent'; label: string; detail: string }> = [
    {
      value: 'primary',
      label: 'Lead conversations',
      detail: 'Shows as a primary coworker that can start and steer chats directly.',
    },
    {
      value: 'subagent',
      label: 'Specialist coworker',
      detail: 'Available for other agents to delegate focused work to through OpenCode task routing.',
    },
  ]
  const activeDetail = options.find((option) => option.value === value)?.detail
  return (
    <Card variant="flat" padding="md">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-text">Can they lead?</div>
          <div className="mt-1 text-2xs text-text-muted">
            Saved as OpenCode agent <code className="rounded border border-border-subtle bg-surface px-1">mode</code>.
          </div>
        </div>
      </div>
      <SegmentedControl
        label="Can they lead?"
        value={value}
        onChange={(mode) => onChange(mode as 'primary' | 'subagent')}
        options={options.map((option) => ({ value: option.value, label: option.label }))}
      />
      {activeDetail ? (
        <p className="mt-2 text-2xs leading-relaxed text-text-muted">{activeDetail}</p>
      ) : null}
    </Card>
  )
}

function PermissionsStep({
  draft,
  onPermissionOverridesChange,
  readOnly,
  catalog,
}: {
  draft: CustomAgentConfig
  onPermissionOverridesChange: (overrides: CustomAgentPermissionOverride[]) => void
  readOnly?: boolean
  catalog: AgentCatalog
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold text-text">OpenCode permissions</h2>
        <p className="mt-1 max-w-2xl text-2xs leading-relaxed text-text-muted">
          Selected tools and skills grant the base runtime access. Change a row here only when this coworker needs a
          tighter or broader saved override; read access stays fixed to allow.
        </p>
      </div>
      <AgentPermissionEditor
        value={draft.permissionOverrides}
        onChange={onPermissionOverridesChange}
        readOnly={readOnly}
      />
      <div className="rounded-xl border border-border-subtle bg-surface p-3">
        <div className="mb-2 text-xs font-semibold text-text">OpenCode preview</div>
        <AgentStaticPreview draft={draft} catalog={catalog} />
      </div>
    </div>
  )
}
