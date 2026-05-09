import type { CapabilitySkill, CapabilityTool, RuntimeToolDescriptor } from '@open-cowork/shared'
import { PluginIcon } from '../plugins/PluginIcon'
import { t } from '../../helpers/i18n'
import {
  linkedToolsForSkill,
  mergedRuntimeToolset,
  prettyKind,
  prettySkillKind,
  type CapabilityMapGroup,
} from './capabilities-page-support.ts'
import { EmptyGrid } from './capabilities-page-components.tsx'

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
      <EmptyGrid message={t('capabilities.mapEmpty', 'No capabilities discovered yet. Add a tool or skill bundle to extend the current OpenCode context.')} />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <CapabilityMetric label={t('capabilities.metricTools', 'Tools')} value={tools.length} detail={t('capabilities.metricToolsDetail', 'Runtime actions')} tone="var(--color-accent)" />
        <CapabilityMetric label={t('capabilities.metricSkills', 'Skills')} value={skills.length} detail={t('capabilities.metricSkillsDetail', 'Agent workflows')} tone="var(--color-amber)" />
        <CapabilityMetric label={t('capabilities.metricCustom', 'Custom')} value={customCount} detail={t('capabilities.metricCustomDetail', 'User additions')} tone="var(--color-green)" />
        <CapabilityMetric label={t('capabilities.metricProject', 'Project')} value={projectCount} detail={t('capabilities.metricProjectDetail', 'Scoped here')} tone="var(--color-info)" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface px-4 py-3">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-text">{t('capabilities.mapTitle', 'Capability map')}</div>
          <div className="text-[11px] text-text-muted mt-0.5">
            {t('capabilities.mapSubtitle', 'Tools are grouped with the skills that depend on them, so runtime access and agent workflows stay visible together.')}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onAddTool}
            className="px-3 py-1.5 rounded-lg border border-border-subtle text-[11px] font-medium text-accent hover:bg-surface-hover cursor-pointer"
          >
            {t('capabilities.addTool', 'Add tool')}
          </button>
          <button
            type="button"
            onClick={onAddSkill}
            className="px-3 py-1.5 rounded-lg border border-border-subtle text-[11px] font-medium text-accent hover:bg-surface-hover cursor-pointer"
          >
            {t('capabilities.addSkillButton', 'Add skill')}
          </button>
        </div>
      </div>

      {groups.length === 0 ? (
        <EmptyGrid message={search.trim()
          ? t('capabilities.noCapabilitiesMatch', 'No capabilities matched your search.')
          : t('capabilities.noCapabilityGroups', 'No tool and skill relationships were discovered yet.')} />
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {groups.map((group) => (
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
      )}
    </div>
  )
}

function CapabilityMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: number
  detail: string
  tone: string
}) {
  return (
    <div
      className="rounded-xl border border-border-subtle bg-surface px-3 py-3"
      style={{ boxShadow: `inset 0 1px 0 color-mix(in srgb, ${tone} 22%, transparent)` }}
    >
      <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">{label}</div>
      <div className="mt-1 flex items-end gap-2">
        <div className="text-[20px] font-semibold leading-none" style={{ color: tone }}>{value}</div>
        <div className="text-[10px] text-text-muted pb-0.5">{detail}</div>
      </div>
    </div>
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
      <section className="rounded-2xl border border-border-subtle bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border-subtle bg-elevated">
          <div className="text-[13px] font-semibold text-text">{group.label}</div>
          <div className="text-[11px] text-text-muted mt-0.5">{t('capabilities.standaloneSkillsHelp', 'Skills without a resolved tool link.')}</div>
        </div>
        <SkillRows
          group={group}
          tools={tools}
          customSkillNames={customSkillNames}
          onOpenSkill={onOpenSkill}
        />
      </section>
    )
  }

  const tool = group.tool
  if (!tool) return null
  const methodsCount = mergedRuntimeToolset(tool, runtimeTools).length
  const tone = isCustomTool
    ? 'var(--color-amber)'
    : tool.kind === 'mcp'
      ? 'var(--color-accent)'
      : 'var(--color-text-secondary)'

  return (
    <section
      className="rounded-2xl border bg-surface overflow-hidden"
      style={{
        borderColor: group.matchedTool ? 'color-mix(in srgb, var(--color-accent) 38%, var(--color-border-subtle))' : 'var(--color-border-subtle)',
      }}
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
            <MapPill tone={tone}>{prettyKind(tool)}</MapPill>
            {isCustomTool ? <MapPill tone="var(--color-amber)">Custom</MapPill> : null}
            {tool.scope ? <MapPill tone="var(--color-text-muted)">{tool.scope === 'project' ? 'Project' : 'Machine'}</MapPill> : null}
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-[14px] font-semibold text-text truncate">{tool.name}</h2>
            {group.skills.length > 0 ? (
              <span className="shrink-0 text-[10px] text-text-muted">{group.skills.length} linked</span>
            ) : null}
          </div>
          <div className="text-[11px] text-text-muted leading-relaxed line-clamp-2 mt-0.5">{tool.description}</div>
        </div>
        <div className="hidden sm:flex flex-col items-end gap-1 text-[10px] text-text-muted shrink-0">
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
        <div className="px-4 py-3 border-t border-border-subtle text-[11px] text-text-muted">
          {t('capabilities.noLinkedSkillsForTool', 'No linked skills yet. This tool can still be assigned directly to agents.')}
        </div>
      )}
    </section>
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
                <span className="text-[12px] font-medium text-text truncate">{skill.label}</span>
                <MapPill tone={skill.source === 'custom' ? 'var(--color-amber)' : 'var(--color-accent)'}>
                  {prettySkillKind(skill)}
                </MapPill>
                {multiTool ? <MapPill tone="var(--color-info)">Multi-tool</MapPill> : null}
                {customSkillNames.has(skill.name) ? <MapPill tone="var(--color-amber)">Custom</MapPill> : null}
              </div>
              <div className="text-[11px] text-text-muted leading-relaxed line-clamp-2 mt-0.5">{skill.description}</div>
              {linkedTools.length > 0 ? (
                <div className="flex flex-wrap gap-1 mt-2">
                  {linkedTools.map((tool) => (
                    <span
                      key={`${skill.name}:${tool.id}`}
                      className="text-[9px] px-1.5 py-0.5 rounded-full"
                      style={{
                        color: tool.id === currentToolId ? 'var(--color-accent)' : 'var(--color-text-muted)',
                        background: tool.id === currentToolId
                          ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)'
                          : 'color-mix(in srgb, var(--color-text-muted) 8%, transparent)',
                      }}
                    >
                      {tool.name}
                    </span>
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

function MapPill({ children, tone }: { children: string; tone: string }) {
  return (
    <span
      className="inline-flex items-center text-[9px] uppercase tracking-[0.06em] px-1.5 py-0.5 rounded font-semibold"
      style={{
        color: tone,
        background: `color-mix(in srgb, ${tone} 11%, transparent)`,
      }}
    >
      {children}
    </span>
  )
}
