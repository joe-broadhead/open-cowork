import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ApprovalsQueueSurface,
  ChannelsGatewaySurface,
  type ApprovalsQueuePermissionItem,
  type ApprovalsQueueQuestionItem,
} from '@open-cowork/ui'
import {
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
import { listVisibleSessionArtifacts } from '../chat/session-artifacts'
import { SessionArtifactList } from '../chat/SessionArtifactList'
import {
  Card,
  EmptyState,
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

function StudioPageShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-base text-text">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-6 py-6">
        {children}
      </div>
    </div>
  )
}

function StatCard({ label, value, icon }: { label: string; value: string | number; icon: 'circle-help' | 'file' | 'activity' }) {
  return (
    <Card padding="md">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg border border-border-subtle bg-surface text-text-secondary">
          <Icon name={icon} size={16} />
        </span>
        <div>
          <div className="text-2xs font-semibold uppercase tracking-widest text-text-muted">{label}</div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-text">{value}</div>
        </div>
      </div>
    </Card>
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
        <button type="button" className="ui-button ui-button--ghost ui-button--sm" onClick={onOpenSettings}>
          <Icon name="settings-2" size={16} />
          <span>{t('studio.channels.settings', 'Open settings')}</span>
        </button>
      </div>
    </StudioPageShell>
  )
}

export function StudioArtifactsPage({ onOpenChat }: OpenChatProps) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const sessions = useSessionStore((state) => state.sessions)
  const currentView = useSessionStore((state) => state.currentView)
  const activeWorkspaceId = useSessionStore((state) => state.activeWorkspaceId)
  const chartArtifactsBySession = useSessionStore((state) => state.chartArtifactsBySession)
  const workspaceSupport = useActiveWorkspaceSupport()
  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId) || null,
    [sessions, currentSessionId],
  )
  const activeWorkspaceIsLocal = activeWorkspaceId === LOCAL_WORKSPACE_ID
  const canReadPrivateArtifacts = !currentSession?.directory && activeWorkspaceIsLocal
  const chartArtifacts = useMemo(
    () => currentSessionId
      ? chartArtifactsBySession[sessionWorkspaceKey(activeWorkspaceId, currentSessionId)] || []
      : [],
    [activeWorkspaceId, chartArtifactsBySession, currentSessionId],
  )
  const artifacts = useMemo(
    () => listVisibleSessionArtifacts(currentView, chartArtifacts, { canReadPrivateArtifacts }),
    [canReadPrivateArtifacts, chartArtifacts, currentView],
  )
  const canShowArtifactList = Boolean(currentSessionId && (canReadPrivateArtifacts || artifacts.length > 0))

  return (
    <StudioPageShell>
      <StudioPageHeader
        eyebrow={t('studio.artifacts.eyebrow', 'Deliverables')}
        title={t('studio.artifacts.title', 'Artifacts')}
        description={t('studio.artifacts.description', 'Generated files, charts, and Cloud-safe attachments remain tied to the active OpenCode session and explicit artifact actions.')}
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

      <div className="grid gap-3 md:grid-cols-3">
        <StatCard label={t('studio.artifacts.total', 'Artifacts')} value={artifacts.length} icon="file" />
        <StatCard label={t('studio.artifacts.charts', 'Charts')} value={chartArtifacts.length} icon="file" />
        <StatCard label={t('studio.artifacts.workspace', 'Workspace')} value={activeWorkspaceId} icon="activity" />
      </div>

      {canShowArtifactList && currentSessionId ? (
        <SessionArtifactList
          sessionId={currentSessionId}
          artifacts={artifacts}
          workspaceId={activeWorkspaceIsLocal ? undefined : activeWorkspaceId}
          canDownloadArtifact={workspaceSupport.flags.canDownloadArtifact}
          downloadDisabledReason={workspaceSupport.flags.reasons.downloadArtifact}
          canRevealArtifact={workspaceSupport.flags.canRevealArtifact}
          revealDisabledReason={workspaceSupport.flags.reasons.revealArtifact}
        />
      ) : (
        <EmptyState
          icon="file"
          title={currentSessionId ? t('studio.artifacts.noSafeTitle', 'No reviewable artifacts') : t('studio.artifacts.emptyTitle', 'No active chat')}
          body={currentSessionId
            ? t('studio.artifacts.noSafeBody', 'Project file paths stay in the project workspace. This page only exposes private workspace artifacts, chart captures, and Cloud artifact records.')
            : t('studio.artifacts.emptyBody', 'Open a chat to review its generated artifacts. This page does not scan local files outside explicit session artifacts.')}
        />
      )}

      {canShowArtifactList && currentSessionId && artifacts.length === 0 ? (
        <Card padding="md">
          <div className="flex items-start gap-3 text-xs text-text-muted">
            <Icon name="info" size={16} className="mt-0.5 shrink-0 text-text-secondary" />
            <div>
              {t('studio.artifacts.noGeneratedYet', 'The active chat has no generated artifacts yet. File edits, chart captures, and Cloud artifacts will appear here when projected by the session.')}
            </div>
          </div>
        </Card>
      ) : null}
    </StudioPageShell>
  )
}
