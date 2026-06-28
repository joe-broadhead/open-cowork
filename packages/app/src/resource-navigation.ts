import {
  createResourceLookupResult,
  createResourceOpenAction,
  parseResourceDeepLink,
  type CanonicalResourceIdentity,
  type CoworkAPI,
  type SessionArtifact,
  type ResourceAuthority,
  type ResourceOpenAction,
  type SessionInfo,
  type WorkspaceInfo,
  type WorkflowDetail,
  type WorkflowRun,
} from '@open-cowork/shared'
import { LOCAL_WORKSPACE_ID, normalizeWorkspaceId } from './stores/session-workspace-keys'

export type ResourceNavigationValue =
  | WorkspaceInfo
  | SessionInfo
  | WorkflowDetail
  | WorkflowRun
  | { kind: 'artifact'; sessionId: string; artifact: SessionArtifact }
  | { kind: 'settings'; surface: string }
  | { kind: 'diagnostics' }
  | { kind: 'capability-tool'; id: string }
  | { kind: 'capability-skill'; id: string }

export type ResourceNavigationAction = ResourceOpenAction<ResourceNavigationValue | null>

export type ResourceNavigationEventDetail = {
  deepLink?: string
  identity?: CanonicalResourceIdentity
}

const DESKTOP_SUPPORTED_AUTHORITIES = new Set<ResourceAuthority>([
  'desktop-local',
  'desktop-cloud',
  'cloud-channel-gateway',
  'standalone-gateway',
  'paired-desktop',
])

export function resourceAuthorityForWorkspace(workspace: WorkspaceInfo): ResourceAuthority {
  if (workspace.authority === 'desktop_local') return 'desktop-local'
  if (workspace.authority === 'cloud_worker') return 'desktop-cloud'
  if (workspace.authority === 'cloud_channel_gateway') return 'cloud-channel-gateway'
  if (workspace.authority === 'gateway_standalone') return 'standalone-gateway'
  if (workspace.authority === 'desktop_paired') return 'paired-desktop'
  if (workspace.kind === 'local') return 'desktop-local'
  if (workspace.kind === 'cloud') return 'desktop-cloud'
  if (workspace.kind === 'gateway') return 'standalone-gateway'
  if (workspace.kind === 'paired_desktop') return 'paired-desktop'
  return 'desktop-local'
}

export function parseResourceNavigationEventDetail(detail: unknown): CanonicalResourceIdentity {
  if (!detail || typeof detail !== 'object') {
    throw new Error('Resource navigation event detail must include a deepLink or identity.')
  }
  const record = detail as ResourceNavigationEventDetail
  if (typeof record.deepLink === 'string') return parseResourceDeepLink(record.deepLink)
  if (record.identity && typeof record.identity === 'object') return record.identity
  throw new Error('Resource navigation event detail must include a deepLink or identity.')
}

function workspaceOptions(workspaceId: string) {
  const normalized = normalizeWorkspaceId(workspaceId)
  return normalized === LOCAL_WORKSPACE_ID ? undefined : { workspaceId: normalized }
}

function statusLabel(status: WorkspaceInfo['status']) {
  return status.replace(/_/g, ' ')
}

function workspaceIsAvailableForResource(workspace: WorkspaceInfo) {
  return workspace.status === 'online'
}

function lookupWorkspace(
  identity: CanonicalResourceIdentity,
  workspaces: WorkspaceInfo[],
) {
  const workspaceId = normalizeWorkspaceId(identity.workspaceId)
  const workspace = workspaces.find((entry) => normalizeWorkspaceId(entry.id) === workspaceId) || null
  if (!workspace) {
    return createResourceLookupResult(identity, null, {
      message: `Workspace ${workspaceId} was not found by exact identity.`,
    })
  }

  if (!DESKTOP_SUPPORTED_AUTHORITIES.has(identity.authority)) {
    return createResourceLookupResult(identity, null, {
      unsupportedAuthority: true,
      message: `Resource authority ${identity.authority} is not supported by the Desktop navigation surface.`,
    })
  }

  const workspaceAuthority = resourceAuthorityForWorkspace(workspace)
  if (workspaceAuthority !== identity.authority) {
    return createResourceLookupResult(identity, null, {
      unsupportedAuthority: true,
      message: `Workspace ${workspace.id} is ${workspaceAuthority}, not ${identity.authority}.`,
    })
  }

  return createResourceLookupResult(identity, workspace)
}

async function unavailableFromError(
  identity: CanonicalResourceIdentity,
  error: unknown,
  fallback: string,
) {
  return createResourceOpenAction(createResourceLookupResult(identity, null, {
    available: false,
    message: error instanceof Error ? error.message : fallback,
  }))
}

