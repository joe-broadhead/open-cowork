import * as os from 'node:os'
import * as path from 'node:path'
import { getConfig, getConfigDir, type GatewayConfig } from './config.js'
import { serviceLogPath } from './service-logs.js'

export type ServiceLifecycleOperationId =
  | 'setup'
  | 'update'
  | 'start'
  | 'stop'
  | 'restart'
  | 'status'
  | 'health'
  | 'doctor'
  | 'logs'
  | 'backup'
  | 'restore'
  | 'incident_bundle'
  | 'cleanup'
  | 'uninstall'

export type ServiceLifecycleResultState =
  | 'supported'
  | 'read_only'
  | 'dry_run_only'
  | 'manual_required'
  | 'external_approval_required'
  | 'unsupported'

export interface ServiceLifecycleOperation {
  id: ServiceLifecycleOperationId
  label: string
  state: ServiceLifecycleResultState
  command: string
  destructive: boolean
  dryRun: boolean
  summary: string
  safeNextAction: string
  evidenceKind: 'local_command' | 'local_http' | 'local_file' | 'manual_operator'
}

export interface ServiceLifecycleTarget {
  path: string
  kind: 'config' | 'state' | 'opencode_assets' | 'service_file' | 'log' | 'release_smoke_artifact'
  owner: 'gateway' | 'opencode' | 'service_manager'
  action: 'inspect' | 'dry_run_remove' | 'manual_remove'
  safeForAgentExecution: boolean
  reason: string
}

export interface ServiceLifecyclePlan {
  schemaVersion: 1
  generatedAt: string
  resultVocabulary: ServiceLifecycleResultState[]
  operations: ServiceLifecycleOperation[]
  gatewayOwnedRoots: string[]
  cleanupTargets: ServiceLifecycleTarget[]
  uninstallTargets: ServiceLifecycleTarget[]
  destructiveExecution: 'none_planned'
  oneCommandUninstallClaimed: false
  claimEffect: 'local_beta_operations_clarity_only'
}

export function buildServiceLifecyclePlan(options: {
  config?: GatewayConfig
  configDir?: string
  stateDir?: string
  homeDir?: string
  platform?: NodeJS.Platform
  now?: Date
} = {}): ServiceLifecyclePlan {
  const config = options.config || getConfig()
  const configDir = path.resolve(options.configDir || getConfigDir())
  const stateDir = path.resolve(options.stateDir || process.env['OPENCODE_GATEWAY_STATE_DIR'] || configDir)
  const homeDir = path.resolve(options.homeDir || os.homedir())
  const platform = options.platform || process.platform
  const opencodeAssets = path.resolve(config.opencodeConfigDir || path.join(homeDir, '.config', 'opencode'))
  const logPath = serviceLogPathForPlatform(platform, homeDir)
  const serviceFile = serviceManagerFile(platform, homeDir)
  const generatedAt = (options.now || new Date()).toISOString()
  const gatewayOwnedRoots = uniqueResolved([configDir, stateDir])

  return {
    schemaVersion: 1,
    generatedAt,
    resultVocabulary: ['supported', 'read_only', 'dry_run_only', 'manual_required', 'external_approval_required', 'unsupported'],
    operations: [
      operation('setup', 'Setup', 'supported', 'opencode-gateway setup --wizard', false, false, 'Create local Gateway config, routing, state, and OpenCode assets.', 'Run from the operator shell and review generated config before exposing any service.', 'local_command'),
      operation('update', 'Update', 'supported', 'opencode-gateway update --wizard', false, false, 'Refresh config, routing, state, and OpenCode assets after pulling code.', 'Run from the operator shell after upgrade, then check status/readiness.', 'local_command'),
      operation('start', 'Start daemon', 'supported', 'opencode-gateway start', false, false, 'Start the local daemon (via the service manager when the service is installed, otherwise in the background).', 'Run status and health after start.', 'local_command'),
      operation('stop', 'Stop daemon', 'supported', 'opencode-gateway stop', false, false, 'Stop the local daemon (via launchctl/systemctl when service-managed so it stays stopped).', 'Pause or drain active work before stopping when real work is running.', 'local_command'),
      operation('restart', 'Restart daemon', 'supported', 'opencode-gateway restart', false, false, 'Stop and start the local daemon.', 'Use after config changes or dependency recovery, then inspect health.', 'local_command'),
      operation('status', 'Status', 'read_only', 'opencode-gateway status', false, false, 'Read daemon, service, queue, and session status.', 'Use first when the operator asks what Gateway is doing.', 'local_http'),
      operation('health', 'Health', 'read_only', 'opencode-gateway health --json', false, false, 'Read component health and remediation hints.', 'Follow component remediation before mutating state.', 'local_http'),
      operation('doctor', 'Doctor', 'read_only', 'opencode-gateway doctor', false, false, 'Collect local diagnostic posture without deleting state.', 'Use for support triage and keep output redacted before sharing.', 'local_command'),
      operation('logs', 'Logs', 'read_only', 'opencode-gateway logs --lines 100', false, false, 'Read recent redacted daemon/service logs.', 'Use bounded line counts and do not share unreviewed raw logs.', 'local_file'),
      operation('backup', 'Backup', 'supported', 'opencode-gateway backup create', false, false, 'Create a local Gateway state backup.', 'Verify the backup before restore or upgrade work.', 'local_command'),
      operation('restore', 'Restore/recovery', 'manual_required', 'opencode-gateway restore <verified-backup>', true, false, 'Restore is intentionally operator-driven because it mutates durable state.', 'Verify the backup, stop active daemon writers, and run from the operator shell.', 'manual_operator'),
      operation('incident_bundle', 'Incident bundle', 'supported', 'opencode-gateway evidence incident', false, false, 'Generate a redacted local support bundle.', 'Inspect the redaction manifest before sharing.', 'local_command'),
      operation('cleanup', 'Cleanup dry run', 'dry_run_only', 'opencode-gateway service lifecycle --json', true, true, 'Gateway lists cleanup targets but does not delete them from this plan.', 'Review gatewayOwnedRoots and run any removal manually from the operator shell.', 'manual_operator'),
      operation('uninstall', 'Uninstall boundary', 'manual_required', 'opencode-gateway service lifecycle --json', true, true, 'One-command uninstall is not claimed; service files, logs, state, config, and OpenCode assets need explicit operator review.', 'Remove service-manager entries and Gateway-owned roots manually only after backup and stop.', 'manual_operator'),
    ],
    gatewayOwnedRoots,
    cleanupTargets: [
      target(configDir, 'config', 'gateway', 'dry_run_remove', true, 'Gateway config directory; deletion is dry-run only in this plan.'),
      target(stateDir, 'state', 'gateway', 'dry_run_remove', true, 'Gateway state directory; backup before any manual removal.'),
    ],
    uninstallTargets: [
      target(configDir, 'config', 'gateway', 'manual_remove', false, 'Manual uninstall target; backup/review first.'),
      target(stateDir, 'state', 'gateway', 'manual_remove', false, 'Manual uninstall target; backup/review first.'),
      target(opencodeAssets, 'opencode_assets', 'opencode', 'manual_remove', false, 'OpenCode-owned assets may include non-Gateway user content; never remove automatically.'),
      target(logPath, 'log', 'service_manager', 'manual_remove', false, 'Service logs are outside Gateway state on many platforms; review before removal.'),
      ...(serviceFile ? [target(serviceFile, 'service_file', 'service_manager', 'manual_remove', false, 'Service-manager file must be unloaded/disabled by the operator before removal.')] : []),
    ],
    destructiveExecution: 'none_planned',
    oneCommandUninstallClaimed: false,
    claimEffect: 'local_beta_operations_clarity_only',
  }
}

