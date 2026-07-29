import {
  WORKSPACE_SUPPORT_APIS,
  coordinationCapabilityFromWorkspaceApi,
  coordinationCapabilityStatus,
  workspaceApiSupportContextForAuthority,
  type WorkspaceApiSupport,
  type WorkspaceApiSupportStatus,
  type WorkspaceExecutionAuthority,
  type WorkspaceKind,
  type WorkspacePolicy,
  type WorkspaceProductSurface,
  type WorkspaceStatus,
  type WorkspaceSupportApi,
} from '@open-cowork/shared'
import type { WorkspaceRegistration } from './workspace-gateway-credential-state.ts'

const LOCAL_WORKSPACE_POLICY: WorkspacePolicy = {
  features: {
    sessions: true,
    threads: true,
    workflows: true,
    artifacts: true,
    settings: true,
    customContent: true,
    capabilities: true,
  },
  allowedAgents: null,
  allowedTools: null,
  allowedMcps: null,
  localFiles: 'enabled',
  localStdioMcps: 'enabled',
  machineRuntimeConfig: 'allowlisted',
}

const DISABLED_CLOUD_POLICY: WorkspacePolicy = {
  features: {
    sessions: false,
    threads: false,
    workflows: false,
    artifacts: false,
    settings: false,
    customContent: false,
    capabilities: false,
  },
  allowedAgents: [],
  allowedTools: [],
  allowedMcps: [],
  localFiles: 'disabled',
  localStdioMcps: 'disabled',
  machineRuntimeConfig: 'disabled',
}

const DISABLED_REMOTE_POLICY: WorkspacePolicy = {
  features: {
    sessions: false,
    threads: false,
    workflows: false,
    artifacts: false,
    settings: false,
    customContent: false,
    capabilities: false,
  },
  allowedAgents: [],
  allowedTools: [],
  allowedMcps: [],
  localFiles: 'disabled',
  localStdioMcps: 'disabled',
  machineRuntimeConfig: 'disabled',
}

export function workspacePolicyForKind(kind: WorkspaceKind): WorkspacePolicy {
  if (kind === 'local') return LOCAL_WORKSPACE_POLICY
  if (kind === 'cloud') return DISABLED_CLOUD_POLICY
  return DISABLED_REMOTE_POLICY
}

function localSupportReason(
  api: WorkspaceSupportApi,
  status: WorkspaceApiSupportStatus,
): string | null {
  if (status === 'supported' || status === 'read_only') return null
  if (api === 'coordination.watches') return 'Desktop Local watch subscriptions require a channel delivery target.'
  if (status === 'deferred') return 'This Desktop Local capability is deferred until its product surface is implemented.'
  return 'This Desktop Local capability is not supported.'
}

function localSupportForApi(
  api: WorkspaceSupportApi,
  workspaceStatus: WorkspaceStatus,
): Omit<WorkspaceApiSupport, 'api'> {
  const capability = coordinationCapabilityFromWorkspaceApi(api)
  const status = capability ? coordinationCapabilityStatus('desktop_local', capability) : 'supported'
  const reason = localSupportReason(api, status)
  return {
    status,
    verdict: {
      allowed: status === 'supported' || status === 'read_only',
      reason,
      ...(reason ? { policyCode: status } : {}),
    },
    context: workspaceApiSupportContextForAuthority('desktop_local', {
      surface: 'desktop_local',
      onlineState: workspaceStatus,
      status,
      ...(reason
        ? {
            blockedReason: {
              allowed: status === 'supported' || status === 'read_only',
              reason,
              policyCode: status,
            },
          }
        : {}),
    }),
  }
}

type RemoteSupportInput = {
  authority: WorkspaceExecutionAuthority
  surface: WorkspaceProductSurface
  workspace: WorkspaceRegistration
  deferredReason: string
  pathReason: string
  workflowReason: string
  artifactReason: string
  settingsReason: string
  customContentReason: string
  capabilitiesReason: string
}

