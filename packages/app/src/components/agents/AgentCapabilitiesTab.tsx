import { useMemo, useState } from 'react'
import type { AgentCatalog, AgentCatalogSkill, AgentCatalogTool } from '@open-cowork/shared'
import { PluginIcon } from '../plugins/PluginIcon'
import { McpRestrictionPanel } from './McpRestrictionPanel'
import { resolveMissingSkillTools } from './agent-builder-utils'
import { t } from '../../helpers/i18n'
import { Button, Input } from '../ui'

type Props = {
  catalog: AgentCatalog
  selectedSkillNames: string[]
  selectedToolIds: string[]
  onToggleSkill: (skillName: string) => void
  onToggleTool: (toolId: string) => void
  onAutoAttachTools: (toolIds: string[]) => void
  readOnly?: boolean
  deniedToolPatterns: string[]
  onToggleDeniedPattern: (pattern: string) => void
  projectDirectory: string | null
}

export type SkillGroup = {
  id: string
  label: string
  tone: 'recommended' | 'linked' | 'multi' | 'standalone'
  skills: AgentCatalogSkill[]
}

export function buildSkillGroups(catalog: AgentCatalog, selectedToolIds: string[], query = ''): SkillGroup[] {
  const toolMap = new Map(catalog.tools.map((tool) => [tool.id, tool]))
  const normalizedQuery = query.trim().toLowerCase()
  const matches = (skill: AgentCatalogSkill) => {
    if (!normalizedQuery) return true
    const linkedToolNames = (skill.toolIds || []).map((toolId) => toolMap.get(toolId)?.name || toolId)
    return [skill.name, skill.label, skill.description, ...linkedToolNames]
      .some((value) => value.toLowerCase().includes(normalizedQuery))
  }
  const remaining = catalog.skills.filter(matches)
  const byName = new Map(remaining.map((skill) => [skill.name, skill]))
  const used = new Set<string>()
  const groups: SkillGroup[] = []

  for (const toolId of selectedToolIds) {
    const tool = toolMap.get(toolId)
    if (!tool) continue
    const skills = remaining.filter((skill) => (skill.toolIds || []).includes(toolId) && !used.has(skill.name))
    if (skills.length === 0) continue
    for (const skill of skills) used.add(skill.name)
    groups.push({
      id: `recommended:${toolId}`,
      label: `Recommended for ${tool.name}`,
      tone: 'recommended',
      skills,
    })
  }

  const oneToolGroups = new Map<string, AgentCatalogSkill[]>()
  for (const skill of remaining) {
    if (used.has(skill.name)) continue
    const toolIds = skill.toolIds || []
    if (toolIds.length !== 1) continue
    const toolId = toolIds[0]!
    const group = oneToolGroups.get(toolId) || []
    group.push(skill)
    oneToolGroups.set(toolId, group)
    used.add(skill.name)
  }

  for (const [toolId, skills] of Array.from(oneToolGroups.entries()).sort((a, b) => {
    const aName = toolMap.get(a[0])?.name || a[0]
    const bName = toolMap.get(b[0])?.name || b[0]
    return aName.localeCompare(bName)
  })) {
    const tool = toolMap.get(toolId)
    groups.push({
      id: `linked:${toolId}`,
      label: tool ? `Linked to ${tool.name}` : `Linked to ${toolId}`,
      tone: 'linked',
      skills,
    })
  }

  const multiTool = remaining.filter((skill) => !used.has(skill.name) && (skill.toolIds || []).length > 1)
  if (multiTool.length > 0) {
    for (const skill of multiTool) used.add(skill.name)
    groups.push({
      id: 'multi-tool',
      label: 'Multi-tool skills',
      tone: 'multi',
      skills: multiTool,
    })
  }

  const standalone = Array.from(byName.values()).filter((skill) => !used.has(skill.name))
  if (standalone.length > 0) {
    groups.push({
      id: 'standalone',
      label: 'Standalone skills',
      tone: 'standalone',
      skills: standalone,
    })
  }

  return groups
}

