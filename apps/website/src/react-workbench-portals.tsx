import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { createPortal } from 'react-dom'
import { ApprovalsQueueSurface, type ApprovalsQueueItem } from '@open-cowork/ui'
import type { ConversationTaskContext, LaunchpadFeedPayload, LaunchpadFreshArtifactItem } from '@open-cowork/shared'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import type { CloudWebThreadFilters, CloudWebThreadSession, CloudWebThreadView } from './thread-workbench.ts'
import {
  CloudApprovalsAndQuestions,
  CloudChatTimeline,
  CloudSidebarThreadList,
  CloudThreadList,
  type CloudRuntimeActionProps,
} from './react-workbench.ts'
import { CloudStatusBar } from './react-workbench-statusbar.ts'
import { CloudConversationMeta } from './react-workbench-context.ts'
import { CloudArtifactReviewDetail, CloudComposerActionCluster, CloudReviewPane } from './react-workbench-review.tsx'
import { CloudAdminSurfacePortals } from './react-admin-surfaces.tsx'
import { CloudSettingsAccessPortals } from './react-workbench-settings-access.tsx'
import { CloudComposerPortal } from './react-workbench-composer.tsx'
import { CloudLaunchpadPortal } from './react-workbench-launchpad.tsx'
import { canManageCloudKnowledge } from './react-workbench-knowledge-state.ts'
import { cloudApprovalsSurfaceHandlers } from './react-workbench-approvals.ts'
import { CloudWorkbenchSurfacePortals } from './react-workbench-surfaces.tsx'
import { sessionTitle, setRouteHash, type ArtifactPanelState } from './react-workbench-controller.ts'
import type { CloudWebCoworkerOption } from './surface-workbench.ts'

