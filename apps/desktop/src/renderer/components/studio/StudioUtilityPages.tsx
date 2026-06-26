import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ApprovalsQueueSurface,
  ArtifactsLibrarySurface,
  ChannelsGatewaySurface,
  type ApprovalsQueuePermissionItem,
  type ApprovalsQueueQuestionItem,
} from '@open-cowork/ui'
import {
  defaultArtifactStatusForKind,
  inferArtifactKind,
  isSafeArtifactOpenTarget,
  type ArtifactIndexEntry,
  type ArtifactIndexPayload,
  type ArtifactStatus,
  channelProviderLabel,
  type ChannelAgentRecord,
  type ChannelBindingPublicRecord,
  type ChannelDeliveryPublicRecord,
  type ChannelIdentityPublicRecord,
  type ChannelProviderKind,
  type ChannelProviderStatus,
  type CoordinationWatch,
  type CoordinationWatchInput,
} from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { LOCAL_WORKSPACE_ID, sessionWorkspaceKey } from '../../stores/session-workspace-keys'
import { useActiveWorkspaceSupport } from '../../stores/workspace-support'
import { t } from '../../helpers/i18n'
import {
  Button,
  Card,
  Icon,
  StudioPageHeader,
} from '../ui'
import {
  approvalQueueActionKey,
  buildDesktopApprovalQueueItems,
} from './approval-queue-model'

type OpenChatProps = {
  onOpenChat: () => void
  onOpenHome?: () => void
}

const EMPTY_ARTIFACT_INDEX: ArtifactIndexPayload = { artifacts: [], total: 0 }

function StudioPageShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-base text-text">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-6 py-6">
        {children}
      </div>
    </div>
  )
}


export function StudioApprovalsPage({ onOpenChat, onOpenHome }: OpenChatProps) {
  const activeWorkspaceId = useSessionStore((state) => state.activeWorkspaceId)
  const sessionsByWorkspace = useSessionStore((state) => state.sessionsByWorkspace)
  const sessionStateById = useSessionStore((state) => state.sessionStateById)
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const currentView = useSessionStore((state) => state.currentView)
  const setCurrentSession = useSessionStore((state) => state.setCurrentSession)
  const addGlobalError = useSessionStore((state) => state.addGlobalError)
  const [pendingAction, setPendingAction] = useState<string | null>(null)

  const queueItems = useMemo(() => buildDesktopApprovalQueueItems({
    activeWorkspaceId,
    sessionsByWorkspace,
    sessionStateById,
    currentSessionId,
    currentView,
    pendingAction,
  }), [activeWorkspaceId, sessionsByWorkspace, sessionStateById, currentSessionId, currentView, pendingAction])

  const runQueueAction = useCallback(async (
    item: Parameters<typeof approvalQueueActionKey>[0],
    action: () => Promise<void>,
  ) => {
    setPendingAction(approvalQueueActionKey(item))
    try {
      await action()
    } catch (error) {
      addGlobalError(error instanceof Error ? error.message : String(error))
    } finally {
      setPendingAction(null)
    }
  }, [addGlobalError])

  const openQueueSession = useCallback((item: { sessionId: string }) => {
    setCurrentSession(item.sessionId)
    onOpenChat()
  }, [onOpenChat, setCurrentSession])

  const respondPermission = useCallback((item: ApprovalsQueuePermissionItem, allowed: boolean) => runQueueAction(item, () => (
    window.coworkApi.permission.respond(item.id, allowed, item.sessionId, { workspaceId: item.workspaceId || activeWorkspaceId })
  )), [activeWorkspaceId, runQueueAction])

  const alwaysAllowUnavailable = useCallback(() => undefined, [])

  const replyQuestion = useCallback((item: ApprovalsQueueQuestionItem, answers: string[][]) => runQueueAction(item, () => (
    window.coworkApi.question.reply(item.sessionId, item.id, answers, { workspaceId: item.workspaceId || activeWorkspaceId })
  )), [activeWorkspaceId, runQueueAction])

  const rejectQuestion = useCallback((item: ApprovalsQueueQuestionItem) => runQueueAction(item, () => (
    window.coworkApi.question.reject(item.sessionId, item.id, { workspaceId: item.workspaceId || activeWorkspaceId })
  )), [activeWorkspaceId, runQueueAction])

  return (
    <StudioPageShell>
      <StudioPageHeader
        eyebrow={t('studio.approvals.eyebrow', 'Review')}
        title={t('studio.approvals.title', 'Approvals')}
        description={t('studio.approvals.description', 'OpenCode permission requests and questions stay runtime-owned; this page gives you one place to answer waiting inputs across chats and channels.')}
        actions={[{
          id: 'open-chat',
          children: currentSessionId ? t('studio.approvals.openChat', 'Open chat') : t('studio.approvals.startChat', 'Start from Home'),
          onClick: currentSessionId ? onOpenChat : (onOpenHome || onOpenChat),
          variant: 'primary',
          rightIcon: currentSessionId ? 'chevron-right' : undefined,
        }]}
      />

      <ApprovalsQueueSurface
        items={queueItems}
        emptyTitle={t('studio.approvals.emptyTitle', 'No approvals waiting')}
        emptyBody={t('studio.approvals.emptyBody', 'OpenCode permission requests and questions will appear here when any chat needs your input.')}
        onOpenSession={openQueueSession}
        onAllowOnce={(item) => respondPermission(item, true)}
        onAlwaysAllow={alwaysAllowUnavailable}
        onDeny={(item) => respondPermission(item, false)}
        onReplyQuestion={replyQuestion}
        onRejectQuestion={rejectQuestion}
      />
    </StudioPageShell>
  )
}

