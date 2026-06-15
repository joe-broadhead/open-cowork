import type { CloudProjectSourceSummary } from '@open-cowork/shared'

export const CLOUD_WEB_THREAD_PAGE_SIZE = 200

export type CloudWebThreadFilters = {
  query?: string
  status?: string
  profile?: string
  project?: string
  tag?: string
}

export type CloudWebThreadSession = {
  sessionId: string
  title?: string | null
  profileName?: string | null
  status?: string | null
  updatedAt?: string | null
  tags?: string[]
  smartFilters?: string[]
  projectSource?: CloudProjectSourceSummary | null
}

export type CloudWebThreadProjection = {
  status?: string | null
  profileName?: string | null
  updatedAt?: string | null
  pendingApprovals?: unknown[]
  pendingQuestions?: unknown[]
  projectSource?: CloudProjectSourceSummary | null
  tags?: string[]
  smartFilters?: string[]
}

export type CloudWebThreadView = {
  session?: CloudWebThreadSession
  projection?: {
    sequence?: number | null
    view?: CloudWebThreadProjection | null
  } | null
}

export function cloudWebThreadStatus(session: CloudWebThreadSession, projection: CloudWebThreadProjection | null | undefined) {
  if (projection?.pendingApprovals?.length) return 'approval'
  if (projection?.pendingQuestions?.length) return 'question'
  return projection?.status || session.status || 'idle'
}

export function cloudWebThreadProjectSource(session: CloudWebThreadSession | null | undefined, projection: CloudWebThreadProjection | null | undefined) {
  return projection?.projectSource || session?.projectSource || null
}

export function cloudWebThreadProjectKind(session: CloudWebThreadSession | null | undefined, projection: CloudWebThreadProjection | null | undefined) {
  return cloudWebThreadProjectSource(session, projection)?.kind || 'chat'
}

export function cloudWebThreadProjectLabel(session: CloudWebThreadSession | null | undefined, projection: CloudWebThreadProjection | null | undefined) {
  const source = cloudWebThreadProjectSource(session, projection)
  if (!source) return 'chat-only'
  if (source.kind === 'git') {
    const repo = source.repositoryUrl || 'git repository'
    return repo.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') || repo
  }
  if (source.kind === 'snapshot') return source.title || 'uploaded snapshot'
  return 'project'
}

export function cloudWebThreadTags(session: CloudWebThreadSession, projection: CloudWebThreadProjection | null | undefined) {
  return [
    ...(Array.isArray(session.tags) ? session.tags : []),
    ...(Array.isArray(session.smartFilters) ? session.smartFilters : []),
    ...(Array.isArray(projection?.tags) ? projection.tags : []),
    ...(Array.isArray(projection?.smartFilters) ? projection.smartFilters : []),
  ].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

export function cloudWebThreadProjection(view: CloudWebThreadView | null | undefined): CloudWebThreadProjection | null {
  const projection = view?.projection?.view
  return projection && typeof projection === 'object' && !Array.isArray(projection) ? projection : null
}

function compareCloudWebThreadUpdatedDesc(a: CloudWebThreadSession, b: CloudWebThreadSession) {
  const aUpdated = a.updatedAt || ''
  const bUpdated = b.updatedAt || ''
  if (aUpdated === bUpdated) return 0
  return bUpdated > aUpdated ? 1 : -1
}

export function filterCloudWebThreads(
  sessions: CloudWebThreadSession[],
  views: Record<string, CloudWebThreadView | undefined>,
  filters: CloudWebThreadFilters = {},
  limit = CLOUD_WEB_THREAD_PAGE_SIZE,
) {
  const query = (filters.query || '').trim().toLowerCase()
  const queryTokens = query.split(/\s+/).filter(Boolean)
  const statusFilter = filters.status || 'all'
  const profileFilter = (filters.profile || '').trim().toLowerCase()
  const projectFilter = filters.project || 'all'
  const tagFilter = (filters.tag || '').trim().toLowerCase()
  const hasStatusFilter = statusFilter !== 'all'
  const hasProfileFilter = Boolean(profileFilter)
  const hasProjectFilter = projectFilter !== 'all'
  const hasTagFilter = Boolean(tagFilter)
  const hasQuery = queryTokens.length > 0
  const needsProjection = hasStatusFilter || hasProfileFilter || hasProjectFilter || hasTagFilter || hasQuery

  return sessions
    .filter((session) => {
      const projection = needsProjection ? cloudWebThreadProjection(views[session.sessionId]) : null
      const status = hasStatusFilter || hasQuery ? cloudWebThreadStatus(session, projection) : ''
      if (hasStatusFilter && status !== statusFilter && session.status !== statusFilter) return false
      if (hasProfileFilter && String(session.profileName || projection?.profileName || '').toLowerCase() !== profileFilter) return false
      if (hasProjectFilter && cloudWebThreadProjectKind(session, projection) !== projectFilter) return false
      const tags = hasTagFilter || hasQuery ? cloudWebThreadTags(session, projection) : []
      if (hasTagFilter && !tags.some((entry) => entry.toLowerCase().includes(tagFilter))) return false
      if (!hasQuery) return true
      const haystack = [
        session.sessionId,
        session.title,
        session.profileName,
        status,
        cloudWebThreadProjectLabel(session, projection),
        ...tags,
      ].filter(Boolean).join(' ').toLowerCase()
      return queryTokens.every((token) => haystack.includes(token))
    })
    .sort(compareCloudWebThreadUpdatedDesc)
    .slice(0, limit)
}
