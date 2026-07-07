import { useCallback, useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { AdminAuditEvent, AdminAuditQuery } from '@open-cowork/shared'
import { Badge, Button, Input, Select } from '../ui'
import { toast } from '../ui'
import { t } from '../../helpers/i18n'
import { AdminSectionHeader, AdminEmpty, AdminError, AdminLoading, AdminTable } from './AdminPrimitives'
import { describeAuditEvent, downloadTextFile, formatDateTime } from './admin-support'

// The audit log accumulates unboundedly on the client: each "Load more" appends
// another server page (50 rows) onto the rendered list, so an operator paging deep
// into history can mount thousands of rows. Above this threshold we window the rows
// with the same @tanstack/react-virtual pattern the sidebar and chat transcript use;
// below it, the plain semantic table is simplest and the DOM cost is negligible.
const VIRTUALIZE_THRESHOLD = 60
const ESTIMATED_AUDIT_ROW_HEIGHT = 57

// Virtualized audit rows. Rendered as an ARIA grid (role="table"/"row"/"cell") so
// screen readers still get tabular semantics even though absolute positioning rules
// out a real <table> here.
function VirtualAuditLog({ events }: { events: AdminAuditEvent[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_AUDIT_ROW_HEIGHT,
    overscan: 8,
  })
  return (
    <div
      ref={scrollRef}
      role="table"
      aria-label={t('admin.audit.title', 'Audit')}
      aria-rowcount={events.length}
      className="max-h-[60vh] overflow-y-auto rounded-lg border border-border-subtle"
    >
      <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vRow) => {
          const event = events[vRow.index]
          if (!event) return null
          return (
            <div
              key={event.eventId}
              role="row"
              data-index={vRow.index}
              ref={virtualizer.measureElement}
              className="grid grid-cols-[2fr_1.5fr_1fr] items-start gap-4 border-b border-border-subtle px-4 py-2.5 text-sm last:border-b-0"
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vRow.start}px)` }}
            >
              <div role="cell" className="font-medium text-text">{describeAuditEvent(event)}</div>
              <div role="cell">
                <Badge tone="muted">{event.actorType}</Badge>
                <span className="ml-2 text-text-muted">{event.actorId || '—'}</span>
              </div>
              <div role="cell" className="text-text-muted">{formatDateTime(event.createdAt)}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const ACTOR_OPTIONS = [
  { value: '', label: 'Any actor' },
  { value: 'user', label: 'User' },
  { value: 'api_token', label: 'API token' },
  { value: 'system', label: 'System' },
]

function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
      <span>{label}</span>
      {children}
    </label>
  )
}

type Filters = { action: string; actorType: string; from: string; to: string }

const EMPTY_FILTERS: Filters = { action: '', actorType: '', from: '', to: '' }

function toQuery(filters: Filters, cursor?: string | null): AdminAuditQuery {
  return {
    action: filters.action.trim() || undefined,
    actorType: (filters.actorType as AdminAuditQuery['actorType']) || undefined,
    from: filters.from ? new Date(filters.from).toISOString() : undefined,
    to: filters.to ? new Date(filters.to).toISOString() : undefined,
    limit: 50,
    cursor: cursor || undefined,
  }
}

// Audit section: a searchable/filterable, paginated log with JSON/CSV export. The
// export streams the server's redacted download; results paginate by cursor.
export function AuditSection({ canRead }: { canRead: boolean }) {
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS)
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS)
  const [events, setEvents] = useState<AdminAuditEvent[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async (filters: Filters, append: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const page = await window.coworkApi.admin.audit.query(toQuery(filters, append))
      setEvents((current) => (append ? [...current, ...page.events] : page.events))
      setCursor(page.nextCursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!canRead) return
    void load(applied, null)
  }, [applied, canRead, load])

  const runExport = useCallback(async (format: 'json' | 'csv') => {
    setExporting(true)
    try {
      const result = await window.coworkApi.admin.audit.export({ ...toQuery(applied), format })
      const saved = downloadTextFile(result.filename, result.contentType, result.content)
      toast({
        message: saved
          ? t('admin.audit.exported', 'Audit log exported.')
          : t('admin.audit.exportUnavailable', 'Export is not available in this environment.'),
        tone: saved ? 'success' : 'warning',
      })
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : t('admin.audit.exportFailed', 'Export failed.'), tone: 'error' })
    } finally {
      setExporting(false)
    }
  }, [applied])

  return (
    <div className="space-y-5">
      <AdminSectionHeader
        title={t('admin.audit.title', 'Audit')}
        description={t('admin.audit.description', 'Search, filter, and export the organization audit log.')}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void runExport('json')} loading={exporting} disabled={!canRead}>
              {t('admin.audit.exportJson', 'Export JSON')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void runExport('csv')} loading={exporting} disabled={!canRead}>
              {t('admin.audit.exportCsv', 'Export CSV')}
            </Button>
          </div>
        }
      />

      <form
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={(event) => {
          event.preventDefault()
          setApplied(draft)
        }}
      >
        <LabeledField label={t('admin.audit.action', 'Event prefix')}>
          <Input
            value={draft.action}
            onChange={(event) => setDraft((current) => ({ ...current, action: event.currentTarget.value }))}
            placeholder="member."
            aria-label={t('admin.audit.action', 'Event prefix')}
          />
        </LabeledField>
        <LabeledField label={t('admin.audit.actor', 'Actor type')}>
          <Select
            label={t('admin.audit.actor', 'Actor type')}
            options={ACTOR_OPTIONS}
            value={draft.actorType}
            onChange={(value) => setDraft((current) => ({ ...current, actorType: value }))}
          />
        </LabeledField>
        <LabeledField label={t('admin.audit.from', 'From')}>
          <Input
            type="date"
            value={draft.from}
            onChange={(event) => setDraft((current) => ({ ...current, from: event.currentTarget.value }))}
            aria-label={t('admin.audit.from', 'From')}
          />
        </LabeledField>
        <LabeledField label={t('admin.audit.to', 'To')}>
          <Input
            type="date"
            value={draft.to}
            onChange={(event) => setDraft((current) => ({ ...current, to: event.currentTarget.value }))}
            aria-label={t('admin.audit.to', 'To')}
          />
        </LabeledField>
        <div className="flex items-end gap-2">
          <Button type="submit" size="sm" disabled={!canRead}>{t('admin.audit.apply', 'Apply')}</Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(EMPTY_FILTERS)
              setApplied(EMPTY_FILTERS)
            }}
          >
            {t('admin.audit.reset', 'Reset')}
          </Button>
        </div>
      </form>

      {error ? (
        <AdminError message={error} onRetry={() => void load(applied, null)} />
      ) : loading && events.length === 0 ? (
        <AdminLoading rows={5} />
      ) : events.length === 0 ? (
        <AdminEmpty
          icon="list-checks"
          title={t('admin.audit.empty.title', 'No audit events')}
          body={t('admin.audit.empty.body', 'No events match these filters yet.')}
        />
      ) : (
        <div className="space-y-3">
          {events.length > VIRTUALIZE_THRESHOLD ? (
            <VirtualAuditLog events={events} />
          ) : (
            <AdminTable
              caption={t('admin.audit.title', 'Audit')}
              columns={[
                t('admin.audit.event', 'Event'),
                t('admin.audit.actorCol', 'Actor'),
                t('admin.audit.when', 'When'),
              ]}
            >
              {events.map((event) => (
                <tr key={event.eventId} className="border-b border-border-subtle align-top last:border-b-0">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-text">{describeAuditEvent(event)}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone="muted">{event.actorType}</Badge>
                    <span className="ml-2 text-text-muted">{event.actorId || '—'}</span>
                  </td>
                  <td className="px-4 py-2.5 text-text-muted">{formatDateTime(event.createdAt)}</td>
                </tr>
              ))}
            </AdminTable>
          )}
          {cursor ? (
            <div className="flex justify-center">
              <Button variant="secondary" size="sm" onClick={() => void load(applied, cursor)} loading={loading}>
                {t('admin.audit.loadMore', 'Load more')}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
