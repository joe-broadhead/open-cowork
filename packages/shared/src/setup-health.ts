import type {
  WorkspaceExecutionAuthority,
  WorkspaceProductSurface,
} from './workspace.js'

export const SETUP_INTENT_IDS = [
  'desktop-local',
  'gateway-only',
  'cloud-connect',
  'desktop-pairing',
  'full-hybrid',
] as const

export type SetupIntentId = typeof SETUP_INTENT_IDS[number]

export const SETUP_HEALTH_STATUSES = [
  'ready',
  'action_required',
  'degraded',
  'offline',
  'unknown',
] as const

export type SetupHealthStatus = typeof SETUP_HEALTH_STATUSES[number]

export const SETUP_HEALTH_CHECK_IDS = [
  'desktop.runtime.ready',
  'desktop.credentials.configured',
  'workspace.authority.declared',
  'workspace.cloud.authenticated',
  'workspace.cloud.sync.reachable',
  'gateway.private_opencode.reachable',
  'gateway.provider.healthy',
  'gateway.operator_auth.configured',
  'cloud.database.migrated',
  'cloud.object_store.configured',
  'cloud.backup_posture.configured',
  'pairing.connection.active',
  'pairing.remote_policy.scoped',
] as const

export type SetupHealthCheckId = typeof SETUP_HEALTH_CHECK_IDS[number]

export type SetupIntent = {
  id: SetupIntentId
  label: string
  summary: string
  authority: WorkspaceExecutionAuthority | 'mixed'
  surfaces: WorkspaceProductSurface[]
  topologyProfile: string
  primaryDocs: string
  primaryCommand: string | null
  validationCommands: string[]
  readyWhen: SetupHealthCheckId[]
  nextActions: string[]
}

export type SetupHealthCheckSpec = {
  id: SetupHealthCheckId
  label: string
  authority: WorkspaceExecutionAuthority | 'mixed'
  severityWhenMissing: Exclude<SetupHealthStatus, 'ready'>
  recoveryAction: string
  docs: string[]
}

export const SETUP_INTENTS: SetupIntent[] = [
  {
    id: 'desktop-local',
    label: 'Run Desktop locally',
    summary: 'Use Desktop with local OpenCode execution, local projects, and local credentials.',
    authority: 'desktop_local',
    surfaces: ['desktop_local'],
    topologyProfile: 'desktop-only',
    primaryDocs: 'docs/desktop-app.md',
    primaryCommand: null,
    validationCommands: ['pnpm test:e2e'],
    readyWhen: [
      'desktop.runtime.ready',
      'desktop.credentials.configured',
      'workspace.authority.declared',
    ],
    nextActions: [
      'Select a provider and model in first-run setup.',
      'Keep local project paths private unless you explicitly copy a session to Cloud.',
    ],
  },
  {
    id: 'gateway-only',
    label: 'Deploy Gateway',
    summary: 'Run a standalone Gateway on a private server with its own private OpenCode and Gateway Postgres.',
    authority: 'gateway_standalone',
    surfaces: ['gateway_standalone'],
    topologyProfile: 'gateway-only',
    primaryDocs: 'docs/standalone-gateway.md',
    primaryCommand: 'pnpm standalone-gateway:setup',
    validationCommands: [
      'pnpm deploy:standalone-gateway:validate',
      'pnpm deploy:standalone-gateway:smoke',
    ],
    readyWhen: [
      'gateway.private_opencode.reachable',
      'gateway.provider.healthy',
      'gateway.operator_auth.configured',
    ],
    nextActions: [
      'Generate a private env file with the setup script and keep it out of git.',
      'Run the standalone doctor before routing channel traffic.',
    ],
  },
  {
    id: 'cloud-connect',
    label: 'Connect Cloud',
    summary: 'Use Desktop with an authenticated Open Cowork Cloud workspace that also syncs with Cloud Web.',
    authority: 'cloud_worker',
    surfaces: ['desktop_cloud', 'cloud_web'],
    topologyProfile: 'cloud-only',
    primaryDocs: 'docs/open-cowork-cloud.md',
    primaryCommand: 'pnpm deploy:validate',
    validationCommands: [
      'pnpm deploy:validate',
      'pnpm ops:validate',
      'pnpm test:cloud-web',
    ],
    readyWhen: [
      'workspace.cloud.authenticated',
      'workspace.cloud.sync.reachable',
      'cloud.database.migrated',
      'cloud.object_store.configured',
    ],
    nextActions: [
      'Sign in to the configured Cloud org from Desktop or Cloud Web.',
      'Confirm /readyz before inviting users.',
    ],
  },
  {
    id: 'desktop-pairing',
    label: 'Pair Desktop',
    summary: 'Opt a Desktop into outbound remote access without exposing a Desktop or OpenCode listener.',
    authority: 'desktop_paired',
    surfaces: ['desktop_paired'],
    topologyProfile: 'desktop-gateway',
    primaryDocs: 'docs/desktop-outbound-pairing.md',
    primaryCommand: null,
    validationCommands: [
      'pnpm test:e2e',
      'pnpm deploy:validate',
    ],
    readyWhen: [
      'pairing.connection.active',
      'pairing.remote_policy.scoped',
      'desktop.runtime.ready',
    ],
    nextActions: [
      'Create a scoped pairing from Settings.',
      'Keep remote approvals on local confirmation unless policy explicitly allows remote approval.',
    ],
  },
  {
    id: 'full-hybrid',
    label: 'Connect all surfaces',
    summary: 'Run Desktop, Cloud Web, Cloud Channel Gateway, and optional standalone or paired authorities together.',
    authority: 'mixed',
    surfaces: ['desktop_local', 'desktop_cloud', 'cloud_web', 'cloud_channel_gateway', 'gateway_standalone', 'desktop_paired'],
    topologyProfile: 'full-hybrid',
    primaryDocs: 'docs/deployment-topologies.md',
    primaryCommand: 'pnpm deploy:launch:validate',
    validationCommands: [
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test',
      'pnpm deploy:validate',
      'pnpm ops:validate',
      'pnpm test:cloud-continuation',
    ],
    readyWhen: [
      'workspace.authority.declared',
      'workspace.cloud.sync.reachable',
      'gateway.provider.healthy',
      'cloud.backup_posture.configured',
      'pairing.remote_policy.scoped',
    ],
    nextActions: [
      'Bring up each smaller topology first.',
      'Verify one execution authority per thread before enabling cross-surface workflows.',
    ],
  },
]

