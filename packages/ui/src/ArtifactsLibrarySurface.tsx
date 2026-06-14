import { useMemo, useState, type ComponentPropsWithoutRef } from 'react'
import {
  type ArtifactIndexEntry,
  type ArtifactKind,
  type ArtifactStatus,
} from '@open-cowork/shared'
import { Badge, type BadgeTone } from './Badge.js'
import { Button } from './Button.js'
import { EmptyState } from './EmptyState.js'
import { Icon, type IconName } from './Icon.js'
import { Input } from './Input.js'
import { cn } from './utils.js'

type ArtifactFilter = 'all' | ArtifactKind | ArtifactStatus
type ArtifactActionAvailability = boolean | ((artifact: ArtifactIndexEntry) => boolean)
type ArtifactActionDisabledReason = string | null | undefined | ((artifact: ArtifactIndexEntry) => string | null | undefined)

export type ArtifactsLibrarySurfaceProps = Omit<ComponentPropsWithoutRef<'section'>, 'children'> & {
  artifacts: ArtifactIndexEntry[]
  loading?: boolean
  error?: string | null
  total?: number
  truncated?: boolean
  canOpenArtifact?: ArtifactActionAvailability
  canExportArtifact?: ArtifactActionAvailability
  artifactActionDisabledReason?: ArtifactActionDisabledReason
  onReload?: () => Promise<unknown> | unknown
  onInspectArtifact?: (artifact: ArtifactIndexEntry) => Promise<unknown> | unknown
  onOpenArtifact?: (artifact: ArtifactIndexEntry) => Promise<unknown> | unknown
  onExportArtifact?: (artifact: ArtifactIndexEntry) => Promise<unknown> | unknown
  onExportAll?: (artifacts: ArtifactIndexEntry[]) => Promise<unknown> | unknown
}

const KIND_FILTERS: Array<{ id: ArtifactFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'document', label: 'Document' },
  { id: 'chart', label: 'Chart' },
  { id: 'deck', label: 'Deck' },
  { id: 'spreadsheet', label: 'Spreadsheet' },
]

const STATUS_FILTERS: Array<{ id: ArtifactFilter; label: string }> = [
  { id: 'draft', label: 'Draft' },
  { id: 'in-review', label: 'In review' },
  { id: 'final', label: 'Final' },
]

const STATUS_LABELS: Record<ArtifactStatus, string> = {
  draft: 'Draft',
  'in-review': 'In review',
  final: 'Final',
}

const KIND_LABELS: Record<ArtifactKind, string> = {
  document: 'Document',
  chart: 'Chart',
  deck: 'Deck',
  spreadsheet: 'Spreadsheet',
  draft: 'Draft',
}

const KIND_ICONS: Record<ArtifactKind, IconName> = {
  document: 'file-text',
  chart: 'activity',
  deck: 'panel-right-open',
  spreadsheet: 'columns',
  draft: 'file',
}

function statusTone(status: ArtifactStatus | undefined): BadgeTone {
  if (status === 'final') return 'success'
  if (status === 'in-review') return 'warning'
  return 'neutral'
}

function safeText(value: unknown, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return fallback
  if (/(secret:\/\/|signed(?:[-_ ]?url|\?)|token=|object[-_ ]?key|bucket|api[_-]?key|credential|password|bearer\s+|(?:^|[:\s])\/[^/\s]+\/|[A-Z]:\\)/i.test(text)) return '[redacted]'
  if (text.length > 96) return `${text.slice(0, 28)}...${text.slice(-16)}`
  return text
}

