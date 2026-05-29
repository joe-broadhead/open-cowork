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
}

export type CloudWebThreadProjection = {
  status?: string | null
  profileName?: string | null
  updatedAt?: string | null
  pendingApprovals?: unknown[]
  pendingQuestions?: unknown[]
  projectSource?: { kind?: string, repositoryUrl?: string | null, title?: string | null } | null
  tags?: string[]
  smartFilters?: string[]
}

export type CloudWebThreadView = {
  session?: CloudWebThreadSession
  projection?: {
    view?: CloudWebThreadProjection | null
  } | null
}

export function cloudWebThreadStatus(session: CloudWebThreadSession, projection: CloudWebThreadProjection | null | undefined) {
  if (projection?.pendingApprovals?.length) return 'approval'
  if (projection?.pendingQuestions?.length) return 'question'
  return projection?.status || session.status || 'idle'
}

export function cloudWebThreadProjectKind(projection: CloudWebThreadProjection | null | undefined) {
  return projection?.projectSource?.kind || 'chat'
}

export function cloudWebThreadProjectLabel(projection: CloudWebThreadProjection | null | undefined) {
  const source = projection?.projectSource
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

  return [...sessions]
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .filter((session) => {
      const projection = cloudWebThreadProjection(views[session.sessionId])
      const status = cloudWebThreadStatus(session, projection)
      if (statusFilter !== 'all' && status !== statusFilter && session.status !== statusFilter) return false
      if (profileFilter && String(session.profileName || projection?.profileName || '').toLowerCase() !== profileFilter) return false
      if (projectFilter !== 'all' && cloudWebThreadProjectKind(projection) !== projectFilter) return false
      const tags = cloudWebThreadTags(session, projection)
      if (tagFilter && !tags.some((entry) => entry.toLowerCase().includes(tagFilter))) return false
      if (!queryTokens.length) return true
      const haystack = [
        session.sessionId,
        session.title,
        session.profileName,
        status,
        cloudWebThreadProjectLabel(projection),
        ...tags,
      ].filter(Boolean).join(' ').toLowerCase()
      return queryTokens.every((token) => haystack.includes(token))
    })
    .slice(0, limit)
}