export function AgentCapabilitiesTab({
  catalog,
  selectedSkillNames,
  selectedToolIds,
  onToggleSkill,
  onToggleTool,
  onAutoAttachTools,
  readOnly,
  deniedToolPatterns,
  onToggleDeniedPattern,
  projectDirectory,
}: Props) {
  const [query, setQuery] = useState('')
  const selectedSkills = useMemo(() => new Set(selectedSkillNames), [selectedSkillNames])
  const selectedTools = useMemo(() => new Set(selectedToolIds), [selectedToolIds])
  const toolMap = useMemo(() => new Map(catalog.tools.map((tool) => [tool.id, tool])), [catalog.tools])
  const skillGroups = useMemo(() => buildSkillGroups(catalog, selectedToolIds, query), [catalog, selectedToolIds, query])
  const filteredTools = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return catalog.tools
    return catalog.tools.filter((tool) => {
      const linkedSkills = catalog.skills.filter((skill) => (skill.toolIds || []).includes(tool.id))
      return [
        tool.id,
        tool.name,
        tool.description,
        ...linkedSkills.flatMap((skill) => [skill.name, skill.label, skill.description]),
      ].some((value) => value.toLowerCase().includes(normalized))
    })
  }, [catalog.skills, catalog.tools, query])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <Input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('agentCapabilities.search', 'Search skills, tools, linked capabilities...')}
          />
        </div>
        {query.trim() && (
          <Button variant="secondary" size="sm" onClick={() => setQuery('')}>
            Clear
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)] gap-4">
        <section className="min-w-0">
          <SectionHeader
            title="Skills"
            detail={`${selectedSkillNames.length} selected`}
          />
          {catalog.skills.length === 0 ? (
            <EmptyState text={t('skillLibrary.empty', 'No skills available yet. Add a skill bundle from the Tools & Skills page.')} />
          ) : skillGroups.length === 0 ? (
            <EmptyState text="No skills matched your search." />
          ) : (
            <div className="flex flex-col gap-3">
              {skillGroups.map((group) => (
                <SkillGroupSection
                  key={group.id}
                  group={group}
                  selectedSkills={selectedSkills}
                  selectedTools={selectedTools}
                  toolMap={toolMap}
                  catalog={catalog}
                  readOnly={readOnly}
                  onToggleSkill={onToggleSkill}
                  onAutoAttachTools={onAutoAttachTools}
                />
              ))}
            </div>
          )}
        </section>

        <section className="min-w-0">
          <SectionHeader
            title="Tools"
            detail={`${selectedToolIds.length} selected`}
          />
          {catalog.tools.length === 0 ? (
            <EmptyState text={t('toolLibrary.empty', 'No tools available yet. Add an MCP from the Tools & Skills page.')} />
          ) : filteredTools.length === 0 ? (
            <EmptyState text="No tools matched your search." />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-1 gap-2.5">
              {filteredTools.map((tool) => (
                <ToolCard
                  key={tool.id}
                  tool={tool}
                  linkedSkills={catalog.skills.filter((skill) => (skill.toolIds || []).includes(tool.id))}
                  selected={selectedTools.has(tool.id)}
                  selectedSkills={selectedSkills}
                  readOnly={readOnly}
                  onToggle={onToggleTool}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <McpRestrictionPanel
        catalog={catalog}
        selectedToolIds={selectedToolIds}
        deniedToolPatterns={deniedToolPatterns}
        projectDirectory={projectDirectory}
        onTogglePattern={onToggleDeniedPattern}
        readOnly={readOnly}
      />
    </div>
  )
}

function SkillGroupSection({
  group,
  selectedSkills,
  selectedTools,
  toolMap,
  catalog,
  readOnly,
  onToggleSkill,
  onAutoAttachTools,
}: {
  group: SkillGroup
  selectedSkills: Set<string>
  selectedTools: Set<string>
  toolMap: Map<string, AgentCatalogTool>
  catalog: AgentCatalog
  readOnly?: boolean
  onToggleSkill: (skillName: string) => void
  onAutoAttachTools: (toolIds: string[]) => void
}) {
  return (
    <div className="rounded-xl border border-border-subtle overflow-hidden">
      <div
        className="px-3 py-2 text-2xs font-medium flex items-center justify-between"
        style={{
          background: group.tone === 'recommended'
            ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)'
            : 'var(--color-elevated)',
          color: group.tone === 'recommended' ? 'var(--color-accent)' : 'var(--color-text-secondary)',
        }}
      >
        <span>{group.label}</span>
        <span className="text-2xs text-text-muted">{group.skills.length}</span>
      </div>
      <div className="divide-y divide-border-subtle">
        {group.skills.map((skill) => {
          const isOn = selectedSkills.has(skill.name)
          const missingTools = resolveMissingSkillTools(skill.name, Array.from(selectedTools), catalog)
          return (
            <SkillCard
              key={skill.name}
              skill={skill}
              selected={isOn}
              selectedTools={selectedTools}
              toolMap={toolMap}
              missingToolIds={missingTools}
              readOnly={readOnly}
              onToggle={onToggleSkill}
              onAutoAttachTools={onAutoAttachTools}
            />
          )
        })}
      </div>
    </div>
  )
}

function SkillCard({
  skill,
  selected,
  selectedTools,
  toolMap,
  missingToolIds,
  readOnly,
  onToggle,
  onAutoAttachTools,
}: {
  skill: AgentCatalogSkill
  selected: boolean
  selectedTools: Set<string>
  toolMap: Map<string, AgentCatalogTool>
  missingToolIds: string[]
  readOnly?: boolean
  onToggle: (skillName: string) => void
  onAutoAttachTools: (toolIds: string[]) => void
}) {
  return (
    <div
      className="transition-colors"
      style={{
        background: selected
          ? 'color-mix(in srgb, var(--color-accent) 7%, transparent)'
          : 'var(--color-surface)',
      }}
    >
      <button
        onClick={() => !readOnly && onToggle(skill.name)}
        disabled={readOnly}
        className="w-full flex items-start gap-2.5 p-3 text-start transition-colors cursor-pointer disabled:cursor-default hover:bg-surface-hover"
      >
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: 'color-mix(in srgb, var(--color-amber) 14%, var(--color-elevated))' }}
        >
          <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="var(--color-amber)" strokeWidth="1.3">
            <path d="M6 1.5L7.5 4.5L10.5 5L8.25 7.25L8.75 10.5L6 9L3.25 10.5L3.75 7.25L1.5 5L4.5 4.5L6 1.5Z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-xs font-medium text-text truncate">{skill.label}</span>
            {skill.source === 'custom' && <CustomBadge />}
            {selected && missingToolIds.length > 0 && (
              <span
                className="shrink-0 w-1.5 h-1.5 rounded-full"
                style={{ background: 'var(--color-amber)' }}
                title={t('skillLibrary.needsTools', 'Needs {{count}} tool(s)', { count: String(missingToolIds.length) })}
              />
            )}
          </div>
          <div className="text-2xs text-text-muted leading-relaxed line-clamp-2">
            {skill.description}
          </div>
          {(skill.toolIds || []).length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {(skill.toolIds || []).map((toolId) => (
                <ToolLinkChip
                  key={toolId}
                  label={toolMap.get(toolId)?.name || toolId}
                  selected={selectedTools.has(toolId)}
                  missing={!toolMap.has(toolId)}
                />
              ))}
            </div>
          )}
        </div>
      </button>
      {selected && missingToolIds.length > 0 && !readOnly && (
        <div
          className="flex items-center justify-between gap-2 px-3 py-2 border-t text-2xs"
          style={{
            borderColor: 'var(--color-border-subtle)',
            background: 'color-mix(in srgb, var(--color-amber) 8%, transparent)',
            color: 'var(--color-amber)',
          }}
        >
          <span className="min-w-0 truncate">
            Needs: {missingToolIds.map((id) => toolMap.get(id)?.name || id).join(', ')}
          </span>
          <button
            onClick={() => onAutoAttachTools(missingToolIds)}
            className="shrink-0 px-2 py-0.5 rounded-full text-2xs font-medium cursor-pointer"
            style={{
              color: 'var(--color-amber)',
              background: 'color-mix(in srgb, var(--color-amber) 16%, transparent)',
            }}
          >
            Add tools
          </button>
        </div>
      )}
    </div>
  )
}