export type CloudWorkbenchPortalTargets = {
  threadListTarget: HTMLElement | null
  sidebarListTarget: HTMLElement | null
  threadCountTarget: HTMLElement | null
  sidebarCountTarget: HTMLElement | null
  loadMoreTarget: HTMLElement | null
  limitStatusTarget: HTMLElement | null
  titleTarget: HTMLElement | null
  metaTarget: HTMLElement | null
  managedActionsTarget: HTMLElement | null
  timelineTarget: HTMLElement | null
  composerTarget: HTMLElement | null
  sessionFormTarget: HTMLElement | null
  inspectorTarget: HTMLElement | null
  eventStatusTarget: HTMLElement | null
  statusBarTarget: HTMLElement | null
  artifactDetailTarget: HTMLElement | null
  launchpadTarget: HTMLElement | null
  approvalsTarget: HTMLElement | null
  approvalsCountTarget: HTMLElement | null
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

export function useCloudWorkbenchPortalTargets(): CloudWorkbenchPortalTargets {
  return {
    threadListTarget: usePortalTarget('thread-list'),
    sidebarListTarget: usePortalTarget('sidebar-thread-list'),
    threadCountTarget: usePortalTarget('thread-count'),
    sidebarCountTarget: usePortalTarget('sidebar-thread-count'),
    loadMoreTarget: usePortalTarget('thread-load-more', { clear: false }),
    limitStatusTarget: usePortalTarget('thread-limit-status'),
    titleTarget: usePortalTarget('chat-session-title'),
    metaTarget: usePortalTarget('chat-session-meta'),
    managedActionsTarget: usePortalTarget('chat-managed-actions'),
    timelineTarget: usePortalTarget('chat-timeline'),
    composerTarget: usePortalTarget('prompt-form'),
    sessionFormTarget: usePortalTarget('session-form', { clear: false }),
    inspectorTarget: usePortalTarget('chat-inspector-detail'),
    eventStatusTarget: usePortalTarget('chat-event-status'),
    statusBarTarget: usePortalTarget('cloud-statusbar'),
    artifactDetailTarget: usePortalTarget('artifact-detail'),
    launchpadTarget: usePortalTarget('cloud-launchpad-home'),
    approvalsTarget: usePortalTarget('cloud-approvals-queue'),
    approvalsCountTarget: usePortalTarget('approvals-alert-count'),
  }
}

type CloudWorkbenchPortalsProps = {
  targets: CloudWorkbenchPortalTargets
  bootstrap: CloudWebClientBootstrap
  workspace: unknown
  sessions: CloudWebThreadSession[]
  views: Record<string, CloudWebThreadView | undefined>
  filters: CloudWebThreadFilters
  selectedSessionId: string | null
  selectedView: CloudWebThreadView | null
  threadLimit: number
  filteredThreadCount: number
  approvalQueueItems: ApprovalsQueueItem[]
  isLoadingApprovalQueue: boolean
  limitStatus: string
  chatMeta: string
  taskContext?: ConversationTaskContext | null
  statusText: string
  actionProps: CloudRuntimeActionProps
  artifactPanel: ArtifactPanelState
  allowedAgents: string[]
  coworkerOptions: CloudWebCoworkerOption[]
  activeCoworker: string
  composerText: string
  composerAgent: string
  error: string | null
  isSending: boolean
  launchpadFeed: LaunchpadFeedPayload
  isLoadingLaunchpad: boolean
  launchpadError: string | null
  hasExplicitAllowedAgents: boolean
  onSelectSession: (sessionId: string) => Promise<void>
  onStartNewChatDraft: (agentName?: string, prompt?: string) => void
  onReloadSessions: () => Promise<void>
  onSetComposerText: Dispatch<SetStateAction<string>>
  onSetComposerAgent: Dispatch<SetStateAction<string>>
  onStopGenerating: () => void
  onLaunchpadSuggestion: (prompt: string, agentName: string) => void
  onOpenLaunchpadArtifact: (item: LaunchpadFreshArtifactItem) => void
}

export function CloudWorkbenchPortals({
  targets,
  bootstrap,
  workspace,
  sessions,
  views,
  filters,
  selectedSessionId,
  selectedView,
  threadLimit,
  filteredThreadCount,
  approvalQueueItems,
  isLoadingApprovalQueue,
  limitStatus,
  chatMeta,
  taskContext,
  statusText,
  actionProps,
  artifactPanel,
  allowedAgents,
  coworkerOptions,
  activeCoworker,
  composerText,
  composerAgent,
  error,
  isSending,
  launchpadFeed,
  isLoadingLaunchpad,
  launchpadError,
  hasExplicitAllowedAgents,
  onSelectSession,
  onStartNewChatDraft,
  onReloadSessions,
  onSetComposerText,
  onSetComposerAgent,
  onStopGenerating,
  onLaunchpadSuggestion,
  onOpenLaunchpadArtifact,
}: CloudWorkbenchPortalsProps) {
  const portals: ReactNode[] = []
  const canCaptureKnowledge = canManageCloudKnowledge(bootstrap.role, workspace)
  const pushPortal = (target: HTMLElement | null, node: ReactNode) => {
    if (target) portals.push(createPortal(node, target))
  }

  pushPortal(targets.threadListTarget, <CloudThreadList sessions={sessions} views={views} filters={filters} selectedSessionId={selectedSessionId} limit={threadLimit} embedded onSelect={onSelectSession} />)
  pushPortal(targets.sidebarListTarget, <CloudSidebarThreadList sessions={sessions} views={views} filters={filters} selectedSessionId={selectedSessionId} onSelect={onSelectSession} />)
  pushPortal(targets.threadCountTarget, <>{filteredThreadCount}</>)
  pushPortal(targets.sidebarCountTarget, <>{filteredThreadCount}</>)
  pushPortal(targets.approvalsCountTarget, <>{approvalQueueItems.length || ''}</>)
  pushPortal(targets.limitStatusTarget, <>{limitStatus}</>)
  pushPortal(targets.titleTarget, <>{selectedView ? sessionTitle(selectedView, selectedSessionId || 'Cloud chat') : 'What shall we cowork on today?'}</>)
  pushPortal(targets.metaTarget, <CloudConversationMeta summary={chatMeta} taskContext={taskContext} onOpenBoard={taskContext ? () => setRouteHash('threads') : undefined} />)
  pushPortal(targets.managedActionsTarget, (
    <>
      <CloudComposerActionCluster profileName={bootstrap.profileName} canCaptureKnowledge={canCaptureKnowledge} />
      <button className="ghost chat-inspector-toggle" id="chat-inspector-toggle" type="button" aria-controls="chat-inspector" aria-expanded="false">Review</button>
    </>
  ))
  pushPortal(targets.timelineTarget, (
    <>
      <CloudApprovalsAndQuestions view={selectedView} {...actionProps} />
      <CloudChatTimeline view={selectedView} {...actionProps} />
    </>
  ))
  pushPortal(targets.inspectorTarget, <CloudReviewPane view={selectedView} {...actionProps} />)
  pushPortal(targets.artifactDetailTarget, <CloudArtifactReviewDetail artifactPanel={artifactPanel} />)
  pushPortal(targets.approvalsTarget, (
    <ApprovalsQueueSurface
      items={approvalQueueItems}
      loading={isLoadingApprovalQueue}
      emptyTitle="No approvals waiting"
      emptyBody="Cloud permission requests and questions will appear here when any chat needs your input."
      // onAlwaysAllow is omitted: cloud has no remember-allow endpoint, so the
      // surface hides that control instead of showing a dead button.
      {...cloudApprovalsSurfaceHandlers(actionProps, (sessionId) => { void onSelectSession(sessionId) })}
    />
  ))
  pushPortal(targets.eventStatusTarget, <>{statusText}</>)
  pushPortal(targets.statusBarTarget, <CloudStatusBar view={selectedView} />)
  pushPortal(targets.composerTarget, (
    <CloudComposerPortal
      bootstrap={bootstrap}
      allowedAgents={allowedAgents}
      coworkerOptions={coworkerOptions}
      activeCoworker={activeCoworker}
      composerText={composerText}
      composerAgent={composerAgent}
      error={error}
      isSending={isSending}
      selectedSessionId={selectedSessionId}
      setComposerText={onSetComposerText}
      setComposerAgent={onSetComposerAgent}
      onStopGenerating={onStopGenerating}
    />
  ))
  pushPortal(targets.launchpadTarget, (
    <CloudLaunchpadPortal
      feed={launchpadFeed}
      loading={isLoadingLaunchpad}
      error={launchpadError}
      coworkerOptions={coworkerOptions}
      policyKnown={Boolean(workspace)}
      hasExplicitAllowedAgents={hasExplicitAllowedAgents}
      onSuggestion={onLaunchpadSuggestion}
      onOpenRoute={setRouteHash}
      onOpenSession={(sessionId) => { void onSelectSession(sessionId) }}
      onOpenArtifact={onOpenLaunchpadArtifact}
    />
  ))
  portals.push(
    <CloudWorkbenchSurfacePortals
      key="workbench-surfaces"
      bootstrap={bootstrap}
      workspace={workspace}
      selectedView={selectedView}
      onStartAgentChat={onStartNewChatDraft}
      onSelectSession={onSelectSession}
      onReloadSessions={onReloadSessions}
      artifactActions={actionProps}
    />,
  )
  portals.push(<CloudAdminSurfacePortals key="admin-surfaces" bootstrap={bootstrap} workspace={workspace} />)
  portals.push(<CloudSettingsAccessPortals key="settings-access" />)

  return <>{portals}</>
}
