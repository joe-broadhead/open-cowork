import type { ChannelActivationMode, ChannelDefinition, LocalWebhookReceiverStatus } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { usePulseDiagnostics } from '../usePulseDiagnostics'

const formatInteger = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

function formatRoute(mode: ChannelActivationMode) {
  switch (mode) {
    case 'ignore':
      return t('connections.route.ignore', 'Ignore')
    case 'draft_reply':
      return t('connections.route.draftReply', 'Draft reply')
    case 'ask_user':
      return t('connections.route.askUser', 'Ask user')
    case 'run_sop':
      return t('connections.route.runSop', 'Run workflow')
    case 'run_crew':
      return t('connections.route.runCrew', 'Run crew')
  }
}

function routeTarget(channel: ChannelDefinition) {
  if (channel.route.targetCrewId) return `Crew: ${channel.route.targetCrewId}`
  if (channel.route.targetSopId) return `Workflow: ${channel.route.targetSopId}`
  return t('connections.route.noTarget', 'No fixed target')
}

function receiverEndpoint(status: LocalWebhookReceiverStatus | null, sourceKey: string) {
  if (!status?.url) return null
  return status.url.replace(':sourceKey', encodeURIComponent(sourceKey))
}

function formatTime(value: string | null | undefined) {
  if (!value) return t('common.never', 'Never')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
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

function StatusPill({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className="inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em]"
      style={{
        color: active ? 'var(--color-green)' : 'var(--color-text-muted)',
        borderColor: active ? 'color-mix(in srgb, var(--color-green) 35%, transparent)' : 'var(--color-border-subtle)',
        background: active ? 'color-mix(in srgb, var(--color-green) 9%, transparent)' : 'var(--color-surface)',
      }}
    >
      {label}
    </span>
  )
}

export function ConnectionsPage({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const {
    diagnostics,
    channelState,
    localWebhookStatus,
    queueItems,
    refreshDiagnostics,
  } = usePulseDiagnostics()
  const activeChannels = channelState.channels.filter((channel) => channel.enabled)
  const reviewItems = channelState.inboundItems.filter((item) => item.status === 'needs_user' || item.status === 'queued' || item.status === 'drafted')
  const failedItems = channelState.inboundItems.filter((item) => item.status === 'denied' || item.status === 'failed')
  const deliveryDrafts = channelState.deliveries.filter((delivery) => delivery.status === 'draft' || delivery.status === 'approval_required' || delivery.status === 'sending')
  const channelQueueItems = queueItems.filter((item) => item.authority.isolation.channelBound)

  return (
    <div className="flex h-full min-h-0 flex-col bg-base text-text">
      <header className="border-b border-border-subtle px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-[18px] font-semibold">{t('connections.title', 'Connections')}</h1>
            <p className="mt-1 max-w-[720px] text-[12px] leading-relaxed text-text-muted">
              {t('connections.subtitle', 'Operational health for inbound channels, webhooks, MCP-backed tools, credentials, and route targets.')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void refreshDiagnostics()} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text">
              {diagnostics.loading ? t('common.refreshing', 'Refreshing...') : t('common.refresh', 'Refresh')}
            </button>
            {onOpenSettings ? (
              <button type="button" onClick={onOpenSettings} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text">
                {t('connections.openSettings', 'Channel settings')}
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <section className="grid grid-cols-6 gap-3 max-[1200px]:grid-cols-3 max-[760px]:grid-cols-2">
          <Stat label={t('connections.activeChannels', 'Active channels')} value={formatInteger.format(activeChannels.length)} tone={activeChannels.length > 0 ? 'accent' : 'default'} />
          <Stat label={t('connections.inboundItems', 'Inbound items')} value={formatInteger.format(channelState.inboundItems.length)} />
          <Stat label={t('connections.needsReview', 'Needs review')} value={formatInteger.format(reviewItems.length)} tone={reviewItems.length > 0 ? 'warn' : 'default'} />
          <Stat label={t('connections.deliveryDrafts', 'Delivery drafts')} value={formatInteger.format(deliveryDrafts.length)} tone={deliveryDrafts.length > 0 ? 'warn' : 'default'} />
          <Stat label={t('connections.configuredMcps', 'Configured MCPs')} value={formatInteger.format(diagnostics.customMcps.length)} />
          <Stat label={t('connections.runtimeTools', 'Runtime tools')} value={formatInteger.format(diagnostics.tools.length)} />
        </section>

        <section className="mt-4 grid grid-cols-[minmax(0,1fr)_320px] gap-4 max-[980px]:grid-cols-1">
          <div className="rounded-lg border border-border-subtle bg-elevated">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
              <div>
                <h2 className="text-[14px] font-semibold">{t('connections.routes', 'Inbound routes')}</h2>
                <p className="mt-0.5 text-[11px] text-text-muted">{t('connections.routesHint', 'Configured channels, route modes, targets, allowed capabilities, and isolation profile.')}</p>
              </div>
              <StatusPill active={Boolean(localWebhookStatus?.listening)} label={localWebhookStatus?.listening ? t('connections.webhookListening', 'Webhook listening') : t('connections.webhookNotListening', 'Webhook inactive')} />
            </div>
            <div className="divide-y divide-border-subtle">
              {channelState.channels.map((channel) => {
                const endpoint = receiverEndpoint(localWebhookStatus, channel.sourceKey)
                return (
                  <article key={channel.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <h3 className="truncate text-[13px] font-semibold">{channel.name}</h3>
                          <StatusPill active={channel.enabled} label={channel.enabled ? t('common.enabled', 'Enabled') : t('common.disabled', 'Disabled')} />
                        </div>
                        <p className="mt-1 text-[11px] text-text-muted">{channel.provider} / {channel.sourceKey} / {formatRoute(channel.route.activationMode)}</p>
                      </div>
                      <div className="shrink-0 text-right text-[11px] text-text-muted">
                        {formatTime(channel.updatedAt)}
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-4 gap-2 max-[980px]:grid-cols-2">
                      <div className="rounded-md border border-border-subtle bg-surface px-3 py-2">
                        <div className="text-[10px] uppercase tracking-[0.1em] text-text-muted">{t('connections.target', 'Target')}</div>
                        <div className="mt-1 truncate text-[12px] text-text-secondary">{routeTarget(channel)}</div>
                      </div>
                      <div className="rounded-md border border-border-subtle bg-surface px-3 py-2">
                        <div className="text-[10px] uppercase tracking-[0.1em] text-text-muted">{t('connections.capabilities', 'Capabilities')}</div>
                        <div className="mt-1 truncate text-[12px] text-text-secondary">{channel.allowedCapabilityIds.join(', ') || t('connections.noCapabilityLimit', 'No limit')}</div>
                      </div>
                      <div className="rounded-md border border-border-subtle bg-surface px-3 py-2">
                        <div className="text-[10px] uppercase tracking-[0.1em] text-text-muted">{t('connections.workspace', 'Workspace')}</div>
                        <div className="mt-1 truncate text-[12px] text-text-secondary">{channel.workspaceProfileId}</div>
                      </div>
                      <div className="rounded-md border border-border-subtle bg-surface px-3 py-2">
                        <div className="text-[10px] uppercase tracking-[0.1em] text-text-muted">{t('connections.senders', 'Senders')}</div>
                        <div className="mt-1 truncate text-[12px] text-text-secondary">{channel.senderAllowlist.length || t('connections.anySender', 'Any')}</div>
                      </div>
                    </div>
                    {endpoint ? <div className="mt-3 break-all rounded-md border border-border-subtle bg-base px-3 py-2 font-mono text-[10px] text-text-muted">{endpoint}</div> : null}
                  </article>
                )
              })}
              {channelState.channels.length === 0 ? (
                <div className="px-4 py-10 text-center text-[12px] text-text-muted">{t('connections.noChannels', 'No inbound channels configured yet.')}</div>
              ) : null}
            </div>
          </div>

          <aside className="flex flex-col gap-4">
            <section className="rounded-lg border border-border-subtle bg-elevated px-4 py-4">
              <h2 className="text-[13px] font-semibold">{t('connections.webhookHealth', 'Local webhook')}</h2>
              <div className="mt-3 space-y-2 text-[12px]">
                <div className="flex justify-between gap-3"><span className="text-text-muted">{t('connections.status', 'Status')}</span><span className="text-text-secondary">{localWebhookStatus?.listening ? t('connections.listening', 'Listening') : localWebhookStatus?.enabled ? t('connections.notListening', 'Not listening') : t('connections.disabled', 'Disabled')}</span></div>
                <div className="flex justify-between gap-3"><span className="text-text-muted">{t('connections.pairedChannels', 'Paired channels')}</span><span className="text-text-secondary">{formatInteger.format(localWebhookStatus?.pairedChannels || 0)}</span></div>
                <div className="flex justify-between gap-3"><span className="text-text-muted">{t('connections.port', 'Port')}</span><span className="text-text-secondary">{localWebhookStatus?.port || '-'}</span></div>
                <div className="flex justify-between gap-3"><span className="text-text-muted">{t('connections.channelQueue', 'Channel queue')}</span><span className="text-text-secondary">{formatInteger.format(channelQueueItems.length)}</span></div>
              </div>
              {localWebhookStatus?.lastError ? <p className="mt-3 rounded-md border border-red-400/25 bg-red-500/10 px-3 py-2 text-[11px] text-red">{localWebhookStatus.lastError}</p> : null}
            </section>
            <section className="rounded-lg border border-border-subtle bg-elevated px-4 py-4">
              <h2 className="text-[13px] font-semibold">{t('connections.reviewQueue', 'Review queue')}</h2>
              <div className="mt-3 space-y-2">
                {reviewItems.slice(0, 4).map((item) => (
                  <div key={item.id} className="rounded-md border border-border-subtle bg-surface px-3 py-2">
                    <div className="truncate text-[12px] font-medium">{item.subject || item.sender}</div>
                    <div className="mt-1 text-[11px] text-text-muted">{item.status.replace(/_/g, ' ')} / {formatRoute(item.route.activationMode)}</div>
                  </div>
                ))}
                {reviewItems.length === 0 ? <div className="rounded-md border border-border-subtle bg-surface px-3 py-3 text-[12px] text-text-muted">{t('connections.noReviewItems', 'No channel items are waiting for review.')}</div> : null}
              </div>
            </section>
            <section className="rounded-lg border border-border-subtle bg-elevated px-4 py-4">
              <h2 className="text-[13px] font-semibold">{t('connections.incidents', 'Connection incidents')}</h2>
              <div className="mt-3 text-[12px] text-text-secondary">
                {failedItems.length === 0
                  ? t('connections.noIncidents', 'No denied or failed inbound items recorded.')
                  : t('connections.incidentCount', '{{count}} denied or failed item(s) need inspection.', { count: formatInteger.format(failedItems.length) })}
              </div>
            </section>
          </aside>
        </section>
      </main>
    </div>
  )
}
