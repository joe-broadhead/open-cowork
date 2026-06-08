import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppApi } from '@open-cowork/ui/app-api'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import {
  CLOUD_WEB_THREAD_PAGE_SIZE, filterCloudWebThreads,
  type CloudWebThreadFilters, type CloudWebThreadSession, type CloudWebThreadView,
} from './thread-workbench.ts'
import {
  CloudApprovalsAndQuestions,
  CloudChatTimeline,
  CloudSidebarThreadList,
  CloudThreadList,
} from './react-workbench.ts'
import { CloudArtifactReviewDetail, CloudComposerActionCluster, CloudReviewPane } from './react-workbench-review.tsx'
import { CloudAdminSurfacePortals } from './react-admin-surfaces.tsx'
import { useCloudWorkbenchForms } from './react-workbench-forms.ts'
import { CloudWorkbenchSurfacePortals } from './react-workbench-surfaces.tsx'
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
  sessionTitle,
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

function usePortalTarget(id: string, options: { clear?: boolean } = {}) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const element = document.getElementById(id)
    if (element && options.clear !== false) element.replaceChildren()
    if (element && id === 'chat-timeline') element.hidden = true
    setTarget(element)
  }, [id, options.clear])
  return target
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

  const sessionsRef = useRef(sessions)
  const threadLimitRef = useRef(threadLimit)
  const nextCursorRef = useRef(nextCursor)
  const isLoadingMoreRef = useRef(isLoadingMore)
  const selectedSessionIdRef = useRef(selectedSessionId)
  const viewsRef = useRef(views)

  const threadListTarget = usePortalTarget('thread-list')
  const sidebarListTarget = usePortalTarget('sidebar-thread-list')
  const threadCountTarget = usePortalTarget('thread-count')
  const sidebarCountTarget = usePortalTarget('sidebar-thread-count')
  const limitStatusTarget = usePortalTarget('thread-limit-status')
  const loadMoreTarget = usePortalTarget('thread-load-more', { clear: false })
  const titleTarget = usePortalTarget('chat-session-title')
  const metaTarget = usePortalTarget('chat-session-meta')
  const managedActionsTarget = usePortalTarget('chat-managed-actions')
  const timelineTarget = usePortalTarget('chat-timeline')
  const composerTarget = usePortalTarget('prompt-form')
  const sessionFormTarget = usePortalTarget('session-form', { clear: false })
  const inspectorTarget = usePortalTarget('chat-inspector-detail')
  const eventStatusTarget = usePortalTarget('chat-event-status')
  const artifactDetailTarget = usePortalTarget('artifact-detail')

  const selectedView = selectedSessionId ? views[selectedSessionId] || null : null
  const allowedAgents = useMemo(() => allowedAgentsFromWorkspace(workspace), [workspace])
  const visibleThreads = useMemo(() => filterCloudWebThreads(sessions, views, filters, threadLimit), [filters, sessions, threadLimit, views])
  const filteredThreadCount = useMemo(() => filterCloudWebThreads(sessions, views, filters, Number.MAX_SAFE_INTEGER).length, [filters, sessions, views])

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
      setSessions((current) => mergeSessions(current, page.sessions, true))
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

  const selectSession = useCallback(async (sessionId: string) => {
    setSelectedSessionId(sessionId)
    setArtifactPanel({ artifactId: null, metadata: null, status: 'idle', error: null })
    setSessionEventStatus('connecting')
    await loadView(sessionId)
    document.body.dataset.chatState = 'thread'
    setRouteHash('chat')
  }, [loadView])

  const startNewChatDraft = useCallback((agentName = '') => {
    setSelectedSessionId(null)
    setComposerText('')
    setComposerAgent(agentName)
    setArtifactPanel({ artifactId: null, metadata: null, status: 'idle', error: null })
    setSessionEventStatus('idle')
    document.body.dataset.chatState = 'empty'
    setRouteHash('chat')
    window.requestAnimationFrame(() => document.getElementById('chat-message-input')?.focus())
  }, [])

  const refreshSelectedSession = useCallback(async () => {
    if (!selectedSessionId) return
    await loadView(selectedSessionId)
  }, [loadView, selectedSessionId])

  const withRuntimeAction = useCallback(async (key: string, action: () => Promise<void>) => {
    setPendingAction(key)
    setError(null)
    try {
      await action()
      await refreshSelectedSession()
      await loadSessions({ keepSelection: true, preserveLoadedPages: true })
    } catch (nextError) {
      setError(errorMessage(nextError))
    } finally {
      setPendingAction(null)
    }
  }, [loadSessions, refreshSelectedSession])

  const respondPermission = useCallback((permissionId: string, allowed: boolean) => {
    if (!selectedSessionId) return
    void withRuntimeAction(`approval:${permissionId}`, async () => {
      await api.sessions.respondPermission(selectedSessionId, { permissionId, response: { allowed } })
    })
  }, [api, selectedSessionId, withRuntimeAction])

  const replyQuestion = useCallback((requestId: string, answers: string[]) => {
    if (!selectedSessionId) return
    const normalized = answers.map((answer) => answer.trim()).filter(Boolean)
    if (!normalized.length) {
      setError('Question answer is required.')
      return
    }
    void withRuntimeAction(`question:${requestId}`, async () => {
      await api.sessions.replyQuestion(selectedSessionId, { requestId, answers: normalized })
    })
  }, [api, selectedSessionId, withRuntimeAction])

  const rejectQuestion = useCallback((requestId: string) => {
    if (!selectedSessionId) return
    void withRuntimeAction(`question:${requestId}`, async () => {
      await api.sessions.rejectQuestion(selectedSessionId, { requestId })
    })
  }, [api, selectedSessionId, withRuntimeAction])

  const readArtifact = useCallback(async (artifactId: string) => {
    if (!selectedSessionId) throw new Error('Select a chat first.')
    const body = asRecord(await api.sessions.artifact(selectedSessionId, artifactId))
    return asRecord(body.artifact || body)
  }, [api, selectedSessionId])

  const openArtifact = useCallback((artifactId: string, mode: 'view' | 'download') => {
    void withRuntimeAction(`artifact:${artifactId}`, async () => {
      const artifact = await readArtifact(artifactId)
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

  const inspectArtifact = useCallback((artifactId: string) => {
    if (!selectedSessionId) return
    setArtifactPanel({ artifactId, metadata: null, status: 'loading', error: null })
    setPendingAction(`artifact:${artifactId}`)
    void (async () => {
      try {
        const body = asRecord(await api.sessions.artifacts(selectedSessionId))
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
    return () => {
      delete document.body.dataset.reactWorkbench
    }
  }, [api, loadSessions])

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
        void loadSessions({ keepSelection: true })
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
  }, [loadMoreSessions, loadSessions, startNewChatDraft])

  useCloudWorkbenchForms({
    api,
    bootstrap,
    workspace,
    composerTarget,
    sessionFormTarget,
    composerText,
    composerAgent,
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
        message: () => {
          void loadSessions({ keepSelection: true, preserveLoadedPages: true })
        },
      })
      return () => stream.close()
    } catch {
      return undefined
    }
  }, [api, loadSessions])

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
    onViewArtifact: (artifactId: string) => openArtifact(artifactId, 'view'),
    onDownloadArtifact: (artifactId: string) => openArtifact(artifactId, 'download'),
    onInspectArtifact: inspectArtifact,
  }

  const portals = []
  if (threadListTarget) {
    portals.push(createPortal(
      <CloudThreadList sessions={sessions} views={views} filters={filters} selectedSessionId={selectedSessionId} limit={threadLimit} embedded onSelect={selectSession} />,
      threadListTarget,
    ))
  }
  if (sidebarListTarget) {
    portals.push(createPortal(
      <CloudSidebarThreadList sessions={sessions} views={views} filters={filters} selectedSessionId={selectedSessionId} onSelect={selectSession} />,
      sidebarListTarget,
    ))
  }
  if (threadCountTarget) portals.push(createPortal(<>{filteredThreadCount}</>, threadCountTarget))
  if (sidebarCountTarget) portals.push(createPortal(<>{filteredThreadCount}</>, sidebarCountTarget))
  if (limitStatusTarget) portals.push(createPortal(<>{limitStatus}</>, limitStatusTarget))
  if (titleTarget) portals.push(createPortal(<>{selectedView ? sessionTitle(selectedView, selectedSessionId || 'Cloud chat') : 'What shall we cowork on today?'}</>, titleTarget))
  if (metaTarget) portals.push(createPortal(<>{chatMeta}</>, metaTarget))
  if (managedActionsTarget) {
    portals.push(createPortal(
      <>
        <CloudComposerActionCluster profileName={bootstrap.profileName} />
        <button className="ghost chat-inspector-toggle" id="chat-inspector-toggle" type="button" aria-controls="chat-inspector" aria-expanded="false">Review</button>
      </>,
      managedActionsTarget,
    ))
  }
  if (timelineTarget) {
    portals.push(createPortal(
      <>
        <CloudApprovalsAndQuestions view={selectedView} {...actionProps} />
        <CloudChatTimeline view={selectedView} {...actionProps} />
      </>,
      timelineTarget,
    ))
  }
  if (inspectorTarget) {
    portals.push(createPortal(
      <CloudReviewPane view={selectedView} {...actionProps} />,
      inspectorTarget,
    ))
  }
  if (artifactDetailTarget) {
    portals.push(createPortal(
      <CloudArtifactReviewDetail artifactPanel={artifactPanel} />,
      artifactDetailTarget,
    ))
  }
  if (eventStatusTarget) portals.push(createPortal(<>{statusText}</>, eventStatusTarget))
  if (composerTarget) {
    portals.push(createPortal(
      <>
        <label className="sr-only" htmlFor="chat-message-input">Message</label>
        <div className="composer-input-chrome">
          <textarea
            id="chat-message-input"
            className="chat-composer-textarea"
            name="text"
            rows={1}
            value={composerText}
            disabled={isSending || bootstrap.features.chat === false}
            placeholder={selectedSessionId ? 'Continue the conversation...' : 'Ask anything, or @mention a coworker'}
            onChange={(event) => setComposerText(event.currentTarget.value)}
          />
        </div>
        <div className="composer-agent-chips" id="composer-agent-chips" aria-label="Coworker shortcuts">
          {allowedAgents.slice(0, 5).map((agent) => (
            <button key={agent} type="button" className="agent-chip" data-active={composerAgent === agent ? 'true' : 'false'} onClick={() => { setComposerAgent(agent); const select = document.getElementById('composer-agent') as HTMLSelectElement | null; if (select) select.value = agent }}>
              @{agent}
            </button>
          ))}
        </div>
        <div className="composer-toolbar" aria-label="Chat controls">
          <div className="composer-toolbar-group">
            <button className="icon-button ghost" type="button" data-managed-control="true" disabled title="Cloud file attachments use project snapshots from Projects" aria-label="Attach file" />
            <label className="composer-select-label">
              <span className="sr-only">Coworker</span>
              <select id="composer-agent" name="agent" value={composerAgent} disabled={isSending} onChange={(event) => setComposerAgent(event.currentTarget.value)}>
                <option value="">Default coworker</option>
                {allowedAgents.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
              </select>
            </label>
          </div>
          <div className="composer-toolbar-group">
            <span className="pill" data-kind={error ? 'warn' : 'ok'}>{error || (bootstrap.features.chat === false ? 'disabled' : 'ready')}</span>
            <button className="composer-send" type="submit" disabled={isSending || !composerText.trim() || bootstrap.features.chat === false} aria-label="Send message">
              <span className="sr-only">Send message</span>
            </button>
          </div>
        </div>
      </>,
      composerTarget,
    ))
  }
  portals.push(
    <CloudWorkbenchSurfacePortals
      key="workbench-surfaces"
      bootstrap={bootstrap}
      workspace={workspace}
      selectedView={selectedView}
      onStartAgentChat={startNewChatDraft}
      onSelectSession={selectSession}
      onReloadSessions={() => loadSessions({ keepSelection: true, preserveLoadedPages: true })}
      artifactActions={actionProps}
    />,
  )
  portals.push(<CloudAdminSurfacePortals key="admin-surfaces" bootstrap={bootstrap} workspace={workspace} />)

  return <>{portals}</>
}

export const CloudReactWorkbench = memo(CloudReactWorkbenchImpl)
