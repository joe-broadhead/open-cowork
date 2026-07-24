import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentBundle, AgentCatalog, BuiltInAgentDetail, CustomAgentConfig, CustomAgentSummary, PublicAppConfig, RuntimeAgentDescriptor, } from '@open-cowork/shared'
import { AgentBuilderPage } from './AgentBuilderPage'
import {
  BuiltInSelectionCard, CustomSelectionCard, RuntimeSelectionCard, } from './AgentSelectionCard'
import { Button, Dialog, EmptyState, ErrorState, Input, SegmentedControl, Skeleton, StudioPageHeader } from '@open-cowork/ui'
import { toast } from '../ui/Toaster'
import { confirmAgentRemoval } from '../../helpers/destructive-actions'
import { t } from '../../helpers/i18n'
import { useSessionStore } from '../../stores/session'
import { useActiveWorkspaceSupport } from '../../stores/workspace-support'
import {
  bundleToAgentConfig,
  decodeAgentBundle,
  defaultBundleFilename,
  encodeAgentBundle,
  stringifyAgentBundle,
} from '../../helpers/agent-bundle'

type Filter = 'all' | 'custom' | 'builtin' | 'runtime' | 'opencode'

// Entry to the builder. The list grid shows every agent (built-in, custom,
// runtime) as a portrait-style card. Clicking one opens the builder.
// Built-in / runtime agents open read-only; customs are full edit.

type SelectedEntry =
  | { kind: 'custom'; name: string }
  | { kind: 'builtin'; name: string }
  | { kind: 'runtime'; name: string }

