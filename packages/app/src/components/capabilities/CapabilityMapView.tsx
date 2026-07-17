import type { CapabilitySkill, CapabilityTool, RuntimeToolDescriptor } from '@open-cowork/shared'
import { PluginIcon } from '../plugins/PluginIcon'
import { t } from '../../helpers/i18n'
import { entityChroma } from '../../helpers/entity-chroma'
import {
  buildCapabilityMapSections, mergedRuntimeToolset, prettyKind, CapabilityMapGroup, } from './capabilities-page-support.ts'
import { EmptyGrid } from './capabilities-page-components.tsx'
import { Badge, Card, Icon, type BadgeTone } from '@open-cowork/ui'

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
}: CapabilityMapViewProps) {
  if (tools.length === 0 && skills.length === 0) {
    return (
      <EmptyGrid message={t('capabilities.mapEmpty', 'No tools or skills discovered yet. Add a tool or skill bundle to extend the current OpenCode context.')} />
    )
  }

  const sections = buildCapabilityMapSections(groups)

  return (
    <div className="flex flex-col gap-5">
      {groups.length === 0 ? (
        <EmptyGrid message={search.trim()
          ? t('capabilities.noCapabilitiesMatch', 'No tools or skills matched your search.')
          : t('capabilities.noCapabilityGroups', 'No tool and skill relationships were discovered yet.')} />
      ) : (
        sections.map((section) => (
          <section key={section.id} className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-end justify-between gap-2 px-0.5">
              <div>
                <h2 className="font-display text-role-card-title font-bold text-text">{section.label}</h2>
                <p className="mt-0.5 text-2xs text-text-muted">{section.description}</p>
              </div>
              <span className="text-2xs text-text-muted tabular-nums">
                {section.groups.length} {section.groups.length === 1 ? 'group' : 'groups'}
              </span>
            </div>
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
              {section.groups.map((group) => (
                <CapabilityMapGroupCard
                  key={group.id}
                  group={group}
                  isCustomTool={group.tool ? customToolIds.has(group.tool.id) : false}
                  customSkillNames={customSkillNames}
                  runtimeTools={runtimeTools}
                  onOpenTool={onOpenTool}
                  onOpenSkill={onOpenSkill}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}

function CapabilityMapGroupCard({
  group,
  isCustomTool,
  customSkillNames,
  runtimeTools,
  onOpenTool,
  onOpenSkill,
}: {
  group: CapabilityMapGroup
  isCustomTool: boolean
  customSkillNames: Set<string>
  runtimeTools: RuntimeToolDescriptor[]
  onOpenTool: (toolId: string) => void
  onOpenSkill: (skillName: string) => void
}) {
  // Standalone groups carry skills with no resolved tool link. They still read
  // as a twin card so the gallery stays a uniform grid — just without a brand
  // glyph or a tool action.
  if (group.type === 'standalone') {
    return (
      <Card
        variant="surface"
        padding="sm"
        hover="none"
        style={{ '--spine': entityChroma(group.label) } as React.CSSProperties}
        className="group relative flex flex-col gap-0 overflow-hidden !p-0 transition-colors duration-[120ms] hover:border-border-strong before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-[color-mix(in_srgb,var(--spine)_60%,transparent)] before:opacity-0 group-hover:before:opacity-100 before:transition-opacity before:duration-[120ms]"
      >
        <div className="p-4 flex items-start gap-3">
          <div
            className="entity-tile rounded-xl flex items-center justify-center shrink-0"
            style={{ width: 36, height: 36, '--entity-chroma': entityChroma(group.label) } as React.CSSProperties}
            aria-hidden="true"
          >
            <Icon name="sparkles" size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-display text-role-card-title font-semibold text-text truncate leading-tight">{group.label}</div>
            <div className="text-2xs text-text-muted mt-0.5">{t('capabilities.standaloneSkillsHelp', 'Skills without a resolved tool link.')}</div>
          </div>
        </div>
        <DependsOnRail
          group={group}
          customSkillNames={customSkillNames}
          onOpenSkill={onOpenSkill}
        />
      </Card>
    )
  }

  const tool = group.tool
  if (!tool) return null
  const methodsCount = mergedRuntimeToolset(tool, runtimeTools).length
  const skillCount = group.skills.length
  const agentCount = tool.agentNames.length
  const kindTone: BadgeTone = isCustomTool ? 'muted' : tool.kind === 'mcp' ? 'info' : 'neutral'

  return (
    <Card
      variant="surface"
      padding="sm"
      hover="none"
      style={group.matchedTool
        ? ({ '--spine': entityChroma(tool.name || tool.id), borderColor: 'color-mix(in srgb, var(--color-accent) 38%, var(--color-border-subtle))' } as React.CSSProperties)
        : ({ '--spine': entityChroma(tool.name || tool.id) } as React.CSSProperties)}
      className="group relative flex flex-col gap-0 overflow-hidden !p-0 transition-colors duration-[120ms] hover:border-border-strong before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-[color-mix(in_srgb,var(--spine)_60%,transparent)] before:opacity-0 group-hover:before:opacity-100 before:transition-opacity before:duration-[120ms]"
    >
      <button
        type="button"
        aria-label={`Open tool ${tool.name}`}
        onClick={() => onOpenTool(tool.id)}
        className="w-full text-start p-4 flex flex-col gap-3 group-hover:bg-surface-hover transition-colors duration-[120ms] cursor-pointer"
      >
        <div className="flex items-start gap-3">
          <PluginIcon icon={tool.icon || tool.namespace || tool.id} size={36} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
              <Badge tone={kindTone}>{prettyKind(tool)}</Badge>
              {isCustomTool ? <Badge tone="muted">Custom</Badge> : null}
            </div>
            <div className="font-display text-role-card-title font-semibold text-text truncate leading-tight">{tool.name}</div>
            <div className="text-2xs text-text-muted mt-0.5 leading-relaxed line-clamp-2">{tool.description}</div>
          </div>
        </div>

        {/* Instrument-readout meta line — tabular counts with dot separators. */}
        <div className="flex flex-wrap items-center gap-2 text-2xs text-text-muted">
          <span className="tabular">
            <span className="text-text-secondary font-[560]">{methodsCount}</span> {methodsCount === 1 ? 'method' : 'methods'}
          </span>
          <span className="text-text-muted/60" aria-hidden>·</span>
          <span className="tabular">
            <span className="text-text-secondary font-[560]">{skillCount}</span> {skillCount === 1 ? 'skill' : 'skills'}
          </span>
          <span className="text-text-muted/60" aria-hidden>·</span>
          <span className="tabular">
            <span className="text-text-secondary font-[560]">{agentCount}</span> {agentCount === 1 ? 'agent' : 'agents'}
          </span>
          {tool.scope ? (
            <>
              <span className="text-text-muted/60" aria-hidden>·</span>
              <span className="inline-flex items-center gap-1">
                <span className="w-[6px] h-[6px] rounded-full shrink-0" style={{ background: entityChroma(tool.name || tool.id) }} aria-hidden />
                {tool.scope === 'project' ? 'Project' : 'Machine'}
              </span>
            </>
          ) : null}
        </div>
      </button>

      {skillCount > 0 ? (
        <DependsOnRail
          group={group}
          customSkillNames={customSkillNames}
          onOpenSkill={onOpenSkill}
        />
      ) : (
        <div className="px-4 py-2.5 border-t border-border-subtle text-2xs text-text-muted">
          {t('capabilities.noLinkedSkillsForTool', 'No linked skills yet. This tool can still be assigned directly to coworkers.')}
        </div>
      )}
    </Card>
  )
}

// DEPENDS-ON rail — a compact strip of skill mini-chips that replaces the old
// per-skill description rows. Up to four chips, then a +N overflow chip. Each
// chip carries a small entity-tile chroma dot keyed by the skill, and stays
// clickable so the skill detail is one tap away. A search-matched skill keeps
// the accent treatment so search still visibly highlights inside the rail.
function DependsOnRail({
  group,
  customSkillNames,
  onOpenSkill,
}: {
  group: CapabilityMapGroup
  customSkillNames: Set<string>
  onOpenSkill: (skillName: string) => void
}) {
  const visible = group.skills.slice(0, 4)
  const overflow = group.skills.length - visible.length
  return (
    <div className="px-4 py-2.5 border-t border-border-subtle">
      <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-text-muted mb-1.5">
        {t('capabilities.dependsOn', 'Depends on')}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {visible.map((skill) => (
          <SkillChip
            key={`${group.id}:${skill.name}`}
            skill={skill}
            highlighted={group.matchedSkillNames.has(skill.name)}
            isCustom={customSkillNames.has(skill.name)}
            onOpen={() => onOpenSkill(skill.name)}
          />
        ))}
        {overflow > 0 ? (
          <span className="inline-flex items-center h-6 rounded-full border border-border-subtle px-2 text-2xs text-text-muted tabular-nums">
            +{overflow}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function SkillChip({
  skill,
  highlighted,
  isCustom,
  onOpen,
}: {
  skill: CapabilitySkill
  highlighted: boolean
  isCustom: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      aria-label={`Open skill ${skill.label}`}
      onClick={onOpen}
      className="group/chip inline-flex items-center h-6 max-w-full gap-1.5 rounded-full border px-2 text-2xs text-text transition-colors duration-[120ms] cursor-pointer hover:bg-surface-hover"
      style={highlighted
        ? { background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }
        : { borderColor: 'var(--color-border-subtle)' }}
    >
      <span
        className={`w-[6px] h-[6px] rounded-full shrink-0 ${isCustom ? 'ring-1 ring-border' : ''}`}
        style={highlighted
          ? { background: 'var(--color-accent)' }
          : { background: entityChroma(skill.name) }}
        aria-hidden
      />
      <span className={`truncate ${highlighted ? 'text-accent' : ''}`}>{skill.label}</span>
    </button>
  )
}
