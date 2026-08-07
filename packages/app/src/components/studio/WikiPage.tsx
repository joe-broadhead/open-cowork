import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  WikiDocument,
  WikiGraph,
  WikiGraphNeighbors,
  WikiOverview,
  WikiPageIndexEntry,
  WikiSearchResult,
  WikiSourceState,
} from '@open-cowork/shared'
import type { AppNavigationTarget } from '../../app-types'
import { t } from '../../helpers/i18n'
import { MarkdownContent } from '../chat/MarkdownContent'
import { WikiGraphView } from './WikiGraphView'
import { WikiSourceDialog } from './WikiSourceDialog'
import { buildWikilinkResolver, rewriteWikiWikilinks } from './wiki-markdown'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  Skeleton,
  StudioPageHeader,
} from '@open-cowork/ui'

type WikiStatusProps = {
  onOpenCapabilities: () => void
  overview: WikiOverview
}

function WikiUnlinked({ overview, onOpenCapabilities }: WikiStatusProps) {
  const message =
    overview.status === 'no-cli'
      ? t('wiki.notLinked.cli', 'The local OpenWiki CLI is not installed. Build products/wiki, or set OPENWIKI_CLI.')
      : overview.status === 'no-root'
        ? t('wiki.notLinked.root', 'No wiki is initialized at this location yet. Create one with `openwiki init`.')
        : overview.error ?? t('wiki.notLinked.error', 'The wiki could not be read right now.')
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center justify-center gap-6 py-24 px-6 text-center">
      <EmptyState
        icon="file-text"
        title={t('wiki.notLinked.title', 'No wiki is linked yet')}
        body={message}
        action={
          <Button onClick={onOpenCapabilities} variant="primary">
            {t('wiki.notLinked.action', 'Open Capabilities')}
          </Button>
        }
      />
    </div>
  )
}

function formatDate(value: string | null): string {
  if (!value) return t('wiki.unknownDate', 'Unknown')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return t('wiki.unknownDate', 'Unknown')
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function PageRow({
  page,
  active,
  onSelect,
}: {
  page: WikiPageIndexEntry
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      data-wiki-page-id={page.id}
      onClick={onSelect}
      className={`flex w-full flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition-colors ${
        active
          ? 'border-accent/60 bg-accent/10'
          : 'border-transparent hover:bg-surface-alt/70'
      }`}
      aria-current={active ? 'page' : undefined}
    >
      <span className="flex w-full items-center gap-2">
        <span className="truncate font-display text-sm font-semibold text-text">{page.title}</span>
        {page.isPrivate ? <Badge tone="accent">{t('wiki.private', 'Private')}</Badge> : null}
      </span>
      <span className="w-full truncate text-2xs text-text-muted">{page.path}</span>
    </button>
  )
}

function SearchResults({
  results,
  onPick,
  onClear,
}: {
  results: WikiSearchResult[]
  onPick: (id: string) => void
  onClear: () => void
}) {
  if (results.length === 0) {
    return (
      <p className="px-1 text-2xs text-text-muted">
        {t('wiki.search.empty', 'No matching pages.')} <button type="button" onClick={onClear} className="underline">{t('wiki.search.clear', 'Clear search')}</button>
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-2xs font-semibold text-text-muted">{t('wiki.search.results', 'Search results')}</span>
        <button type="button" onClick={onClear} className="text-2xs underline text-text-muted">{t('wiki.search.clear', 'Clear')}</button>
      </div>
      {results.map((result) => (
        <button
          key={result.id}
          type="button"
          onClick={() => onPick(result.id)}
          className="flex w-full flex-col items-start gap-1 rounded-lg border border-transparent px-2 py-1.5 text-left hover:bg-surface-alt/70"
        >
          <span className="flex w-full items-center gap-2">
            <span className="truncate text-sm font-medium text-text">{result.title}</span>
            {result.isPrivate ? <Badge tone="accent">{t('wiki.private', 'Private')}</Badge> : null}
          </span>
          <span className="line-clamp-2 w-full text-2xs text-text-muted">{result.snippet || result.path}</span>
        </button>
      ))}
    </div>
  )
}


function neighborTitleById(neighbors: WikiGraphNeighbors | null, pages: WikiPageIndexEntry[], id: string): string {
  if (neighbors) {
    const node = neighbors.nodes.find((n) => n.id === id)
    if (node && node.title) return node.title
  }
  const page = pages.find((pg) => pg.id === id)
  if (!page) return id
  return page.title || page.path || id
}

function LinkList({
  ids,
  neighbors,
  pages,
  onSelect,
  empty,
}: {
  ids: string[]
  neighbors: WikiGraphNeighbors | null
  pages: WikiPageIndexEntry[]
  onSelect: (id: string) => void
  empty: ReactNode
}) {
  if (ids.length === 0) return <p className="text-2xs text-text-muted">{empty}</p>
  return (
    <div className="flex flex-col gap-0.5">
      {ids.slice(0, 12).map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect(id)}
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-alt/70"
        >
          <span className="truncate text-xs text-text hover:text-accent">{neighborTitleById(neighbors, pages, id)}</span>
        </button>
      ))}
    </div>
  )
}

