import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAIN_DIR = join(process.cwd(), 'apps/desktop/src/main')

const EXPECTED_DOMAIN_FOLDERS = [
  'desktop-pairing',
  'ipc',
  'update',
  'workflow',
]

const ALLOWED_TOP_LEVEL_TYPESCRIPT = [
  'app-menu.ts',
  'app-protocol-schemes.ts',
  'app-reset.ts',
  'artifact-attachments.ts',
  'artifact-path-policy.ts',
  'branding-protocol.ts',
  'built-in-agent-details.ts',
  'capability-tool-discovery.ts',
  'chart-artifact-access.ts',
  'chart-artifacts.ts',
  'chart-frame-assets.ts',
  'chart-renderer.ts',
  'chart-spec-safety.ts',
  'cloud-subscription-manager.ts',
  'cloud-workspace-adapter.ts',
  'cloud-workspace-auth.ts',
  'cloud-workspace-cache.ts',
  'cloud-workspace-credentials.ts',
  'cloud-workspace-registry.ts',
  'content-security-policy.ts',
  'custom-skill-integrity.ts',
  'desktop-electron-hosts.ts',
  'destructive-actions.ts',
  'diagnostics-export.ts',
  'directory-grants.ts',
  'event-message-handlers.ts',
  'event-runtime-handlers.ts',
  'event-subscriptions.ts',
  'event-task-run-dispatch.ts',
  'event-task-state.ts',
  'event-task-timing.ts',
  'events.ts',
  'explorer-normalizers.ts',
  'gateway-workspace-adapter.ts',
  'gateway-workspace-credentials.ts',
  'gateway-workspace-registry.ts',
  'headless-host.ts',
  'index.ts',
  'ipc-artifact-access.ts',
  'ipc-handlers.ts',
  'ipc-runtime-context.ts',
  'keyed-serializer.ts',
  'main-window-controller.ts',
  'main-window-lifecycle.ts',
  'main-window-security.ts',
  'mcp-preflight.ts',
  'native-confirmation.ts',
  'opencode-compatibility.ts',
  'permission-inheritance.ts',
  'permission-tracker.ts',
  'pricing.ts',
  'project-registry.ts',
  'project-source-snapshot.ts',
  'promise-chain.ts',
  'question-normalization.ts',
  'queue-map.ts',
  'runtime-initialization.ts',
  'runtime-input-diagnostics.ts',
  'runtime-mcp-recovery.ts',
  'runtime-mcp-status-polling.ts',
  'runtime-reconnect-policy.ts',
  'sandbox-storage.ts',
  'semantic-ui-local-actions.ts',
  'semver.d.ts',
  'session-artifact-access.ts',
  'session-import.ts',
  'session-status-coordinator.ts',
  'session-status-reconciler.ts',
  'session-task-state-store.ts',
  'startup-splash.ts',
  'window-state.ts',
  'window-zoom.ts',
  'workspace-gateway-cloud-artifacts.ts',
  'workspace-gateway-cloud-sessions.ts',
  'workspace-gateway-cloud-threads.ts',
  'workspace-gateway-cloud-workflows.ts',
  'workspace-gateway.ts',
]

function listDomainFolders() {
  return readdirSync(MAIN_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

function listTopLevelTypescript() {
  return readdirSync(MAIN_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

test('desktop main-process domain folders stay reflected in the source map', () => {
  assert.deepEqual(listDomainFolders(), EXPECTED_DOMAIN_FOLDERS)

  const readme = readFileSync(join(MAIN_DIR, 'README.md'), 'utf8')
  for (const folder of EXPECTED_DOMAIN_FOLDERS) {
    assert.match(readme, new RegExp(`\`${folder}/\``), `${folder}/ must be described in the source map`)
  }
  assert.doesNotMatch(readme, /`thread-index\/`/, 'thread-index moved to runtime-host and must not be listed as a desktop main folder')
})

test('desktop main-process top-level TypeScript files require an explicit source-map exception', () => {
  assert.deepEqual(listTopLevelTypescript(), ALLOWED_TOP_LEVEL_TYPESCRIPT)
})