export function formatServiceLifecyclePlan(plan: ServiceLifecyclePlan): string {
  const lines = [
    'OpenCode Gateway Service Lifecycle',
    `Generated: ${plan.generatedAt}`,
    `Claim: ${plan.claimEffect}`,
    `One-command uninstall claimed: ${plan.oneCommandUninstallClaimed ? 'yes' : 'no'}`,
    '',
    'Operations:',
    ...plan.operations.map(row => `- ${row.state}: ${row.id} - ${row.command} :: ${row.summary} Next: ${row.safeNextAction}`),
    '',
    'Gateway-owned roots:',
    ...plan.gatewayOwnedRoots.map(root => `- ${root}`),
    '',
    'Cleanup targets are dry-run only:',
    ...plan.cleanupTargets.map(row => `- ${row.action}: ${row.path} (${row.reason})`),
    '',
    'Uninstall targets require manual operator review:',
    ...plan.uninstallTargets.map(row => `- ${row.owner}: ${row.path} (${row.reason})`),
  ]
  return `${lines.join('\n')}\n`
}

function operation(
  id: ServiceLifecycleOperationId,
  label: string,
  state: ServiceLifecycleResultState,
  command: string,
  destructive: boolean,
  dryRun: boolean,
  summary: string,
  safeNextAction: string,
  evidenceKind: ServiceLifecycleOperation['evidenceKind'],
): ServiceLifecycleOperation {
  return { id, label, state, command, destructive, dryRun, summary, safeNextAction, evidenceKind }
}

function target(
  targetPath: string,
  kind: ServiceLifecycleTarget['kind'],
  owner: ServiceLifecycleTarget['owner'],
  action: ServiceLifecycleTarget['action'],
  safeForAgentExecution: boolean,
  reason: string,
): ServiceLifecycleTarget {
  return { path: path.resolve(targetPath), kind, owner, action, safeForAgentExecution, reason }
}

function serviceManagerFile(platform: NodeJS.Platform, homeDir: string): string | undefined {
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'LaunchAgents', 'com.opencode-gateway.daemon.plist')
  if (platform === 'linux') return path.join(homeDir, '.config', 'systemd', 'user', 'opencode-gateway.service')
  return undefined
}

function serviceLogPathForPlatform(platform: NodeJS.Platform, homeDir: string): string {
  if (platform === process.platform && homeDir === os.homedir()) return serviceLogPath()
  return platform === 'darwin'
    ? path.join(homeDir, 'Library', 'Logs', 'opencode-gateway.log')
    : path.join(homeDir, '.local', 'share', 'opencode-gateway.log')
}

function uniqueResolved(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean).map(item => path.resolve(item)))]
}