function neighborBuckets(
  neighbors: WikiGraphNeighbors | null,
): { backlinks: string[]; outgoing: string[]; related: string[] } {
  const backlinks: string[] = []
  const outgoing: string[] = []
  const related: string[] = []
  if (!neighbors) return { backlinks, outgoing, related }
  const rootId = neighbors.rootId
  const seen = new Set<string>()
  const byId = new Map(neighbors.nodes.map((node) => [node.id, node]))
  for (const edge of neighbors.edges) {
    if (edge.edgeType !== 'page_link' && edge.edgeType !== 'page_typed_link') continue
    if (edge.toId === rootId && edge.fromId !== rootId) {
      const node = byId.get(edge.fromId)
      if (node && node.recordType === 'page' && !seen.has(node.id)) {
        seen.add(node.id)
        backlinks.push(node.id)
      }
    } else if (edge.fromId === rootId && edge.toId !== rootId) {
      const node = byId.get(edge.toId)
      if (node && node.recordType === 'page' && !seen.has(node.id)) {
        seen.add(node.id)
        outgoing.push(node.id)
      }
    }
  }
  for (const node of neighbors.nodes) {
    if (node.recordType !== 'page') continue
    if (node.id === rootId || seen.has(node.id)) continue
    related.push(node.id)
  }
  return { backlinks, outgoing, related }
}