function remoteSupportMatrix(input: RemoteSupportInput): WorkspaceApiSupport[] {
  const remoteSupport = (
    api: WorkspaceSupportApi,
    status: WorkspaceApiSupportStatus,
    reason: string | null,
    options: {
      artifactBody?: 'gateway_artifact_store' | 'redacted_metadata_only' | 'none'
      artifactReveal?: 'gateway_artifact_store' | 'redacted_metadata_only' | 'none'
    } = {},
  ): WorkspaceApiSupport => ({
    api,
    status,
    verdict: {
      allowed: status === 'supported' || status === 'read_only',
      reason,
      ...(reason ? { policyCode: status === 'deferred' ? 'workspace.deferred' : 'workspace.not_supported' } : {}),
    },
    context: workspaceApiSupportContextForAuthority(input.authority, {
      surface: input.surface,
      onlineState: input.workspace.status,
      status,
      pathExposure: 'redacted_remote',
      pairingState: input.authority === 'desktop_paired'
        ? input.workspace.status === 'online' ? 'paired_online' : input.workspace.status === 'offline' ? 'paired_offline' : 'pairing_required'
        : 'not_applicable',
      workflows: status === 'deferred' ? 'deferred' : 'not_supported',
      ...(options.artifactBody ? { artifactBody: options.artifactBody } : {}),
      ...(options.artifactReveal ? { artifactReveal: options.artifactReveal } : {}),
      ...(reason
        ? {
            blockedReason: {
              allowed: false,
              reason,
              policyCode: status === 'deferred' ? 'workspace.deferred' : 'workspace.not_supported',
            },
          }
        : {}),
    }),
  })

  return [
    remoteSupport('sessions.list', 'deferred', input.deferredReason),
    remoteSupport('sessions.create', 'deferred', input.deferredReason),
    remoteSupport('sessions.activate', 'deferred', input.deferredReason),
    remoteSupport('sessions.get', 'deferred', input.deferredReason),
    remoteSupport('sessions.prompt', 'deferred', input.deferredReason),
    remoteSupport('sessions.abort', 'deferred', input.deferredReason),
    remoteSupport('sessions.fileSnippet', 'not_supported', input.pathReason, { artifactBody: 'none', artifactReveal: 'none' }),
    remoteSupport('sessions.diff', 'not_supported', input.pathReason, { artifactBody: 'none', artifactReveal: 'none' }),
    remoteSupport('threads.search', 'deferred', input.deferredReason),
    remoteSupport('threads.tags', 'deferred', input.deferredReason),
    remoteSupport('threads.smartFilters', 'deferred', input.deferredReason),
    remoteSupport('workflows.list', 'deferred', input.workflowReason),
    remoteSupport('workflows.run', 'deferred', input.workflowReason),
    remoteSupport('coordination.projects', 'deferred', input.deferredReason),
    remoteSupport('coordination.tasks', 'deferred', input.deferredReason),
    remoteSupport('coordination.runs', 'deferred', input.deferredReason),
    remoteSupport('coordination.schedules', 'deferred', input.workflowReason),
    remoteSupport('coordination.watches', 'deferred', input.deferredReason),
    remoteSupport('coordination.delegation', 'deferred', input.deferredReason),
    remoteSupport('artifacts.list', 'deferred', input.artifactReason, {
      artifactBody: input.authority === 'gateway_standalone' ? 'gateway_artifact_store' : 'redacted_metadata_only',
      artifactReveal: 'none',
    }),
    remoteSupport('artifacts.index', 'deferred', input.artifactReason, { artifactBody: 'redacted_metadata_only', artifactReveal: 'none' }),
    remoteSupport('artifacts.status', 'deferred', input.artifactReason, { artifactBody: 'redacted_metadata_only', artifactReveal: 'none' }),
    remoteSupport('artifacts.upload', 'deferred', input.artifactReason, { artifactReveal: 'none' }),
    remoteSupport('artifacts.download', 'deferred', input.artifactReason, {
      artifactBody: input.authority === 'gateway_standalone' ? 'gateway_artifact_store' : 'redacted_metadata_only',
      artifactReveal: 'none',
    }),
    remoteSupport('artifacts.reveal', 'not_supported', 'Remote workspace artifacts cannot be revealed in the local filesystem.', { artifactBody: 'none', artifactReveal: 'none' }),
    remoteSupport('settings.portable', 'not_supported', input.settingsReason),
    remoteSupport('customContent.agents', 'not_supported', input.customContentReason),
    remoteSupport('customContent.skills', 'not_supported', input.customContentReason),
    remoteSupport('customContent.mcps', 'not_supported', input.customContentReason),
    remoteSupport('capabilities.catalog', 'deferred', input.capabilitiesReason),
    remoteSupport('localFiles', 'not_supported', input.pathReason, { artifactBody: 'none', artifactReveal: 'none' }),
    remoteSupport('localStdioMcps', 'not_supported', 'Remote workspaces do not execute this Desktop app\'s local stdio MCPs.'),
    remoteSupport('machineRuntimeConfig', 'not_supported', 'Remote workspaces do not use this Desktop app\'s machine-native runtime config.'),
    remoteSupport('voice.capture', 'not_supported', 'Private realtime voice is Desktop Local only.'),
    remoteSupport('voice.stt', 'not_supported', 'On-device speech-to-text is Desktop Local only.'),
    remoteSupport('voice.tts', 'not_supported', 'Private text-to-speech is Desktop Local only.'),
    remoteSupport('voice.conversation', 'not_supported', 'Voice conversation is Desktop Local only.'),
  ]
}

