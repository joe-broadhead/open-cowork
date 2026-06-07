import { useMemo, type ReactNode } from 'react'
import { useSessionStore } from '../../stores/session'
import { LOCAL_WORKSPACE_ID, sessionWorkspaceKey } from '../../stores/session-workspace-keys'
import { useActiveWorkspaceSupport } from '../../stores/workspace-support'
import { t } from '../../helpers/i18n'
import { listVisibleSessionArtifacts } from '../chat/session-artifacts'
import { SessionArtifactList } from '../chat/SessionArtifactList'
import {
  Card,
  ChannelStatusCard,
  EmptyState,
  Icon,
  StudioPageHeader,
} from '../ui'

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
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const currentView = useSessionStore((state) => state.currentView)
  const pendingApprovals = currentView.pendingApprovals
  const pendingQuestions = currentView.pendingQuestions
  const hasActiveQueue = pendingApprovals.length > 0 || pendingQuestions.length > 0

  return (
    <StudioPageShell>
      <StudioPageHeader
        eyebrow={t('studio.approvals.eyebrow', 'Review')}
        title={t('studio.approvals.title', 'Approvals')}
        description={t('studio.approvals.description', 'OpenCode permission requests and questions stay runtime-owned; this page gives you one place to find the active session queue.')}
        actions={[{
          id: 'open-chat',
          children: currentSessionId ? t('studio.approvals.openChat', 'Open chat') : t('studio.approvals.startChat', 'Start from Home'),
          onClick: currentSessionId ? onOpenChat : (onOpenHome || onOpenChat),
          variant: 'primary',
          rightIcon: currentSessionId ? 'chevron-right' : undefined,
        }]}
      />

      <div className="grid gap-3 md:grid-cols-3">
        <StatCard label={t('studio.approvals.permissions', 'Permission requests')} value={pendingApprovals.length} icon="circle-help" />
        <StatCard label={t('studio.approvals.questions', 'Questions')} value={pendingQuestions.length} icon="circle-help" />
        <StatCard
          label={t('studio.approvals.sessions', 'Sessions waiting')}
          value={hasActiveQueue ? 1 : 0}
          icon="activity"
        />
      </div>

      {hasActiveQueue ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {pendingApprovals.map((approval) => (
            <Card key={approval.id} padding="md">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 grid h-8 w-8 place-items-center rounded-lg border border-border-subtle bg-surface text-amber-200">
                  <Icon name="circle-help" size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-text">{approval.tool}</div>
                  <div className="mt-1 text-xs leading-relaxed text-text-muted">{approval.description}</div>
                  <div className="mt-2 text-2xs uppercase tracking-widest text-text-muted">
                    {approval.taskRunId ? t('studio.approvals.specialist', 'Specialist lane') : t('studio.approvals.activeChat', 'Active chat')}
                  </div>
                </div>
              </div>
            </Card>
          ))}
          {pendingQuestions.map((question) => (
            <Card key={question.id} padding="md">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 grid h-8 w-8 place-items-center rounded-lg border border-border-subtle bg-surface text-accent">
                  <Icon name="circle-help" size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-text">{question.questions[0]?.header || t('studio.approvals.question', 'Question')}</div>
                  <div className="mt-1 text-xs leading-relaxed text-text-muted">
                    {question.questions[0]?.question || t('studio.approvals.questionFallback', 'Open the active chat to answer this question.')}
                  </div>
                  <div className="mt-2 text-2xs uppercase tracking-widest text-text-muted">
                    {question.questions.length} {t('studio.approvals.prompts', 'prompt(s)')}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          icon="badge-check"
          title={t('studio.approvals.emptyTitle', 'No approvals waiting')}
          body={currentSessionId
            ? t('studio.approvals.emptyBodyActive', 'The active chat has no pending OpenCode permissions or questions.')
            : t('studio.approvals.emptyBody', 'Start or open a chat; permission requests and questions will appear here when OpenCode asks for input.')}
        />
      )}
    </StudioPageShell>
  )
}

export function StudioChannelsPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const mcpConnections = useSessionStore((state) => state.mcpConnections)
  const activeWorkspaceId = useSessionStore((state) => state.activeWorkspaceId)
  const workspaceSupport = useActiveWorkspaceSupport()
  const connected = mcpConnections.filter((entry) => entry.connected).length

  return (
    <StudioPageShell>
      <StudioPageHeader
        eyebrow={t('studio.channels.eyebrow', 'Connections')}
        title={t('studio.channels.title', 'Channels')}
        description={t('studio.channels.description', 'Desktop channels are workspace and gateway entry points around OpenCode execution. Local runtime behavior stays owned by OpenCode.')}
        actions={[{
          id: 'settings',
          children: t('studio.channels.settings', 'Open settings'),
          onClick: onOpenSettings,
          variant: 'secondary',
          leftIcon: 'settings-2',
        }]}
      />

      <div className="grid gap-3 md:grid-cols-3">
        <StatCard label={t('studio.channels.workspace', 'Active workspace')} value={activeWorkspaceId} icon="activity" />
        <StatCard label={t('studio.channels.connectedTools', 'Connected MCPs')} value={`${connected}/${mcpConnections.length}`} icon="activity" />
        <StatCard label={t('studio.channels.authority', 'Authority')} value={workspaceSupport.flags.authority || 'desktop_local'} icon="activity" />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ChannelStatusCard
          title={t('studio.channels.workspaceCard', 'Workspace channel')}
          description={t('studio.channels.workspaceDescription', 'Use the workspace switcher in the sidebar to move between local, paired Desktop, Cloud, or Gateway-backed workspaces.')}
          status={{ label: workspaceSupport.loaded ? t('studio.channels.ready', 'Ready') : t('studio.channels.checking', 'Checking'), tone: workspaceSupport.loaded ? 'success' : 'warning' }}
          meta={<span className="text-2xs text-text-muted">{workspaceSupport.flags.pathExposure || t('studio.channels.noPathExposure', 'No path exposure')}</span>}
        />
        <ChannelStatusCard
          title={t('studio.channels.gatewayCard', 'Gateway channel')}
          description={t('studio.channels.gatewayDescription', 'Standalone Gateway and Cloud channel bindings are available through explicit workspace connections and admin setup, not implicit Desktop runtime mutation.')}
          status={{ label: t('studio.channels.explicit', 'Explicit setup'), tone: 'neutral' }}
        />
      </div>

      {mcpConnections.length ? (
        <div className="grid gap-2">
          {mcpConnections.map((connection) => (
            <Card key={connection.name} padding="sm">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-text">{connection.name}</div>
                  <div className="mt-0.5 truncate text-2xs text-text-muted">{connection.error || connection.rawStatus || t('studio.channels.mcpReady', 'MCP connection')}</div>
                </div>
                <span className={`rounded border px-2 py-1 text-2xs ${connection.connected ? 'border-green-500/30 text-green-200' : 'border-amber-500/30 text-amber-200'}`}>
                  {connection.connected ? t('studio.channels.connected', 'Connected') : t('studio.channels.notConnected', 'Not connected')}
                </span>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          icon="activity"
          title={t('studio.channels.emptyTitle', 'No MCP channels connected')}
          body={t('studio.channels.emptyBody', 'Configured tools and gateway workspaces will appear here after the runtime reports connection status.')}
        />
      )}
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
