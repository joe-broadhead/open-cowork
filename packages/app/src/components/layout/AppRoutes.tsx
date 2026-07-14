import { lazy, Suspense, type ComponentProps } from 'react'
import type { CustomAgentConfig, PublicAppConfig } from '@open-cowork/shared'
import type { AppNavigationTarget, AppView } from '../../app-types'
import type { AdminAccessState } from '../../hooks/useAdminAccessible'
import { t } from '../../helpers/i18n'
import { HomePage } from '../HomePage'
import type { WorkflowNavigationTarget } from '../workflows/WorkflowsPage'
import type { CapabilityNavigationTarget } from '../capabilities/CapabilitiesPage'
import { RouteFallback } from './RouteFallback'

const ChatView = lazy(() => import('../chat/ChatView').then((module) => ({ default: module.ChatView })))
const ProjectsBoardPage = lazy(() => import('../projects/ProjectsBoardPage').then((module) => ({ default: module.ProjectsBoardPage })))
const KnowledgePage = lazy(() => import('../studio/KnowledgePage').then((module) => ({ default: module.KnowledgePage })))
const WorkflowsPage = lazy(() => import('../workflows/WorkflowsPage').then((module) => ({ default: module.WorkflowsPage })))
const AgentsPage = lazy(() => import('../agents/AgentsPage').then((module) => ({ default: module.AgentsPage })))
const CapabilitiesPage = lazy(() => import('../capabilities/CapabilitiesPage').then((module) => ({ default: module.CapabilitiesPage })))
const HealthCenterPage = lazy(() => import('../health/HealthCenterPage').then((module) => ({ default: module.HealthCenterPage })))
const AdminPage = lazy(() => import('../admin/AdminPage').then((module) => ({ default: module.AdminPage })))
const StudioApprovalsPage = lazy(() => import('../studio/StudioUtilityPages').then((module) => ({ default: module.StudioApprovalsPage })))
const StudioArtifactsPage = lazy(() => import('../studio/StudioUtilityPages').then((module) => ({ default: module.StudioArtifactsPage })))
const StudioChannelsPage = lazy(() => import('../studio/StudioUtilityPages').then((module) => ({ default: module.StudioChannelsPage })))
const PrimitiveGallery = lazy(() => import('../ui/PrimitiveGallery').then((module) => ({ default: module.PrimitiveGallery })))

type AppRoutesProps = {
  view: AppView
  config: PublicAppConfig
  adminAccess: AdminAccessState
  agentBuilderSeed: Partial<CustomAgentConfig> | null
  workflowNavigationTarget: WorkflowNavigationTarget | null
  capabilityNavigationTarget: CapabilityNavigationTarget | null
  onStartThread: ComponentProps<typeof HomePage>['onStartThread']
  onOpenThread: (sessionId: string) => void | Promise<void>
  onNavigate: (target: AppNavigationTarget) => void
  onOpenSettings: () => void
  onClearAgentBuilderSeed: () => void
  onTestAgent: (agentName: string, directory?: string | null) => void | Promise<void>
  onStartAgentChat: (agentName: string, directory?: string | null) => void | Promise<void>
  onCreateAgent: (seed: Partial<CustomAgentConfig>) => void
  onWorkflowNavigationHandled: () => void
  onCapabilityNavigationHandled: () => void
}

export function AppRoutes({
  view,
  config,
  adminAccess,
  agentBuilderSeed,
  workflowNavigationTarget,
  capabilityNavigationTarget,
  onStartThread,
  onOpenThread,
  onNavigate,
  onOpenSettings,
  onClearAgentBuilderSeed,
  onTestAgent,
  onStartAgentChat,
  onCreateAgent,
  onWorkflowNavigationHandled,
  onCapabilityNavigationHandled,
}: AppRoutesProps) {
  return (
    <>
      {view === 'home' && (
        <HomePage
          brandName={config.branding.name}
          homeBranding={config.branding.home}
          onStartThread={onStartThread}
          onOpenThread={onOpenThread}
          onNavigate={onNavigate}
        />
      )}
      {view === 'chat' && (
        <Suspense fallback={<RouteFallback />}>
          <ChatView onNavigate={onNavigate} />
        </Suspense>
      )}
      {view === 'projects' && (
        <Suspense fallback={<RouteFallback />}>
          <ProjectsBoardPage onOpenThread={onOpenThread} />
        </Suspense>
      )}
      {view === 'knowledge' && (
        <Suspense fallback={<RouteFallback />}>
          <KnowledgePage />
        </Suspense>
      )}
      {view === 'approvals' && (
        <Suspense fallback={<RouteFallback />}>
          <StudioApprovalsPage onOpenChat={() => onNavigate('chat')} onOpenHome={() => onNavigate('home')} />
        </Suspense>
      )}
      {view === 'playbooks' && (
        <Suspense fallback={<RouteFallback />}>
          <WorkflowsPage
            onOpenThread={onOpenThread}
            initialTarget={workflowNavigationTarget}
            onInitialTargetHandled={onWorkflowNavigationHandled}
          />
        </Suspense>
      )}
      {view === 'team' && (
        <Suspense fallback={<RouteFallback />}>
          <AgentsPage
            initialDraft={agentBuilderSeed}
            onClearDraft={onClearAgentBuilderSeed}
            onClose={() => onNavigate('chat')}
            onOpenCapabilities={() => onNavigate('tools')}
            onTestAgent={(agentName, directory) => void onTestAgent(agentName, directory)}
            onStartAgentChat={(agentName, directory) => void onStartAgentChat(agentName, directory)}
          />
        </Suspense>
      )}
      {view === 'channels' && (
        <Suspense fallback={<RouteFallback />}>
          <StudioChannelsPage onOpenSettings={onOpenSettings} />
        </Suspense>
      )}
      {view === 'tools' && (
        <Suspense fallback={<RouteFallback />}>
          <CapabilitiesPage
            onClose={() => onNavigate('chat')}
            initialTarget={capabilityNavigationTarget}
            onInitialTargetHandled={onCapabilityNavigationHandled}
            onCreateAgent={onCreateAgent}
          />
        </Suspense>
      )}
      {view === 'artifacts' && (
        <Suspense fallback={<RouteFallback />}>
          <StudioArtifactsPage onOpenChat={() => onNavigate('chat')} />
        </Suspense>
      )}
      {view === 'health' && (
        <Suspense fallback={<RouteFallback />}>
          <HealthCenterPage />
        </Suspense>
      )}
      {view === 'admin' && adminAccess.accessible && (
        <Suspense fallback={<RouteFallback label={t('admin.loading', 'Loading admin controls…')} />}>
          <AdminPage />
        </Suspense>
      )}
      {view === 'admin' && !adminAccess.accessible && (
        <RouteFallback
          label={adminAccess.checked
            ? t('admin.unavailable', 'Admin is not available for this account.')
            : t('admin.checkingAccess', 'Checking admin access…')}
        />
      )}
      {view === 'ui-primitives' && (
        <Suspense fallback={<RouteFallback />}>
          <PrimitiveGallery />
        </Suspense>
      )}
    </>
  )
}
