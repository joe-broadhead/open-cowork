import { useEffect, useState } from 'react'
import type {
  WikiRemoteConnectionSummary,
  WikiSourceResult,
  WikiSourceState,
} from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { Badge, Button, Card, Dialog } from '@open-cowork/ui'

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function ConnectionRow({
  connection,
  active,
  busy,
  onUse,
  onRemove,
}: {
  connection: WikiRemoteConnectionSummary
  active: boolean
  busy: boolean
  onUse: () => void
  onRemove: () => void
}) {
  return (
    <div className={`flex flex-col gap-2 rounded-lg border p-3 ${active ? 'border-accent/60 bg-accent/10' : 'border-border'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone="neutral">{connection.authMethod === 'oauth' ? 'OAuth' : 'Token'}</Badge>
          <span className="truncate font-display text-sm font-semibold text-text">{connection.label}</span>
          {active ? <Badge tone="accent">{t('wiki.source.active', 'Active')}</Badge> : null}
        </div>
        {connection.status === 'connected' ? (
          <Badge tone="success">
            {`${connection.pageCount ?? 0} ${t('wiki.pages', 'pages')}${connection.workspace ? ` · ${connection.workspace}` : ''}`}
          </Badge>
        ) : (
          <Badge tone="danger">{t('wiki.source.unavailable', 'Unavailable')}</Badge>
        )}
      </div>
      <span className="truncate text-2xs text-text-muted">{connection.origin}</span>
      {connection.error ? <span className="text-2xs text-red">{connection.error}</span> : null}
      <div className="flex items-center gap-2">
        <Button variant={active ? 'secondary' : 'primary'} size="sm" disabled={busy || active} onClick={onUse}>
          {t('wiki.source.use', 'Use this wiki')}
        </Button>
        {!active ? (
          <Button variant="danger" size="sm" disabled={busy} onClick={onRemove}>
            {t('wiki.source.remove', 'Remove')}
          </Button>
        ) : null}
        <span className="ml-auto text-2xs text-text-muted">
          {t('wiki.source.lastUsed', 'Used')} {formatDate(connection.lastUsedAt ?? connection.createdAt)}
        </span>
      </div>
    </div>
  )
}

export function WikiSourceDialog({
  open,
  source,
  onClose,
  onChanged,
}: {
  open: boolean
  source: WikiSourceState | null
  onClose: () => void
  onChanged: () => void
}) {
  const [origin, setOrigin] = useState('')
  const [label, setLabel] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setOrigin('')
      setLabel('')
      setToken('')
      setError(null)
    }
  }, [open])

  if (!open) return null

  const finish = async (result: WikiSourceResult | null, pendingErrorMessage: string) => {
    setBusy(false)
    if (result && !result.ok) {
      setError(result.error ?? pendingErrorMessage)
      return
    }
    onChanged()
    onClose()
  }

  const run = (task: () => Promise<WikiSourceResult | null>, pendingErrorMessage: string) => {
    setBusy(true)
    setError(null)
    void task()
      .then((result) => finish(result, pendingErrorMessage))
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      })
  }

  const startOauth = () => {
    if (!origin.trim()) { setError(t('wiki.source.originRequired', 'Enter the hosted wiki origin.')); return }
    run(() => window.coworkApi?.wiki?.connectRemote({ origin: origin.trim(), label: label.trim() || undefined }) ?? null,
        t('wiki.source.oauthFailed', 'Could not start the OAuth connection.'))
  }

  const connectWithToken = () => {
    if (!origin.trim()) { setError(t('wiki.source.originRequired', 'Enter the hosted wiki origin.')); return }
    if (!token.trim()) { setError(t('wiki.source.token', 'Enter a service-account token (openwiki auth token create).')); return }
    run(() => window.coworkApi?.wiki?.connectRemoteWithToken({ origin: origin.trim(), token: token.trim(), label: label.trim() || undefined }) ?? null,
        t('wiki.source.tokenFailed', 'Could not connect with that token.'))
  }

  const activate = (connectionId: string) => {
    run(() => window.coworkApi?.wiki?.setActiveSource(connectionId) ?? null,
        t('wiki.source.activateFailed', 'Could not switch to that wiki.'))
  }

  const remove = (connectionId: string) => {
    run(() => window.coworkApi?.wiki?.removeRemoteConnection(connectionId) ?? null,
        t('wiki.source.removeFailed', 'Could not remove that wiki.'))
  }

  const useLocal = () => {
    run(() => window.coworkApi?.wiki?.setActiveSource(null) ?? null,
        t('wiki.source.localFailed', 'Could not switch to the local wiki.'))
  }

  const connections = source?.connections ?? []

  return (
    <Dialog
      title={t('wiki.source.title', 'Wiki sources')}
      onClose={onClose}
      size="md"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between rounded-lg border border-border bg-surface-alt/40 px-3 py-2">
            <div className="flex items-center gap-2">
              <Badge tone="neutral">{t('wiki.source.local', 'Local')}</Badge>
              <span className="font-display text-sm font-medium text-text">{t('wiki.source.localWiki', 'Local wiki')}</span>
            </div>
            <Button
              variant={source?.kind === 'local' ? 'secondary' : 'primary'}
              size="sm"
              disabled={busy || source?.kind === 'local'}
              loading={busy && source?.kind !== 'local'}
              onClick={useLocal}
            >
              {source?.kind === 'local' ? t('wiki.source.active', 'Active') : t('wiki.source.use', 'Use')}
            </Button>
          </div>
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              active={source?.kind === 'remote' && source.connectionId === connection.id}
              busy={busy}
              onUse={() => activate(connection.id)}
              onRemove={() => remove(connection.id)}
            />
          ))}
        </div>

        <Card>
          <div className="flex flex-col gap-3">
            <span className="font-display text-sm font-semibold text-text">{t('wiki.source.add', 'Connect a hosted wiki')}</span>
            <div className="flex flex-col gap-2">
              <input
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
                placeholder={t('wiki.source.originPlaceholder', 'https://wiki.example.com')}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted"
                disabled={busy}
              />
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t('wiki.source.labelPlaceholder', 'Label (optional)')}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted"
                disabled={busy}
              />
              <textarea
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={t('wiki.source.tokenPlaceholder', 'Service token (owk_agent_…) — create on the server with: openwiki auth token create --scope wiki:read --scope wiki:search')}
                rows={2}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted"
                disabled={busy}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm" loading={busy} onClick={startOauth}>
                {t('wiki.source.oauthConnect', 'Connect with OAuth (browser)')}
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={connectWithToken}>
                {t('wiki.source.tokenConnect', 'Connect with token')}
              </Button>
            </div>
            <p className="text-2xs text-text-muted">
              {t('wiki.source.oauthHint', 'OAuth opens your default browser for consent. Token connects are validated with a read probe before saving.')}
            </p>
          </div>
        </Card>

        {error ? <div className="rounded-lg border border-border bg-red/10 px-3 py-2 text-2xs text-red">{error}</div> : null}
      </div>
    </Dialog>
  )
}
