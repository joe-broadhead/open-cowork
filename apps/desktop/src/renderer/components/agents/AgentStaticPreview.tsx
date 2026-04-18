import type { AgentCatalog, CustomAgentConfig } from '@open-cowork/shared'
import { compileAgentPreview, scopeLabel, scopeTone } from './agent-builder-utils'
import { t } from '../../helpers/i18n'

// Static "what will OpenCode see" inspector. Spans below the builder
// card. No live SDK call — just renders the compiled view so users can
// confirm their agent's shape before saving.

type Props = {
  draft: CustomAgentConfig
  catalog: AgentCatalog
}

export function AgentStaticPreview({ draft, catalog }: Props) {
  const preview = compileAgentPreview(draft, catalog)
  const scopeColor = scopeTone(preview.scope)

  return (
    <div
      className="rounded-2xl border bg-surface p-5"
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="text-[13px] font-semibold text-text">{t('agentPreview.title', 'Static preview')}</h3>
          <p className="text-[11px] text-text-muted mt-0.5">
            {t('agentPreview.subtitle', "How OpenCode will see this agent when it's invoked. No network call — just the compiled view.")}
          </p>
        </div>
        <div
          className="shrink-0 text-[10px] uppercase tracking-[0.08em] px-2 py-1 rounded-full font-medium"
          style={{
            color: scopeColor,
            background: `color-mix(in srgb, ${scopeColor} 12%, transparent)`,
          }}
        >
          {t('agentPreview.scopeLabel', '{{scope}} scope', { scope: scopeLabel(preview.scope) })}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <PreviewTile label={t('agentPreview.mention', 'Mention')} value={preview.mentionAs} mono />
        <PreviewTile label={t('agentPreview.toolsResolved', 'Tools resolved')} value={t('agentPreview.nOfM', '{{n}} of {{m}}', { n: String(preview.selectedTools.length), m: String(draft.toolIds.length) })} />
        <PreviewTile label={t('agentPreview.skillsResolved', 'Skills resolved')} value={t('agentPreview.nOfM', '{{n}} of {{m}}', { n: String(preview.selectedSkills.length), m: String(draft.skillNames.length) })} />
      </div>

      {(preview.missingTools.length > 0 || preview.missingSkills.length > 0) && (
        <div
          className="rounded-lg px-3 py-2 mb-4 text-[11px]"
          style={{
            color: 'var(--color-amber)',
            background: 'color-mix(in srgb, var(--color-amber) 8%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-amber) 20%, transparent)',
          }}
        >
          {preview.missingTools.length > 0 && (
            <div>{t('agentPreview.missingTools', 'Missing tools: {{list}}', { list: preview.missingTools.join(', ') })}</div>
          )}
          {preview.missingSkills.length > 0 && (
            <div>{t('agentPreview.missingSkills', 'Missing skills: {{list}}', { list: preview.missingSkills.join(', ') })}</div>
          )}
        </div>
      )}

      <PreviewSection label={t('agentPreview.systemPrompt', 'System prompt')}>
        <div
          className="rounded-lg px-3.5 py-3 text-[12px] text-text-secondary whitespace-pre-wrap leading-relaxed"
          style={{
            background: 'var(--color-elevated)',
            border: '1px solid var(--color-border-subtle)',
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          {preview.instructions}
        </div>
      </PreviewSection>

      {preview.selectedTools.length > 0 && (
        <PreviewSection label={t('agentPreview.toolPatterns', 'Tool patterns')}>
          <div className="flex flex-wrap gap-1.5">
            {preview.selectedTools.flatMap((tool) => tool.patterns.map((pattern) => (
              <code
                key={`${tool.id}:${pattern}`}
                className="text-[10px] font-mono px-2 py-0.5 rounded border"
                style={{
                  borderColor: 'var(--color-border-subtle)',
                  background: 'var(--color-elevated)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                {pattern}
              </code>
            )))}
          </div>
        </PreviewSection>
      )}

      {preview.selectedSkills.length > 0 && (
        <PreviewSection label={t('agentPreview.skillsAvailable', 'Skills available to load')}>
          <div className="flex flex-col gap-1.5">
            {preview.selectedSkills.map((skill) => (
              <div
                key={skill.name}
                className="rounded-lg px-3 py-2 text-[11px]"
                style={{
                  background: 'var(--color-elevated)',
                  border: '1px solid var(--color-border-subtle)',
                }}
              >
                <div className="font-medium text-text mb-0.5">{skill.label}</div>
                <div className="text-text-muted leading-relaxed">{skill.description}</div>
              </div>
            ))}
          </div>
        </PreviewSection>
      )}
    </div>
  )
}

function PreviewTile({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      className="rounded-lg px-3 py-2 border"
      style={{
        background: 'var(--color-elevated)',
        borderColor: 'var(--color-border-subtle)',
      }}
    >
      <div className="text-[9px] uppercase tracking-[0.08em] text-text-muted">{label}</div>
      <div className={`text-[12px] font-medium text-text truncate mt-0.5 ${mono ? 'font-mono' : ''}`} title={value}>
        {value}
      </div>
    </div>
  )
}

function PreviewSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-2">{label}</div>
      {children}
    </div>
  )
}
