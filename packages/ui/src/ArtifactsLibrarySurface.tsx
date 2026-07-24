import { useMemo, useRef, useState, type ChangeEvent, type ComponentPropsWithoutRef, type CSSProperties } from 'react'
import {
  type ArtifactIndexEntry,
  type ArtifactKind,
  type ArtifactStatus,
} from '@open-cowork/shared'
import { Badge, type BadgeTone } from './Badge.js'
import { Button } from './Button.js'
import { EmptyState } from './EmptyState.js'
import { ErrorState } from './ErrorState.js'
import { Icon, type IconName } from './Icon.js'
import { Input } from './Input.js'
import { Skeleton } from './Skeleton.js'
import { cn, entityChroma } from './utils.js'

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
  /** Advance an artifact through the draft → in-review → final review lifecycle. When provided, each non-final card shows an advance control. */
  onAdvanceStatus?: (artifact: ArtifactIndexEntry, nextStatus: ArtifactStatus) => Promise<unknown> | unknown
  /** Upload a file as a new artifact. When provided, the toolbar shows an Upload control; the picked file is read to base64 here so callers only POST it. */
  onUploadArtifact?: (input: { filename: string, contentType: string, dataBase64: string }) => Promise<unknown> | unknown
  canUploadArtifact?: boolean
  uploadDisabledReason?: string
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('Could not read the selected file.'))
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
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

// The artifact review lifecycle, in order. `nextArtifactStatus` returns the
// status an artifact advances to, or null when it is already final (terminal).
const STATUS_ORDER: readonly ArtifactStatus[] = ['draft', 'in-review', 'final']

function nextArtifactStatus(status: ArtifactStatus): ArtifactStatus | null {
  const index = STATUS_ORDER.indexOf(status)
  return index >= 0 && index < STATUS_ORDER.length - 1 ? STATUS_ORDER[index + 1]! : null
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
  onAdvanceStatus,
}: {
  artifact: ArtifactIndexEntry
  canOpen: boolean
  canExport: boolean
  disabledReason?: string | null
  onOpen?: (artifact: ArtifactIndexEntry) => Promise<unknown> | unknown
  onExport?: (artifact: ArtifactIndexEntry) => Promise<unknown> | unknown
  onInspect?: (artifact: ArtifactIndexEntry) => Promise<unknown> | unknown
  onAdvanceStatus?: (artifact: ArtifactIndexEntry, nextStatus: ArtifactStatus) => Promise<unknown> | unknown
}) {
  const kind = artifact.kind || 'draft'
  const status = artifact.status || 'draft'
  const advanceTo = nextArtifactStatus(status)
  const updated = dateLabel(artifact.updatedAt || artifact.createdAt)

  return (
    <article className="studio-artifact-card artifact-card" data-kind={kind} data-status={status} data-session-id={artifact.sessionId}>
      <div className="studio-artifact-card__head">
        <span
          className="studio-artifact-card__icon entity-tile"
          style={{ '--entity-chroma': entityChroma(`${kind}:${artifact.filename}`) } as CSSProperties}
          aria-hidden="true"
        >
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
        {onAdvanceStatus && advanceTo ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onAdvanceStatus(artifact, advanceTo)}
          >
            {`Advance to ${STATUS_LABELS[advanceTo]}`}
          </Button>
        ) : null}
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
  onAdvanceStatus,
  onUploadArtifact,
  canUploadArtifact = true,
  uploadDisabledReason,
  className,
  ...props
}: ArtifactsLibrarySurfaceProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ArtifactFilter>('all')
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const handleUploadChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = '' // allow re-selecting the same file
    if (!file || !onUploadArtifact) return
    await onUploadArtifact({
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      dataBase64: await fileToBase64(file),
    })
  }
  const filteredArtifacts = useMemo(() => filterArtifacts(artifacts, query, filter), [artifacts, filter, query])
  const exportableArtifacts = useMemo(
    () => filteredArtifacts.filter((artifact) => canExportArtifact !== false && actionAvailable(canExportArtifact, artifact)),
    [canExportArtifact, filteredArtifacts],
  )
  const knownTotal = total ?? artifacts.length
  const filterOptions = [...KIND_FILTERS, ...STATUS_FILTERS]
  const emptyTitle = truncated ? 'No loaded artifacts found' : 'No artifacts yet'
  const emptyBody = truncated
    ? 'Search and filters apply to the loaded page of artifact results. Clear filters or reload after narrowing the upstream index scope.'
    : 'Charts, files, and deliverables from OpenCode chats show up here. Produce work in Chat, or open a session artifact from the thread inspector.'

  return (
    <section {...props} className={cn('studio-artifacts-library', loading && 'studio-artifacts-library--loading', className)} aria-label="Artifact library">
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
          {onUploadArtifact ? (
            <>
              <input
                ref={uploadInputRef}
                type="file"
                hidden
                aria-hidden="true"
                tabIndex={-1}
                onChange={handleUploadChange}
              />
              <Button
                size="sm"
                variant="secondary"
                leftIcon="arrow-up"
                disabled={canUploadArtifact === false}
                disabledReason={canUploadArtifact === false ? (uploadDisabledReason || 'Open a chat to upload an artifact to it.') : undefined}
                onClick={() => uploadInputRef.current?.click()}
              >
                Upload
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {error ? (
        <ErrorState
          title="Couldn’t load artifacts"
          message={error}
          hint="Your saved artifacts aren’t lost — this is a load error. Reload to try fetching them again."
          onRetry={onReload ? () => { void onReload() } : undefined}
          retryLabel="Reload"
        />
      ) : null}
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
              onAdvanceStatus={onAdvanceStatus}
            />
          ))}
        </div>
      ) : loading ? (
        <div className="studio-artifacts-grid" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} variant="card" className="studio-artifact-card" />
          ))}
        </div>
      ) : (
        <EmptyState
          icon="file"
          title={emptyTitle}
          body={emptyBody}
        />
      )}
    </section>
  )
}
