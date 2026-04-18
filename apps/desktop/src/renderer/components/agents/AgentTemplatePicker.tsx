import type { AgentCatalog, CustomAgentConfig } from '@open-cowork/shared'
import { AgentAvatar } from './AgentAvatar'
import { applyTemplate, type AgentTemplate } from './agent-builder-utils'
import { getStarterTemplates } from './starter-templates'
import { ModalBackdrop } from '../layout/ModalBackdrop'
import { t } from '../../helpers/i18n'

type Props = {
  catalog: AgentCatalog
  onPick: (seed: Partial<CustomAgentConfig> | null) => void
  onCancel: () => void
}

// Modal shown on "New agent". Offers 4 starter templates + a blank
// option. Picking a template produces a partial `CustomAgentConfig`
// filtered against the live catalog — we never hand the builder a
// reference to a tool/skill that doesn't exist.

export function AgentTemplatePicker({ catalog, onPick, onCancel }: Props) {
  return (
    <>
      <ModalBackdrop onDismiss={onCancel} />
      <div
        className="fixed top-[6%] left-1/2 -translate-x-1/2 z-50 w-[720px] max-w-[95vw] max-h-[88vh] rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        style={{
          background: 'var(--color-base)',
          border: '1px solid var(--color-border)',
        }}
      >
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          <div>
            <h2 className="text-[15px] font-semibold text-text">{t('agentTemplate.title', 'Start a new agent')}</h2>
            <p className="text-[12px] text-text-muted mt-0.5">
              {t('agentTemplate.subtitle', 'Pick a starter to skip the blank canvas — you can change anything after.')}
            </p>
          </div>
          <button
            onClick={onCancel}
            aria-label={t('common.close', 'Close')}
            className="text-text-muted hover:text-text cursor-pointer text-[20px] leading-none"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto p-5 grid grid-cols-1 md:grid-cols-2 gap-3">
          {getStarterTemplates().map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              onPick={() => onPick(applyTemplate(template, catalog))}
            />
          ))}
          <button
            onClick={() => onPick(null)}
            className="flex items-start gap-3 p-4 rounded-xl border-2 border-dashed border-border-subtle hover:bg-surface-hover transition-colors cursor-pointer text-start md:col-span-2"
          >
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0"
              style={{
                background: 'color-mix(in srgb, var(--color-text-muted) 10%, transparent)',
                color: 'var(--color-text-muted)',
              }}
            >
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="11" y1="4" x2="11" y2="18" />
                <line x1="4" y1="11" x2="18" y2="11" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-text mb-0.5">{t('agentTemplate.startBlank', 'Start from blank')}</div>
              <div className="text-[11px] text-text-muted leading-relaxed">
                {t('agentTemplate.startBlankHint', 'No pre-selected tools or instructions — design the agent from scratch.')}
              </div>
            </div>
          </button>
        </div>
      </div>
    </>
  )
}

function TemplateCard({
  template,
  onPick,
}: {
  template: AgentTemplate
  onPick: () => void
}) {
  return (
    <button
      onClick={onPick}
      className="flex items-start gap-3 p-4 rounded-xl border bg-surface hover:bg-surface-hover transition-colors cursor-pointer text-start"
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      <AgentAvatar name={template.label} color={template.color} size="lg" />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-text mb-0.5">{template.label}</div>
        <div className="text-[11px] text-text-muted leading-relaxed line-clamp-3">
          {template.description}
        </div>
        <div className="flex flex-wrap gap-2 mt-2 text-[10px] text-text-muted">
          {typeof template.temperature === 'number' && (
            <span>{t('agentTemplate.temp', 'temp {{value}}', { value: template.temperature.toFixed(1) })}</span>
          )}
          {typeof template.steps === 'number' && (
            <span>{t('agentTemplate.steps', '{{count}} steps', { count: String(template.steps) })}</span>
          )}
          {(template.toolIds?.length ?? 0) > 0 && (
            <span>{t('agentTemplate.toolHints', '{{count}} tool hint(s)', { count: String(template.toolIds!.length) })}</span>
          )}
        </div>
      </div>
    </button>
  )
}