function cloudSupportMatrix(
  workspace: WorkspaceRegistration,
  policy: WorkspacePolicy,
): WorkspaceApiSupport[] {
  const feature = (key: string, fallback = false) => policy.features[key] ?? fallback
  const cloudSupport = (
    api: WorkspaceSupportApi,
    status: WorkspaceApiSupportStatus,
    reason: string | null = null,
  ): WorkspaceApiSupport => ({
    api,
    status,
    verdict: {
      allowed: status === 'supported' || status === 'read_only',
      reason,
      ...(reason ? { policyCode: status } : {}),
    },
    context: workspaceApiSupportContextForAuthority('cloud_worker', {
      surface: 'desktop_cloud',
      onlineState: workspace.status,
      status,
      pathExposure: status === 'not_supported' ? 'not_exposed' : 'cloud_safe_refs',
      ...(api === 'artifacts.reveal' ? { artifactReveal: 'none' as const } : {}),
      ...(reason
        ? {
            blockedReason: {
              allowed: status === 'supported' || status === 'read_only',
              reason,
              policyCode: status,
            },
          }
        : {}),
    }),
  })
  const supportedIf = (
    api: WorkspaceSupportApi,
    allowed: boolean,
    reason: string,
  ): WorkspaceApiSupport => (
    allowed ? cloudSupport(api, 'supported') : cloudSupport(api, 'blocked_by_policy', reason)
  )
  const chatEnabled = feature('chat', feature('sessions', true))
  return [
    supportedIf('sessions.list', chatEnabled, 'Cloud chat is disabled by this workspace policy.'),
    supportedIf('sessions.create', chatEnabled, 'Cloud chat is disabled by this workspace policy.'),
    supportedIf('sessions.activate', chatEnabled, 'Cloud chat is disabled by this workspace policy.'),
    supportedIf('sessions.get', chatEnabled, 'Cloud chat is disabled by this workspace policy.'),
    supportedIf('sessions.prompt', chatEnabled, 'Cloud chat is disabled by this workspace policy.'),
    supportedIf('sessions.abort', chatEnabled, 'Cloud chat is disabled by this workspace policy.'),
    cloudSupport('sessions.fileSnippet', 'not_supported', 'Cloud workspaces cannot read arbitrary local host paths.'),
    cloudSupport('sessions.diff', 'not_supported', 'Cloud workspaces cannot diff arbitrary local host paths.'),
    supportedIf('threads.search', feature('threadIndex'), 'Cloud thread index is disabled by this workspace policy.'),
    supportedIf('threads.tags', feature('threadIndex'), 'Cloud thread index is disabled by this workspace policy.'),
    supportedIf('threads.smartFilters', feature('threadIndex'), 'Cloud thread index is disabled by this workspace policy.'),
    supportedIf('workflows.list', feature('workflows'), 'Cloud workflows are disabled by this workspace policy.'),
    supportedIf('workflows.run', feature('workflows'), 'Cloud workflows are disabled by this workspace policy.'),
    cloudSupport('coordination.projects', 'deferred', 'Cloud project coordination is deferred until the shared coordination control plane is available.'),
    cloudSupport('coordination.tasks', 'deferred', 'Cloud task coordination is deferred until the shared coordination control plane is available.'),
    supportedIf('coordination.runs', feature('workflows'), 'Cloud coordination runs are disabled by this workspace policy.'),
    supportedIf('coordination.schedules', feature('workflows'), 'Cloud schedules are disabled by this workspace policy.'),
    cloudSupport('coordination.watches', 'deferred', 'Cloud watch management is deferred in the desktop Cloud surface until the WorkspaceGateway adapter is wired.'),
    cloudSupport('coordination.delegation', 'deferred', 'Cloud delegation coordination is deferred until the shared coordination control plane is available.'),
    supportedIf('artifacts.list', feature('artifacts'), 'Cloud artifacts are disabled by this workspace policy.'),
    supportedIf('artifacts.index', feature('artifacts'), 'Cloud artifacts are disabled by this workspace policy.'),
    supportedIf('artifacts.status', feature('artifacts'), 'Cloud artifacts are disabled by this workspace policy.'),
    supportedIf('artifacts.upload', feature('artifacts'), 'Cloud artifacts are disabled by this workspace policy.'),
    supportedIf('artifacts.download', feature('artifacts'), 'Cloud artifacts are disabled by this workspace policy.'),
    cloudSupport('artifacts.reveal', 'not_supported', 'Cloud artifacts cannot be revealed in the local filesystem. Export the artifact instead.'),
    supportedIf('settings.portable', feature('settings'), 'Cloud portable settings are disabled by this workspace policy.'),
    supportedIf('customContent.agents', feature('customAgents'), 'Cloud custom agents are disabled by this workspace policy.'),
    supportedIf('customContent.skills', feature('customSkills'), 'Cloud custom skills are disabled by this workspace policy.'),
    supportedIf('customContent.mcps', feature('customMcps'), 'Cloud custom MCPs are disabled by this workspace policy.'),
    supportedIf('capabilities.catalog', feature('agents'), 'Cloud capability catalog is disabled by this workspace policy.'),
    cloudSupport('localFiles', 'not_supported', 'Cloud workspaces do not implicitly upload local files.'),
    cloudSupport('localStdioMcps', 'not_supported', 'Cloud workspaces do not execute arbitrary local stdio MCPs.'),
    cloudSupport('machineRuntimeConfig', 'not_supported', 'Cloud workspaces do not use machine-native runtime config.'),
    cloudSupport('voice.capture', 'not_supported', 'Private realtime voice is Desktop Local only. Cloud workspaces do not capture microphone audio on this machine.'),
    cloudSupport('voice.stt', 'not_supported', 'On-device speech-to-text (Aurum) is Desktop Local only.'),
    cloudSupport('voice.tts', 'not_supported', 'Private text-to-speech is Desktop Local only.'),
    cloudSupport('voice.conversation', 'not_supported', 'Voice conversation is Desktop Local only.'),
  ]
}