export function WikiPage({ onOpenCapabilities }: { onOpenCapabilities: () => void }) {
  const [overview, setOverview] = useState<WikiOverview | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [pages, setPages] = useState<WikiPageIndexEntry[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [doc, setDoc] = useState<WikiDocument | null>(null)
  const [loadingPages, setLoadingPages] = useState(false)
  const [loadingDoc, setLoadingDoc] = useState(false)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<WikiSearchResult[] | null>(null)
  const [view, setView] = useState<'browse' | 'graph'>('browse')
  const [graph, setGraph] = useState<WikiGraph | null>(null)
  const [neighbors, setNeighbors] = useState<WikiGraphNeighbors | null>(null)
  const [source, setSource] = useState<WikiSourceState | null>(null)
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false)

  const refresh = useCallback(async () => {
    setOverview(null)
    setOverviewError(null)
    try {
      const viewApi = window.coworkApi?.wiki
      if (!viewApi) {
        setOverviewError(t('wiki.apiUnavailable', 'The wiki API is not available in this runtime.'))
        return
      }
      const info = await viewApi.overview()
      setOverview(info)
      void viewApi.getSource().then(setSource).catch(() => {})
      if (info.status !== 'linked') return
      setLoadingPages(true)
      const list = await viewApi.listPages()
      setPages(list)
      const currentStillExists = selectedId ? list.some((page) => page.id === selectedId) : false
      if (!currentStillExists && list.length > 0) setSelectedId(list[0]?.id ?? null)
    } catch (err) {
      setOverviewError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingPages(false)
    }
  }, [selectedId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Load the selected page's body.
  useEffect(() => {
    if (!selectedId) { setDoc(null); return }
    let cancelled = false
    setLoadingDoc(true)
    const viewApi = window.coworkApi?.wiki
    viewApi?.readPage(selectedId).then((doc) => {
      if (cancelled) return
      setDoc(doc)
    }).catch(() => {
      if (!cancelled) setDoc(null)
    }).finally(() => {
      if (!cancelled) setLoadingDoc(false)
    })
    return () => { cancelled = true }
  }, [selectedId])

  // Load the whole-workspace graph once the wiki is linked.
  useEffect(() => {
    if (overview?.status !== 'linked') return
    let cancelled = false
    void window.coworkApi?.wiki?.graph().then((graphData) => {
      if (!cancelled) setGraph(graphData)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [overview?.status, overview?.origin])

  // Load the selected page's graph neighborhood (backlinks + related).
  useEffect(() => {
    if (!selectedId) { setNeighbors(null); return }
    let cancelled = false
    void window.coworkApi?.wiki?.graphNeighbors(selectedId).then((neighborsData) => {
      if (!cancelled) setNeighbors(neighborsData)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [selectedId])

  const resolver = useMemo(() => buildWikilinkResolver(pages), [pages])
  const openPage = useCallback((id: string) => {
    setSelectedId(id)
    setView('browse')
  }, [])

  const openSourceDialog = useCallback(() => {
    void window.coworkApi?.wiki?.getSource().then(setSource).catch(() => {})
    setSourceDialogOpen(true)
  }, [])

  const runSearch = useCallback(async () => {
    const term = query.trim()
    if (!term) return
    setSearching(true)
    try {
      const results = await window.coworkApi?.wiki?.search(term) ?? []
      setSearchResults(results)
    } finally {
      setSearching(false)
    }
  }, [query])

  const selectSearchResult = useCallback(async (id: string) => {
    setSelectedId(id)
    setSearchResults(null)
    setQuery('')
  }, [])

  const isEmpty = useMemo(() => overview !== null && overview.status === 'linked' && pages.length === 0, [overview, pages])

  if (overviewError) {
    return (
      <div className="studio-surface p-8">
        <ErrorState title={t('wiki.error', 'Could not load the wiki')} message={overviewError} />
      </div>
    )
  }

  if (!overview) {
    return (
      <div className="studio-surface p-8">
        <Skeleton className="h-16 w-64" />
        <div className="mt-6 grid grid-cols-[260px_1fr] gap-6">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    )
  }

  if (overview.status !== 'linked') {
    return (
      <div className="studio-surface">
        <WikiUnlinked overview={overview} onOpenCapabilities={onOpenCapabilities} />
      </div>
    )
  }

  const selected = (pages || []).find((page) => page.id === selectedId) || null
  const buckets = neighborBuckets(neighbors)

  return (
    <div className="studio-surface flex min-h-0 flex-col">
      <StudioPageHeader
        eyebrow={t('wiki.eyebrow', 'OpenWiki')}
        title={t('wiki.title', 'Wiki')}
        description={overview.root || undefined}
        meta={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={openSourceDialog}
              className="flex items-center gap-1.5 rounded-full border border-border bg-surface-alt/70 px-2.5 py-1 text-2xs font-medium text-text-muted transition-colors hover:text-text"
              title={t('wiki.source.manage', 'Manage wiki sources')}
            >
              <Badge tone={overview.source === 'remote' ? 'accent' : 'neutral'}>
                {overview.source === 'remote' ? t('wiki.source.remoteChip', 'Remote') : t('wiki.source.localChip', 'Local')}
              </Badge>
              <span className="max-w-56 truncate">{overview.source === 'remote' ? overview.origin : t('wiki.source.localWiki', 'Local wiki')}</span>
            </button>
            <Badge tone="neutral">
              {pages.length} {t('wiki.pages', 'pages')}
            </Badge>
          </div>
        }
        actions={[
          { id: 'wiki-sources', children: t('wiki.source.manage', 'Sources'), onClick: openSourceDialog, variant: 'secondary' },
          { id: 'wiki-refresh', children: t('wiki.refresh', 'Refresh'), onClick: () => void refresh(), variant: 'secondary' },
        ]}
      />
      <div className="mx-auto flex w-full max-w-7xl min-h-0 flex-1 flex-col px-6 pb-10">
        <div className="flex items-center justify-between pb-3">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-0.5" role="tablist" aria-label={t('wiki.viewToggle', 'Wiki view')}>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'browse'}
              onClick={() => setView('browse')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${view === 'browse' ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text'}`}
            >
              {t('wiki.browse', 'Browse')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'graph'}
              onClick={() => setView('graph')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${view === 'graph' ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text'}`}
            >
              {t('wiki.graphView', 'Graph')}
            </button>
          </div>
          <span className="text-2xs text-text-muted">
            {graph ? `${graph.nodes.length} ${t('wiki.nodes', 'nodes')} · ${graph.edges.length} ${t('wiki.edges', 'edges')}` : ''}
          </span>
        </div>

        {view === 'graph' ? (
          <div className="min-h-0 flex-1">
            <WikiGraphView
              graph={graph ?? { nodes: [], edges: [] }}
              selectedId={selectedId}
              onSelect={(id) => openPage(id)}
            />
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_230px] gap-6">
            {/* Left rail: search + page list */}
            <aside className="flex min-h-0 flex-col gap-3">
              <Card>
                <div className="flex flex-col gap-2">
                  <label className="text-2xs font-semibold text-text-muted">{t('wiki.search', 'Search')}</label>
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') void runSearch() }}
                    placeholder={t('wiki.searchPlaceholder', 'Search pages…')}
                    className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={searching || !query.trim()}
                    onClick={() => void runSearch()}
                  >
                    {searching ? t('wiki.searching', 'Searching…') : t('wiki.go', 'Search')}
                  </Button>
                </div>
              </Card>

              <Card className="flex min-h-0 flex-1 flex-col">
                {searchResults ? (
                  <div className="p-3">
                    <SearchResults results={searchResults} onPick={(id) => void selectSearchResult(id)} onClear={() => setSearchResults(null)} />
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-col gap-1 overflow-y-auto p-3">
                    {loadingPages
                      ? Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-12" />)
                      : pages.map((page) => (
                          <PageRow key={page.id} page={page} active={page.id === selectedId} onSelect={() => openPage(page.id)} />
                        ))}
                  </div>
                )}
              </Card>
            </aside>

            {/* Main: page body */}
            <main className="min-h-0 overflow-y-auto rounded-lg border border-border bg-surface p-6">
              {isEmpty ? (
                <EmptyState icon="file-text" title={t('wiki.noPages.title', 'This wiki has no pages yet')} body={t('wiki.noPages.body', 'Ask a coworker to draft pages, or add markdown files into the wiki root.')} />
              ) : !selectedId ? (
                <p className="text-2xs text-text-muted">{t('wiki.selectHint', 'Select a page to read it.')}</p>
              ) : loadingDoc ? (
                <div className="flex flex-col gap-3">
                  <Skeleton className="h-8 w-1/2" />
                  <Skeleton className="h-96" />
                </div>
              ) : doc ? (
                <article>
                  <header className="mb-4 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <h1 className="font-display text-xl font-bold text-text">{doc.title}</h1>
                      {doc.isPrivate ? <Badge tone="accent">{t('wiki.private', 'Private')}</Badge> : null}
                      {doc.sectionTitle ? <Badge tone="neutral">{doc.sectionTitle}</Badge> : null}
                    </div>
                    <div className="flex items-center gap-3 text-2xs text-text-muted">
                      <span className="font-mono">{doc.path}</span>
                      <span>{formatDate(doc.updatedAt)}</span>
                      {doc.status ? <Badge tone="muted">{doc.status}</Badge> : null}
                    </div>
                  </header>
                  <MarkdownContent
                    text={doc.bodyMarkdown}
                    rewrite={(markdown) => rewriteWikiWikilinks(markdown, resolver)}
                    onInternalWikiLink={(id) => openPage(id)}
                  />
                </article>
              ) : (
                <p className="text-2xs text-text-muted">{t('wiki.unreadable', 'This page could not be read.')}</p>
              )}
            </main>

            {/* Right rail: backlinks / outgoing / related */}
            <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
              <Card>
                <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-text-muted">{t('wiki.backlinks', 'Linked mentions')}</h3>
                <LinkList ids={buckets.backlinks} neighbors={neighbors} pages={pages} onSelect={(id) => openPage(id)} empty={t('wiki.noBacklinks', 'No pages link here yet.')} />
              </Card>
              <Card>
                <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-text-muted">{t('wiki.outgoing', 'Outgoing links')}</h3>
                <LinkList ids={buckets.outgoing} neighbors={neighbors} pages={pages} onSelect={(id) => openPage(id)} empty={t('wiki.noOutgoing', 'This page links to nothing yet.')} />
              </Card>
              <Card>
                <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-text-muted">{t('wiki.related', 'Related')}</h3>
                <LinkList ids={buckets.related} neighbors={neighbors} pages={pages} onSelect={(id) => openPage(id)} empty={t('wiki.noRelated', 'No related pages found.')} />
              </Card>
            </aside>
          </div>
        )}
      </div>
      <WikiSourceDialog
        open={sourceDialogOpen}
        source={source}
        onClose={() => setSourceDialogOpen(false)}
        onChanged={() => void refresh()}
      />
    </div>
  )
}
