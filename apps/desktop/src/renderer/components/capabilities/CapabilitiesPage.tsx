import { useEffect, useMemo, useState } from 'react'
import type { CapabilitySkill, CapabilitySkillBundle, CapabilityTool, CustomAgentConfig, CustomMcpConfig, CustomSkillConfig, RuntimeToolDescriptor } from '@open-cowork/shared'
import { CustomMcpForm } from '../plugins/CustomMcpForm'
import { CustomSkillForm } from '../plugins/CustomSkillForm'
import { useSessionStore } from '../../stores/session'
import { confirmMcpRemoval, confirmSkillRemoval } from '../../helpers/destructive-actions'
import { SkillSelectionCard, ToolSelectionCard } from './CapabilitySelectionCard'
import { t } from '../../helpers/i18n'
import {
  buildCapabilityMapGroups,
  buildAgentSeedFromSkill,
  buildAgentSeedFromTool,
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
import { FleetRegistryTable, FleetRegistryViewToggle } from '../fleet/FleetRegistryTable'
import {
  buildCapabilityRegistryItems,
  filterFleetRegistryItems,
  isFleetRegistryViewsEnabled,
  sortFleetRegistryItems,
} from '../fleet/fleet-registry-model'
import { useFleetRegistryPreferences } from '../fleet/useFleetRegistryPreferences'

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
  const [selectedToolDetail, setSelectedToolDetail] = useState<CapabilityTool | null>(null)
  const [selectedSkillBundle, setSelectedSkillBundle] = useState<CapabilitySkillBundle | null>(null)

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

  const loadAll = () => {
    window.coworkApi.capabilities.tools(toolOptions).then(setTools)
    window.coworkApi.capabilities.skills(contextOptions).then(setSkills)
    window.coworkApi.custom.listMcps(contextOptions).then(setCustomMcps)
    window.coworkApi.custom.listSkills(contextOptions).then(setCustomSkills)
    window.coworkApi.tools.list(toolOptions).then(setRuntimeTools).catch(() => setRuntimeTools([]))
  }

  useEffect(() => {
    loadAll()
    const unsubscribe = window.coworkApi.on.runtimeReady(() => loadAll())
    return unsubscribe
  }, [currentSessionId, currentProjectDirectory])

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
      .sort((a, b) => safeText(a.name).localeCompare(safeText(b.name), undefined, { sensitivity: 'base' }))
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
  const registryEnabled = isFleetRegistryViewsEnabled()
  const registryItems = useMemo(
    () => buildCapabilityRegistryItems({ tools, skills, runtimeTools }),
    [runtimeTools, skills, tools],
  )
  const registryPreferences = useFleetRegistryPreferences('capabilities', registryItems.length)
  const tabFilteredRegistryItems = useMemo(
    () => registryItems.filter((item) => {
      if (tab === 'map') return true
      return item.metadata?.capabilityType === (tab === 'tools' ? 'tool' : 'skill')
    }),
    [registryItems, tab],
  )
  const visibleRegistryItems = useMemo(
    () => sortFleetRegistryItems(
      filterFleetRegistryItems(tabFilteredRegistryItems, {
        query: search,
        quickFilter: registryPreferences.quickFilter,
      }),
      registryPreferences.sort,
    ),
    [registryPreferences.quickFilter, registryPreferences.sort, search, tabFilteredRegistryItems],
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
    ? t('capabilities.searchMap', 'Search tools, skills, linked capabilities, or agents…')
    : tab === 'tools'
      ? t('capabilities.searchTools', 'Search tools, descriptions, or agents…')
      : t('capabilities.searchSkills', 'Search skills, descriptions, or agents…')
  const addButtonLabel = tab === 'skills'
    ? t('capabilities.addSkillButton', 'Add skill')
    : t('capabilities.addTool', 'Add tool')
  const openRegistryItem = (item: (typeof registryItems)[number]) => {
    const capabilityType = item.metadata?.capabilityType
    const capabilityId = typeof item.metadata?.capabilityId === 'string' ? item.metadata.capabilityId : item.id
    if (capabilityType === 'tool') setSelection({ type: 'tool', id: capabilityId })
    if (capabilityType === 'skill') setSelection({ type: 'skill', name: capabilityId })
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1200px] mx-auto px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[18px] font-semibold text-text">{t('capabilities.title', 'Capabilities')}</h1>
            <p className="text-[13px] text-text-secondary mt-1">
              {t('capabilities.subtitle', 'Inspect the tools and skill bundles available in the current OpenCode context, including bundled, machine, project, and custom additions.')}
            </p>
          </div>
          <button onClick={onClose} className="text-[12px] text-text-muted hover:text-text-secondary cursor-pointer">{t('agentsPage.backToChat', 'Back to chat')}</button>
        </div>

        <div className="flex items-center gap-3 mb-6">
          <div className="flex-1">
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder}
              className="w-full px-4 py-2.5 rounded-xl bg-elevated border border-border-subtle text-[13px] text-text placeholder:text-text-muted outline-none focus:border-border"
            />
          </div>
          <div className="flex rounded-lg border border-border-subtle overflow-hidden">
            {(['map', 'tools', 'skills'] as const).map((value) => (
              <button
                key={value}
                onClick={() => setTab(value)}
                className={`px-3 py-1.5 text-[12px] font-medium cursor-pointer transition-colors capitalize ${tab === value ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text-secondary'}`}
              >
                {value === 'map'
                  ? t('capabilities.tab.map', 'Map')
                  : value === 'tools'
                    ? t('capabilities.tab.tools', 'Tools')
                    : t('capabilities.tab.skills', 'Skills')}
              </button>
            ))}
          </div>
          {registryEnabled ? (
            <FleetRegistryViewToggle
              viewMode={registryPreferences.viewMode}
              onViewModeChange={registryPreferences.setViewMode}
            />
          ) : null}
          <button
            onClick={() => tab === 'skills' ? setSkillForm('new') : setMcpForm('new')}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium hover:opacity-90 cursor-pointer"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="5" y1="1.5" x2="5" y2="8.5" /><line x1="1.5" y1="5" x2="8.5" y2="5" />
            </svg>
            {addButtonLabel}
          </button>
        </div>

        {registryEnabled && registryPreferences.viewMode === 'table' ? (
          <FleetRegistryTable
            surfaceLabel="Capability"
            items={visibleRegistryItems}
            totalCount={registryItems.length}
            quickFilter={registryPreferences.quickFilter}
            sort={registryPreferences.sort}
            onQuickFilterChange={registryPreferences.setQuickFilter}
            onSortChange={registryPreferences.setSort}
            onOpenItem={openRegistryItem}
            onBulkAction={(action, items) => {
              if (action.kind === 'open_dependency' && items[0]) openRegistryItem(items[0])
            }}
            emptyMessage="No capabilities match the current registry filters."
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
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {filteredTools.map((tool) => {
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
          )
        ) : (
          filteredSkills.length === 0 ? (
            <EmptyGrid message={skills.length === 0
              ? t('capabilities.noSkillsDiscovered', 'No skills discovered yet. Add a custom skill bundle to extend agents.')
              : t('capabilities.noSkillsMatch', 'No skills matched your search.')} />
          ) : (
            <div className="flex flex-col gap-4">
              {filteredSkillGroups.map((group) => (
                <section key={group.id} className="rounded-2xl border border-border-subtle bg-surface p-3">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div>
                      <div className="text-[12px] font-semibold text-text">{group.label}</div>
                      <div className="text-[10px] text-text-muted">
                        {group.type === 'tool'
                          ? t('capabilities.skillsLinkedToTool', 'Skills linked to this tool')
                          : t('capabilities.standaloneSkillsHelp', 'Skills without a resolved tool link.')}
                      </div>
                    </div>
                    {group.tool ? (
                      <button
                        type="button"
                        onClick={() => setSelection({ type: 'tool', id: group.tool!.id })}
                        className="px-2 py-1 rounded-md border border-border-subtle text-[10px] text-text-muted hover:text-accent hover:bg-surface-hover cursor-pointer"
                      >
                        Open tool
                      </button>
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
                </section>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}
