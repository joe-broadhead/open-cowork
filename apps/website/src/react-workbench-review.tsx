import type { ReactNode } from 'react'
import { ActionCluster, DiffView, type DiffViewFile } from '@open-cowork/ui'
import { cloudWebRuntimeCounts, cloudWebSafeArtifactMetadata } from './runtime-workbench.ts'
import type { CloudWebThreadView } from './thread-workbench.ts'
import type { ArtifactPanelState } from './react-workbench-controller.ts'
import {
  CloudArtifactCards,
  CloudRuntimeStatus,
  type CloudRuntimeActionProps,
} from './react-workbench.ts'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function list<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function text(value: unknown, fallback = '') {
  return String(value ?? fallback)
}

function runtimeProjection(view: CloudWebThreadView | null | undefined) {
  return record(view?.projection?.view)
}

function byteLabel(value: unknown) {
  const bytes = typeof value === 'number' && Number.isFinite(value) ? value : 0
  if (bytes <= 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`
}

function artifactId(artifact: Record<string, unknown>) {
  return text(artifact.artifactId || artifact.id || artifact.filePath || '')
}

function artifactReviewPath(artifact: Record<string, unknown>, fallback: string) {
  return text(artifact.filePath || artifact.filename || artifact.name || artifact.artifactId || artifact.id, fallback)
}

function artifactReviewFiles(artifacts: Record<string, unknown>[]): DiffViewFile[] {
  return artifacts.slice(0, 12).map((artifact, index) => {
    const size = byteLabel(artifact.size)
    const type = text(artifact.mime || artifact.contentType)
    return {
      id: artifactId(artifact) || `artifact-${index}`,
      path: artifactReviewPath(artifact, `artifact-${index + 1}`),
      status: 'unknown',
      synthetic: true,
      meta: [type, size].filter(Boolean).join(' - '),
    }
  })
}

function metadataDetails(summary: string, value: unknown): ReactNode {
  return (
    <details className="runtime-detail" open>
      <summary>{summary}</summary>
      <pre>{JSON.stringify(value ?? {}, null, 2)}</pre>
    </details>
  )
}

export function CloudReviewPane({ view, ...props }: { view: CloudWebThreadView | null | undefined } & CloudRuntimeActionProps) {
  const projection = runtimeProjection(view)
  const artifacts = list<Record<string, unknown>>(projection.artifacts)
  const counts = cloudWebRuntimeCounts(projection)
  return (
    <DiffView
      title="Review"
      subtitle={view
        ? `${counts.artifact} artifact${counts.artifact === 1 ? '' : 's'} - ${counts.taskRun} task${counts.taskRun === 1 ? '' : 's'}`
        : 'Artifacts, runtime context, and session outputs.'}
      files={artifactReviewFiles(artifacts)}
      empty="No artifacts to review yet."
      className="cloud-review-pane"
    >
      <CloudRuntimeStatus view={view} />
      <CloudArtifactCards view={view} {...props} />
    </DiffView>
  )
}

export function CloudArtifactReviewDetail({ artifactPanel }: { artifactPanel: ArtifactPanelState }) {
  const safeMetadata = artifactPanel.metadata ? cloudWebSafeArtifactMetadata(artifactPanel.metadata) : null
  const files = safeMetadata ? artifactReviewFiles([safeMetadata]) : []
  const body = artifactPanel.status === 'loading'
    ? <span className="pill" data-kind="warn">loading</span>
    : artifactPanel.error
      ? <p className="notice">{artifactPanel.error}</p>
      : safeMetadata
        ? metadataDetails('Artifact metadata', safeMetadata)
        : <p className="empty">Choose Inspect on an artifact to load metadata. Artifact bodies are fetched only for explicit view or download actions.</p>

  return (
    <DiffView
      title="Artifact metadata"
      subtitle={artifactPanel.artifactId ? `Review ${artifactPanel.artifactId}` : 'Review artifact metadata before opening.'}
      files={files}
      empty="Choose Inspect on an artifact to load metadata."
      className="cloud-artifact-review"
    >
      {body}
    </DiffView>
  )
}

export function CloudComposerActionCluster({ profileName }: { profileName: string }) {
  return (
    <ActionCluster
      label="Cloud chat actions"
      className="cloud-chat-action-cluster"
      items={[
        {
          id: 'cloud-model',
          label: 'Cloud model',
          icon: 'brain',
          disabled: true,
          title: 'Model selection is managed by this cloud workspace',
        },
        {
          id: 'reasoning',
          label: 'Think Auto',
          icon: 'sparkles',
          disabled: true,
          title: 'Reasoning is managed by this cloud workspace',
        },
        {
          id: 'profile',
          label: profileName || 'default',
          icon: 'settings-2',
          disabled: true,
          title: 'Active cloud profile',
        },
      ]}
    />
  )
}
