import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  BuiltInAgentDetail,
  CapabilitySkill,
  CapabilitySkillBundle,
  CapabilityTool,
  CustomAgentConfig,
  CustomAgentSummary,
  CustomMcpConfig,
  CustomSkillConfig,
  RuntimeToolDescriptor,
  WorkflowListPayload,
} from '@open-cowork/shared'
import { CustomMcpForm } from '../plugins/CustomMcpForm'
import { CustomSkillForm } from '../plugins/CustomSkillForm'
import { Button, Card, IconButton, Input, SegmentedControl, Skeleton, Tooltip } from '../ui'
import { useSessionStore } from '../../stores/session'
import { confirmMcpRemoval, confirmSkillRemoval } from '../../helpers/destructive-actions'
import { SkillSelectionCard, ToolSelectionCard } from './CapabilitySelectionCard'
import { t } from '../../helpers/i18n'
import {
  buildCapabilityMapGroups,
  buildCapabilityMapSections,
  buildCapabilityToolSections,
  buildCapabilityRelationshipRows,
  buildAgentSeedFromSkill,
  buildAgentSeedFromTool,
  isCapabilityRelationshipGraphEnabled,
  linkedSkillsForTool,
  linkedToolsForSkill,
  mergedRuntimeToolset,
  safeText,
  skillMatchesCapabilityQuery,
  toolMatchesCapabilityQuery,
  type Selection,
  type Tab,
} from './capabilities-page-support.ts'
import { EmptyGrid } from './capabilities-page-components.tsx'
import { CapabilitySkillDetailView, CapabilityToolDetailView } from './CapabilitiesDetailViews'
import { CapabilityMapView } from './CapabilityMapView'
import { CapabilityRelationshipView } from './CapabilityRelationshipView'

