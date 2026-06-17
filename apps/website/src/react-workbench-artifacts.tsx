import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ArtifactIndexEntry, ArtifactIndexPayload } from '@open-cowork/shared'
import { ArtifactsLibrarySurface } from '@open-cowork/ui'
import { useAppApi } from '@open-cowork/ui/app-api'
import { type CloudRuntimeActionProps } from './react-workbench.ts'
import { asRecord, errorMessage } from './react-workbench-controller.ts'
import type { CloudWebThreadView } from './thread-workbench.ts'

type CloudArtifactSurfacePortalsProps = {
  selectedView: CloudWebThreadView | null
  artifactActions: CloudRuntimeActionProps
}

function usePortalTarget(id: string) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const element = document.getElementById(id)
    if (element) element.replaceChildren()
    setTarget(element)
  }, [id])
  return target
}

function currentBodyRoute() {
  return document.body.dataset.route || null
}

function useActiveBodyRoute() {
  const [activeRoute, setActiveRoute] = useState<string | null>(() => currentBodyRoute())
  useEffect(() => {
    const update = () => setActiveRoute(currentBodyRoute())
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-route'],
    })
    return () => observer.disconnect()
  }, [])
  return activeRoute
}

function readString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function readNumber(value: unknown, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function indexedArtifact(value: unknown, fallbackOrder: number): ArtifactIndexEntry | null {
  const record = asRecord(value)
  const id = readString(record.id, readString(record.artifactId, readString(record.cloudArtifactId, readString(record.filePath))))
  const sessionId = readString(record.sessionId)
  const filename = readString(record.filename, readString(record.name, 'artifact'))
  const filePath = readString(record.filePath, id)
  if (!id || !sessionId || !filePath) return null
  return {
    ...record,
    id,
    sessionId,
    filePath,
    filename,
    toolId: readString(record.toolId, readString(record.toolName, 'cloud-artifact')),
    toolName: readString(record.toolName, readString(record.authorAgentId, 'artifact')),
    order: readNumber(record.order, fallbackOrder),
  } as ArtifactIndexEntry
}

function artifactActionId(artifact: ArtifactIndexEntry) {
  const loose = artifact as ArtifactIndexEntry & { artifactId?: unknown }
  return readString(artifact.cloudArtifactId, readString(loose.artifactId, artifact.id))
}

function ArtifactLibraryStatus({
  index,
  error,
}: {
  index: ArtifactIndexPayload
  error: string | null
}) {
  return (
    <div className="studio-artifacts-sidecar">
      <h3>Library scope</h3>
      <div className="row compact"><strong>Indexed</strong><span>{index.total}</span></div>
      <div className="row compact"><strong>Loaded</strong><span>{index.artifacts.length}</span></div>
      <div className="row compact"><strong>Sessions scanned</strong><span>{index.scannedSessions ?? 'current page'}</span></div>
      {index.truncated ? <p className="empty">Results are truncated. Use search or filters to narrow the library.</p> : null}
      {error ? <p className="notice" data-kind="danger">{error}</p> : null}
    </div>
  )
}

export function CloudArtifactSurfacePortals({ artifactActions }: CloudArtifactSurfacePortalsProps) {
  const api = useAppApi()
  const activeRoute = useActiveBodyRoute()
  const artifactListTarget = usePortalTarget('artifact-list')
  const artifactHistoryTarget = usePortalTarget('artifact-history')
  const [artifactIndex, setArtifactIndex] = useState<ArtifactIndexPayload>({ artifacts: [], total: 0 })
  const [artifactIndexError, setArtifactIndexError] = useState<string | null>(null)
  const [artifactIndexLoading, setArtifactIndexLoading] = useState(false)
  const shouldLoadArtifactIndex = Boolean(artifactListTarget && activeRoute === 'artifacts')

  const loadArtifactIndex = useCallback(async () => {
    setArtifactIndexLoading(true)
    try {
      const body = asRecord(await api.artifacts.index({ limit: 100 }))
      const artifacts = Array.isArray(body.artifacts)
        ? body.artifacts.map(indexedArtifact).filter((artifact): artifact is ArtifactIndexEntry => Boolean(artifact))
        : []
      setArtifactIndex({
        artifacts,
        total: readNumber(body.total, artifacts.length),
        scannedSessions: readNumber(body.scannedSessions, 0) || undefined,
        truncated: Boolean(body.truncated),
      })
      setArtifactIndexError(null)
    } catch (error) {
      setArtifactIndexError(errorMessage(error))
      setArtifactIndex({ artifacts: [], total: 0 })
    } finally {
      setArtifactIndexLoading(false)
    }
  }, [api])

  useEffect(() => {
    if (!shouldLoadArtifactIndex) return
    void loadArtifactIndex()
  }, [loadArtifactIndex, shouldLoadArtifactIndex])

  return (
    <>
      {artifactListTarget ? createPortal(
        <ArtifactsLibrarySurface
          artifacts={artifactIndex.artifacts}
          total={artifactIndex.total}
          truncated={artifactIndex.truncated}
          loading={artifactIndexLoading}
          error={artifactIndexError}
          onReload={loadArtifactIndex}
          onOpenArtifact={(artifact) => {
            const id = artifactActionId(artifact)
            if (id) void artifactActions.onViewArtifact?.(id, { sessionId: artifact.sessionId })
          }}
          onExportArtifact={(artifact) => {
            const id = artifactActionId(artifact)
            if (id) void artifactActions.onDownloadArtifact?.(id, { sessionId: artifact.sessionId })
          }}
          onInspectArtifact={(artifact) => {
            const id = artifactActionId(artifact)
            if (id) artifactActions.onInspectArtifact?.(id, { sessionId: artifact.sessionId })
          }}
          onExportAll={async (artifacts) => {
            for (const artifact of artifacts) {
              const id = artifactActionId(artifact)
              if (id) await artifactActions.onDownloadArtifact?.(id, { sessionId: artifact.sessionId })
            }
          }}
        />,
        artifactListTarget,
      ) : null}
      {artifactHistoryTarget ? createPortal(
        <ArtifactLibraryStatus index={artifactIndex} error={artifactIndexError} />,
        artifactHistoryTarget,
      ) : null}
    </>
  )
}
