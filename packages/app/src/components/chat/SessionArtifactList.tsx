import { useEffect, useRef, useState } from 'react'
import { isSafeArtifactOpenTarget } from '@open-cowork/shared'
import { attachmentFromArtifact, buildChartRerenderPrompt, dispatchComposerCompose } from './composer-events'
import { listSessionArtifacts } from './session-artifacts'

type SessionArtifact = ReturnType<typeof listSessionArtifacts>[number]

type ArtifactPreviewState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; url: string; mime: string }

const IMAGE_ARTIFACT_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'])

function isPreviewableArtifact(artifact: SessionArtifact) {
  if (artifact.chart) return true
  if (artifact.mime?.startsWith('image/')) return true
  const extension = artifact.filename.split('.').pop()?.toLowerCase()
  return extension ? IMAGE_ARTIFACT_EXTENSIONS.has(extension) : false
}

function artifactWorkspaceScope(workspaceId?: string) {
  return workspaceId ? { workspaceId } : {}
}

export function SessionArtifactList({
  sessionId,
  artifacts,
  workspaceId,
  canDownloadArtifact = true,
  downloadDisabledReason = 'Artifact downloads are disabled by this workspace policy.',
  canRevealArtifact = true,
  revealDisabledReason = 'Cloud artifacts cannot be revealed in the local filesystem.',
}: {
  sessionId: string
  artifacts: ReturnType<typeof listSessionArtifacts>
  workspaceId?: string
  canDownloadArtifact?: boolean
  downloadDisabledReason?: string
  canRevealArtifact?: boolean
  revealDisabledReason?: string
}) {
  const [exportingId, setExportingId] = useState<string | null>(null)
  const [composerAction, setComposerAction] = useState<{
    artifactId: string
    mode: 'open' | 'send' | 'rerender'
  } | null>(null)
  const [previewStates, setPreviewStates] = useState<Record<string, ArtifactPreviewState>>({})
  const previewStatesRef = useRef(previewStates)

  useEffect(() => {
    previewStatesRef.current = previewStates
  }, [previewStates])

  useEffect(() => {
    const activeIds = new Set(artifacts.map((artifact) => artifact.id))
    setPreviewStates((current) => {
      let changed = false
      const next: Record<string, ArtifactPreviewState> = {}
      for (const [artifactId, state] of Object.entries(current)) {
        if (activeIds.has(artifactId)) {
          next[artifactId] = state
        } else {
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [artifacts])

  useEffect(() => {
    let cancelled = false

    if (!canDownloadArtifact) {
      setPreviewStates({})
      return () => {
        cancelled = true
      }
    }

    for (const artifact of artifacts) {
      if (!isPreviewableArtifact(artifact)) continue
      if (previewStatesRef.current[artifact.id]) continue

      setPreviewStates((current) => (
        current[artifact.id]
          ? current
          : { ...current, [artifact.id]: { status: 'loading' } }
      ))

      void window.coworkApi.artifact.readAttachment({
        sessionId,
        filePath: artifact.filePath,
        ...artifactWorkspaceScope(workspaceId),
      }).then((payload) => {
        if (cancelled) return
        if (!payload.mime.startsWith('image/')) {
          setPreviewStates((current) => ({ ...current, [artifact.id]: { status: 'failed' } }))
          return
        }
        setPreviewStates((current) => ({
          ...current,
          [artifact.id]: {
            status: 'ready',
            url: payload.url,
            mime: payload.mime,
          },
        }))
      }).catch(() => {
        if (cancelled) return
        setPreviewStates((current) => ({ ...current, [artifact.id]: { status: 'failed' } }))
      })
    }

    return () => {
      cancelled = true
    }
  }, [artifacts, canDownloadArtifact, sessionId, workspaceId])

  if (artifacts.length === 0) {
    return (
      <div className="rounded-2xl border border-border-subtle bg-surface px-3 py-3 text-xs text-text-muted">
        No generated artifacts yet.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {artifacts.map((artifact) => {
        const previewState = previewStates[artifact.id]
        const showPreview = isPreviewableArtifact(artifact)
        const canOpenArtifact = isSafeArtifactOpenTarget({ filename: artifact.filename, mime: artifact.mime })
        const bodyActionsBlocked = !canDownloadArtifact
        const bodyActionTitle = bodyActionsBlocked ? downloadDisabledReason : undefined
        const actionClassName = 'px-2.5 py-1.5 rounded-lg border border-border-subtle text-2xs text-text-secondary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-text-secondary'

        return (
          <div
            key={artifact.id}
            className="rounded-2xl border border-border-subtle bg-surface px-3 py-3"
          >
            <div className="flex items-start gap-3">
              {showPreview && (
                <div className="w-24 shrink-0 overflow-hidden rounded-xl border border-border-subtle bg-base">
                  {previewState?.status === 'ready' ? (
                    <img
                      src={previewState.url}
                      alt={artifact.filename}
                      className="block h-16 w-full object-contain bg-base"
                    />
                  ) : (
                    <div className="flex h-16 w-full items-center justify-center px-2 text-center text-2xs font-medium text-text-muted">
                      {bodyActionsBlocked ? 'Preview disabled' : previewState?.status === 'failed' ? 'Preview unavailable' : 'Loading preview…'}
                    </div>
                  )}
                </div>
              )}

              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium leading-relaxed text-text break-words">
                  {artifact.filename}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-text-muted">
                  <span>{artifact.toolName}</span>
                  <span aria-hidden="true">•</span>
                  <span>{artifact.taskRunId ? 'via sub-agent' : 'in thread'}</span>
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {canOpenArtifact ? (
                <button
                  onClick={async () => {
                    if (bodyActionsBlocked) return
                    try {
                      setComposerAction({ artifactId: artifact.id, mode: 'open' })
                      await window.coworkApi.artifact.open({
                        sessionId,
                        filePath: artifact.filePath,
                        suggestedName: artifact.filename,
                        ...artifactWorkspaceScope(workspaceId),
                      })
                    } finally {
                      setComposerAction(null)
                    }
                  }}
                  disabled={bodyActionsBlocked || composerAction !== null}
                  title={bodyActionTitle}
                  className={actionClassName}
                >
                  {composerAction?.artifactId === artifact.id && composerAction.mode === 'open' ? 'Opening…' : 'Open'}
                </button>
              ) : null}

              <button
                onClick={async () => {
                  if (bodyActionsBlocked) return
                  try {
                    setComposerAction({ artifactId: artifact.id, mode: 'send' })
                    const payload = await window.coworkApi.artifact.readAttachment({
                      sessionId,
                      filePath: artifact.filePath,
                      ...artifactWorkspaceScope(workspaceId),
                    })
                    dispatchComposerCompose({
                      attachments: [attachmentFromArtifact(payload)],
                    })
                  } finally {
                    setComposerAction(null)
                  }
                }}
                disabled={bodyActionsBlocked || composerAction !== null}
                title={bodyActionTitle}
                className={actionClassName}
              >
                {composerAction?.artifactId === artifact.id && composerAction.mode === 'send' ? 'Sending…' : 'Send to thread'}
              </button>

              {artifact.chart ? (
                <button
                  onClick={async () => {
                    if (bodyActionsBlocked) return
                    try {
                      setComposerAction({ artifactId: artifact.id, mode: 'rerender' })
                      const payload = await window.coworkApi.artifact.readAttachment({
                        sessionId,
                        filePath: artifact.filePath,
                        ...artifactWorkspaceScope(workspaceId),
                      })
                      dispatchComposerCompose({
                        text: buildChartRerenderPrompt(payload.chart || artifact.chart!),
                        attachments: [attachmentFromArtifact(payload)],
                      })
                    } finally {
                      setComposerAction(null)
                    }
                  }}
                  disabled={bodyActionsBlocked || composerAction !== null}
                  title={bodyActionTitle}
                  className={actionClassName}
                >
                  {composerAction?.artifactId === artifact.id && composerAction.mode === 'rerender' ? 'Preparing…' : 'Rerender'}
                </button>
              ) : null}

              {canRevealArtifact && artifact.source !== 'cloud' ? (
                <button
                  onClick={async () => {
                    await window.coworkApi.artifact.reveal({
                      sessionId,
                      filePath: artifact.filePath,
                      ...artifactWorkspaceScope(workspaceId),
                    })
                  }}
                  className="px-2.5 py-1.5 rounded-lg border border-border-subtle text-2xs text-text-secondary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer whitespace-nowrap"
                >
                  Reveal
                </button>
              ) : (
                <span className="px-2.5 py-1.5 text-2xs text-text-muted" title={revealDisabledReason}>
                  {artifact.source === 'cloud' ? 'Cloud artifact' : 'Reveal disabled'}
                </span>
              )}

              <button
                onClick={async () => {
                  if (bodyActionsBlocked) return
                  try {
                    setExportingId(artifact.id)
                    await window.coworkApi.artifact.export({
                      sessionId,
                      filePath: artifact.filePath,
                      suggestedName: artifact.filename,
                      ...artifactWorkspaceScope(workspaceId),
                    })
                  } finally {
                    setExportingId(null)
                  }
                }}
                disabled={bodyActionsBlocked || exportingId === artifact.id}
                title={bodyActionTitle}
                className={actionClassName}
              >
                {exportingId === artifact.id ? 'Exporting…' : 'Export'}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