export const SETUP_HEALTH_CHECKS: SetupHealthCheckSpec[] = [
  {
    id: 'desktop.runtime.ready',
    label: 'Desktop runtime ready',
    authority: 'desktop_local',
    severityWhenMissing: 'action_required',
    recoveryAction: 'Restart the runtime and verify provider credentials.',
    docs: ['docs/desktop-app.md', 'docs/security-model.md'],
  },
  {
    id: 'desktop.credentials.configured',
    label: 'Desktop provider credentials configured',
    authority: 'desktop_local',
    severityWhenMissing: 'action_required',
    recoveryAction: 'Open first-run setup or Settings -> Models and configure a provider.',
    docs: ['docs/getting-started.md', 'docs/desktop-app.md'],
  },
  {
    id: 'workspace.authority.declared',
    label: 'Workspace authority declared',
    authority: 'mixed',
    severityWhenMissing: 'degraded',
    recoveryAction: 'Choose a topology and keep one execution authority per thread.',
    docs: ['docs/deployment-topologies.md', 'docs/hybrid-security-gates.md'],
  },
  {
    id: 'workspace.cloud.authenticated',
    label: 'Cloud workspace authenticated',
    authority: 'cloud_worker',
    severityWhenMissing: 'action_required',
    recoveryAction: 'Sign in to the Cloud org or rotate the desktop API token.',
    docs: ['docs/cloud-client.md', 'docs/open-cowork-cloud.md'],
  },
  {
    id: 'workspace.cloud.sync.reachable',
    label: 'Cloud sync reachable',
    authority: 'cloud_worker',
    severityWhenMissing: 'offline',
    recoveryAction: 'Check Cloud URL, network, bearer token, and /readyz.',
    docs: ['docs/deployment-readiness.md', 'docs/cloud-web-workbench.md'],
  },
  {
    id: 'gateway.private_opencode.reachable',
    label: 'Gateway private OpenCode reachable',
    authority: 'gateway_standalone',
    severityWhenMissing: 'action_required',
    recoveryAction: 'Run the standalone doctor and keep OpenCode loopback or private.',
    docs: ['docs/standalone-gateway.md', 'deploy/standalone-gateway/README.md'],
  },
  {
    id: 'gateway.provider.healthy',
    label: 'Gateway provider healthy',
    authority: 'gateway_standalone',
    severityWhenMissing: 'degraded',
    recoveryAction: 'Check provider token, signing secret, webhook URL, and provider readiness.',
    docs: ['docs/gateway-provider-readiness.md', 'docs/gateway-appliance.md'],
  },
  {
    id: 'gateway.operator_auth.configured',
    label: 'Gateway operator auth configured',
    authority: 'gateway_standalone',
    severityWhenMissing: 'action_required',
    recoveryAction: 'Set an admin token before exposing health, readiness, diagnostics, metrics, or delivery controls.',
    docs: ['docs/gateway-appliance.md', 'docs/hybrid-security-gates.md'],
  },
  {
    id: 'cloud.database.migrated',
    label: 'Cloud database migrated',
    authority: 'cloud_worker',
    severityWhenMissing: 'action_required',
    recoveryAction: 'Run deployment validation and confirm Postgres migrations before routing traffic.',
    docs: ['docs/deployment-readiness.md', 'docs/runbooks/backup-restore.md'],
  },
  {
    id: 'cloud.object_store.configured',
    label: 'Cloud object store configured',
    authority: 'cloud_worker',
    severityWhenMissing: 'action_required',
    recoveryAction: 'Configure provider-backed object storage for artifacts, checkpoints, and diagnostics.',
    docs: ['docs/deployment-readiness.md', 'deploy/README.md'],
  },
  {
    id: 'cloud.backup_posture.configured',
    label: 'Cloud backup posture configured',
    authority: 'cloud_worker',
    severityWhenMissing: 'degraded',
    recoveryAction: 'Complete the backup and restore runbooks and record a restore drill.',
    docs: ['docs/runbooks/backup-restore.md', 'docs/runbooks/restore-drill-report.md'],
  },
  {
    id: 'pairing.connection.active',
    label: 'Desktop pairing active',
    authority: 'desktop_paired',
    severityWhenMissing: 'offline',
    recoveryAction: 'Reconnect or revoke and recreate the pairing from Settings.',
    docs: ['docs/desktop-outbound-pairing.md'],
  },
  {
    id: 'pairing.remote_policy.scoped',
    label: 'Desktop pairing remote policy scoped',
    authority: 'desktop_paired',
    severityWhenMissing: 'action_required',
    recoveryAction: 'Keep remote approvals/questions on local confirmation unless scoped policy allows remote responses.',
    docs: ['docs/desktop-outbound-pairing.md', 'docs/hybrid-security-gates.md'],
  },
]

export function setupIntentById(id: SetupIntentId) {
  return SETUP_INTENTS.find((intent) => intent.id === id) || null
}

export function setupHealthCheckById(id: SetupHealthCheckId) {
  return SETUP_HEALTH_CHECKS.find((check) => check.id === id) || null
}