export function CapabilitiesPage({
  onClose,
  onCreateAgent,
}: {
  onClose: () => void
  onCreateAgent: (seed: Partial<CustomAgentConfig>) => void
}) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const sessions = useSessionStore((state) => state.sessions)
  const [tab, setTab] = useState<Tab>('map')
  const [search, setSearch] = useState('')
  const [tools, setTools] = useState<CapabilityTool[]>([])
  const [skills, setSkills] = useState<CapabilitySkill[]>([])
  const [customMcps, setCustomMcps] = useState<CustomMcpConfig[]>([])
  const [customSkills, setCustomSkills] = useState<CustomSkillConfig[]>([])
  // Each pair drives one form surface. `null` hides it; `'new'` opens a
  // blank form; a CustomMcpConfig / CustomSkillConfig opens the form in
  // edit mode seeded with that bundle's current state.
  const [mcpForm, setMcpForm] = useState<'new' | CustomMcpConfig | null>(null)
  const [skillForm, setSkillForm] = useState<'new' | CustomSkillConfig | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [runtimeTools, setRuntimeTools] = useState<RuntimeToolDescriptor[]>([])
  const [customAgents, setCustomAgents] = useState<CustomAgentSummary[]>([])
  const [builtInAgents, setBuiltInAgents] = useState<BuiltInAgentDetail[]>([])
  const [workflowList, setWorkflowList] = useState<WorkflowListPayload | null>(null)
  const [selectedToolDetail, setSelectedToolDetail] = useState<CapabilityTool | null>(null)
  const [selectedSkillBundle, setSelectedSkillBundle] = useState<CapabilitySkillBundle | null>(null)
  const [loading, setLoading] = useState(true)
  const relationshipEnabled = isCapabilityRelationshipGraphEnabled()

  const currentProjectDirectory = useMemo(
    () => sessions.find((session) => session.id === currentSessionId)?.directory || null,
    [currentSessionId, sessions],
  )
  const toolOptions = useMemo(
    () => currentSessionId ? { sessionId: currentSessionId } : undefined,
    [currentSessionId],
  )
  const contextOptions = useMemo(
    () => currentProjectDirectory ? { directory: currentProjectDirectory } : undefined,
    [currentProjectDirectory],
  )

  const loadAll = useCallback(() => {
    setLoading(true)
    const base = Promise.all([
      window.coworkApi.capabilities.tools(toolOptions),
      window.coworkApi.capabilities.skills(contextOptions),
      window.coworkApi.custom.listMcps(contextOptions),
      window.coworkApi.custom.listSkills(contextOptions),
      window.coworkApi.tools.list(toolOptions).catch(() => []),
    ]).then(([nextTools, nextSkills, nextMcps, nextCustomSkills, nextRuntimeTools]) => {
      setTools(nextTools)
      setSkills(nextSkills)
      setCustomMcps(nextMcps)
      setCustomSkills(nextCustomSkills)
      setRuntimeTools(nextRuntimeTools)
    })
    const relationships = relationshipEnabled
      ? Promise.all([
          window.coworkApi.agents.list(contextOptions).catch(() => []),
          window.coworkApi.app.builtinAgents().catch(() => []),
          window.coworkApi.workflows.list().catch(() => null),
        ]).then(([nextCustomAgents, nextBuiltInAgents, nextWorkflowList]) => {
          setCustomAgents(nextCustomAgents)
          setBuiltInAgents(nextBuiltInAgents)
          setWorkflowList(nextWorkflowList)
        })
      : Promise.resolve().then(() => {
          setCustomAgents([])
          setBuiltInAgents([])
          setWorkflowList(null)
        })
    void Promise.all([base, relationships]).finally(() => setLoading(false))
  }, [contextOptions, relationshipEnabled, toolOptions])

  useEffect(() => {
    loadAll()
    const unsubscribe = window.coworkApi.on.runtimeReady(() => loadAll())
    return unsubscribe
  }, [loadAll])

  useEffect(() => {
    if (selection?.type !== 'tool') {
      setSelectedToolDetail(null)
      return
    }

    window.coworkApi.capabilities.tool(selection.id, toolOptions).then(setSelectedToolDetail).catch(() => setSelectedToolDetail(null))
    window.coworkApi.tools.list(toolOptions).then(setRuntimeTools).catch(() => setRuntimeTools([]))
  }, [selection, toolOptions])

  useEffect(() => {
    if (selection?.type !== 'skill') {
      setSelectedSkillBundle(null)
      return
    }

    window.coworkApi.capabilities.skillBundle(selection.name, contextOptions).then(setSelectedSkillBundle).catch(() => setSelectedSkillBundle(null))
  }, [selection, contextOptions])

  const customToolIds = useMemo(
    () => new Set(customMcps.map((entry) => entry.name)),
    [customMcps],
  )
  const customSkillNames = useMemo(
    () => new Set(customSkills.map((entry) => entry.name)),
    [customSkills],
  )
  const mapGroups = useMemo(
    () => buildCapabilityMapGroups(tools, skills, search),
    [search, skills, tools],
  )
  const filteredTools = useMemo(() => (
    tools
      .filter((tool) => toolMatchesCapabilityQuery(tool, skills, search))
  ), [search, skills, tools])

  const filteredSkills = useMemo(() => (
    skills
      .filter((skill) => skillMatchesCapabilityQuery(skill, tools, search))
      .sort((a, b) => safeText(a.label).localeCompare(safeText(b.label), undefined, { sensitivity: 'base' }))
  ), [search, skills, tools])
  const filteredSkillGroups = useMemo(
    () => mapGroups.filter((group) => group.skills.length > 0),
    [mapGroups],
  )
  const toolSections = useMemo(
    () => buildCapabilityToolSections(filteredTools),
    [filteredTools],
  )
  const skillSections = useMemo(
    () => buildCapabilityMapSections(filteredSkillGroups),
    [filteredSkillGroups],
  )
  const relationshipRows = useMemo(
    () => {
      if (!relationshipEnabled) return []
      return buildCapabilityRelationshipRows({
        tools,
        skills,
        runtimeTools,
        capabilityRisks: [],
        customAgents,
        builtInAgents,
        workflows: workflowList,
        query: search,
      })
    },
    [builtInAgents, customAgents, relationshipEnabled, runtimeTools, search, skills, tools, workflowList],
  )
  const allRelationshipRows = useMemo(
    () => {
      if (!relationshipEnabled) return []
      return buildCapabilityRelationshipRows({
        tools,
        skills,
        runtimeTools,
        capabilityRisks: [],
        customAgents,
        builtInAgents,
        workflows: workflowList,
      })
    },
    [builtInAgents, customAgents, relationshipEnabled, runtimeTools, skills, tools, workflowList],
  )
  const selectedTool = selection?.type === 'tool'
    ? selectedToolDetail || tools.find((tool) => tool.id === selection.id) || null
    : null
  const selectedSkill = selection?.type === 'skill'
    ? skills.find((skill) => skill.name === selection.name) || null
    : null

  if (mcpForm) {
    return (
      <CustomMcpForm
        projectDirectory={currentProjectDirectory}
        existing={mcpForm === 'new' ? null : mcpForm}
        onSave={() => { setMcpForm(null); loadAll() }}
        onCancel={() => setMcpForm(null)}
      />
    )
  }

  if (skillForm) {
    return (
      <CustomSkillForm
        projectDirectory={currentProjectDirectory}
        existing={skillForm === 'new' ? null : skillForm}
        onSave={() => { setSkillForm(null); loadAll() }}
        onCancel={() => setSkillForm(null)}
      />
    )
  }

  if (selectedTool) {
    const custom = customMcps.find((entry) => entry.name === selectedTool.id) || null
    const availableTools = mergedRuntimeToolset(selectedTool, runtimeTools)
    const linkedSkills = linkedSkillsForTool(selectedTool, skills)

    return (
      <CapabilityToolDetailView
        selectedTool={selectedTool}
        custom={custom}
        availableTools={availableTools}
        linkedSkills={linkedSkills}
        onBack={() => setSelection(null)}
        onCreateAgent={() => onCreateAgent(buildAgentSeedFromTool(selectedTool))}
        onEditTool={() => {
          if (custom) setMcpForm(custom)
        }}
        onRemoveTool={async () => {
          if (!custom) return
          const target = {
            name: custom.name,
            scope: custom.scope,
            directory: custom.directory || null,
          } as const
          const confirmation = await confirmMcpRemoval(target)
          if (!confirmation) return
          const ok = await window.coworkApi.custom.removeMcp(target, confirmation.token)
          if (!ok) return
          setSelection(null)
          loadAll()
        }}
        onOpenSkill={(skillName) => setSelection({ type: 'skill', name: skillName })}
      />
    )
  }

  if (selectedSkill) {
    const custom = customSkills.find((entry) => entry.name === selectedSkill.name) || null
    const bundle = selectedSkillBundle || null
    const linkedTools = linkedToolsForSkill(selectedSkill, tools)

    return (
      <CapabilitySkillDetailView
        selectedSkill={selectedSkill}
        custom={custom}
        bundle={bundle}
        linkedTools={linkedTools}
        contextOptions={contextOptions}
        onBack={() => setSelection(null)}
        onCreateAgent={() => onCreateAgent(buildAgentSeedFromSkill(selectedSkill))}
        onEditSkill={() => {
          if (custom) setSkillForm(custom)
        }}
        onRemoveSkill={async () => {
          if (!custom) return
          const target = {
            name: custom.name,
            scope: custom.scope,
            directory: custom.directory || null,
          } as const
          const confirmation = await confirmSkillRemoval(target)
          if (!confirmation) return
          const ok = await window.coworkApi.custom.removeSkill(target, confirmation.token)
          if (!ok) return
          setSelection(null)
          loadAll()
        }}
        onOpenTool={(toolId) => setSelection({ type: 'tool', id: toolId })}
      />
    )
  }

  const searchPlaceholder = tab === 'map'
    ? t('capabilities.searchMap', 'Search tools, skills, linked capabilities, or coworkers...')
    : tab === 'relationships'
      ? t('capabilities.searchRelationships', 'Search capabilities, coworkers, playbooks, risks, credentials, or policies...')
      : tab === 'tools'
        ? t('capabilities.searchTools', 'Search connections, descriptions, or coworkers...')
        : t('capabilities.searchSkills', 'Search abilities, descriptions, or coworkers...')
  const addButtonLabel = tab === 'skills'
    ? t('capabilities.addSkillButton', 'Add ability')
    : t('capabilities.addTool', 'Add connection')
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="feature-page-shell">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-display text-role-page-title font-bold text-text">{t('capabilities.title', 'Tools & Skills')}</h1>
              <GlossaryHelp />
            </div>
            <p className="text-sm text-text-secondary mt-1">
              {t('capabilities.subtitle', 'Inspect the OpenCode tools and skills available to coworkers and playbooks in the current workspace.')}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('agentsPage.backToChat', 'Back to chat')}</Button>
        </div>

        <div className="feature-toolbar mb-3">
          <div className="flex-1">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              leftIcon="search"
              clearable
              onClear={() => setSearch('')}
              placeholder={searchPlaceholder}
            />
          </div>
          <SegmentedControl
            label={t('capabilities.tabLabel', 'Tools and skills view')}
            value={tab}
            onChange={(value) => setTab(value as Tab)}
            options={([
              'map',
              ...(relationshipEnabled ? ['relationships' as const] : []),
              'tools',
              'skills',
            ] as const).map((value) => ({
              value,
              label: value === 'map'
                ? t('capabilities.tab.map', 'Tools & Skills')
                : value === 'relationships'
                  ? t('capabilities.tab.relationships', 'Relationships')
                  : value === 'tools'
                    ? t('capabilities.tab.tools', 'Connections')
                    : t('capabilities.tab.skills', 'Abilities'),
            }))}
          />
          <Button
            variant="primary"
            size="sm"
            leftIcon="plus"
            onClick={() => tab === 'skills' ? setSkillForm('new') : setMcpForm('new')}
          >
            {addButtonLabel}
          </Button>
        </div>
        {!relationshipEnabled ? (
          <Card padding="sm" className="mb-6 text-2xs text-text-muted">
            {t('capabilities.relationshipsDisabled', 'The relationship view is available behind the Tools & Skills relationship feature flag. The main tools and skills lists remain available here.')}
          </Card>
        ) : (
          <div className="mb-6" />
        )}

        {loading && tools.length === 0 && skills.length === 0 ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} variant="card" className="h-36" />
            ))}
          </div>
        ) : tab === 'relationships' && relationshipEnabled ? (
          <CapabilityRelationshipView
            rows={relationshipRows}
            allRowsCount={allRelationshipRows.length}
            onOpenTool={(toolId) => setSelection({ type: 'tool', id: toolId })}
            onOpenSkill={(skillName) => setSelection({ type: 'skill', name: skillName })}
          />
        ) : tab === 'map' ? (
          <CapabilityMapView
            groups={mapGroups}
            tools={tools}
            skills={skills}
            customToolIds={customToolIds}
            customSkillNames={customSkillNames}
            runtimeTools={runtimeTools}
            search={search}
            onOpenTool={(toolId) => setSelection({ type: 'tool', id: toolId })}
            onOpenSkill={(skillName) => setSelection({ type: 'skill', name: skillName })}
            onAddTool={() => setMcpForm('new')}
            onAddSkill={() => setSkillForm('new')}
          />
        ) : tab === 'tools' ? (
          filteredTools.length === 0 ? (
            <EmptyGrid message={tools.length === 0
              ? t('capabilities.noToolsDiscovered', 'No tools discovered yet. Add a custom MCP to extend the runtime.')
              : t('capabilities.noToolsMatch', 'No tools matched your search.')} />
          ) : (
            <div className="flex flex-col gap-5">
              {toolSections.map((section) => (
                <section key={section.id} className="flex flex-col gap-2.5">
                  <CapabilitySectionHeading section={section} count={section.tools.length} unit="tool" />
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {section.tools.map((tool) => {
                      const custom = customMcps.find((entry) => entry.name === tool.id)
                      const availableCount = mergedRuntimeToolset(tool, runtimeTools).length
                      return (
                        <ToolSelectionCard
                          key={tool.id}
                          tool={tool}
                          methodsCount={availableCount}
                          isCustom={Boolean(custom)}
                          linkedSkills={linkedSkillsForTool(tool, skills)}
                          onOpen={() => setSelection({ type: 'tool', id: tool.id })}
                          onRemove={custom
                            ? async () => {
                                const target = {
                                  name: custom.name,
                                  scope: custom.scope,
                                  directory: custom.directory || null,
                                } as const
                                const confirmation = await confirmMcpRemoval(target)
                                if (!confirmation) return
                                const ok = await window.coworkApi.custom.removeMcp(target, confirmation.token)
                                if (!ok) return
                                loadAll()
                              }
                            : undefined}
                        />
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          )
        ) : (
          filteredSkills.length === 0 ? (
            <EmptyGrid message={skills.length === 0
              ? t('capabilities.noSkillsDiscovered', 'No skills discovered yet. Add a custom skill bundle to extend agents.')
              : t('capabilities.noSkillsMatch', 'No skills matched your search.')} />
          ) : (
            <div className="flex flex-col gap-5">
              {skillSections.map((section) => (
                <section key={section.id} className="flex flex-col gap-2.5">
                  <CapabilitySectionHeading section={section} count={section.groups.length} unit="group" />
                  <div className="flex flex-col gap-4">
                    {section.groups.map((group) => (
                      <Card key={group.id} padding="sm">
                        <div className="flex items-center justify-between gap-3 mb-3">
                          <div>
                            <div className="text-xs font-semibold text-text">{group.label}</div>
                            <div className="text-2xs text-text-muted">
                              {group.type === 'tool'
                                ? t('capabilities.skillsLinkedToTool', 'Skills linked to this tool')
                                : t('capabilities.standaloneSkillsHelp', 'Skills without a resolved tool link.')}
                            </div>
                          </div>
                          {group.tool ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setSelection({ type: 'tool', id: group.tool!.id })}
                            >
                              Open tool
                            </Button>
                          ) : null}
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                          {group.skills.map((skill) => {
                            const custom = customSkills.find((entry) => entry.name === skill.name)
                            return (
                              <SkillSelectionCard
                                key={`${group.id}:${skill.name}`}
                                skill={skill}
                                isCustom={Boolean(custom)}
                                linkedTools={linkedToolsForSkill(skill, tools)}
                                onOpen={() => setSelection({ type: 'skill', name: skill.name })}
                                onRemove={custom
                                  ? async () => {
                                      const target = {
                                        name: custom.name,
                                        scope: custom.scope,
                                        directory: custom.directory || null,
                                      } as const
                                      const confirmation = await confirmSkillRemoval(target)
                                      if (!confirmation) return
                                      const ok = await window.coworkApi.custom.removeSkill(target, confirmation.token)
                                      if (!ok) return
                                      loadAll()
                                    }
                                  : undefined}
                              />
                            )
                          })}
                        </div>
                      </Card>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}

function GlossaryHelp() {
  return (
    <Tooltip
      side="bottom"
      content={(
        <span>
          MCP means Model Context Protocol. Tools let agents call integrations. Skills are reusable instructions. Capabilities are the combined tools and skills an agent can use.
        </span>
      )}
    >
      <IconButton icon="circle-help" label={t('capabilities.glossary', 'Glossary')} size="sm" variant="ghost" />
    </Tooltip>
  )
}

function CapabilitySectionHeading({
  section,
  count,
  unit,
}: {
  section: { label: string; description: string }
  count: number
  unit: 'tool' | 'group'
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2 px-0.5">
      <div>
        <h2 className="font-display text-role-card-title font-bold text-text">{section.label}</h2>
        <p className="mt-0.5 text-2xs text-text-muted">{section.description}</p>
      </div>
      <span className="text-2xs text-text-muted">
        {count} {count === 1 ? unit : `${unit}s`}
      </span>
    </div>
  )
}