function ToolCard({
  tool,
  linkedSkills,
  selected,
  selectedSkills,
  readOnly,
  onToggle,
}: {
  tool: AgentCatalogTool
  linkedSkills: AgentCatalogSkill[]
  selected: boolean
  selectedSkills: Set<string>
  readOnly?: boolean
  onToggle: (toolId: string) => void
}) {
  return (
    <button
      onClick={() => !readOnly && onToggle(tool.id)}
      disabled={readOnly}
      className="flex items-start gap-2.5 p-3 rounded-xl border text-start transition-colors cursor-pointer disabled:cursor-default"
      style={{
        borderColor: selected ? 'var(--color-accent)' : 'var(--color-border-subtle)',
        background: selected
          ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)'
          : 'var(--color-surface)',
        boxShadow: selected ? 'var(--ring-selected)' : 'none',
      }}
      title={tool.description}
    >
      <PluginIcon icon={tool.icon} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-text truncate">{tool.name}</span>
          {tool.supportsWrite && (
            <span
              className="shrink-0 text-2xs uppercase tracking-[0.04em] px-1 py-px rounded"
              style={{
                color: 'var(--color-amber)',
                background: 'color-mix(in srgb, var(--color-amber) 12%, transparent)',
              }}
              title={t('toolLibrary.writeTooltip', "This tool can write — adds to the coworker's footprint")}
            >
              W
            </span>
          )}
        </div>
        <div className="text-2xs text-text-muted leading-relaxed line-clamp-2 mt-0.5">
          {tool.description}
        </div>
        {linkedSkills.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {linkedSkills.slice(0, 4).map((skill) => (
              <span
                key={skill.name}
                className="text-2xs px-1.5 py-0.5 rounded-full"
                style={{
                  color: selectedSkills.has(skill.name) ? 'var(--color-accent)' : 'var(--color-text-muted)',
                  background: selectedSkills.has(skill.name)
                    ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)'
                    : 'color-mix(in srgb, var(--color-text-muted) 8%, transparent)',
                }}
              >
                {skill.label}
              </span>
            ))}
            {linkedSkills.length > 4 && (
              <span className="text-2xs px-1.5 py-0.5 rounded-full text-text-muted">
                +{linkedSkills.length - 4}
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  )
}

function ToolLinkChip({ label, selected, missing }: { label: string; selected: boolean; missing: boolean }) {
  const tone = missing
    ? 'var(--color-red)'
    : selected
      ? 'var(--color-accent)'
      : 'var(--color-text-muted)'
  return (
    <span
      className="inline-flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded-full"
      style={{
        color: tone,
        background: `color-mix(in srgb, ${tone} 10%, transparent)`,
      }}
    >
      {label}
    </span>
  )
}

function CustomBadge() {
  return (
    <span
      className="shrink-0 text-2xs uppercase tracking-[0.04em] px-1 py-px rounded"
      style={{
        color: 'var(--color-amber)',
        background: 'color-mix(in srgb, var(--color-amber) 12%, transparent)',
      }}
    >
      Custom
    </span>
  )
}

function SectionHeader({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <h3 className="text-xs font-semibold text-text">{title}</h3>
      <span className="text-2xs text-text-muted">{detail}</span>
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="text-xs text-text-muted py-8 text-center rounded-xl border border-border-subtle border-dashed">
      {text}
    </div>
  )
}