type ChannelSnapshot = {
  providers: ChannelProviderStatus[]
  agents: ChannelAgentRecord[]
  bindings: ChannelBindingPublicRecord[]
  people: ChannelIdentityPublicRecord[]
  deliveries: ChannelDeliveryPublicRecord[]
  watches: CoordinationWatch[]
}

const EMPTY_CHANNEL_SNAPSHOT: ChannelSnapshot = {
  providers: [],
  agents: [],
  bindings: [],
  people: [],
  deliveries: [],
  watches: [],
}

export function StudioChannelsPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const activeWorkspaceId = useSessionStore((state) => state.activeWorkspaceId)
  const workspaceSupport = useActiveWorkspaceSupport()
  const [snapshot, setSnapshot] = useState<ChannelSnapshot>(EMPTY_CHANNEL_SNAPSHOT)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadChannels = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [
        providers,
        agents,
        bindings,
        people,
        deliveries,
        watches,
      ] = await Promise.all([
        window.coworkApi.channels.providers({ workspaceId: activeWorkspaceId }),
        window.coworkApi.channels.agents({ workspaceId: activeWorkspaceId, limit: 100 }),
        window.coworkApi.channels.bindings({ workspaceId: activeWorkspaceId, limit: 100 }),
        window.coworkApi.channels.people({ workspaceId: activeWorkspaceId, limit: 100 }),
        window.coworkApi.channels.deliveries({ workspaceId: activeWorkspaceId, limit: 50 }),
        window.coworkApi.channels.watches({ workspaceId: activeWorkspaceId, limit: 500 }),
      ])
      setSnapshot({ providers, agents, bindings, people, deliveries, watches })
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
      setSnapshot(EMPTY_CHANNEL_SNAPSHOT)
    } finally {
      setLoading(false)
    }
  }, [activeWorkspaceId])

  useEffect(() => {
    void loadChannels()
  }, [loadChannels])

  const ensureChannelAgent = useCallback(async () => {
    const existing = snapshot.agents.find((agent) => agent.status === 'active')
    if (existing) return existing.agentId
    const created = await window.coworkApi.channels.createAgent({
      name: 'Gateway Channel Coworker',
      profileName: 'default',
      status: 'active',
      managed: true,
    })
    return created.agentId
  }, [snapshot.agents])

  const connectProvider = useCallback(async (provider: ChannelProviderKind) => {
    const agentId = await ensureChannelAgent()
    await window.coworkApi.channels.connectBinding({
      agentId,
      provider,
      displayName: `${channelProviderLabel(provider)} channel`,
      status: 'auth_required',
      settings: {},
    })
  }, [ensureChannelAgent])

  const createWatch = useCallback((input: CoordinationWatchInput) => (
    window.coworkApi.channels.createWatch({ ...input, workspaceId: activeWorkspaceId })
  ), [activeWorkspaceId])

  return (
    <StudioPageShell>
      <ChannelsGatewaySurface
        providers={snapshot.providers}
        agents={snapshot.agents}
        bindings={snapshot.bindings}
        people={snapshot.people}
        deliveries={snapshot.deliveries}
        watches={snapshot.watches}
        loading={loading}
        error={error}
        platformLabel={`${activeWorkspaceId} - ${workspaceSupport.flags.authority || 'desktop_local'}`}
        canManage
        onReload={loadChannels}
        onConnectProvider={connectProvider}
        onDisconnectBinding={(bindingId) => window.coworkApi.channels.disconnectBinding(bindingId, { workspaceId: activeWorkspaceId })}
        onResolvePerson={(input) => window.coworkApi.channels.resolvePerson(input)}
        onCreateWatch={createWatch}
        onPauseWatch={(watchId) => window.coworkApi.channels.pauseWatch(watchId, { workspaceId: activeWorkspaceId })}
        onResumeWatch={(watchId) => window.coworkApi.channels.resumeWatch(watchId, { workspaceId: activeWorkspaceId })}
        onDeleteWatch={(watchId) => window.coworkApi.channels.deleteWatch(watchId, { workspaceId: activeWorkspaceId })}
      />
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" leftIcon="settings-2" onClick={onOpenSettings}>
          {t('studio.channels.settings', 'Open settings')}
        </Button>
      </div>
    </StudioPageShell>
  )
}

