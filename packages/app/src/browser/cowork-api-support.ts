import {
  WORKSPACE_SUPPORT_APIS,
  workspaceApiSupportContextForAuthority,
  type WorkspaceApiSupport,
  type WorkspaceApiSupportStatus,
} from '@open-cowork/shared'

export type CloudFeatureFlags = Record<string, boolean>

const BROWSER_LOCAL_ONLY_APIS = new Set<string>([
  'sessions.fileSnippet',
  'sessions.diff',
  'localFiles',
  'localStdioMcps',
  'machineRuntimeConfig',
])

function cloudFeatureEnabled(features: CloudFeatureFlags, key: string) {
  return features[key] !== false
}

function cloudFeatureForWorkspaceApi(api: string): string | null {
  if (api.startsWith('sessions.')) return 'chat'
  if (api.startsWith('workflows.')) return 'workflows'
  if (api.startsWith('artifacts.')) return 'artifacts'
  if (api.startsWith('threads.')) return 'threadIndex'
  if (api === 'settings.portable') return 'settings'
  if (api === 'customContent.agents') return 'customAgents'
  if (api === 'customContent.skills') return 'customSkills'
  if (api === 'customContent.mcps') return 'customMcps'
  return null
}

export function browserCloudWorkspaceSupport(features: CloudFeatureFlags): WorkspaceApiSupport[] {
  const cloudArtifactsEnabled = cloudFeatureEnabled(features, 'artifacts')
  const supportContext = (status: WorkspaceApiSupportStatus, reason: string | null, api: string) => {
    const verdict = { allowed: status === 'supported' || status === 'read_only', reason }
    return {
      api,
      status,
      verdict,
      context: workspaceApiSupportContextForAuthority('cloud_worker', {
        status,
        surface: 'cloud_web',
        onlineState: 'online',
        pathExposure: 'cloud_safe_refs',
        artifactBody: cloudArtifactsEnabled && status !== 'blocked_by_policy' ? 'cloud_object_store' : 'none',
        artifactReveal: 'none',
        workflows: status === 'blocked_by_policy' ? 'blocked' : undefined,
        ...(status === 'blocked_by_policy' ? { blockedReason: verdict } : {}),
      }),
    } satisfies WorkspaceApiSupport
  }

  return WORKSPACE_SUPPORT_APIS.map((api) => {
    if (BROWSER_LOCAL_ONLY_APIS.has(api) || api === 'artifacts.reveal') {
      return supportContext('not_supported', 'This browser workspace cannot access local desktop files or reveal files on this machine.', api)
    }
    if (api === 'capabilities.catalog') {
      const capabilitiesEnabled = cloudFeatureEnabled(features, 'agents')
        || cloudFeatureEnabled(features, 'customSkills')
        || cloudFeatureEnabled(features, 'customMcps')
      return capabilitiesEnabled
        ? supportContext('supported', null, api)
        : supportContext('blocked_by_policy', 'Capabilities are disabled by this cloud profile.', api)
    }
    const feature = cloudFeatureForWorkspaceApi(api)
    if (feature && !cloudFeatureEnabled(features, feature)) {
      return supportContext('blocked_by_policy', `${feature} is disabled by this cloud profile.`, api)
    }
    return supportContext('supported', null, api)
  })
}
