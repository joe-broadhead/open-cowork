import { useEffect, useState } from 'react'
import type { DesktopPairingAuditEvent, DesktopPairingPublicRecord } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'

function statusLabel(record: DesktopPairingPublicRecord) {
  if (record.status === 'paired_online') return t('settings.pairing.status.online', 'Online')
  if (record.status === 'paired_offline') return t('settings.pairing.status.offline', 'Offline queued')
  if (record.status === 'disabled') return t('settings.pairing.status.disabled', 'Disabled')
  if (record.status === 'revoked') return t('settings.pairing.status.revoked', 'Revoked')
  return t('settings.pairing.status.error', 'Error')
}

function statusColor(record: DesktopPairingPublicRecord) {
  if (record.status === 'paired_online') return 'var(--color-green)'
  if (record.status === 'revoked' || record.status === 'error') return 'var(--color-red)'
  return 'var(--color-text-muted)'
}

function formatTime(value: string | null | undefined) {
  if (!value) return t('settings.pairing.never', 'Never')
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value))
  } catch {
    return value
  }
}

export function SettingsPairingPanel() {
  const [pairings, setPairings] = useState<DesktopPairingPublicRecord[]>([])
  const [audit, setAudit] = useState<DesktopPairingAuditEvent[]>([])
  const [label, setLabel] = useState('')
  const [brokerUrl, setBrokerUrl] = useState('')
  const [pairingToken, setPairingToken] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    const [nextPairings, nextAudit] = await Promise.all([
      window.coworkApi.desktopPairing.list(),
      window.coworkApi.desktopPairing.audit(),
    ])
    setPairings(nextPairings)
    setAudit(nextAudit)
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.coworkApi.desktopPairing.list(),
      window.coworkApi.desktopPairing.audit(),
    ]).then(([nextPairings, nextAudit]) => {
      if (cancelled) return
      setPairings(nextPairings)
      setAudit(nextAudit)
    }).catch((err) => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : String(err))
    })
    return () => { cancelled = true }
  }, [])

  const createPairing = async () => {
    setError(null)
    try {
      const created = await window.coworkApi.desktopPairing.create({
        label: label.trim() || t('settings.pairing.defaultLabel', 'Mobile gateway'),
        brokerUrl: brokerUrl.trim() || null,
        enabled: Boolean(brokerUrl.trim()),
        allowedWorkspaceIds: ['local'],
      })
      setPairingToken(created.pairingToken)
      setLabel('')
      setBrokerUrl('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const runAction = async (record: DesktopPairingPublicRecord, action: 'connect' | 'disconnect' | 'sync' | 'revoke') => {
    setBusyId(record.id)
    setError(null)
    try {
      if (action === 'connect') await window.coworkApi.desktopPairing.connect(record.id)
      else if (action === 'disconnect') await window.coworkApi.desktopPairing.disconnect(record.id)
      else if (action === 'sync') await window.coworkApi.desktopPairing.sync(record.id)
      else await window.coworkApi.desktopPairing.revoke(record.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const copyToken = async () => {
    if (!pairingToken) return
    await window.coworkApi.clipboard.writeText(pairingToken)
    setPairingToken(null)
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-2xl border border-border-subtle bg-surface px-4 py-4">
        <div className="text-[12px] font-semibold text-text">{t('settings.pairing.title', 'Outbound pairing')}</div>
        <div className="mt-1 text-[11px] leading-relaxed text-text-muted">
          {t('settings.pairing.description', 'Pairings let an approved gateway claim local desktop commands over a Desktop-initiated connection. Local paths, MCP details, and artifact bodies stay redacted by default.')}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1.4fr_auto]">
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t('settings.pairing.labelPlaceholder', 'Device label')}
            className="rounded-xl border border-border bg-elevated px-3 py-2 text-[12px] text-text outline-none"
          />
          <input
            value={brokerUrl}
            onChange={(event) => setBrokerUrl(event.target.value)}
            placeholder={t('settings.pairing.brokerPlaceholder', 'https://gateway.example.com')}
            className="rounded-xl border border-border bg-elevated px-3 py-2 text-[12px] text-text outline-none"
          />
          <button
            type="button"
            onClick={() => void createPairing()}
            className="rounded-xl px-4 py-2 text-[12px] font-semibold"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}
          >
            {t('settings.pairing.create', 'Create')}
          </button>
        </div>
        {pairingToken ? (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-elevated px-3 py-2">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">{t('settings.pairing.oneTimeToken', 'One-time token')}</div>
              <div className="truncate font-mono text-[11px] text-text" title={pairingToken}>{pairingToken}</div>
            </div>
            <button type="button" className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-[11px] text-text" onClick={() => void copyToken()}>
              {t('settings.pairing.copy', 'Copy')}
            </button>
          </div>
        ) : null}
        {error ? <div className="mt-3 text-[11px]" style={{ color: 'var(--color-red)' }}>{error}</div> : null}
      </div>

      <div className="grid gap-3">
        {pairings.length === 0 ? (
          <div className="rounded-2xl border border-border-subtle bg-surface px-4 py-5 text-[12px] text-text-muted">
            {t('settings.pairing.empty', 'No desktop pairings configured.')}
          </div>
        ) : pairings.map((record) => (
          <div key={record.id} className="rounded-2xl border border-border-subtle bg-surface px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[12px] font-semibold text-text">{record.label}</div>
                <div className="mt-1 truncate text-[11px] text-text-muted">{record.brokerUrl || t('settings.pairing.noBroker', 'Broker URL not configured')}</div>
              </div>
              <div className="shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold" style={{ color: statusColor(record), background: 'color-mix(in srgb, currentColor 10%, transparent)' }}>
                {statusLabel(record)}
              </div>
            </div>
            <div className="mt-3 grid gap-2 text-[11px] text-text-muted sm:grid-cols-3">
              <div>{t('settings.pairing.lastSeen', 'Last seen')}: {formatTime(record.lastHeartbeatAt)}</div>
              <div>{t('settings.pairing.sequence', 'Sequence')}: {record.lastCommandSequence}</div>
              <div>{record.credential.hasToken ? t('settings.pairing.tokenStored', 'Token stored') : t('settings.pairing.tokenMissing', 'Token missing')}</div>
            </div>
            {record.error ? <div className="mt-2 text-[11px]" style={{ color: 'var(--color-red)' }}>{record.error}</div> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {record.enabled ? (
                <button type="button" disabled={busyId === record.id} onClick={() => void runAction(record, 'disconnect')} className="rounded-lg border border-border px-3 py-1.5 text-[11px] text-text">
                  {t('settings.pairing.disconnect', 'Disconnect')}
                </button>
              ) : record.status !== 'revoked' ? (
                <button type="button" disabled={busyId === record.id} onClick={() => void runAction(record, 'connect')} className="rounded-lg border border-border px-3 py-1.5 text-[11px] text-text">
                  {t('settings.pairing.connect', 'Connect')}
                </button>
              ) : null}
              {record.status !== 'revoked' ? (
                <button type="button" disabled={busyId === record.id} onClick={() => void runAction(record, 'sync')} className="rounded-lg border border-border px-3 py-1.5 text-[11px] text-text">
                  {t('settings.pairing.sync', 'Sync now')}
                </button>
              ) : null}
              {record.status !== 'revoked' ? (
                <button type="button" disabled={busyId === record.id} onClick={() => void runAction(record, 'revoke')} className="rounded-lg border border-border px-3 py-1.5 text-[11px]" style={{ color: 'var(--color-red)' }}>
                  {t('settings.pairing.revoke', 'Revoke')}
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-border-subtle bg-surface px-4 py-4">
        <div className="text-[12px] font-semibold text-text">{t('settings.pairing.audit', 'Remote access audit')}</div>
        <div className="mt-3 grid gap-2">
          {audit.slice(0, 8).map((entry) => (
            <div key={entry.id} className="flex items-center justify-between gap-3 text-[11px]">
              <div className="min-w-0 truncate text-text">{entry.action}</div>
              <div className="shrink-0 text-text-muted">{formatTime(entry.createdAt)}</div>
            </div>
          ))}
          {audit.length === 0 ? <div className="text-[11px] text-text-muted">{t('settings.pairing.auditEmpty', 'No remote access events yet.')}</div> : null}
        </div>
      </div>
    </div>
  )
}