export function workspaceSupportMatrix(
  workspace: WorkspaceRegistration,
  cloudPolicy: WorkspacePolicy = DISABLED_CLOUD_POLICY,
): WorkspaceApiSupport[] {
  if (workspace.kind === 'local') {
    return WORKSPACE_SUPPORT_APIS.map((api) => ({
      api,
      ...localSupportForApi(api, workspace.status),
    }))
  }
  if (workspace.kind === 'gateway') {
    return remoteSupportMatrix({
      authority: 'gateway_standalone',
      surface: 'gateway_standalone',
      workspace,
      deferredReason: 'Desktop Gateway sessions are deferred until Standalone Gateway exposes a Desktop-safe session and projection API.',
      pathReason: 'Gateway workspaces do not expose private Gateway host paths to Desktop.',
      workflowReason: 'Gateway workflow control from Desktop is deferred until the Standalone Gateway API is available.',
      artifactReason: 'Gateway artifact browsing from Desktop is deferred until the Standalone Gateway artifact API is available.',
      settingsReason: 'Gateway runtime settings stay owned by the Standalone Gateway deployment.',
      customContentReason: 'Gateway custom content stays owned by the Standalone Gateway deployment.',
      capabilitiesReason: 'Gateway capability catalog sync is deferred until the Standalone Gateway API is available.',
    })
  }
  if (workspace.kind === 'paired_desktop') {
    const pairingReason = workspace.status === 'online'
      ? 'Paired Desktop workspace browsing is deferred until the edge registration API is available.'
      : 'Paired Desktop connector is offline or disabled.'
    return remoteSupportMatrix({
      authority: 'desktop_paired',
      surface: 'desktop_paired',
      workspace,
      deferredReason: pairingReason,
      pathReason: 'Paired Desktop workspaces redact local paths from remote surfaces by default.',
      workflowReason: 'Paired Desktop workflow control is deferred until pairing workflow policy exists.',
      artifactReason: 'Paired Desktop exposes redacted artifact metadata only until artifact-body policy is explicit.',
      settingsReason: 'Paired Desktop settings remain local to the owning Desktop.',
      customContentReason: 'Paired Desktop custom content remains local to the owning Desktop.',
      capabilitiesReason: 'Paired Desktop capability sync is deferred until remote projection policy exists.',
    })
  }
  return cloudSupportMatrix(workspace, cloudPolicy)
}
