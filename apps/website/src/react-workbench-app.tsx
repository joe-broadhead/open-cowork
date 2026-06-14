import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppApi } from '@open-cowork/ui/app-api'
import type { LaunchpadFreshArtifactItem } from '@open-cowork/shared'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import { CLOUD_WEB_THREAD_PAGE_SIZE, filterCloudWebThreads, type CloudWebThreadFilters, type CloudWebThreadSession, type CloudWebThreadView } from './thread-workbench.ts'
import { buildCloudHandoffAgentBySessionId, type ArtifactActionContext } from './react-workbench.ts'
import { useCloudConversationTaskContext } from './react-workbench-context.ts'
import { useCloudLaunchpad } from './react-workbench-launchpad.tsx'
import { useCloudWorkbenchForms } from './react-workbench-forms.ts'
import { cloudWebCoworkerOptionsFromWorkspace, cloudWebPromptAssignment } from './surface-workbench.ts'
import { CloudWorkbenchPortals, useCloudWorkbenchPortalTargets } from './react-workbench-portals.tsx'
import {
  APPROVAL_QUEUE_VIEW_HYDRATION_LIMIT,
  buildCloudApprovalQueueItems,
  normalizeQuestionAnswers,
  useActiveBodyRoute,
  useCloudApprovalQueueHydration,
  workspaceEventSessionId,
} from './react-workbench-approvals.ts'
import {
  allowedAgentsFromWorkspace,
  asRecord,
  closeCloudReviewPane,
  decodeBase64,
  downloadBlob,
  errorMessage,
  mergeSessions,
  pageFromResponse,
  projectionSequence,
  readThreadFilters,
  sessionMessageCount,
  setCloudStatus,
  setRouteHash,
  syncThreadQueryControls,
  type ArtifactPanelState,
  type SessionListPage,
} from './react-workbench-controller.ts'
declare global {
  interface Window {
    __openCoworkReactWorkbench?: {
      ownsChat: boolean
      ownsThreads: boolean
      selectSession: (sessionId: string) => Promise<void>
      startNewChatDraft: (agentName?: string) => void
      loadSessions: (options?: { keepSelection?: boolean, preserveLoadedPages?: boolean }) => Promise<void>
      loadMoreSessions: () => Promise<void>
    }
  }
}

