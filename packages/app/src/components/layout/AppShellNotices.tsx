import type { AppMetadata } from '@open-cowork/shared'
import { dismissPreview } from '../../app-helpers'
import { t } from '../../helpers/i18n'
import { Button } from '@open-cowork/ui'
import { RuntimeOfflineBanner } from './RuntimeOfflineBanner'

type ResourceNavigationNotice = {
  status: string
  message: string
}

type AppShellNoticesProps = {
  metadata: AppMetadata | null
  showPreviewNotice: boolean
  onPreviewDismiss: () => void
  showCloudWebCapabilityNotice?: boolean
  onCloudWebCapabilityDismiss?: () => void
  runtimeWasReady: boolean
  runtimeError: string | null
  onRuntimeRestart: () => Promise<void>
  rendererErrorNotice: string | null
  onRendererErrorDismiss: () => void
  resourceNavigationNotice: ResourceNavigationNotice | null
  onResourceNavigationDismiss: () => void
}

const CLOUD_WEB_CAPABILITY_DISMISSED_KEY = 'open-cowork.cloud-web.capability-banner.dismissed'

export function isCloudWebCapabilityBannerDismissed(storage: Pick<Storage, 'getItem'> | null | undefined = typeof window !== 'undefined' ? window.localStorage : null) {
  try {
    return storage?.getItem(CLOUD_WEB_CAPABILITY_DISMISSED_KEY) === 'true'
  } catch {
    return false
  }
}

export function dismissCloudWebCapabilityBanner(storage: Pick<Storage, 'setItem'> | null | undefined = typeof window !== 'undefined' ? window.localStorage : null) {
  try {
    storage?.setItem(CLOUD_WEB_CAPABILITY_DISMISSED_KEY, 'true')
  } catch {
    // ignore quota / private mode
  }
}

const previewNoticeStyle = {
  borderColor: 'color-mix(in srgb, var(--color-amber) 34%, var(--color-border-subtle))',
  background: 'color-mix(in srgb, var(--color-amber) 10%, var(--color-surface))',
  color: 'var(--color-text)',
}

export function AppShellNotices({
  metadata,
  showPreviewNotice,
  onPreviewDismiss,
  showCloudWebCapabilityNotice = false,
  onCloudWebCapabilityDismiss,
  runtimeWasReady,
  runtimeError,
  onRuntimeRestart,
  rendererErrorNotice,
  onRendererErrorDismiss,
  resourceNavigationNotice,
  onResourceNavigationDismiss,
}: AppShellNoticesProps) {
  return (
    <>
      {showPreviewNotice && metadata ? (
        <div className="flex items-center gap-3 border-b px-4 py-2 text-xs" style={previewNoticeStyle}>
          <span className="font-semibold">Public preview {metadata.version}</span>
          <span className="min-w-0 flex-1 text-text-muted">
            This v0.x build may change quickly. macOS preview artifacts can be unsigned until signing is configured.
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              dismissPreview(metadata.version)
              onPreviewDismiss()
            }}
          >
            {t('common.dismiss', 'Dismiss')}
          </Button>
        </div>
      ) : null}
      {showCloudWebCapabilityNotice ? (
        <div
          className="flex items-center gap-3 border-b px-4 py-2 text-xs"
          style={previewNoticeStyle}
          data-testid="cloud-web-capability-banner"
          role="status"
        >
          <span className="font-semibold">{t('cloudWeb.capabilityBanner.title', 'Cloud workspace')}</span>
          <span className="min-w-0 flex-1 text-text-muted">
            {t(
              'cloudWeb.capabilityBanner.body',
              'Browser Studio syncs Cloud sessions with Desktop Cloud and Channel Gateway. Local folders, local MCP processes, machine runtime config, and custom coworker authoring stay on Desktop.',
            )}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              dismissCloudWebCapabilityBanner()
              onCloudWebCapabilityDismiss?.()
            }}
          >
            {t('common.dismiss', 'Dismiss')}
          </Button>
        </div>
      ) : null}
      {runtimeWasReady && runtimeError ? (
        <RuntimeOfflineBanner error={runtimeError} onRestart={onRuntimeRestart} />
      ) : null}
      {rendererErrorNotice ? (
        <ShellAlert
          tone="red"
          title="App error"
          message={rendererErrorNotice}
          onDismiss={onRendererErrorDismiss}
        />
      ) : null}
      {resourceNavigationNotice ? (
        <ShellAlert
          tone="amber"
          title="Resource unavailable"
          message={resourceNavigationNotice.message}
          status={resourceNavigationNotice.status}
          testId="resource-navigation-notice"
          onDismiss={onResourceNavigationDismiss}
        />
      ) : null}
    </>
  )
}

function ShellAlert({
  tone,
  title,
  message,
  status,
  testId,
  onDismiss,
}: {
  tone: 'amber' | 'red'
  title: string
  message: string
  status?: string
  testId?: string
  onDismiss: () => void
}) {
  const toneClass = tone === 'red'
    ? 'border-red/30 bg-red/10 text-red'
    : 'border-amber/30 bg-amber/10 text-amber'
  const messageClass = tone === 'red' ? 'text-red/85' : 'text-amber/85'
  return (
    <div
      role="alert"
      data-testid={testId}
      data-status={status}
      className={`mx-3 mt-3 flex items-start gap-3 rounded-lg border px-3 py-2 text-xs shadow-card ${toneClass}`}
    >
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{title}</div>
        <div className={`mt-0.5 ${messageClass}`}>{message}</div>
      </div>
      <Button variant="ghost" size="sm" className="no-drag" onClick={onDismiss}>
        {t('common.dismiss', 'Dismiss')}
      </Button>
    </div>
  )
}