function byteLabel(value: unknown) {
  const size = Number(value)
  if (!Number.isFinite(size) || size <= 0) return null
  if (size < 1024) return `${Math.round(size)} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function dateLabel(value: unknown) {
  if (typeof value !== 'string' || !value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function artifactId(artifact: ArtifactIndexEntry) {
  const loose = artifact as ArtifactIndexEntry & { artifactId?: unknown }
  const publicId = safeText(artifact.cloudArtifactId || loose.artifactId, '')
  if (publicId && publicId !== '[redacted]') return publicId
  return `Session artifact ${artifact.order + 1}`
}

function authorLabel(artifact: ArtifactIndexEntry) {
  return safeText(artifact.authorAgentId || artifact.toolName || artifact.toolId, 'Unknown coworker')
}

function projectLabel(artifact: ArtifactIndexEntry) {
  return safeText(artifact.projectId || artifact.sessionTitle || artifact.workspaceId, 'Unassigned project')
}

function artifactHaystack(artifact: ArtifactIndexEntry) {
  return [
    artifact.filename,
    artifact.kind,
    artifact.status,
    artifact.sessionTitle,
    artifact.projectId,
    artifact.taskId,
    artifact.workspaceId,
    artifact.toolName,
    artifact.toolId,
    artifact.authorAgentId,
  ].filter(Boolean).join(' ').toLowerCase()
}

function matchesFilter(artifact: ArtifactIndexEntry, filter: ArtifactFilter) {
  if (filter === 'all') return true
  return artifact.kind === filter || artifact.status === filter
}

function actionAvailable(value: ArtifactActionAvailability | undefined, artifact: ArtifactIndexEntry) {
  return typeof value === 'function' ? value(artifact) : value !== false
}

function actionDisabledReason(value: ArtifactActionDisabledReason, artifact: ArtifactIndexEntry) {
  return typeof value === 'function' ? value(artifact) : value
}

function filterArtifacts(artifacts: ArtifactIndexEntry[], query: string, filter: ArtifactFilter) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return artifacts.filter((artifact) => {
    if (!matchesFilter(artifact, filter)) return false
    if (!tokens.length) return true
    const haystack = artifactHaystack(artifact)
    return tokens.every((token) => haystack.includes(token))
  })
}

function artifactMeta(artifact: ArtifactIndexEntry) {
  return [
    KIND_LABELS[artifact.kind || 'draft'] || 'Artifact',
    byteLabel(artifact.size),
    artifact.mime ? safeText(artifact.mime) : null,
  ].filter(Boolean).join(' · ')
}

function ArtifactLibraryCard({
  artifact,
  canOpen,
  canExport,
  disabledReason,
  onOpen,
  onExport,
  onInspect,
}: {
  artifact: ArtifactIndexEntry
  canOpen: boolean
  canExport: boolean
  disabledReason?: string | null
  onOpen?: (artifact: ArtifactIndexEntry) => Promise<unknown> | unknown
  onExport?: (artifact: ArtifactIndexEntry) => Promise<unknown> | unknown
  onInspect?: (artifact: ArtifactIndexEntry) => Promise<unknown> | unknown
}) {
  const kind = artifact.kind || 'draft'
  const status = artifact.status || 'draft'
  const updated = dateLabel(artifact.updatedAt || artifact.createdAt)

  return (
    <article className="studio-artifact-card artifact-card" data-kind={kind} data-status={status} data-session-id={artifact.sessionId}>
      <div className="studio-artifact-card__head">
        <span className="studio-artifact-card__icon" aria-hidden="true">
          <Icon name={KIND_ICONS[kind] || 'file'} size={20} />
        </span>
        <div className="studio-artifact-card__title">
          <h3>{safeText(artifact.filename, 'artifact')}</h3>
          <p>{artifactMeta(artifact)}</p>
        </div>
        <Badge tone={statusTone(status)}>{STATUS_LABELS[status]}</Badge>
      </div>
      <div className="studio-artifact-card__preview">
        <span>{safeText(artifact.sessionTitle, 'Generated deliverable')}</span>
        <code>{artifactId(artifact)}</code>
      </div>
      <dl className="studio-artifact-card__facts">
        <div><dt>By</dt><dd>{authorLabel(artifact)}</dd></div>
        <div><dt>Source</dt><dd>{projectLabel(artifact)}</dd></div>
        <div><dt>Updated</dt><dd>{updated || 'Unknown'}</dd></div>
      </dl>
      <div className="studio-artifact-card__actions">
        {onInspect ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onInspect(artifact)}
          >
            Inspect
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          disabled={!canOpen}
          disabledReason={!canOpen ? disabledReason || 'Opening artifacts is unavailable here.' : undefined}
          onClick={() => onOpen?.(artifact)}
        >
          Open
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!canExport}
          disabledReason={!canExport ? disabledReason || 'Exporting artifacts is unavailable here.' : undefined}
          onClick={() => onExport?.(artifact)}
        >
          Export
        </Button>
      </div>
    </article>
  )
}

export function ArtifactsLibrarySurface({
  artifacts,
  loading = false,
  error = null,
  total,
  truncated = false,
  canOpenArtifact = true,
  canExportArtifact = true,
  artifactActionDisabledReason,
  onReload,
  onInspectArtifact,
  onOpenArtifact,
  onExportArtifact,
  onExportAll,
  className,
  ...props
}: ArtifactsLibrarySurfaceProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ArtifactFilter>('all')
  const filteredArtifacts = useMemo(() => filterArtifacts(artifacts, query, filter), [artifacts, filter, query])
  const exportableArtifacts = useMemo(
    () => filteredArtifacts.filter((artifact) => canExportArtifact !== false && actionAvailable(canExportArtifact, artifact)),
    [canExportArtifact, filteredArtifacts],
  )
  const inReviewCount = artifacts.filter((artifact) => artifact.status === 'in-review').length
  const finalCount = artifacts.filter((artifact) => artifact.status === 'final').length
  const knownTotal = total ?? artifacts.length
  const filterOptions = [...KIND_FILTERS, ...STATUS_FILTERS]
  const emptyTitle = truncated ? 'No loaded artifacts found' : 'No artifacts found'
  const emptyBody = truncated
    ? 'Search and filters apply to the loaded page of artifact results. Clear filters or reload after narrowing the upstream index scope.'
    : 'Generated documents, charts, decks, and spreadsheets will appear here after OpenCode sessions produce artifacts.'

  return (
    <section {...props} className={cn('studio-artifacts-library', loading && 'studio-artifacts-library--loading', className)} aria-label="Artifact library">
      <div className="studio-artifacts-summary" aria-label="Artifacts summary">
        <div><span>Total</span><strong>{knownTotal}</strong></div>
        <div><span>In review</span><strong>{inReviewCount}</strong></div>
        <div><span>Final</span><strong>{finalCount}</strong></div>
      </div>
      <div className="studio-artifacts-toolbar">
        <Input
          value={query}
          leftIcon="search"
          placeholder="Search artifacts, coworkers, or projects"
          aria-label="Search artifacts"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <div className="studio-artifacts-filters" role="toolbar" aria-label="Artifact filters">
          {filterOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className="studio-artifacts-filter"
              data-active={filter === option.id ? 'true' : undefined}
              aria-pressed={filter === option.id}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="studio-artifacts-toolbar__actions">
          {onReload ? <Button size="sm" variant="ghost" leftIcon="rotate-ccw" onClick={() => onReload()}>Refresh</Button> : null}
          {onExportAll ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={exportableArtifacts.length === 0}
              disabledReason={exportableArtifacts.length === 0 && filteredArtifacts.length > 0 ? 'No visible artifacts are exportable here.' : undefined}
              onClick={() => onExportAll(exportableArtifacts)}
            >
              {truncated ? 'Export visible' : 'Export all'}
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <p className="studio-artifacts-notice" data-tone="danger">{error}</p> : null}
      {truncated ? <p className="studio-artifacts-notice" data-tone="warning">Showing the first {artifacts.length} of {knownTotal} artifacts. Search, filters, and bulk export apply to loaded results only.</p> : null}
      {filteredArtifacts.length ? (
        <div className="studio-artifacts-grid">
          {filteredArtifacts.map((artifact) => (
            <ArtifactLibraryCard
              key={`${artifact.sessionId}:${artifact.id}:${artifact.filePath}`}
              artifact={artifact}
              canOpen={actionAvailable(canOpenArtifact, artifact) && Boolean(onOpenArtifact)}
              canExport={actionAvailable(canExportArtifact, artifact) && Boolean(onExportArtifact)}
              disabledReason={actionDisabledReason(artifactActionDisabledReason, artifact)}
              onInspect={onInspectArtifact}
              onOpen={onOpenArtifact}
              onExport={onExportArtifact}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon="file"
          title={loading ? 'Loading artifacts' : emptyTitle}
          body={loading ? 'The artifact library is loading across projects and chats.' : emptyBody}
        />
      )}
    </section>
  )
}
