import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CustomMcpConfig } from '../packages/shared/src/index.ts'
import type { AppSettings } from '../packages/shared/src/index.ts'
import { listReadyGoogleAuthLocalMcpNames, resolveCustomMcpRuntimeEntry } from '../apps/desktop/src/main/runtime-mcp.ts'
import { clearConfigCaches, type BundleMcp } from '../apps/desktop/src/main/config-loader.ts'

const BASE_SETTINGS: AppSettings = {
  selectedProviderId: null,
  selectedModelId: null,
  providerCredentials: {},
  integrationCredentials: {},
  integrationEnabled: {},
  enableBash: false,
  enableFileWrite: false,
  runtimeToolingBridgeEnabled: true,
  automationLaunchAtLogin: false,
  automationRunInBackground: false,
  automationDesktopNotifications: true,
  automationQuietHoursStart: '22:00',
  automationQuietHoursEnd: '07:00',
  defaultAutomationAutonomyPolicy: 'review-first',
  defaultAutomationExecutionMode: 'planning_only',
}

function makeStdioMcp(overrides: Partial<CustomMcpConfig> = {}): CustomMcpConfig {
  return {
    scope: 'machine',
    directory: null,
    name: 'sheets',
    type: 'stdio',
    command: 'node',
    args: ['/tmp/sheets-mcp.js'],
    ...overrides,
  }
}

test('resolveCustomMcpRuntimeEntry does NOT inject Google creds when googleAuth is false / unset', () => {
  // Default case: nothing in env related to Google, regardless of whether
  // the user is signed in. Prevents arbitrary MCPs from ever seeing the
  // app-level Google access token.
  const entry = resolveCustomMcpRuntimeEntry(makeStdioMcp({ googleAuth: false }))
  assert.ok(entry && entry.type === 'local')
  if (entry?.type !== 'local') return
  assert.equal(entry.environment?.GOOGLE_APPLICATION_CREDENTIALS, undefined)

  const entryUnset = resolveCustomMcpRuntimeEntry(makeStdioMcp({}))
  assert.ok(entryUnset && entryUnset.type === 'local')
  if (entryUnset?.type !== 'local') return
  assert.equal(entryUnset.environment?.GOOGLE_APPLICATION_CREDENTIALS, undefined)
})

test('resolveCustomMcpRuntimeEntry does NOT inject Google creds when googleAuth=true but no Google auth session', () => {
  // auth.mode defaults to 'none' in the test config, so even with the
  // opt-in flag the MCP spawns without the env var. This is the
  // graceful-degradation path — downstream forks that haven't enabled
  // Google OAuth (or users who haven't signed in yet) get no injection.
  const entry = resolveCustomMcpRuntimeEntry(makeStdioMcp({ googleAuth: true }))
  assert.ok(entry && entry.type === 'local')
  if (entry?.type !== 'local') return
  assert.equal(entry.environment?.GOOGLE_APPLICATION_CREDENTIALS, undefined)
})

test('resolveCustomMcpRuntimeEntry injects GOOGLE_APPLICATION_CREDENTIALS when googleAuth + active Google auth', () => {
  // Simulate a downstream distribution with google-oauth configured and
  // a user who has signed in: ADC file present on disk under the app
  // data dir. The env injection should point the subprocess at that file
  // so google-auth / googleapis / gcloud find it automatically.
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-google-auth-'))
  const configDir = join(tempRoot, 'downstream')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR

  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), `{
  "allowedEnvPlaceholders": [],
  "auth": {
    "mode": "google-oauth",
    "googleOAuth": {
      "clientId": "test-client-id.apps.googleusercontent.com",
      "clientSecret": "test-secret"
    }
  }
}`)

  // getAppDataDir() resolves to `electronApp.getPath('userData')` in
  // Electron, but in node:test it falls back to `join(cwd, '.open-cowork-test')`.
  // Seed the ADC file there so `getAdcPathIfAvailable()` finds it.
  const adcDir = join(process.cwd(), '.open-cowork-test')
  mkdirSync(adcDir, { recursive: true })
  const adcPath = join(adcDir, 'application_default_credentials.json')
  writeFileSync(adcPath, JSON.stringify({
    client_id: 'test-client-id.apps.googleusercontent.com',
    client_secret: 'test-secret',
    refresh_token: 'test-refresh',
    type: 'authorized_user',
  }))

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  clearConfigCaches()

  try {
    const entry = resolveCustomMcpRuntimeEntry(makeStdioMcp({ googleAuth: true }))
    assert.ok(entry && entry.type === 'local', 'expected a local MCP entry')
    if (entry?.type !== 'local') return
    assert.equal(
      entry.environment?.GOOGLE_APPLICATION_CREDENTIALS,
      adcPath,
      'env should point subprocess at the ADC file',
    )
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
    rmSync(adcPath, { force: true })
  }
})

test('resolveCustomMcpRuntimeEntry resolves project-relative stdio commands against the selected project directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'opencowork-project-mcp-'))
  const scriptPath = join(root, 'bin', 'server.js')

  try {
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(scriptPath, 'process.stdout.write("ok")', { flag: 'w' })

    const entry = resolveCustomMcpRuntimeEntry(makeStdioMcp({
      scope: 'project',
      directory: root,
      command: './bin/server.js',
      args: ['--stdio'],
    }))

    assert.ok(entry && entry.type === 'local', 'expected a local MCP entry')
    if (entry?.type !== 'local') return
    assert.deepEqual(entry.command, [scriptPath, '--stdio'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listReadyGoogleAuthLocalMcpNames includes only ready local Google-auth MCPs', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-google-auth-list-'))
  const configDir = join(tempRoot, 'downstream')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR

  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), `{
  "allowedEnvPlaceholders": [],
  "auth": {
    "mode": "google-oauth",
    "googleOAuth": {
      "clientId": "test-client-id.apps.googleusercontent.com",
      "clientSecret": "test-secret"
    }
  }
}`)

  const adcDir = join(process.cwd(), '.open-cowork-test')
  mkdirSync(adcDir, { recursive: true })
  const adcPath = join(adcDir, 'application_default_credentials.json')
  writeFileSync(adcPath, JSON.stringify({
    client_id: 'test-client-id.apps.googleusercontent.com',
    client_secret: 'test-secret',
    refresh_token: 'test-refresh',
    type: 'authorized_user',
  }))

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  clearConfigCaches()

  try {
    const builtinMcps: BundleMcp[] = [
      {
        name: 'google-sheets',
        type: 'local',
        description: 'Sheets',
        authMode: 'none',
        command: ['node', '/tmp/sheets.js'],
        googleAuth: true,
      },
      {
        name: 'charts',
        type: 'local',
        description: 'Charts',
        authMode: 'none',
        command: ['node', '/tmp/charts.js'],
      },
      {
        name: 'atlassian',
        type: 'remote',
        description: 'Atlassian',
        authMode: 'oauth',
        url: 'https://example.com/mcp',
        googleAuth: true,
      },
    ]
    const customMcps: CustomMcpConfig[] = [
      makeStdioMcp({ name: 'workspace-sheets', googleAuth: true }),
      { ...makeStdioMcp({ name: 'workspace-http', googleAuth: true }), type: 'http', url: 'https://example.com/mcp' },
      makeStdioMcp({ name: 'plain-stdio', googleAuth: false }),
    ]

    const names = listReadyGoogleAuthLocalMcpNames({
      builtinMcps,
      customMcps,
      settings: BASE_SETTINGS,
    })

    assert.deepEqual(names, ['google-sheets', 'workspace-sheets'])
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
    rmSync(adcPath, { force: true })
  }
})