function CloudReactWorkbenchImpl({ bootstrap }: { bootstrap: CloudWebClientBootstrap }) {
  const api = useAppApi()
  const pageLimit = CLOUD_WEB_THREAD_PAGE_SIZE
  const [workspace, setWorkspace] = useState<unknown | null>(null)
  const [sessions, setSessions] = useState<CloudWebThreadSession[]>([])
  const [views, setViews] = useState<Record<string, CloudWebThreadView | undefined>>({})
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [filters, setFilters] = useState<CloudWebThreadFilters>({ status: 'all', project: 'all' })
  const [threadLimit, setThreadLimit] = useState(pageLimit)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [totalEstimate, setTotalEstimate] = useState<number | null>(null)
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [sessionListError, setSessionListError] = useState<string | null>(null)
  const [composerText, setComposerText] = useState('')
  const [composerAgent, setComposerAgent] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [sessionEventStatus, setSessionEventStatus] = useState<'idle' | 'connecting' | 'open' | 'retrying' | 'closed' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [artifactPanel, setArtifactPanel] = useState<ArtifactPanelState>({ artifactId: null, metadata: null, status: 'idle', error: null })
  const [isLoadingApprovalQueue, setIsLoadingApprovalQueue] = useState(false)
  const sessionsRef = useRef(sessions)
  const threadLimitRef = useRef(threadLimit)
  const nextCursorRef = useRef(nextCursor)
  const isLoadingMoreRef = useRef(isLoadingMore)
  const selectedSessionIdRef = useRef(selectedSessionId)
  const viewsRef = useRef(views)
  const activeRoute = useActiveBodyRoute()
  const activeRouteRef = useRef<string | null>(activeRoute)
  const portalTargets = useCloudWorkbenchPortalTargets()
  const { composerTarget, eventStatusTarget, loadMoreTarget, sessionFormTarget, timelineTarget } = portalTargets

  const selectedView = selectedSessionId ? views[selectedSessionId] || null : null
  const coworkerOptions = useMemo(() => cloudWebCoworkerOptionsFromWorkspace(workspace, bootstrap.profileName), [bootstrap.profileName, workspace])
  const hasExplicitAllowedAgents = useMemo(() => Array.isArray(asRecord(asRecord(workspace).policy).allowedAgents), [workspace])
  const allowedAgents = useMemo(() => {
    const optionAgents = coworkerOptions.map((option) => option.name)
    return optionAgents.length ? optionAgents : allowedAgentsFromWorkspace(workspace)
  }, [coworkerOptions, workspace])
  const activeCoworker = useMemo(() => cloudWebPromptAssignment(composerText, allowedAgents, composerAgent).agent, [allowedAgents, composerAgent, composerText])
  useEffect(() => {
    if (hasExplicitAllowedAgents) setComposerAgent((current) => (!current || allowedAgents.includes(current)) ? current : allowedAgents[0] || '')
  }, [allowedAgents, hasExplicitAllowedAgents])

  const visibleThreads = useMemo(() => filterCloudWebThreads(sessions, views, filters, threadLimit), [filters, sessions, threadLimit, views])
  const filteredThreadCount = useMemo(() => filterCloudWebThreads(sessions, views, filters, Number.MAX_SAFE_INTEGER).length, [filters, sessions, views])
  const handoffAgentBySessionId = useMemo(() => buildCloudHandoffAgentBySessionId(views), [views])
  const approvalQueueItems = useMemo(() => buildCloudApprovalQueueItems(sessions, views, pendingAction), [pendingAction, sessions, views])
  const taskContext = useCloudConversationTaskContext(api, selectedSessionId)

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    threadLimitRef.current = threadLimit
  }, [threadLimit])

  useEffect(() => {
    nextCursorRef.current = nextCursor
  }, [nextCursor])

  useEffect(() => {
    isLoadingMoreRef.current = isLoadingMore
  }, [isLoadingMore])

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId
  }, [selectedSessionId])

  useEffect(() => {
    viewsRef.current = views
  }, [views])

  useEffect(() => {
    activeRouteRef.current = activeRoute
  }, [activeRoute])

  const fetchSessionPage = useCallback(async (cursor: string | null): Promise<SessionListPage> => {
    return pageFromResponse(await api.sessions.list({ limit: pageLimit, cursor }))
  }, [api, pageLimit])

  const loadSessions = useCallback(async (options: { keepSelection?: boolean, preserveLoadedPages?: boolean } = {}) => {
    const loadedPages = Math.max(1, Math.ceil(Math.max(sessionsRef.current.length, threadLimitRef.current, pageLimit) / pageLimit))
    const pageTarget = options.preserveLoadedPages ? loadedPages : 1
    setIsLoadingSessions(true)
    setSessionListError(null)
    try {
      let cursor: string | null = null
      let merged: CloudWebThreadSession[] = []
      let estimate: number | null = null
      for (let index = 0; index < pageTarget; index += 1) {
        const page = await fetchSessionPage(cursor)
        merged = mergeSessions(merged, page.sessions, true)
        cursor = page.nextCursor
        estimate = page.totalEstimate
        if (!cursor) break
      }
      sessionsRef.current = merged
      setSessions(merged)
      nextCursorRef.current = cursor; setNextCursor(cursor)
      setTotalEstimate(estimate)
      if (!options.preserveLoadedPages) setThreadLimit(pageLimit)
      if (!options.keepSelection && merged[0]) setSelectedSessionId(merged[0].sessionId)
      const currentSelection = selectedSessionIdRef.current
      if (currentSelection && !merged.some((session) => session.sessionId === currentSelection) && !viewsRef.current[currentSelection]) {
        setSelectedSessionId(null)
      }
    } catch (nextError) {
      const message = errorMessage(nextError)
      setSessionListError(message)
      setError(message)
      setCloudStatus(message, 'warn')
    } finally {
      setIsLoadingSessions(false)
    }
  }, [fetchSessionPage, pageLimit])

  const refreshApprovalQueueViews = useCallback(async (options: { force?: boolean, sessionIds?: string[] } = {}) => {
    const candidates = sessionsRef.current.slice(0, APPROVAL_QUEUE_VIEW_HYDRATION_LIMIT)
    const currentViews = viewsRef.current
    const requestedSessionIds = new Set((options.sessionIds || []).filter(Boolean))
    const targets = requestedSessionIds.size
      ? candidates.filter((session) => requestedSessionIds.has(session.sessionId))
      : options.force
      ? candidates
      : candidates.filter((session) => !currentViews[session.sessionId])
    if (!targets.length) return
    const results = await Promise.allSettled(targets.map((session) => api.sessions.view(session.sessionId) as Promise<CloudWebThreadView>))
    setViews((current) => {
      const next = { ...current }
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') next[targets[index].sessionId] = result.value
      })
      viewsRef.current = next
      return next
    })
  }, [api])

  const loadMoreSessions = useCallback(async () => {
    if (visibleThreads.length < filteredThreadCount) {
      setThreadLimit((current) => current + pageLimit)
      return
    }
    const cursor = nextCursorRef.current
    if (!cursor || isLoadingMoreRef.current) return
    isLoadingMoreRef.current = true; const loadMoreButton = document.getElementById('thread-load-more') as HTMLButtonElement | null; if (loadMoreButton) loadMoreButton.disabled = true
    setIsLoadingMore(true)
    setSessionListError(null)
    try {
      const page = await fetchSessionPage(cursor)
      setSessions((current) => {
        const next = mergeSessions(current, page.sessions, true)
        sessionsRef.current = next
        return next
      })
      nextCursorRef.current = page.nextCursor; setNextCursor(page.nextCursor)
      setTotalEstimate(page.totalEstimate)
      setThreadLimit((current) => current + pageLimit)
    } catch (nextError) {
      const message = errorMessage(nextError)
      setSessionListError(message)
      setError(message)
      setCloudStatus(message, 'warn')
    } finally {
      isLoadingMoreRef.current = false; if (loadMoreButton) loadMoreButton.disabled = false; setIsLoadingMore(false)
    }
  }, [fetchSessionPage, filteredThreadCount, pageLimit, visibleThreads.length])

  const loadView = useCallback(async (sessionId: string) => {
    const view = await api.sessions.view(sessionId) as CloudWebThreadView
    setViews((current) => ({ ...current, [sessionId]: view }))
    return view
  }, [api])

  useCloudApprovalQueueHydration({ activeRoute, refreshApprovalQueueViews, sessions, setError, setIsLoadingApprovalQueue })

  const selectSession = useCallback(async (sessionId: string) => {
    setSelectedSessionId(sessionId)
    setArtifactPanel({ artifactId: null, metadata: null, status: 'idle', error: null })
    setSessionEventStatus('connecting')
    await loadView(sessionId)
    document.body.dataset.chatState = 'thread'
    setRouteHash('chat')
  }, [loadView])

  const startNewChatDraft = useCallback((agentName = '', prompt = '') => {
    setSelectedSessionId(null)
    setComposerText(prompt)
    setComposerAgent(agentName)
    setArtifactPanel({ artifactId: null, metadata: null, status: 'idle', error: null })
    setSessionEventStatus('idle')
    document.body.dataset.chatState = 'empty'
    setRouteHash('chat')
    window.requestAnimationFrame(() => document.getElementById('chat-message-input')?.focus())
  }, [])

  const { feed: launchpadFeed, loading: isLoadingLaunchpad, error: launchpadError, loadFeed: loadLaunchpadFeed, startSuggestion: startLaunchpadSuggestion } = useCloudLaunchpad({
    api,
    onDraft: (prompt, agentName) => startNewChatDraft(agentName, prompt),
  })

  const refreshSelectedSession = useCallback(async () => {
    if (!selectedSessionId) return
    await loadView(selectedSessionId)
  }, [loadView, selectedSessionId])

  const withRuntimeAction = useCallback(async (key: string, action: () => Promise<void>, targetSessionId?: string | null) => {
    setPendingAction(key)
    setError(null)
    try {
      await action()
      if (targetSessionId) await loadView(targetSessionId)
      else await refreshSelectedSession()
      await loadSessions({ keepSelection: true, preserveLoadedPages: true })
      await loadLaunchpadFeed()
    } catch (nextError) {
      setError(errorMessage(nextError))
    } finally {
      setPendingAction(null)
    }
  }, [loadLaunchpadFeed, loadSessions, loadView, refreshSelectedSession])

  const respondPermission = useCallback((permissionId: string, allowed: boolean, context?: { sessionId?: string | null }) => {
    const targetSessionId = context?.sessionId || selectedSessionId
    if (!targetSessionId) return
    const key = context?.sessionId ? `permission:${targetSessionId}:${permissionId}` : `approval:${permissionId}`
    void withRuntimeAction(key, async () => {
      await api.sessions.respondPermission(targetSessionId, { permissionId, response: { allowed } })
    }, targetSessionId)
  }, [api, selectedSessionId, withRuntimeAction])

  const replyQuestion = useCallback((requestId: string, answers: string[] | string[][], context?: { sessionId?: string | null }) => {
    const targetSessionId = context?.sessionId || selectedSessionId
    if (!targetSessionId) return
    const normalized = normalizeQuestionAnswers(answers)
    if (!normalized.length) {
      setError('Question answer is required.')
      return
    }
    const key = context?.sessionId ? `question:${targetSessionId}:${requestId}` : `question:${requestId}`
    void withRuntimeAction(key, async () => {
      await api.sessions.replyQuestion(targetSessionId, { requestId, answers: normalized })
    }, targetSessionId)
  }, [api, selectedSessionId, withRuntimeAction])

  const rejectQuestion = useCallback((requestId: string, context?: { sessionId?: string | null }) => {
    const targetSessionId = context?.sessionId || selectedSessionId
    if (!targetSessionId) return
    const key = context?.sessionId ? `question:${targetSessionId}:${requestId}` : `question:${requestId}`
    void withRuntimeAction(key, async () => {
      await api.sessions.rejectQuestion(targetSessionId, { requestId })
    }, targetSessionId)
  }, [api, selectedSessionId, withRuntimeAction])

  const readArtifact = useCallback(async (artifactId: string, sessionId?: string | null) => {
    const targetSessionId = sessionId || selectedSessionId
    if (!targetSessionId) throw new Error('Select a chat first.')
    const body = asRecord(await api.sessions.artifact(targetSessionId, artifactId))
    return asRecord(body.artifact || body)
  }, [api, selectedSessionId])

  const openArtifact = useCallback((artifactId: string, mode: 'view' | 'download', context?: ArtifactActionContext) => {
    void withRuntimeAction(`artifact:${artifactId}`, async () => {
      const artifact = await readArtifact(artifactId, context?.sessionId)
      const blob = decodeBase64(artifact.dataBase64, artifact.contentType || artifact.mime)
      if (mode === 'download') {
        downloadBlob(blob, String(artifact.filename || artifact.name || 'artifact'))
        return
      }
      const url = URL.createObjectURL(blob)
      try {
        window.open(url, '_blank', 'noopener,noreferrer')
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    })
  }, [readArtifact, withRuntimeAction])

  const inspectArtifact = useCallback((artifactId: string, context?: ArtifactActionContext) => {
    const targetSessionId = context?.sessionId || selectedSessionId
    if (!targetSessionId) return
    setArtifactPanel({ artifactId, metadata: null, status: 'loading', error: null })
    setPendingAction(`artifact:${artifactId}`)
    void (async () => {
      try {
        const body = asRecord(await api.sessions.artifacts(targetSessionId))
        const artifacts = Array.isArray(body.artifacts) ? body.artifacts.map(asRecord) : []
        const metadata = artifacts.find((artifact) => String(artifact.artifactId || artifact.id || artifact.filePath || '') === artifactId) || { artifactId }
        setArtifactPanel({ artifactId, metadata, status: 'idle', error: null })
        setRouteHash('artifacts')
      } catch (nextError) {
        const message = errorMessage(nextError)
        setArtifactPanel({ artifactId, metadata: null, status: 'error', error: message })
        setError(message)
      } finally {
        setPendingAction(null)
      }
    })()
  }, [api, selectedSessionId])

  const openLaunchpadArtifact = useCallback((item: LaunchpadFreshArtifactItem) => {
    if (item.artifactId && item.sessionId) {
      inspectArtifact(item.artifactId, { sessionId: item.sessionId })
      return
    }
    setRouteHash('artifacts')
  }, [inspectArtifact])

  useEffect(() => {
    const bridge = {
      ownsChat: true,
      ownsThreads: true,
      selectSession,
      startNewChatDraft,
      loadSessions,
      loadMoreSessions,
    }
    window.__openCoworkReactWorkbench = bridge
    return () => {
      if (window.__openCoworkReactWorkbench === bridge) delete window.__openCoworkReactWorkbench
    }
  }, [loadMoreSessions, loadSessions, selectSession, startNewChatDraft])

  useEffect(() => {
    document.body.dataset.reactWorkbench = 'active'
    void api.workspace.current().then(setWorkspace).catch((nextError) => setError(errorMessage(nextError)))
    void loadSessions({ keepSelection: true }).catch((nextError) => setError(errorMessage(nextError)))
    void loadLaunchpadFeed().catch((nextError) => setError(errorMessage(nextError)))
    return () => {
      delete document.body.dataset.reactWorkbench
    }
  }, [api, loadLaunchpadFeed, loadSessions])

  useEffect(() => {
    document.body.dataset.chatState = selectedSessionId && views[selectedSessionId] ? 'thread' : 'empty'
    if (timelineTarget) timelineTarget.hidden = !(selectedSessionId && views[selectedSessionId])
    if (!selectedSessionId) closeCloudReviewPane()
  }, [selectedSessionId, timelineTarget, views])

  useEffect(() => {
    setFilters(readThreadFilters())
    const handler = (event: Event) => {
      const target = event.currentTarget as HTMLInputElement | HTMLSelectElement
      if (target.id === 'thread-query' || target.id === 'sidebar-thread-query') syncThreadQueryControls(target.value)
      setThreadLimit(pageLimit)
      setFilters(readThreadFilters())
    }
    const controls = ['thread-query', 'sidebar-thread-query', 'thread-status', 'thread-profile', 'thread-project', 'thread-tag']
      .map((id) => document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)
      .filter((control): control is HTMLInputElement | HTMLSelectElement => Boolean(control))
    for (const control of controls) control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'input', handler)
    return () => {
      for (const control of controls) control.removeEventListener(control.tagName === 'SELECT' ? 'change' : 'input', handler)
    }
  }, [pageLimit])

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      if (target.closest('#refresh-threads')) {
        event.preventDefault()
        event.stopImmediatePropagation()
        void (async () => {
          await loadSessions({ keepSelection: true })
          if (activeRouteRef.current === 'approvals') await refreshApprovalQueueViews({ force: true })
        })().catch((nextError) => {
          const message = errorMessage(nextError)
          setError(message)
          setCloudStatus(message, 'warn')
        })
        return
      }
      if (target.closest('#thread-load-more')) {
        event.preventDefault()
        event.stopImmediatePropagation()
        void loadMoreSessions()
        return
      }
      const newThreadButton = target.closest('[data-new-thread-shortcut="true"]')
      if (newThreadButton) {
        event.preventDefault()
        event.stopImmediatePropagation()
        startNewChatDraft()
      }
    }
    document.addEventListener('click', handler, true)
    return () => document.removeEventListener('click', handler, true)
  }, [loadMoreSessions, loadSessions, refreshApprovalQueueViews, startNewChatDraft])

  useCloudWorkbenchForms({
    api,
    bootstrap,
    workspace,
    composerTarget,
    sessionFormTarget,
    composerText,
    composerAgent,
    allowedAgents,
    isSending,
    selectedSessionId,
    setComposerText,
    setIsSending,
    setError,
    setViews,
    setSelectedSessionId,
    loadSessions,
    loadView,
  })

  useEffect(() => {
    if (!selectedSessionId) return undefined
    let closed = false
    let stream: { close: () => void } | null = null
    setSessionEventStatus('connecting')
    void (async () => {
      try {
        const currentView = await loadView(selectedSessionId)
        if (closed) return
        stream = api.sessions.events(selectedSessionId, {
          open: () => setSessionEventStatus('open'),
          error: () => setSessionEventStatus('retrying'),
          message: () => {
            void loadView(selectedSessionId).catch((nextError) => {
              setSessionEventStatus('error'); const message = errorMessage(nextError); setError(message); setCloudStatus(message, 'warn')
            })
          },
        }, { afterSequence: projectionSequence(currentView) })
      } catch (nextError) {
        if (closed) return
        setSessionEventStatus('error'); const message = errorMessage(nextError); setError(message); setCloudStatus(message, 'warn')
      }
    })()
    return () => { closed = true; stream?.close(); setSessionEventStatus('closed') }
  }, [api, loadView, selectedSessionId])

  useEffect(() => {
    try {
      const stream = api.workspace.events({
        message: (event) => {
          void (async () => {
            const sessionId = workspaceEventSessionId(event)
            await loadSessions({ keepSelection: true, preserveLoadedPages: true })
            if (sessionId) {
              await refreshApprovalQueueViews({ sessionIds: [sessionId] })
            } else if (activeRouteRef.current === 'approvals') {
              await refreshApprovalQueueViews(event.type === 'snapshot.required' ? { force: true } : undefined)
            }
            await loadLaunchpadFeed()
          })().catch((nextError) => {
            const message = errorMessage(nextError)
            setError(message)
            setCloudStatus(message, 'warn')
          })
        },
      })
      return () => stream.close()
    } catch {
      return undefined
    }
  }, [api, loadLaunchpadFeed, loadSessions, refreshApprovalQueueViews])

  useEffect(() => {
    eventStatusTarget?.setAttribute('data-kind', error ? 'warn' : sessionEventStatus === 'open' || sessionEventStatus === 'idle' ? 'ok' : sessionEventStatus === 'retrying' ? 'warn' : '')
  }, [error, eventStatusTarget, sessionEventStatus])

  useEffect(() => {
    loadMoreTarget?.toggleAttribute('hidden', !(visibleThreads.length < filteredThreadCount || Boolean(nextCursor)))
    if (loadMoreTarget instanceof HTMLButtonElement) loadMoreTarget.disabled = isLoadingMore
  }, [filteredThreadCount, isLoadingMore, loadMoreTarget, nextCursor, visibleThreads.length])

  const chatMeta = selectedView
    ? [
      asRecord(selectedView.session).profileName,
      `${sessionMessageCount(selectedView)} message(s)`,
    ].filter(Boolean).join(' - ')
    : 'Ask anything, or @mention a coworker'
  const statusText = error || (selectedSessionId ? sessionEventStatus : bootstrap.features.chat === false ? 'disabled' : 'ready')
  const limitStatus = sessionListError
    ? sessionListError
    : isLoadingSessions && !sessions.length
      ? 'Loading chats'
      : totalEstimate !== null
        ? `${visibleThreads.length} of ${sessions.length} loaded of about ${totalEstimate} total`
        : sessions.length
          ? `${sessions.length} loaded${nextCursor ? '; more available' : ''}`
          : 'No chats loaded'

  const actionProps = {
    pendingAction,
    onRespondPermission: respondPermission,
    onReplyQuestion: replyQuestion,
    onRejectQuestion: rejectQuestion,
    onViewArtifact: (artifactId: string, context?: ArtifactActionContext) => openArtifact(artifactId, 'view', context),
    onDownloadArtifact: (artifactId: string, context?: ArtifactActionContext) => openArtifact(artifactId, 'download', context),
    onInspectArtifact: inspectArtifact,
    onOpenTaskSession: (sessionId: string) => {
      void selectSession(sessionId)
    },
    handoffAgentBySessionId,
  }

  return (
    <CloudWorkbenchPortals
      targets={portalTargets}
      bootstrap={bootstrap}
      workspace={workspace}
      sessions={sessions}
      views={views}
      filters={filters}
      selectedSessionId={selectedSessionId}
      selectedView={selectedView}
      threadLimit={threadLimit}
      filteredThreadCount={filteredThreadCount}
      approvalQueueItems={approvalQueueItems}
      isLoadingApprovalQueue={isLoadingApprovalQueue}
      limitStatus={limitStatus}
      chatMeta={chatMeta}
      taskContext={taskContext}
      statusText={statusText}
      actionProps={actionProps}
      artifactPanel={artifactPanel}
      allowedAgents={allowedAgents}
      coworkerOptions={coworkerOptions}
      activeCoworker={activeCoworker}
      composerText={composerText}
      composerAgent={composerAgent}
      error={error}
      isSending={isSending}
      launchpadFeed={launchpadFeed}
      isLoadingLaunchpad={isLoadingLaunchpad}
      launchpadError={launchpadError}
      hasExplicitAllowedAgents={hasExplicitAllowedAgents}
      onSelectSession={selectSession}
      onStartNewChatDraft={startNewChatDraft}
      onReloadSessions={() => loadSessions({ keepSelection: true, preserveLoadedPages: true })}
      onSetComposerText={setComposerText}
      onSetComposerAgent={setComposerAgent}
      onLaunchpadSuggestion={startLaunchpadSuggestion}
      onOpenLaunchpadArtifact={openLaunchpadArtifact}
    />
  )
}

export const CloudReactWorkbench = memo(CloudReactWorkbenchImpl)