export function AgentsPage({
  onClose,
  onOpenCapabilities,
  onTestAgent,
  onStartAgentChat,
  initialDraft,
  onClearDraft,
}: {
  onClose: () => void
  onOpenCapabilities: () => void
  onTestAgent?: (agentName: string, directory?: string | null) => void
  onStartAgentChat?: (agentName: string, directory?: string | null) => void
  initialDraft?: Partial<CustomAgentConfig> | null
  onClearDraft?: () => void
}) {
  const [customs, setCustoms] = useState<CustomAgentSummary[]>([])
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null)
  const [appConfig, setAppConfig] = useState<PublicAppConfig | null>(null)
  const [builtinDetails, setBuiltinDetails] = useState<BuiltInAgentDetail[]>([])
  const [runtimeAgents, setRuntimeAgents] = useState<RuntimeAgentDescriptor[]>([])
  const [selected, setSelected] = useState<SelectedEntry | null>(null)
  const [creating, setCreating] = useState(false)
  const [creatingSeed, setCreatingSeed] = useState<Partial<CustomAgentConfig> | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  // When an import collides with an existing custom coworker, we hold the
  // decoded bundle here and surface a styled confirm before overwriting.
  const [importConflict, setImportConflict] = useState<{ name: string } | null>(null)
  const pendingImportBundle = useRef<AgentBundle | null>(null)

  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const sessions = useSessionStore((state) => state.sessions)
  const workspaceSupport = useActiveWorkspaceSupport()
  // Custom coworker authoring edits local machine/runtime config — Desktop local only.
  const canAuthorCustomCoworkers = workspaceSupport.flags.canUseMachineRuntimeConfig
    || workspaceSupport.flags.authority === 'desktop_local'

  const projectDirectory = useMemo(
    () => sessions.find((session) => session.id === currentSessionId)?.directory || null,
    [currentSessionId, sessions],
  )

  const contextOptions = useMemo(
    () => projectDirectory ? { directory: projectDirectory } : undefined,
    [projectDirectory],
  )

  const refresh = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    void Promise.all([
      window.coworkApi.agents.list(contextOptions),
      window.coworkApi.agents.catalog(contextOptions),
      window.coworkApi.app.builtinAgents(),
      window.coworkApi.agents.runtime().catch(() => []),
      window.coworkApi.app.config(),
    ])
      .then(([nextCustoms, nextCatalog, nextBuiltIns, nextRuntimeAgents, nextConfig]) => {
        setCustoms(nextCustoms)
        setCatalog(nextCatalog)
        setBuiltinDetails(nextBuiltIns)
        setRuntimeAgents(nextRuntimeAgents)
        setAppConfig(nextConfig)
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setLoading(false))
  }, [contextOptions])

  useEffect(() => {
    refresh()
    const unsubscribe = window.coworkApi.on.runtimeReady(() => refresh())
    return unsubscribe
  }, [refresh])

  useEffect(() => {
    if (!initialDraft) return
    // External seeders (command palette) bypass starter suggestions; the
    // draft they hand us is the intent.
    setSelected(null)
    setCreatingSeed(initialDraft)
    setCreating(true)
  }, [initialDraft])

  // Any runtime-registered agent that isn't also a built-in or a Cowork
  // custom — these are SDK plugin injections; we still surface them.
  const runtimeUnknown = useMemo(() => {
    const known = new Set<string>()
    for (const agent of builtinDetails) known.add(agent.name)
    for (const agent of customs) known.add(agent.name)
    return runtimeAgents.filter((agent) => !known.has(agent.name))
  }, [builtinDetails, customs, runtimeAgents])

  const filteredCustoms = useMemo(() => (
    customs
      .filter((agent) => matchesSearch(search, agent.name, agent.description, agent.instructions, ...agent.skillNames, ...agent.toolIds))
      .sort(compareCustomAgents)
  ), [customs, search])

  const filteredBuiltIns = useMemo(() => (
    builtinDetails
      .filter((agent) => agent.source === 'open-cowork')
      .filter((agent) => matchesSearch(
        search, agent.label, agent.name, agent.description, agent.instructions,
        ...agent.skills, ...agent.toolAccess,
      ))
      .sort(compareBuiltInAgents)
  ), [builtinDetails, search])

  const filteredRuntime = useMemo(() => (
    runtimeUnknown
      .filter((agent) => matchesSearch(search, agent.name, agent.description || '', ...(agent.toolIds || [])))
      .sort(compareRuntimeAgents)
  ), [runtimeUnknown, search])

  const filteredOpenCode = useMemo(() => (
    builtinDetails
      .filter((agent) => agent.source === 'opencode')
      .filter((agent) => matchesSearch(
        search, agent.label, agent.name, agent.description, agent.instructions,
        ...agent.skills, ...agent.toolAccess,
      ))
      .sort(compareBuiltInAgents)
  ), [builtinDetails, search])

  const selectedCustom = useMemo(
    () => selected?.kind === 'custom'
      ? customs.find((entry) => entry.name === selected.name) || null
      : null,
    [selected, customs],
  )

  const selectedBuiltIn = useMemo(
    () => selected?.kind === 'builtin'
      ? builtinDetails.find((entry) => entry.name === selected.name) || null
      : null,
    [selected, builtinDetails],
  )

  const selectedRuntime = useMemo(
    () => selected?.kind === 'runtime'
      ? runtimeAgents.find((entry) => entry.name === selected.name) || null
      : null,
    [selected, runtimeAgents],
  )

  // Route into the builder
  if (catalog && (creating || selectedCustom || selectedBuiltIn || selectedRuntime)) {
    return (
      <AgentBuilderPage
        target={
          selectedCustom
            ? { kind: 'custom', agent: selectedCustom }
            : selectedBuiltIn
              ? { kind: 'builtin', agent: selectedBuiltIn }
              : selectedRuntime
                ? { kind: 'runtime', agent: selectedRuntime }
                : { kind: 'new', seed: creatingSeed }
        }
        catalog={catalog}
        appConfig={appConfig}
        existingCustomNames={customs.map((entry) => entry.name)}
        projectDirectory={projectDirectory}
        onCancel={() => {
          setSelected(null)
          setCreating(false)
          setCreatingSeed(null)
          onClearDraft?.()
        }}
        onSaved={(testAgent) => {
          setSelected(null)
          setCreating(false)
          setCreatingSeed(null)
          onClearDraft?.()
          refresh()
          if (testAgent) onTestAgent?.(testAgent.name, testAgent.directory ?? projectDirectory)
        }}
        onTestAgent={onTestAgent}
        onOpenCapabilities={onOpenCapabilities}
      />
    )
  }

  const showCustoms = filter === 'all' || filter === 'custom'
  const showBuiltIns = filter === 'all' || filter === 'builtin'
  const showRuntime = (filter === 'all' || filter === 'runtime') && runtimeUnknown.length > 0
  const showOpenCode = filter === 'all' || filter === 'opencode'

  const onExportAgent = async (agent: CustomAgentSummary) => {
    const bundle = encodeAgentBundle(agent)
    await window.coworkApi.dialog.saveText(defaultBundleFilename(agent.name), stringifyAgentBundle(bundle))
  }

  const finalizeImport = async (targetName: string) => {
    const config = bundleToAgentConfig(
      { ...pendingImportBundle.current!, name: targetName },
      projectDirectory
        ? { scope: 'project', directory: projectDirectory }
        : { scope: 'machine' },
    )
    await window.coworkApi.agents.create(config)
    refresh()
    setSelected({ kind: 'custom', name: targetName })
  }

  const onImportAgent = async () => {
    const result = await window.coworkApi.dialog.openJson()
    if (!result) return
    const decoded = decodeAgentBundle(result.content)
    if (!decoded.ok) {
      toast({
        tone: 'error',
        message: t('studioTeamPage.importFailed', 'Could not import {{filename}}: {{error}}', { filename: result.filename, error: decoded.error }),
      })
      return
    }
    const existingNames = new Set(customs.map((entry) => entry.name))
    const targetName = decoded.bundle.name
    pendingImportBundle.current = decoded.bundle
    if (existingNames.has(targetName)) {
      // Surface a styled confirm before overwriting an existing coworker;
      // the replace runs once the user confirms in the dialog.
      setImportConflict({ name: targetName })
      return
    }
    await finalizeImport(targetName)
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="feature-page-shell">
        <StudioPageHeader
          className="mb-6"
          eyebrow={t('studioTeamPage.eyebrow', 'Team')}
          title={t('studioTeamPage.title', 'Coworkers')}
          description={t('studioTeamPage.subtitle', 'Compose OpenCode agents into a coworker roster with clear roles, skills, tools, and chat assignment affordances.')}
          meta={(
            <div className="flex flex-wrap gap-2 text-2xs text-text-muted">
              <span>{customs.length} {t('studioTeamPage.customCount', 'custom')}</span>
              <span>{filteredBuiltIns.length} {t('studioTeamPage.builtInCount', 'built-in')}</span>
              {runtimeUnknown.length > 0 ? <span>{runtimeUnknown.length} {t('studioTeamPage.runtimeCount', 'runtime')}</span> : null}
            </div>
          )}
          actions={[{
            id: 'back-to-chat',
            children: t('agentsPage.backToChat', 'Back to chat'),
            onClick: onClose,
            variant: 'ghost',
          }]}
        />

        <div className="feature-toolbar mb-6">
          <div className="flex-1">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              leftIcon="search"
              clearable
              onClear={() => setSearch('')}
              placeholder={t('studioTeamPage.search', 'Search coworkers, skills, tools, or instructions...')}
            />
          </div>
          <SegmentedControl
            label={t('studioTeamPage.filterLabel', 'Coworker filter')}
            value={filter}
            onChange={(value) => setFilter(value as Filter)}
            options={(['all', 'custom', 'builtin', 'runtime', 'opencode'] as const).map((value) => ({
              value,
              label: value === 'builtin' ? 'Built-in' : value === 'opencode' ? 'OpenCode' : value[0]!.toUpperCase() + value.slice(1),
              disabled: value === 'runtime' && runtimeUnknown.length === 0,
            }))}
          />
          <Button
            variant="secondary"
            size="sm"
            leftIcon="arrow-down"
            onClick={onImportAgent}
            disabled={!canAuthorCustomCoworkers}
            disabledReason={canAuthorCustomCoworkers
              ? undefined
              : t('studioTeamPage.cloudAuthoringBlocked', 'Custom coworker import is Desktop local. Cloud shows policy-safe roster metadata and Start chat only.')}
            title={t('studioTeamPage.importTitle', 'Import a custom coworker from a .cowork-agent.json file')}
          >
            {t('agentsPage.import', 'Import')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            leftIcon="plus"
            disabled={!canAuthorCustomCoworkers}
            disabledReason={canAuthorCustomCoworkers
              ? undefined
              : t('studioTeamPage.cloudAuthoringBlocked', 'Custom coworker authoring is Desktop local. Cloud shows policy-safe roster metadata and Start chat only.')}
            onClick={() => {
              setSelected(null)
              setCreatingSeed(null)
              setCreating(true)
              onClearDraft?.()
            }}
          >
            {t('studioTeamPage.newCoworker', 'New coworker')}
          </Button>
        </div>
        {!canAuthorCustomCoworkers ? (
          <p className="mb-4 text-2xs text-text-muted" role="note">
            {t(
              'studioTeamPage.cloudAuthoringNote',
              'This Cloud workspace lists allowed coworkers. Hire/edit custom coworkers stays on Desktop local (machine runtime config).',
            )}
          </p>
        ) : null}

        {loading && !catalog ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} variant="card" className="h-40" />
            ))}
          </div>
        ) : null}

        {!loading && loadError && !catalog ? (
          <ErrorState
            title={t('studioTeamPage.loadErrorTitle', 'Couldn’t load coworkers')}
            message={t('studioTeamPage.loadErrorBody', 'We couldn’t reach the runtime to load your coworker catalog.')}
            hint={loadError}
            onRetry={refresh}
            retryLabel={t('studioTeamPage.reload', 'Reload')}
          />
        ) : null}

        {loadError && catalog ? (
          <div role="alert" className="mb-4 rounded-md border border-red/30 bg-red/10 px-3 py-2 text-xs text-red">
            <span className="font-semibold">{t('studioTeamPage.refreshFailed', 'Couldn’t refresh coworkers.')}</span> {loadError}
            <Button size="sm" variant="ghost" className="ml-2" onClick={refresh}>
              {t('studioTeamPage.reload', 'Reload')}
            </Button>
          </div>
        ) : null}

        {!(loading && !catalog) && !(loadError && !catalog) && showCustoms && (
          <ListSection
            label={t('studioTeamPage.customSection', 'Custom coworkers')}
            sublabel={t('studioTeamPage.customSectionHelp', 'Built by you; edit, enable, export, or delete from the card.')}
            emptyState={customs.length === 0
              ? t('studioTeamPage.noCustom', 'No custom coworkers yet. Create one to package a repeatable role, instructions, skills, and tools.')
              : t('studioTeamPage.noCustomMatch', 'No custom coworkers matched your search.')}
            empty={filteredCustoms.length === 0}
          >
            {filteredCustoms.map((agent) => (
              <CustomSelectionCard
                key={agent.name}
                agent={agent}
                catalog={catalog}
                onOpen={() => setSelected({ kind: 'custom', name: agent.name })}
                onTest={onTestAgent ? () => onTestAgent(
                  agent.name,
                  agent.scope === 'project' ? agent.directory || projectDirectory : projectDirectory,
                ) : undefined}
                onStartChat={onStartAgentChat ? () => onStartAgentChat(
                  agent.name,
                  agent.scope === 'project' ? agent.directory || projectDirectory : projectDirectory,
                ) : undefined}
                onExport={() => onExportAgent(agent)}
                onDelete={async () => {
                  const target = {
                    name: agent.name,
                    scope: agent.scope,
                    directory: agent.directory || null,
                  } as const
                  const confirmation = await confirmAgentRemoval(target)
                  if (!confirmation) return
                  const ok = await window.coworkApi.agents.remove(target, confirmation.token)
                  if (ok) refresh()
                }}
              />
            ))}
          </ListSection>
        )}

        {!(loading && !catalog) && !(loadError && !catalog) && showBuiltIns && (
          <ListSection
            label={t('studioTeamPage.builtInSection', 'Built-in coworkers')}
            sublabel={t('studioTeamPage.builtInSectionHelp', 'Open Cowork specialists built from bundled skills and tools.')}
            emptyState={t('studioTeamPage.noBuiltInMatch', 'No built-in coworkers matched your search.')}
            empty={filteredBuiltIns.length === 0}
          >
            {filteredBuiltIns.map((agent) => (
              <BuiltInSelectionCard
                key={agent.name}
                agent={agent}
                onOpen={() => setSelected({ kind: 'builtin', name: agent.name })}
                onTest={onTestAgent ? () => onTestAgent(agent.name, projectDirectory) : undefined}
              />
            ))}
          </ListSection>
        )}

        {!(loading && !catalog) && !(loadError && !catalog) && showRuntime && (
          <ListSection
            label={t('studioTeamPage.runtimeSection', 'Runtime-registered coworkers')}
            sublabel={t('studioTeamPage.runtimeSectionHelp', 'Coworkers registered by an SDK plugin; OpenCode still owns their runtime behavior.')}
            emptyState={t('studioTeamPage.noRuntimeMatch', 'No runtime coworkers matched your search.')}
            empty={filteredRuntime.length === 0}
          >
            {filteredRuntime.map((agent) => (
              <RuntimeSelectionCard
                key={agent.name}
                agent={agent}
                onOpen={() => setSelected({ kind: 'runtime', name: agent.name })}
                onTest={onTestAgent ? () => onTestAgent(agent.name, projectDirectory) : undefined}
              />
            ))}
          </ListSection>
        )}

        {!(loading && !catalog) && !(loadError && !catalog) && showOpenCode && (
          <ListSection
            label="OpenCode defaults"
            sublabel="Native OpenCode agents that own core execution behavior."
            emptyState={t('studioTeamPage.noOpenCodeMatch', 'No OpenCode defaults matched your search.')}
            empty={filteredOpenCode.length === 0}
          >
            {filteredOpenCode.map((agent) => (
              <BuiltInSelectionCard
                key={agent.name}
                agent={agent}
                onOpen={() => setSelected({ kind: 'builtin', name: agent.name })}
                onTest={onTestAgent ? () => onTestAgent(agent.name, projectDirectory) : undefined}
              />
            ))}
          </ListSection>
        )}
      </div>

      {importConflict ? (
        <Dialog
          title={t('studioTeamPage.importConflictTitle', 'Replace existing coworker?')}
          size="sm"
          onClose={() => {
            setImportConflict(null)
            pendingImportBundle.current = null
          }}
          footer={(
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setImportConflict(null)
                  pendingImportBundle.current = null
                }}
              >
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const targetName = importConflict.name
                  setImportConflict(null)
                  void finalizeImport(targetName).finally(() => {
                    pendingImportBundle.current = null
                  })
                }}
              >
                {t('studioTeamPage.importConflictReplace', 'Replace')}
              </Button>
            </div>
          )}
        >
          <p className="text-sm text-text-secondary">
            {t('studioTeamPage.importConflict', 'A custom coworker named "{{name}}" already exists. Replace it with the imported one?', { name: importConflict.name })}
          </p>
        </Dialog>
      ) : null}
    </div>
  )
}

