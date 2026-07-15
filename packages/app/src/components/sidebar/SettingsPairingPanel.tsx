import { useEffect, useState } from 'react'
import type { DesktopPairingAuditEvent, DesktopPairingPublicRecord } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { Badge, Button, Card, Input, type BadgeTone } from '@open-cowork/ui'

function statusLabel(record: DesktopPairingPublicRecord) {
  if (record.status === 'paired_online') return t('settings.pairing.status.online', 'Online')
  if (record.status === 'paired_offline') return t('settings.pairing.status.offline', 'Offline queued')
  if (record.status === 'disabled') return t('settings.pairing.status.disabled', 'Disabled')
  if (record.status === 'revoked') return t('settings.pairing.status.revoked', 'Revoked')
  return t('settings.pairing.status.error', 'Error')
}

function statusTone(record: DesktopPairingPublicRecord): BadgeTone {
  if (record.status === 'paired_online') return 'success'
  if (record.status === 'revoked' || record.status === 'error') return 'danger'
  return 'neutral'
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
      <Card>
        <div className="text-xs font-semibold text-text">{t('settings.pairing.title', 'Outbound pairing')}</div>
        <div className="mt-1 text-2xs leading-relaxed text-text-muted">
          {t('settings.pairing.description', 'Pairings let an approved gateway claim local desktop commands over a Desktop-initiated connection. Local paths, MCP details, and artifact bodies stay redacted by default.')}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1.4fr_auto]">
          <Input
            size="sm"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t('settings.pairing.labelPlaceholder', 'Device label')}
            aria-label={t('settings.pairing.labelPlaceholder', 'Device label')}
          />
          <Input
            size="sm"
            value={brokerUrl}
            onChange={(event) => setBrokerUrl(event.target.value)}
            placeholder={t('settings.pairing.brokerPlaceholder', 'https://gateway.example.com')}
            aria-label={t('settings.pairing.brokerLabel', 'Broker URL')}
          />
          <Button
            type="button"
            size="sm"
            variant="primary"
            onClick={() => void createPairing()}
          >
            {t('settings.pairing.create', 'Create')}
          </Button>
        </div>
        {pairingToken ? (
          <Card variant="flat" padding="sm" className="mt-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-2xs uppercase tracking-[0.08em] text-text-muted">{t('settings.pairing.oneTimeToken', 'One-time token')}</div>
              <div className="truncate font-mono text-2xs text-text" title={pairingToken}>{pairingToken}</div>
            </div>
            <Button type="button" size="sm" variant="secondary" className="shrink-0" onClick={() => void copyToken()}>
              {t('settings.pairing.copy', 'Copy')}
            </Button>
          </Card>
        ) : null}
        {error ? <div className="mt-3 text-2xs text-red">{error}</div> : null}
      </Card>

      <div className="grid gap-3">
        {pairings.length === 0 ? (
          <Card variant="flat" className="text-xs text-text-muted">
            {t('settings.pairing.empty', 'No desktop pairings configured.')}
          </Card>
        ) : pairings.map((record) => (
          <Card key={record.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-text">{record.label}</div>
                <div className="mt-1 truncate text-2xs text-text-muted">{record.brokerUrl || t('settings.pairing.noBroker', 'Broker URL not configured')}</div>
              </div>
              <Badge tone={statusTone(record)} className="shrink-0">
                {statusLabel(record)}
              </Badge>
            </div>
            <div className="mt-3 grid gap-2 text-2xs text-text-muted sm:grid-cols-3">
              <div>{t('settings.pairing.lastSeen', 'Last seen')}: {formatTime(record.lastHeartbeatAt)}</div>
              <div>{t('settings.pairing.sequence', 'Sequence')}: {record.lastCommandSequence}</div>
              <div>{record.credential.hasToken ? t('settings.pairing.tokenStored', 'Token stored') : t('settings.pairing.tokenMissing', 'Token missing')}</div>
            </div>
            {record.error ? <div className="mt-2 text-2xs text-red">{record.error}</div> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {record.enabled ? (
                <Button type="button" size="sm" variant="secondary" disabled={busyId === record.id} onClick={() => void runAction(record, 'disconnect')}>
                  {t('settings.pairing.disconnect', 'Disconnect')}
                </Button>
              ) : record.status !== 'revoked' ? (
                <Button type="button" size="sm" variant="secondary" disabled={busyId === record.id} onClick={() => void runAction(record, 'connect')}>
                  {t('settings.pairing.connect', 'Connect')}
                </Button>
              ) : null}
              {record.status !== 'revoked' ? (
                <Button type="button" size="sm" variant="secondary" disabled={busyId === record.id} onClick={() => void runAction(record, 'sync')}>
                  {t('settings.pairing.sync', 'Sync now')}
                </Button>
              ) : null}
              {record.status !== 'revoked' ? (
                <Button type="button" size="sm" variant="danger" disabled={busyId === record.id} onClick={() => void runAction(record, 'revoke')}>
                  {t('settings.pairing.revoke', 'Revoke')}
                </Button>
              ) : null}
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <div className="text-xs font-semibold text-text">{t('settings.pairing.audit', 'Remote access audit')}</div>
        <div className="mt-3 grid gap-2">
          {audit.slice(0, 8).map((entry) => (
            <div key={entry.id} className="flex items-center justify-between gap-3 text-2xs">
              <div className="min-w-0 truncate text-text">{entry.action}</div>
              <div className="shrink-0 text-text-muted">{formatTime(entry.createdAt)}</div>
            </div>
          ))}
          {audit.length === 0 ? <div className="text-2xs text-text-muted">{t('settings.pairing.auditEmpty', 'No remote access events yet.')}</div> : null}
        </div>
      </Card>
    </div>
  )
}