export function StudioArtifactsPage({ onOpenChat }: OpenChatProps) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const sessions = useSessionStore((state) => state.sessions)
  const activeWorkspaceId = useSessionStore((state) => state.activeWorkspaceId)
  const chartArtifactsBySession = useSessionStore((state) => state.chartArtifactsBySession)
  const workspaceSupport = useActiveWorkspaceSupport()
  const [artifactIndexState, setArtifactIndexState] = useState<{
    workspaceId: string | null
    payload: ArtifactIndexPayload
  }>({ workspaceId: null, payload: EMPTY_ARTIFACT_INDEX })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const loadSequenceRef = useRef(0)
  const activeWorkspaceIsLocal = activeWorkspaceId === LOCAL_WORKSPACE_ID
  const canUseArtifactBodies = activeWorkspaceIsLocal || workspaceSupport.flags.canDownloadArtifact
  const artifactActionDisabledReason = workspaceSupport.flags.reasons.downloadArtifact
  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions])
  const artifactIndex = artifactIndexState.workspaceId === activeWorkspaceId ? artifactIndexState.payload : EMPTY_ARTIFACT_INDEX
  const artifactIndexLoading = loading || artifactIndexState.workspaceId !== activeWorkspaceId

  const loadArtifacts = useCallback(async () => {
    const loadSequence = loadSequenceRef.current + 1
    loadSequenceRef.current = loadSequence
    const workspaceId = activeWorkspaceId
    setLoading(true)
    setError(null)
    try {
      const result = await window.coworkApi.artifact.index({
        workspaceId: activeWorkspaceIsLocal ? undefined : activeWorkspaceId,
        limit: 200,
      })
      if (loadSequenceRef.current !== loadSequence) return
      setArtifactIndexState({ workspaceId, payload: result })
    } catch (loadError) {
      if (loadSequenceRef.current !== loadSequence) return
      setError(loadError instanceof Error ? loadError.message : String(loadError))
      setArtifactIndexState({ workspaceId, payload: EMPTY_ARTIFACT_INDEX })
    } finally {
      if (loadSequenceRef.current === loadSequence) setLoading(false)
    }
  }, [activeWorkspaceId, activeWorkspaceIsLocal])

  useEffect(() => {
    void loadArtifacts()
  }, [loadArtifacts])

  const artifactRequest = useCallback((artifact: ArtifactIndexEntry) => ({
    sessionId: artifact.sessionId,
    filePath: artifact.filePath,
    suggestedName: artifact.filename,
    workspaceId: activeWorkspaceIsLocal ? undefined : activeWorkspaceId,
  }), [activeWorkspaceId, activeWorkspaceIsLocal])

  const openArtifact = useCallback(async (artifact: ArtifactIndexEntry) => {
    await window.coworkApi.artifact.open(artifactRequest(artifact))
  }, [artifactRequest])

  const exportArtifact = useCallback(async (artifact: ArtifactIndexEntry) => {
    await window.coworkApi.artifact.export(artifactRequest(artifact))
  }, [artifactRequest])

  const exportVisibleArtifacts = useCallback(async (artifacts: ArtifactIndexEntry[]) => {
    for (const artifact of artifacts) {
      await exportArtifact(artifact)
    }
  }, [exportArtifact])

  const advanceArtifactStatus = useCallback(async (artifact: ArtifactIndexEntry, nextStatus: ArtifactStatus) => {
    try {
      await window.coworkApi.artifact.updateStatus({
        sessionId: artifact.sessionId,
        artifactId: artifact.id,
        status: nextStatus,
        workspaceId: activeWorkspaceIsLocal ? undefined : activeWorkspaceId,
      })
      await loadArtifacts()
    } catch (advanceError) {
      setError(advanceError instanceof Error ? advanceError.message : String(advanceError))
    }
  }, [activeWorkspaceId, activeWorkspaceIsLocal, loadArtifacts])

  const uploadArtifact = useCallback(async (input: { filename: string, contentType: string, dataBase64: string }) => {
    if (!currentSessionId) return
    try {
      await window.coworkApi.artifact.upload({
        sessionId: currentSessionId,
        filename: input.filename,
        contentType: input.contentType,
        dataBase64: input.dataBase64,
        workspaceId: activeWorkspaceIsLocal ? undefined : activeWorkspaceId,
      })
      await loadArtifacts()
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError))
    }
  }, [activeWorkspaceId, activeWorkspaceIsLocal, currentSessionId, loadArtifacts])

  const rendererChartArtifacts = useMemo<ArtifactIndexEntry[]>(() => {
    return sessions.flatMap((session) => {
      const sessionArtifacts = chartArtifactsBySession[sessionWorkspaceKey(activeWorkspaceId, session.id)] || []
      return sessionArtifacts.map((artifact): ArtifactIndexEntry => {
        const kind = inferArtifactKind(artifact)
        return {
          ...artifact,
          kind,
          status: artifact.status || defaultArtifactStatusForKind(kind),
          sessionId: session.id,
          sessionTitle: session.title,
          workspaceId: activeWorkspaceId,
        }
      })
    })
  }, [activeWorkspaceId, chartArtifactsBySession, sessions])

  const artifacts = useMemo(() => {
    const merged = [...artifactIndex.artifacts]
    const keys = new Set(merged.map((artifact) => `${artifact.sessionId}:${artifact.filePath}`))
    for (const artifact of rendererChartArtifacts) {
      const key = `${artifact.sessionId}:${artifact.filePath}`
      if (keys.has(key)) continue
      keys.add(key)
      merged.push(artifact)
    }
    return merged
  }, [artifactIndex.artifacts, rendererChartArtifacts])
  const artifactTotal = artifactIndex.total + Math.max(0, artifacts.length - artifactIndex.artifacts.length)
  const canUseArtifactBody = useCallback((artifact: ArtifactIndexEntry) => {
    if (!canUseArtifactBodies) return false
    if (!activeWorkspaceIsLocal) return true
    if (artifact.kind === 'chart' || artifact.chart) return true
    const session = sessionById.get(artifact.sessionId)
    return Boolean(session && !session.directory)
  }, [activeWorkspaceIsLocal, canUseArtifactBodies, sessionById])
  const canOpenArtifactBody = useCallback((artifact: ArtifactIndexEntry) => (
    canUseArtifactBody(artifact) && isSafeArtifactOpenTarget({ filename: artifact.filename, mime: artifact.mime })
  ), [canUseArtifactBody])
  const artifactBodyDisabledReason = useCallback((artifact: ArtifactIndexEntry) => {
    if (!canUseArtifactBodies) return artifactActionDisabledReason
    if (!activeWorkspaceIsLocal || canUseArtifactBody(artifact)) return null
    return t('studio.artifacts.projectFileActionBlocked', 'Project-file artifacts stay in their project workspace. Open or export the file from the project itself.')
  }, [activeWorkspaceIsLocal, artifactActionDisabledReason, canUseArtifactBodies, canUseArtifactBody])

  return (
    <StudioPageShell>
      <StudioPageHeader
        eyebrow={t('studio.artifacts.eyebrow', 'Deliverables')}
        title={t('studio.artifacts.title', 'Artifacts')}
        description={t('studio.artifacts.description', 'Generated files, charts, and Cloud-safe attachments across projects, sessions, and coworkers. OpenCode still owns execution; this page indexes the deliverables it already emits.')}
        actions={[{
          id: 'open-chat',
          children: t('studio.artifacts.openChat', 'Open chat'),
          onClick: onOpenChat,
          variant: 'primary',
          rightIcon: 'chevron-right',
          disabled: !currentSessionId,
          disabledReason: currentSessionId ? undefined : t('studio.artifacts.noActiveChat', 'Open or start a chat before reviewing artifacts.'),
        }]}
      />

      <ArtifactsLibrarySurface
        artifacts={artifacts}
        total={artifactTotal}
        truncated={artifactIndex.truncated}
        loading={artifactIndexLoading}
        error={error}
        canOpenArtifact={canOpenArtifactBody}
        canExportArtifact={canUseArtifactBody}
        artifactActionDisabledReason={artifactBodyDisabledReason}
        onReload={loadArtifacts}
        onOpenArtifact={openArtifact}
        onExportArtifact={exportArtifact}
        onExportAll={exportVisibleArtifacts}
        onAdvanceStatus={advanceArtifactStatus}
        onUploadArtifact={uploadArtifact}
        canUploadArtifact={Boolean(currentSessionId)}
        uploadDisabledReason={t('studio.artifacts.uploadNeedsChat', 'Open or start a chat to upload an artifact to it.')}
      />

      <Card padding="md">
        <div className="flex items-start gap-3 text-xs text-text-muted">
          <Icon name="info" size={16} className="mt-0.5 shrink-0 text-text-secondary" />
          <div>
            {t('studio.artifacts.safetyNote', 'Artifact previews show filenames, status, coworker, source project, and session provenance only. Local paths, object-store keys, signed URLs, and artifact bodies stay behind explicit Open or Export actions.')}
          </div>
        </div>
      </Card>
    </StudioPageShell>
  )
}
