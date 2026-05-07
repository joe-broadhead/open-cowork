import { useMemo } from 'react'
import type {
  BuiltInAgentDetail,
  DashboardSummary,
} from '@open-cowork/shared'
import { t } from '../helpers/i18n'
import {
  ArrowUpRight,
  FolderIcon,
  formatInteger,
  formatLeadAgentLabel,
  formatProviderLabel,
  formatRuntimeOptionValue,
  formatSourceLabel,
  formatThreadPath,
  PlusIcon,
  type DiagnosticsState,
} from './pulse-page-support.tsx'
import { Row, TagRail } from './pulse-page-components.tsx'

type PulseSidebarProps = {
  busySessions: Set<string>
  dashboardSummary: DashboardSummary | null
  diagnostics: DiagnosticsState
  leadAgent: BuiltInAgentDetail | null
  recentSessions: DashboardSummary['recentSessions']
  onCreateThread: (directory?: string) => void | Promise<void>
  onOpenRecentThread: (sessionId: string) => void | Promise<void>
}

export function PulseSidebar({
  busySessions,
  dashboardSummary,
  diagnostics,
  leadAgent,
  recentSessions,
  onCreateThread,
  onOpenRecentThread,
}: PulseSidebarProps) {
  const runtimeOptionTags = useMemo(() => {
    const options = diagnostics.runtimeInputs?.providerOptions || {}
    return Object.entries(options).map(([key, value]) => `${key}: ${formatRuntimeOptionValue(value)}`)
  }, [diagnostics.runtimeInputs])
  const runtimeOverrideTags = diagnostics.runtimeInputs?.credentialOverrideKeys || []

  return (
    <aside
      className="border-s max-[1080px]:border-s-0 max-[1080px]:border-t border-border-subtle p-5 flex flex-col gap-5"
      style={{ background: 'color-mix(in srgb, var(--color-base) 95%, var(--color-elevated) 5%)' }}
    >
      <section
        className="rounded-[24px] border border-border-subtle overflow-hidden"
        style={{
          background: 'color-mix(in srgb, var(--color-surface) 40%, var(--color-elevated) 60%)',
          boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--color-text) 2.5%, transparent)',
        }}
      >
        <div className="px-4 py-4 border-b border-border-subtle">
          <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{t('homepage.side.recentWork', 'Recent work')}</div>
          <div className="mt-2 text-[18px] font-semibold text-text">{t('homepage.side.resumeThreads', 'Resume threads')}</div>
        </div>
        <div className="p-3 flex flex-col gap-2.5">
          {recentSessions.length > 0 ? (
            recentSessions.map((session) => {
              const isBusy = busySessions.has(session.id)
              return (
                <button
                  key={session.id}
                  onClick={() => void onOpenRecentThread(session.id)}
                  className="w-full rounded-2xl px-4 py-3 text-start hover:bg-surface-hover transition-colors cursor-pointer"
                  style={{
                    background: 'color-mix(in srgb, var(--color-elevated) 96%, var(--color-base) 4%)',
                    boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        {isBusy ? (
                          <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-accent animate-pulse" />
                        ) : (
                          <span
                            className="w-1.5 h-1.5 rounded-full shrink-0"
                            style={{ background: 'color-mix(in srgb, var(--color-text-muted) 50%, transparent)' }}
                          />
                        )}
                        <span className="text-[13px] font-medium text-text truncate">{session.title || t('sidebar.threadFallback', 'Thread {{id}}', { id: session.id.slice(0, 6) })}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-text-muted truncate">
                        {formatThreadPath(session.directory)} · {new Date(session.updatedAt).toLocaleDateString()}
                      </div>
                    </div>
                    <span className="text-text-muted shrink-0"><ArrowUpRight /></span>
                  </div>
                </button>
              )
            })
          ) : (
            <div
              className="rounded-2xl px-4 py-6 text-[12px] leading-relaxed text-text-muted"
              style={{
                background: 'color-mix(in srgb, var(--color-elevated) 92%, var(--color-base) 8%)',
                boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
              }}
            >
              {t('homepage.side.noRecentThreads', 'No threads in {{window}} yet. Start one from the actions below and the home page becomes your queue.', { window: dashboardSummary?.range.label?.toLowerCase() || t('homepage.side.selectedPeriod', 'the selected period') })}
            </div>
          )}
        </div>
      </section>

      <section
        className="rounded-[24px] border border-border-subtle overflow-hidden"
        style={{
          background: 'color-mix(in srgb, var(--color-surface) 40%, var(--color-elevated) 60%)',
          boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--color-text) 2.5%, transparent)',
        }}
      >
        <div className="px-4 py-4 border-b border-border-subtle">
          <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{t('homepage.side.actions', 'Actions')}</div>
          <div className="mt-2 text-[18px] font-semibold text-text">{t('homepage.side.openWorkingSurface', 'Open a working surface')}</div>
        </div>
        <div className="p-3 grid grid-cols-1 gap-2.5">
          <button
            onClick={() => void onCreateThread()}
            className="rounded-2xl hover:bg-surface-hover px-4 py-3 text-start transition-colors cursor-pointer"
            style={{
              background: 'color-mix(in srgb, var(--color-elevated) 96%, var(--color-base) 4%)',
              boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <span
                className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-surface text-text-secondary"
                style={{
                  boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
                }}
              >
                <PlusIcon />
              </span>
              <span className="text-text-muted"><ArrowUpRight /></span>
            </div>
            <div className="mt-4 text-[14px] font-semibold text-text">{t('homepage.side.newThread', 'New thread')}</div>
            <div className="mt-1 text-[12px] leading-relaxed text-text-secondary">
              {t('homepage.side.newThreadHint', 'Open a fresh workspace-bound conversation.')}
            </div>
          </button>

          <button
            onClick={async () => {
              const dir = await window.coworkApi.dialog.selectDirectory()
              if (dir) await onCreateThread(dir)
            }}
            className="rounded-2xl hover:bg-surface-hover px-4 py-3 text-start transition-colors cursor-pointer"
            style={{
              background: 'color-mix(in srgb, var(--color-elevated) 96%, var(--color-base) 4%)',
              boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <span
                className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-surface text-text-secondary"
                style={{
                  boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
                }}
              >
                <FolderIcon />
              </span>
              <span className="text-text-muted"><ArrowUpRight /></span>
            </div>
            <div className="mt-4 text-[14px] font-semibold text-text">{t('homepage.side.openDirectory', 'Open directory')}</div>
            <div className="mt-1 text-[12px] leading-relaxed text-text-secondary">
              {t('homepage.side.openDirectoryHint', 'Ground the next session in a real codebase or project folder.')}
            </div>
          </button>
        </div>
      </section>

      <section
        className="rounded-[24px] border border-border-subtle px-4 py-4"
        style={{
          background: 'color-mix(in srgb, var(--color-surface) 40%, var(--color-elevated) 60%)',
          boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--color-text) 2.5%, transparent)',
        }}
      >
        <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{t('homepage.side.currentInventory', 'Current inventory')}</div>
        <div className="mt-3 flex flex-col gap-3">
          <Row label={t('homepage.side.availableTools', 'Available tools')} value={formatInteger.format(diagnostics.tools.length)} />
          <Row label={t('homepage.card.leadAgent', 'Lead agent')} value={formatLeadAgentLabel(leadAgent)} />
          <Row label={t('homepage.side.skillBundles', 'Skill bundles')} value={formatInteger.format(diagnostics.skills.length)} />
        </div>
      </section>

      <section
        className="rounded-[24px] border border-border-subtle px-4 py-4"
        style={{
          background: 'color-mix(in srgb, var(--color-surface) 40%, var(--color-elevated) 60%)',
          boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--color-text) 2.5%, transparent)',
        }}
      >
        <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{t('homepage.side.runtimeInputs', 'Runtime inputs')}</div>
        <div className="mt-3 flex flex-col gap-3">
          <Row label={t('homepage.side.opencodeVersion', 'OpenCode')} value={diagnostics.runtimeInputs?.opencodeVersion || t('common.unknown', 'Unknown')} />
          <Row
            label={t('homepage.side.providerName', 'Provider')}
            value={diagnostics.runtimeInputs?.providerName || formatProviderLabel(diagnostics.runtimeInputs?.providerId) || t('homepage.pill.providerNotConfigured', 'Not configured')}
          />
          <Row
            label={t('homepage.side.providerSource', 'Provider source')}
            value={diagnostics.runtimeInputs ? formatSourceLabel(diagnostics.runtimeInputs.providerSource) : t('common.unknown', 'Unknown')}
            tone="muted"
          />
          <Row
            label={t('homepage.side.model', 'Model')}
            value={diagnostics.runtimeInputs?.modelId || diagnostics.runtimeModel.modelId || t('homepage.pill.providerNotConfigured', 'Not configured')}
          />
          <Row
            label={t('homepage.side.modelSource', 'Model source')}
            value={diagnostics.runtimeInputs ? formatSourceLabel(diagnostics.runtimeInputs.modelSource) : t('common.unknown', 'Unknown')}
            tone="muted"
          />
          <Row label={t('homepage.side.package', 'Package')} value={diagnostics.runtimeInputs?.providerPackage || t('homepage.side.packageFallback', 'Built-in/runtime')} tone="muted" />
        </div>

        <div className="mt-4">
          <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{t('homepage.side.providerOptions', 'Provider options')}</div>
          <div className="mt-2">
            <TagRail items={runtimeOptionTags} emptyLabel={t('homepage.side.noOptions', 'No non-secret provider options exposed.')} />
          </div>
        </div>

        <div className="mt-4">
          <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{t('homepage.side.credentialOverrides', 'Credential overrides')}</div>
          <div className="mt-2">
            <TagRail items={runtimeOverrideTags} emptyLabel={t('homepage.side.usingDefaults', 'Using config defaults.')} />
          </div>
        </div>
      </section>
    </aside>
  )
}
