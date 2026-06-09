import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppApi } from '@open-cowork/ui/app-api'
import { CloudArtifactCards, CloudSelectedArtifactHistory, type CloudRuntimeActionProps } from './react-workbench.ts'
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

export function CloudArtifactSurfacePortals({ selectedView, artifactActions }: CloudArtifactSurfacePortalsProps) {
  const api = useAppApi()
  const activeRoute = useActiveBodyRoute()
  const artifactListTarget = usePortalTarget('artifact-list')
  const artifactHistoryTarget = usePortalTarget('artifact-history')
  const [artifactIndex, setArtifactIndex] = useState<Record<string, unknown>[]>([])
  const [artifactIndexError, setArtifactIndexError] = useState<string | null>(null)
  const shouldLoadArtifactIndex = Boolean(artifactHistoryTarget && activeRoute === 'artifacts')

  const loadArtifactIndex = useCallback(async () => {
    try {
      const body = asRecord(await api.artifacts.index({ limit: 100 }))
      setArtifactIndex(Array.isArray(body.artifacts) ? body.artifacts.map(asRecord) : [])
      setArtifactIndexError(null)
    } catch (error) {
      setArtifactIndexError(errorMessage(error))
    }
  }, [api])

  useEffect(() => {
    if (!shouldLoadArtifactIndex) return
    void loadArtifactIndex()
  }, [loadArtifactIndex, shouldLoadArtifactIndex])

  return (
    <>
      {artifactListTarget ? createPortal(<CloudArtifactCards view={selectedView} {...artifactActions} />, artifactListTarget) : null}
      {artifactHistoryTarget ? createPortal(
        <CloudSelectedArtifactHistory
          view={selectedView}
          indexedArtifacts={artifactIndex}
          indexError={artifactIndexError}
          {...artifactActions}
        />,
        artifactHistoryTarget,
      ) : null}
    </>
  )
}
