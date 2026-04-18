import type { AgentCatalog } from '@open-cowork/shared'
import { resolveMissingSkillTools } from './agent-builder-utils'
import { t } from '../../helpers/i18n'

type Props = {
  catalog: AgentCatalog
  selectedSkillNames: string[]
  selectedToolIds: string[]
  onToggle: (skillName: string) => void
  onAutoAttachTools: (toolIds: string[]) => void
  readOnly?: boolean
}

// Skills workbench — a stacked list (not grid) because skill descriptions
// are prose and benefit from width. Each row is a button that toggles
// the skill; if the skill needs tools the agent doesn't have, we show an
// amber "needs X" hint with a one-click "also add tool" affordance.
export function SkillLibraryTab({
  catalog,
  selectedSkillNames,
  selectedToolIds,
  onToggle,
  onAutoAttachTools,
  readOnly,
}: Props) {
  const selected = new Set(selectedSkillNames)

  if (catalog.skills.length === 0) {
    return (
      <div className="text-[12px] text-text-muted py-8 text-center rounded-xl border border-border-subtle border-dashed">
        {t('skillLibrary.empty', 'No skills available yet. Add a skill bundle from the Capabilities page.')}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {catalog.skills.map((skill) => {
        const isOn = selected.has(skill.name)
        const missingTools = resolveMissingSkillTools(skill.name, selectedToolIds, catalog)
        const toolMap = new Map(catalog.tools.map((tool) => [tool.id, tool]))
        return (
          <div
            key={skill.name}
            className="rounded-xl border overflow-hidden transition-colors"
            style={{
              borderColor: isOn ? 'var(--color-accent)' : 'var(--color-border-subtle)',
              background: isOn
                ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)'
                : 'var(--color-surface)',
            }}
          >
            <button
              onClick={() => !readOnly && onToggle(skill.name)}
              disabled={readOnly}
              className="w-full flex items-start gap-2.5 p-3 text-left transition-colors cursor-pointer disabled:cursor-default hover:bg-surface-hover"
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
                  <span className="text-[12px] font-medium text-text truncate">{skill.label}</span>
                  {skill.source === 'custom' && (
                    <span
                      className="shrink-0 text-[9px] uppercase tracking-[0.04em] px-1 py-px rounded"
                      style={{
                        color: 'var(--color-amber)',
                        background: 'color-mix(in srgb, var(--color-amber) 12%, transparent)',
                      }}
                    >
                      Custom
                    </span>
                  )}
                  {isOn && missingTools.length > 0 && (
                    <span
                      className="shrink-0 w-1.5 h-1.5 rounded-full"
                      style={{ background: 'var(--color-amber)' }}
                      title={t('skillLibrary.needsTools', 'Needs {{count}} tool(s)', { count: String(missingTools.length) })}
                    />
                  )}
                </div>
                <div className="text-[11px] text-text-muted leading-relaxed line-clamp-2">
                  {skill.description}
                </div>
              </div>
            </button>
            {isOn && missingTools.length > 0 && !readOnly && (
              <div
                className="flex items-center justify-between gap-2 px-3 py-2 border-t text-[11px]"
                style={{
                  borderColor: 'var(--color-border-subtle)',
                  background: 'color-mix(in srgb, var(--color-amber) 8%, transparent)',
                  color: 'var(--color-amber)',
                }}
              >
                <span className="min-w-0 truncate">
                  Needs: {missingTools.map((id) => toolMap.get(id)?.name || id).join(', ')}
                </span>
                <button
                  onClick={() => onAutoAttachTools(missingTools)}
                  className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium cursor-pointer"
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
      })}
    </div>
  )
}
