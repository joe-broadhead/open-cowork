import { useCallback, useEffect, useState } from 'react'
import { Button } from '@open-cowork/ui'
import { t } from '../../helpers/i18n'

/**
 * STT/TTS asset readiness for first-run (JOE-1109).
 * Shows offline-ready state, integrity, and ensure-cache action.
 */
export function VoiceAssetsPanel() {
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [assets, setAssets] = useState<{
    sttReady: boolean
    ttsReady: boolean
    offlineReady: boolean
    model: string
    integrity: string
    cacheDir: string
    allowDownload: boolean
    detail: string | null
  } | null>(null)

  const refresh = useCallback(async () => {
    if (!window.coworkApi?.voice?.assetsStatus) {
      setLoading(false)
      setError(t('settings.privacy.voiceAssetsUnavailable', 'Voice asset status is unavailable in this runtime.'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      const status = await window.coworkApi.voice.assetsStatus()
      setAssets({
        sttReady: status.stt.ready,
        ttsReady: status.tts.ready,
        offlineReady: status.offlineReady,
        model: status.stt.model,
        integrity: status.stt.integrity,
        cacheDir: status.stt.cacheDir,
        allowDownload: status.stt.allowDownload,
        detail: status.stt.detail || status.tts.detail || null,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const ensure = useCallback(async () => {
    if (!window.coworkApi?.voice?.ensureAssets) return
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      const result = await window.coworkApi.voice.ensureAssets()
      setMessage(result.detail)
      setAssets({
        sttReady: result.status.stt.ready,
        ttsReady: result.status.tts.ready,
        offlineReady: result.status.offlineReady,
        model: result.status.stt.model,
        integrity: result.status.stt.integrity,
        cacheDir: result.status.stt.cacheDir,
        allowDownload: result.status.stt.allowDownload,
        detail: result.status.stt.detail || result.status.tts.detail || null,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-surface px-3 py-3" data-testid="voice-assets-panel">
      <div className="text-xs font-medium text-text">
        {t('settings.privacy.voiceAssetsTitle', 'Voice assets (local models)')}
      </div>
      <div className="text-2xs leading-relaxed text-text-muted">
        {t(
          'settings.privacy.voiceAssetsDescription',
          'STT models are local files only. Default is offline fail-closed (no silent download). Download of model weights is opt-in via OPEN_COWORK_AURUM_ALLOW_DOWNLOAD=1 — never user audio.',
        )}
      </div>
      {loading ? (
        <div className="text-2xs text-text-muted">{t('settings.privacy.voiceAssetsLoading', 'Checking local assets…')}</div>
      ) : null}
      {assets ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-2xs">
          <dt className="text-text-muted">{t('settings.privacy.voiceAssetsStt', 'STT model')}</dt>
          <dd className="text-text tabular-nums">
            {assets.model}
            {' · '}
            {assets.sttReady
              ? t('settings.privacy.voiceAssetsReady', 'ready')
              : t('settings.privacy.voiceAssetsMissing', 'missing')}
            {' · '}
            {assets.integrity}
          </dd>
          <dt className="text-text-muted">{t('settings.privacy.voiceAssetsTts', 'TTS')}</dt>
          <dd className="text-text">
            {assets.ttsReady
              ? t('settings.privacy.voiceAssetsTtsReady', 'local OS ready')
              : t('settings.privacy.voiceAssetsTtsMissing', 'unavailable')}
          </dd>
          <dt className="text-text-muted">{t('settings.privacy.voiceAssetsOffline', 'Offline ready')}</dt>
          <dd className="text-text">
            {assets.offlineReady
              ? t('settings.privacy.voiceAssetsOfflineYes', 'Yes — model + TTS present')
              : t('settings.privacy.voiceAssetsOfflineNo', 'No — fix STT/TTS before dogfood')}
          </dd>
          {assets.cacheDir ? (
            <>
              <dt className="text-text-muted">{t('settings.privacy.voiceAssetsCache', 'Cache')}</dt>
              <dd className="text-text break-all">{assets.cacheDir}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {assets?.detail ? (
        <div className="text-2xs leading-relaxed text-text-muted" role="status">{assets.detail}</div>
      ) : null}
      {message ? (
        <div className="text-2xs leading-relaxed text-text" role="status">{message}</div>
      ) : null}
      {error ? (
        <div className="text-2xs leading-relaxed text-red" role="alert">{error}</div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading || busy}>
          {t('settings.privacy.voiceAssetsRefresh', 'Refresh status')}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void ensure()} disabled={loading || busy} loading={busy}>
          {t('settings.privacy.voiceAssetsEnsure', 'Ensure local model')}
        </Button>
      </div>
      {assets && !assets.allowDownload && !assets.sttReady ? (
        <div className="text-2xs leading-relaxed text-text-muted">
          {t(
            'settings.privacy.voiceAssetsDownloadHint',
            'Download stays off by default. Pre-cache the model offline, copy from the system Aurum cache, or set OPEN_COWORK_AURUM_ALLOW_DOWNLOAD=1 for an explicit file fetch path.',
          )}
        </div>
      ) : null}
    </div>
  )
}
