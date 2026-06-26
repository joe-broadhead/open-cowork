import type { CapabilitySkill, CapabilityTool, RuntimeToolDescriptor } from '@open-cowork/shared'
import { PluginIcon } from '../plugins/PluginIcon'
import { t } from '../../helpers/i18n'
import {
  buildCapabilityMapSections,
  linkedToolsForSkill,
  mergedRuntimeToolset,
  prettyKind,
  prettySkillKind,
  type CapabilityMapGroup,
} from './capabilities-page-support.ts'
import { EmptyGrid } from './capabilities-page-components.tsx'
import { Badge, Button, Card, type BadgeTone } from '../ui'

type CapabilityMapViewProps = {
  groups: CapabilityMapGroup[]
  tools: CapabilityTool[]
  skills: CapabilitySkill[]
  customToolIds: Set<string>
  customSkillNames: Set<string>
  runtimeTools: RuntimeToolDescriptor[]
  search: string
  onOpenTool: (toolId: string) => void
  onOpenSkill: (skillName: string) => void
  onAddTool: () => void
  onAddSkill: () => void
}

export function CapabilityMapView({
  groups,
  tools,
  skills,
  customToolIds,
  customSkillNames,
  runtimeTools,
  search,
  onOpenTool,
  onOpenSkill,
  onAddTool,
  onAddSkill,
}: CapabilityMapViewProps) {
  const customCount = customToolIds.size + customSkillNames.size
  const projectCount = [
    ...tools.filter((tool) => tool.scope === 'project'),
    ...skills.filter((skill) => skill.scope === 'project'),
  ].length

  if (tools.length === 0 && skills.length === 0) {
    return (
      <EmptyGrid message={t('capabilities.mapEmpty', 'No tools or skills discovered yet. Add a tool or skill bundle to extend the current OpenCode context.')} />
    )
  }

  const sections = buildCapabilityMapSections(groups)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <CapabilityMetric label={t('capabilities.metricTools', 'Tools')} value={tools.length} detail={t('capabilities.metricToolsDetail', 'Runtime actions')} emphasis />
        <CapabilityMetric label={t('capabilities.metricSkills', 'Skills')} value={skills.length} detail={t('capabilities.metricSkillsDetail', 'Coworker and playbook access')} />
        <CapabilityMetric label={t('capabilities.metricCustom', 'Custom')} value={customCount} detail={t('capabilities.metricCustomDetail', 'User additions')} />
        <CapabilityMetric label={t('capabilities.metricProject', 'Project')} value={projectCount} detail={t('capabilities.metricProjectDetail', 'Scoped here')} />
      </div>

      <Card padding="sm" className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-text">{t('capabilities.mapTitle', 'Tool and skill map')}</div>
          <div className="text-2xs text-text-muted mt-0.5">
            {t('capabilities.mapSubtitle', 'Tools are grouped with the skills that depend on them, so runtime access for coworkers and playbooks stays visible together.')}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="secondary" size="sm" onClick={onAddTool}>
            {t('capabilities.addTool', 'Add tool')}
          </Button>
          <Button variant="secondary" size="sm" onClick={onAddSkill}>
            {t('capabilities.addSkillButton', 'Add skill')}
          </Button>
        </div>
      </Card>

      {groups.length === 0 ? (
        <EmptyGrid message={search.trim()
          ? t('capabilities.noCapabilitiesMatch', 'No tools or skills matched your search.')
          : t('capabilities.noCapabilityGroups', 'No tool and skill relationships were discovered yet.')} />
      ) : (
        <div className="flex flex-col gap-5">
          {sections.map((section) => (
            <section key={section.id} className="flex flex-col gap-2.5">
              <div className="flex flex-wrap items-end justify-between gap-2 px-0.5">
                <div>
                  <h2 className="font-display text-role-card-title font-bold text-text">{section.label}</h2>
                  <p className="mt-0.5 text-2xs text-text-muted">{section.description}</p>
                </div>
                <span className="text-2xs text-text-muted">
                  {section.groups.length} {section.groups.length === 1 ? 'group' : 'groups'}
                </span>
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-stretch">
                {section.groups.map((group) => (
                  <CapabilityMapGroupCard
                    key={group.id}
                    group={group}
                    tools={tools}
                    isCustomTool={group.tool ? customToolIds.has(group.tool.id) : false}
                    customSkillNames={customSkillNames}
                    runtimeTools={runtimeTools}
                    onOpenTool={onOpenTool}
                    onOpenSkill={onOpenSkill}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function CapabilityMetric({
  label,
  value,
  detail,
  emphasis = false,
}: {
  label: string
  value: number
  detail: string
  emphasis?: boolean
}) {
  return (
    <Card padding="sm">
      <div className="text-2xs uppercase tracking-[0.08em] text-text-muted">{label}</div>
      <div className="mt-1 flex items-end gap-2">
        <div className={`text-xl font-semibold leading-none ${emphasis ? 'text-accent' : 'text-text'}`}>{value}</div>
        <div className="text-2xs text-text-muted pb-0.5">{detail}</div>
      </div>
    </Card>
  )
}

function CapabilityMapGroupCard({
  group,
  tools,
  isCustomTool,
  customSkillNames,
  runtimeTools,
  onOpenTool,
  onOpenSkill,
}: {
  group: CapabilityMapGroup
  tools: CapabilityTool[]
  isCustomTool: boolean
  customSkillNames: Set<string>
  runtimeTools: RuntimeToolDescriptor[]
  onOpenTool: (toolId: string) => void
  onOpenSkill: (skillName: string) => void
}) {
  if (group.type === 'standalone') {
    return (
      <Card variant="flat" padding="sm" style={{ padding: 0 }} className="h-full overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-border-subtle bg-elevated">
          <div className="text-sm font-semibold text-text">{group.label}</div>
          <div className="text-2xs text-text-muted mt-0.5">{t('capabilities.standaloneSkillsHelp', 'Skills without a resolved tool link.')}</div>
        </div>
        <SkillRows
          group={group}
          tools={tools}
          customSkillNames={customSkillNames}
          onOpenSkill={onOpenSkill}
        />
      </Card>
    )
  }

  const tool = group.tool
  if (!tool) return null
  const methodsCount = mergedRuntimeToolset(tool, runtimeTools).length
  const kindTone: BadgeTone = isCustomTool ? 'warning' : tool.kind === 'mcp' ? 'info' : 'neutral'

  return (
    <Card
      variant="flat"
      padding="sm"
      className="h-full overflow-hidden flex flex-col"
      style={group.matchedTool
        ? { padding: 0, borderColor: 'color-mix(in srgb, var(--color-accent) 38%, var(--color-border-subtle))' }
        : { padding: 0 }}
    >
      <button
        type="button"
        aria-label={`Open tool ${tool.name}`}
        onClick={() => onOpenTool(tool.id)}
        className="w-full text-start px-4 py-3.5 flex items-start gap-3 hover:bg-surface-hover transition-colors cursor-pointer"
      >
        <PluginIcon icon={tool.icon || tool.namespace || tool.id} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <Badge tone={kindTone}>{prettyKind(tool)}</Badge>
            {isCustomTool ? <Badge tone="warning">Custom</Badge> : null}
            {tool.scope ? <Badge tone="muted">{tool.scope === 'project' ? 'Project' : 'Machine'}</Badge> : null}
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-md font-semibold text-text truncate">{tool.name}</h2>
            {group.skills.length > 0 ? (
              <span className="shrink-0 text-2xs text-text-muted">{group.skills.length} linked</span>
            ) : null}
          </div>
          <div className="text-2xs text-text-muted leading-relaxed line-clamp-2 mt-0.5">{tool.description}</div>
        </div>
        <div className="hidden sm:flex flex-col items-end gap-1 text-2xs text-text-muted shrink-0">
          <span>{methodsCount} {methodsCount === 1 ? 'method' : 'methods'}</span>
          <span>{tool.agentNames.length} {tool.agentNames.length === 1 ? 'agent' : 'agents'}</span>
        </div>
      </button>

      {group.skills.length > 0 ? (
        <SkillRows
          group={group}
          tools={tools}
          customSkillNames={customSkillNames}
          currentToolId={tool.id}
          onOpenSkill={onOpenSkill}
        />
      ) : (
        <div className="mt-auto px-4 py-3 border-t border-border-subtle text-2xs text-text-muted">
          {t('capabilities.noLinkedSkillsForTool', 'No linked skills yet. This tool can still be assigned directly to agents.')}
        </div>
      )}
    </Card>
  )
}

function SkillRows({
  group,
  tools,
  customSkillNames,
  currentToolId,
  onOpenSkill,
}: {
  group: CapabilityMapGroup
  tools: CapabilityTool[]
  customSkillNames: Set<string>
  currentToolId?: string
  onOpenSkill: (skillName: string) => void
}) {
  return (
    <div className="border-t border-border-subtle divide-y divide-border-subtle">
      {group.skills.map((skill) => {
        const linkedTools = linkedToolsForSkill(skill, tools)
        const highlighted = group.matchedSkillNames.has(skill.name)
        const multiTool = linkedTools.length > 1
        return (
          <button
            key={`${group.id}:${skill.name}`}
            type="button"
            aria-label={`Open skill ${skill.label}`}
            onClick={() => onOpenSkill(skill.name)}
            className="w-full text-start px-4 py-3 flex items-start gap-3 hover:bg-surface-hover transition-colors cursor-pointer"
            style={{
              background: highlighted ? 'color-mix(in srgb, var(--color-accent) 7%, transparent)' : undefined,
            }}
          >
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: 'color-mix(in srgb, var(--color-amber) 14%, var(--color-elevated))' }}
              aria-hidden="true"
            >
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="var(--color-amber)" strokeWidth="1.3">
                <path d="M6 1.5L7.5 4.5L10.5 5L8.25 7.25L8.75 10.5L6 9L3.25 10.5L3.75 7.25L1.5 5L4.5 4.5L6 1.5Z" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium text-text truncate">{skill.label}</span>
                <Badge tone={skill.source === 'custom' ? 'warning' : 'neutral'}>
                  {prettySkillKind(skill)}
                </Badge>
                {multiTool ? <Badge tone="info">Multi-tool</Badge> : null}
                {customSkillNames.has(skill.name) ? <Badge tone="warning">Custom</Badge> : null}
              </div>
              <div className="text-2xs text-text-muted leading-relaxed line-clamp-2 mt-0.5">{skill.description}</div>
              {linkedTools.length > 0 ? (
                <div className="flex flex-wrap gap-1 mt-2">
                  {linkedTools.map((tool) => (
                    <Badge
                      key={`${skill.name}:${tool.id}`}
                      tone={tool.id === currentToolId ? 'accent' : 'muted'}
                    >
                      {tool.name}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
          </button>
        )
      })}
    </div>
  )
}