function matchesSearch(search: string, ...values: Array<string | undefined | null>) {
  const query = search.trim().toLowerCase()
  if (!query) return true
  return values.some((value) => value?.toLowerCase().includes(query))
}

function compareLabel(a: string | null | undefined, b: string | null | undefined) {
  return (a || '').localeCompare(b || '', undefined, { sensitivity: 'base' })
}

function compareCustomAgents(a: CustomAgentSummary, b: CustomAgentSummary) {
  return compareLabel(a.name, b.name)
}

function compareBuiltInAgents(a: BuiltInAgentDetail, b: BuiltInAgentDetail) {
  return compareLabel(a.label || a.name, b.label || b.name)
}

function compareRuntimeAgents(a: RuntimeAgentDescriptor, b: RuntimeAgentDescriptor) {
  return compareLabel(a.name, b.name)
}

function ListSection({
  label,
  sublabel,
  empty,
  emptyState,
  children,
}: {
  label: string
  sublabel: string
  empty: boolean
  emptyState: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-8">
      <div className="mb-3">
        <h2 className="font-display text-role-section-title font-bold text-text">{label}</h2>
        <p className="text-xs text-text-muted mt-0.5">{sublabel}</p>
      </div>
      {empty ? (
        <EmptyState
          icon="bot"
          title={label}
          body={emptyState}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">{children}</div>
      )}
    </section>
  )
}