export async function resolveDesktopResourceNavigationAction(
  api: CoworkAPI,
  identity: CanonicalResourceIdentity,
): Promise<ResourceNavigationAction> {
  const workspaces = await api.workspace.list()
  const workspaceLookup = lookupWorkspace(identity, workspaces)
  if (!workspaceLookup.found || !workspaceLookup.value) {
    return createResourceOpenAction(workspaceLookup)
  }

  const workspace = workspaceLookup.value
  if (identity.kind === 'workspace') {
    return createResourceOpenAction(workspaceLookup)
  }

  if (!workspaceIsAvailableForResource(workspace)) {
    return createResourceOpenAction(createResourceLookupResult(identity, null, {
      available: false,
      message: `Workspace ${workspace.id} is ${statusLabel(workspace.status)}.`,
    }))
  }

  const options = workspaceOptions(workspace.id)

  if (identity.kind === 'session') {
    try {
      const session = await api.session.get(identity.sessionId!, options)
      return createResourceOpenAction(createResourceLookupResult(identity, session, {
        message: `Thread ${identity.sessionId} was not found in workspace ${workspace.id}.`,
      }))
    } catch (error) {
      return unavailableFromError(identity, error, 'Thread lookup is unavailable.')
    }
  }

  if (identity.kind === 'workflow') {
    try {
      const workflow = await api.workflows.get(identity.workflowId!, options)
      return createResourceOpenAction(createResourceLookupResult(identity, workflow, {
        message: `Workflow ${identity.workflowId} was not found in workspace ${workspace.id}.`,
      }))
    } catch (error) {
      return unavailableFromError(identity, error, 'Workflow lookup is unavailable.')
    }
  }

  if (identity.kind === 'workflow-run') {
    try {
      const workflow = await api.workflows.get(identity.workflowId!, options)
      const run = workflow?.runs.find((entry) => entry.id === identity.runId) || null
      return createResourceOpenAction(createResourceLookupResult(identity, run, {
        message: `Workflow run ${identity.runId} was not found in workflow ${identity.workflowId}.`,
      }))
    } catch (error) {
      return unavailableFromError(identity, error, 'Workflow run lookup is unavailable.')
    }
  }

  if (identity.kind === 'artifact') {
    try {
      const artifacts = await api.artifact.list({
        sessionId: identity.sessionId!,
        ...options,
      })
      const artifact = artifacts.find((entry) => entry.id === identity.artifactId) || null
      return createResourceOpenAction(createResourceLookupResult(identity, artifact ? {
        kind: 'artifact',
        sessionId: identity.sessionId!,
        artifact,
      } : null, {
        message: `Artifact ${identity.artifactId} was not found in thread ${identity.sessionId}.`,
      }))
    } catch (error) {
      return unavailableFromError(identity, error, 'Artifact lookup is unavailable.')
    }
  }

  if (identity.kind === 'settings') {
    return createResourceOpenAction(createResourceLookupResult(identity, {
      kind: 'settings',
      surface: identity.settingsSurface!,
    }))
  }

  if (identity.kind === 'diagnostics') {
    return createResourceOpenAction(createResourceLookupResult(identity, { kind: 'diagnostics' }))
  }

  if (identity.kind === 'capability') {
    if (identity.capabilityKind === 'tool') {
      try {
        const tool = await api.capabilities.tool(identity.capabilityId!, options)
        return createResourceOpenAction(createResourceLookupResult(identity, tool ? {
          kind: 'capability-tool',
          id: identity.capabilityId!,
        } : null, {
          message: `Tool capability ${identity.capabilityId} was not found in workspace ${workspace.id}.`,
        }))
      } catch (error) {
        return unavailableFromError(identity, error, 'Tool capability lookup is unavailable.')
      }
    }
    if (identity.capabilityKind === 'skill') {
      try {
        const skill = await api.capabilities.skillBundle(identity.capabilityId!, options)
        return createResourceOpenAction(createResourceLookupResult(identity, skill ? {
          kind: 'capability-skill',
          id: identity.capabilityId!,
        } : null, {
          message: `Skill capability ${identity.capabilityId} was not found in workspace ${workspace.id}.`,
        }))
      } catch (error) {
        return unavailableFromError(identity, error, 'Skill capability lookup is unavailable.')
      }
    }
    return createResourceOpenAction(createResourceLookupResult(identity, null, {
      available: false,
      message: `Exact ${identity.capabilityKind} capability lookup is not available yet.`,
    }))
  }

  return createResourceOpenAction(createResourceLookupResult(identity, null, {
    available: false,
    message: `Exact ${identity.kind} navigation is not available yet.`,
  }))
}
