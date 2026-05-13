import { useEffect, useMemo, useState } from 'react'
import type {
  EffectiveAppSettings,
  GovernanceAuditEvent,
  GovernanceRegistryPayload,
  PublicAppConfig,
  RuntimePermissionPolicy,
} from '@open-cowork/shared'
import { writeTextToClipboard } from '../../helpers/clipboard'
import { t } from '../../helpers/i18n'
import { useSessionStore } from '../../stores/session'
import { usePulseDiagnostics } from '../usePulseDiagnostics'

const formatInteger = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const formatCurrency = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

function permissionLabel(value: RuntimePermissionPolicy | undefined) {
  if (value === 'allow') return t('governance.permission.allow', 'Allow')
  if (value === 'ask') return t('governance.permission.ask', 'Ask')
  return t('governance.permission.deny', 'Deny')
}

function formatDate(value: string | null | undefined) {
  if (!value) return t('common.never', 'Never')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

function summarizeRegistry(registry: GovernanceRegistryPayload | null) {
  const subjects = registry?.subjects || []
  const controls = subjects.flatMap((subject) => subject.incidentControls)
  return {
    org: registry?.organization.displayName || t('governance.localOrg', 'Local organization'),
    agents: subjects.filter((subject) => subject.subjectKind === 'agent').length,
    crews: subjects.filter((subject) => subject.subjectKind === 'crew').length,
    tools: subjects.filter((subject) => subject.subjectKind === 'tool').length,
    memories: subjects.filter((subject) => subject.subjectKind === 'memory').length,
    dependencies: registry?.dependencyIndex.length || 0,
    controls: controls.length,
    availableControls: controls.filter((control) => control.available).length,
    vaults: registry?.secretVaults.length || 0,
    activeVaults: registry?.secretVaults.filter((vault) => vault.status === 'active').length || 0,
    nodes: registry?.executionNodes.length || 0,
    activeNodes: registry?.executionNodes.filter((node) => node.status === 'active').length || 0,
  }
}

function Stat({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'accent' | 'warn' }) {
  const color = tone === 'warn' ? 'var(--color-orange)' : tone === 'accent' ? 'var(--color-accent)' : 'var(--color-text)'
  return (
    <div className="rounded-lg border border-border-subtle bg-elevated px-3 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{label}</div>
      <div className="mt-2 text-[20px] font-semibold tabular-nums" style={{ color }}>{value}</div>
    </div>
  )
}

function AuditRow({ event }: { event: GovernanceAuditEvent }) {
  return (
    <div className="rounded-md border border-border-subtle bg-surface px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-medium text-text">{event.subjectKind}: {event.subjectId}</div>
          <div className="mt-1 text-[11px] text-text-muted">{event.action.replace(/_/g, ' ')} / {formatDate(event.createdAt)}</div>
        </div>
        <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-[0.1em] ${event.outcome === 'failed' ? 'text-red' : 'text-accent'}`}>{event.outcome}</span>
      </div>
      {event.reason ? <div className="mt-2 line-clamp-2 text-[11px] text-text-secondary">{event.reason}</div> : null}
    </div>
  )
}

export function GovernancePage({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const {
    diagnostics,
    capabilityRisks,
    governanceRegistry,
    governanceAuditEvents,
    improvementSummary,
    refreshDiagnostics,
  } = usePulseDiagnostics()
  const [settings, setSettings] = useState<EffectiveAppSettings | null>(null)
  const [config, setConfig] = useState<PublicAppConfig | null>(null)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'working' | 'copied' | 'empty' | 'failed'>('idle')
  const addGlobalError = useSessionStore((state) => state.addGlobalError)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.coworkApi.settings.get(),
      window.coworkApi.app.config(),
    ]).then(([nextSettings, nextConfig]) => {
      if (cancelled) return
      setSettings(nextSettings)
      setConfig(nextConfig)
    }).catch((error) => {
      if (cancelled) return
      addGlobalError(t('governance.settingsLoadFailed', 'Could not load governance settings. Please try again.'))
      try {
        window.coworkApi?.diagnostics?.reportRendererError?.({
          message: `Governance settings load failed: ${error instanceof Error ? error.message : String(error)}`,
          stack: error instanceof Error ? error.stack : undefined,
          view: 'governance',
        })
      } catch {
        // Diagnostics are best-effort from this recovery path.
      }
    })
    return () => { cancelled = true }
  }, [addGlobalError])

  const registrySummary = useMemo(() => summarizeRegistry(governanceRegistry), [governanceRegistry])
  const riskSummary = useMemo(() => ({
    high: capabilityRisks.filter((risk) => risk.risk === 'high').length,
    write: capabilityRisks.filter((risk) => risk.writeCapable).length,
    approval: capabilityRisks.filter((risk) => risk.approvalRequired).length,
  }), [capabilityRisks])

  async function copyAuditExport() {
    setCopyStatus('working')
    try {
      const payload = await window.coworkApi.operations.exportGovernanceAudit({ format: 'ndjson' })
      if (!payload.body.trim()) {
        setCopyStatus('empty')
        return
      }
      const copied = await writeTextToClipboard(payload.body)
      setCopyStatus(copied ? 'copied' : 'failed')
    } catch (error) {
      setCopyStatus('failed')
      addGlobalError(t('governance.auditExportFailed', 'Could not export the governance audit. Please try again.'))
      try {
        window.coworkApi?.diagnostics?.reportRendererError?.({
          message: `Governance audit export failed: ${error instanceof Error ? error.message : String(error)}`,
          stack: error instanceof Error ? error.stack : undefined,
          view: 'governance',
        })
      } catch {
        // Diagnostics are best-effort from this recovery path.
      }
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-base text-text">
      <header className="border-b border-border-subtle px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-[18px] font-semibold">{t('governance.title', 'Governance')}</h1>
            <p className="mt-1 max-w-[760px] text-[12px] leading-relaxed text-text-muted">
              {t('governance.subtitle', 'Operational policy, destructive-action controls, audit incidents, capability risk, and guardrail health.')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void refreshDiagnostics()} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text">
              {diagnostics.loading ? t('common.refreshing', 'Refreshing...') : t('common.refresh', 'Refresh')}
            </button>
            {onOpenSettings ? (
              <button type="button" onClick={onOpenSettings} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text">
                {t('governance.openSettings', 'Policy settings')}
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <section className="grid grid-cols-6 gap-3 max-[1200px]:grid-cols-3 max-[760px]:grid-cols-2">
          <Stat label={t('governance.agents', 'Agents')} value={formatInteger.format(registrySummary.agents)} />
          <Stat label={t('governance.crews', 'Crews')} value={formatInteger.format(registrySummary.crews)} />
          <Stat label={t('governance.dependencies', 'Dependencies')} value={formatInteger.format(registrySummary.dependencies)} />
          <Stat label={t('governance.controls', 'Controls')} value={`${formatInteger.format(registrySummary.availableControls)}/${formatInteger.format(registrySummary.controls)}`} tone={registrySummary.availableControls > 0 ? 'accent' : 'default'} />
          <Stat label={t('governance.highRisk', 'High risk')} value={formatInteger.format(riskSummary.high)} tone={riskSummary.high > 0 ? 'warn' : 'default'} />
          <Stat label={t('governance.writeCaps', 'Write caps')} value={formatInteger.format(riskSummary.write)} tone={riskSummary.write > 0 ? 'warn' : 'default'} />
        </section>

        <section className="mt-4 grid grid-cols-[minmax(0,1fr)_360px] gap-4 max-[1040px]:grid-cols-1">
          <div className="rounded-lg border border-border-subtle bg-elevated">
            <div className="border-b border-border-subtle px-4 py-3">
              <h2 className="text-[14px] font-semibold">{registrySummary.org}</h2>
              <p className="mt-0.5 text-[11px] text-text-muted">
                {t('governance.registryHint', 'Current governed subjects, dependencies, vaults, execution nodes, and incident controls.')}
              </p>
            </div>
            <div className="grid grid-cols-4 gap-3 px-4 py-4 max-[980px]:grid-cols-2">
              {[
                { label: t('governance.tools', 'Tools'), value: registrySummary.tools },
                { label: t('governance.memories', 'Memories'), value: registrySummary.memories },
                { label: t('governance.vaults', 'Vaults'), value: `${registrySummary.activeVaults}/${registrySummary.vaults}` },
                { label: t('governance.nodes', 'Nodes'), value: `${registrySummary.activeNodes}/${registrySummary.nodes}` },
              ].map((item) => (
                <div key={item.label} className="rounded-md border border-border-subtle bg-surface px-3 py-3">
                  <div className="text-[10px] uppercase tracking-[0.1em] text-text-muted">{item.label}</div>
                  <div className="mt-1 text-[14px] font-semibold text-text">{item.value}</div>
                </div>
              ))}
            </div>
            <div className="divide-y divide-border-subtle">
              {(governanceRegistry?.dependencyIndex || []).slice(0, 8).map((entry) => (
                <div key={`${entry.dependency.kind}:${entry.dependency.id}`} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{entry.dependency.kind.replace(/_/g, ' ')}</div>
                      <div className="mt-1 truncate text-[13px] font-medium text-text">{entry.dependency.label}</div>
                    </div>
                    <div className="shrink-0 text-[11px] text-text-muted">{formatInteger.format(entry.subjectIds.length)} subject(s)</div>
                  </div>
                </div>
              ))}
              {(governanceRegistry?.dependencyIndex.length || 0) === 0 ? (
                <div className="px-4 py-10 text-center text-[12px] text-text-muted">{t('governance.noDependencies', 'No governed dependency map is available yet.')}</div>
              ) : null}
            </div>
          </div>

          <aside className="flex flex-col gap-4">
            <section className="rounded-lg border border-border-subtle bg-elevated px-4 py-4">
              <h2 className="text-[13px] font-semibold">{t('governance.permissionPolicy', 'Permission policy')}</h2>
              <div className="mt-3 space-y-2 text-[12px]">
                <div className="flex justify-between gap-3"><span className="text-text-muted">{t('governance.shellCommands', 'Shell commands')}</span><span className="text-text-secondary">{permissionLabel(settings?.bashPermission)} / max {permissionLabel(config?.permissions.bash)}</span></div>
                <div className="flex justify-between gap-3"><span className="text-text-muted">{t('governance.fileEditing', 'File editing')}</span><span className="text-text-secondary">{permissionLabel(settings?.fileWritePermission)} / max {permissionLabel(config?.permissions.fileWrite)}</span></div>
                <div className="flex justify-between gap-3"><span className="text-text-muted">{t('governance.toolingBridge', 'Developer config bridge')}</span><span className="text-text-secondary">{settings?.runtimeToolingBridgeEnabled ? t('common.enabled', 'Enabled') : t('common.disabled', 'Disabled')}</span></div>
              </div>
            </section>
            <section className="rounded-lg border border-border-subtle bg-elevated px-4 py-4">
              <h2 className="text-[13px] font-semibold">{t('governance.guardrails', 'Automation guardrails')}</h2>
              <div className="mt-3 space-y-2 text-[12px]">
                <div className="flex justify-between gap-3"><span className="text-text-muted">{t('governance.maxAutonomy', 'Max autonomy')}</span><span className="text-text-secondary">{settings?.operationalMaxAutonomy || '-'}</span></div>
                <div className="flex justify-between gap-3"><span className="text-text-muted">{t('governance.writeParallelism', 'Write parallelism')}</span><span className="text-text-secondary">{settings ? formatInteger.format(settings.operationalWriteMaxParallel) : '-'}</span></div>
                <div className="flex justify-between gap-3"><span className="text-text-muted">{t('governance.maxRunDuration', 'Max run duration')}</span><span className="text-text-secondary">{settings ? `${settings.operationalMaxRunDurationMinutes}m` : '-'}</span></div>
                <div className="flex justify-between gap-3"><span className="text-text-muted">{t('governance.queueBudget', 'Queue budget')}</span><span className="text-text-secondary">{settings?.operationalMaxCostUsd == null ? t('governance.noBudgetCap', 'No cap') : formatCurrency.format(settings.operationalMaxCostUsd)}</span></div>
                <div className="flex justify-between gap-3"><span className="text-text-muted">{t('governance.governedLearning', 'Governed learning')}</span><span className="text-text-secondary">{settings?.improvementProposalsEnabled ? t('common.enabled', 'Enabled') : t('common.disabled', 'Disabled')}</span></div>
                <div className="flex justify-between gap-3"><span className="text-text-muted">{t('governance.pendingProposals', 'Pending proposals')}</span><span className="text-text-secondary">{formatInteger.format(improvementSummary?.proposals.proposed || 0)}</span></div>
              </div>
            </section>
            <section className="rounded-lg border border-border-subtle bg-elevated px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[13px] font-semibold">{t('governance.recentIncidents', 'Recent incidents')}</h2>
                <button type="button" onClick={() => void copyAuditExport()} disabled={copyStatus === 'working'} className="rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-secondary hover:bg-surface-hover disabled:cursor-wait disabled:opacity-60">
                  {copyStatus === 'working' ? t('common.copying', 'Copying...') : t('governance.copyAudit', 'Copy audit')}
                </button>
              </div>
              {copyStatus !== 'idle' && copyStatus !== 'working' ? (
                <div className="mt-2 text-[11px] text-text-muted">
                  {copyStatus === 'copied' ? t('governance.copied', 'Copied') : copyStatus === 'empty' ? t('governance.emptyAudit', 'No records') : t('governance.copyFailed', 'Copy failed')}
                </div>
              ) : null}
              <div className="mt-3 space-y-2">
                {governanceAuditEvents.slice(0, 5).map((event) => <AuditRow key={event.id} event={event} />)}
                {governanceAuditEvents.length === 0 ? <div className="rounded-md border border-border-subtle bg-surface px-3 py-3 text-[12px] text-text-muted">{t('governance.noIncidents', 'No governance audit incidents recorded yet.')}</div> : null}
              </div>
            </section>
          </aside>
        </section>
      </main>
    </div>
  )
}
