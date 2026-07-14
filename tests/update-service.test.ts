import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { UpdateInstallEvent } from '../packages/shared/src/index.ts'
import {
  checkInstallableUpdate,
  downloadInstallableUpdate,
  getUpdateInstallCapability,
  quitAndInstallUpdate,
  resetUpdateInstallServiceForTests,
  subscribeUpdateInstallEvents,
} from '../apps/desktop/src/main/update/update-service.ts'

type MockUpdateInfo = { version: string }
type MockUpdateCheckResult = {
  isUpdateAvailable: boolean
  updateInfo: MockUpdateInfo
  versionInfo: MockUpdateInfo
}

class MockUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  requestHeaders: Record<string, string> | null = null
  feedOptions: Record<string, unknown> | null = null
  logger: unknown = null
  checkCalls = 0
  downloadCalls = 0
  quitCalls: Array<{ isSilent?: boolean; isForceRunAfter?: boolean }> = []
  private readonly checkResult: MockUpdateCheckResult | null

  constructor(checkResult: MockUpdateCheckResult | null) {
    super()
    this.checkResult = checkResult
  }

  async checkForUpdates() {
    this.checkCalls += 1
    this.emit('checking-for-update')
    return this.checkResult
  }

  async downloadUpdate() {
    this.downloadCalls += 1
    this.emit('download-progress', {
      percent: 50,
      transferred: 512,
      total: 1024,
      bytesPerSecond: 2048,
    })
    this.emit('update-downloaded', this.checkResult?.updateInfo || { version: '1.2.4' })
    return ['/tmp/open-cowork-update.zip']
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
    this.quitCalls.push({ isSilent, isForceRunAfter })
  }

  setFeedURL(options: Record<string, unknown>) {
    this.feedOptions = options
  }
}

const githubReleaseSource = {
  kind: 'github-releases' as const,
  label: 'GitHub Releases',
  channel: 'latest',
  requiresAuth: false,
  authKind: 'none' as const,
}

function availableResult(version = '1.2.4'): MockUpdateCheckResult {
  const updateInfo = { version }
  return {
    isUpdateAvailable: true,
    updateInfo,
    versionInfo: updateInfo,
  }
}

function currentResult(version = '1.2.3'): MockUpdateCheckResult {
  const updateInfo = { version }
  return {
    isUpdateAvailable: false,
    updateInfo,
    versionInfo: updateInfo,
  }
}

function supportedOptions(updater: MockUpdater) {
  return {
    updater,
    isPackaged: true,
    platform: 'darwin' as const,
    signedInstallEligible: true,
    feedConfigured: true,
    currentVersion: '1.2.3',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
  }
}

function captureEvents() {
  const events: UpdateInstallEvent[] = []
  subscribeUpdateInstallEvents((event) => events.push(event))
  return events
}

test('update install capability disables install while running from source', async () => {
  assert.deepEqual(await getUpdateInstallCapability({
    isPackaged: false,
    platform: 'darwin',
    signedInstallEligible: true,
    feedConfigured: true,
    currentVersion: '1.2.3',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
  }), {
    supported: false,
    reason: 'dev',
    currentVersion: '1.2.3',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
    releaseSource: githubReleaseSource,
  })
})

test('update install capability keeps Linux on the verified manual-download path', async () => {
  assert.deepEqual(await getUpdateInstallCapability({
    isPackaged: true,
    platform: 'linux',
    signedInstallEligible: true,
    feedConfigured: true,
    currentVersion: '1.2.3',
    manualReleaseUrl: null,
  }), {
    supported: false,
    reason: 'platform',
    currentVersion: '1.2.3',
    manualReleaseUrl: null,
    releaseSource: githubReleaseSource,
  })
})

test('update install capability supports signed packaged Windows builds with feed metadata', async () => {
  assert.deepEqual(await getUpdateInstallCapability({
    isPackaged: true,
    platform: 'win32',
    signedInstallEligible: true,
    feedConfigured: true,
    currentVersion: '1.2.3',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
  }), {
    supported: true,
    currentVersion: '1.2.3',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
    releaseSource: githubReleaseSource,
  })
})

test('update install capability rejects unsigned packaged Windows builds', async () => {
  assert.deepEqual(await getUpdateInstallCapability({
    isPackaged: true,
    platform: 'win32',
    signedInstallEligible: false,
    feedConfigured: true,
    currentVersion: '1.2.3',
    manualReleaseUrl: null,
  }), {
    supported: false,
    reason: 'unsigned',
    currentVersion: '1.2.3',
    manualReleaseUrl: null,
    releaseSource: githubReleaseSource,
  })
})

test('update install capability rejects unsigned packaged macOS builds', async () => {
  assert.deepEqual(await getUpdateInstallCapability({
    isPackaged: true,
    platform: 'darwin',
    signedInstallEligible: false,
    feedConfigured: true,
    currentVersion: '1.2.3',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
  }), {
    supported: false,
    reason: 'unsigned',
    currentVersion: '1.2.3',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
    releaseSource: githubReleaseSource,
  })
})

test('update install capability requires feed metadata after signing is eligible', async () => {
  assert.deepEqual(await getUpdateInstallCapability({
    isPackaged: true,
    platform: 'darwin',
    signedInstallEligible: true,
    feedConfigured: false,
    currentVersion: '1.2.3',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
  }), {
    supported: false,
    reason: 'missing-feed',
    currentVersion: '1.2.3',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
    releaseSource: githubReleaseSource,
  })
})

test('update install capability reports supported only for signed packaged macOS builds with feed metadata', async () => {
  assert.deepEqual(await getUpdateInstallCapability({
    isPackaged: true,
    platform: 'darwin',
    signedInstallEligible: true,
    feedConfigured: true,
    currentVersion: '1.2.3',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
  }), {
    supported: true,
    currentVersion: '1.2.3',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
    releaseSource: githubReleaseSource,
  })
})

test('update install capability reads signed feed eligibility from packaged resources', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-update-service-'))
  try {
    const markerPath = join(root, 'open-cowork-update-capability.json')
    writeFileSync(markerPath, `${JSON.stringify({
      schemaVersion: 2,
      signedInstallEligible: true,
      feedConfigured: true,
      releaseSourceKind: 'github-releases',
      channel: 'latest',
    })}\n`)

    assert.deepEqual(await getUpdateInstallCapability({
      isPackaged: true,
      platform: 'darwin',
      currentVersion: '1.2.3',
      manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
      resourcePath: markerPath,
    }), {
      supported: true,
      currentVersion: '1.2.3',
      manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
      releaseSource: githubReleaseSource,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('update install capability ignores malformed packaged resource markers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-update-service-'))
  try {
    const markerPath = join(root, 'open-cowork-update-capability.json')
    writeFileSync(markerPath, '{"schemaVersion":999,"signedInstallEligible":true,"feedConfigured":true}\n')

    assert.deepEqual(await getUpdateInstallCapability({
      isPackaged: true,
      platform: 'darwin',
      currentVersion: '1.2.3',
      manualReleaseUrl: null,
      resourcePath: markerPath,
    }), {
      supported: false,
      reason: 'unsigned',
      currentVersion: '1.2.3',
      manualReleaseUrl: null,
      releaseSource: githubReleaseSource,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('update install capability rejects obsolete schema-v1 resource markers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-update-service-'))
  try {
    const markerPath = join(root, 'open-cowork-update-capability.json')
    writeFileSync(markerPath, '{"schemaVersion":1,"signedInstallEligible":true,"feedConfigured":true}\n')

    assert.deepEqual(await getUpdateInstallCapability({
      isPackaged: true,
      platform: 'darwin',
      currentVersion: '1.2.3',
      manualReleaseUrl: null,
      resourcePath: markerPath,
    }), {
      supported: false,
      reason: 'unsigned',
      currentVersion: '1.2.3',
      manualReleaseUrl: null,
      releaseSource: githubReleaseSource,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installable update check reports available state without downloading', async () => {
  resetUpdateInstallServiceForTests()
  const updater = new MockUpdater(availableResult())
  const events = captureEvents()

  assert.deepEqual(await checkInstallableUpdate(supportedOptions(updater)), {
    status: 'available',
    currentVersion: '1.2.3',
    latestVersion: '1.2.4',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
  })
  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.deepEqual(updater.feedOptions, {
    provider: 'github',
    owner: 'joe-broadhead',
    repo: 'open-cowork',
    channel: 'latest',
  })
  assert.equal(updater.checkCalls, 1)
  assert.equal(updater.downloadCalls, 0)
  assert.deepEqual(events.map((event) => event.status), ['checking', 'available'])
})

test('installable update check reports current state when no update exists', async () => {
  resetUpdateInstallServiceForTests()
  const updater = new MockUpdater(currentResult())
  const events = captureEvents()

  assert.deepEqual(await checkInstallableUpdate(supportedOptions(updater)), {
    status: 'not-available',
    currentVersion: '1.2.3',
    latestVersion: '1.2.3',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
  })
  assert.deepEqual(events.map((event) => event.status), ['checking', 'not-available'])
})

test('download rejects unsupported builds before touching the updater', async () => {
  resetUpdateInstallServiceForTests()
  const updater = new MockUpdater(availableResult())
  const events = captureEvents()

  await assert.rejects(() => downloadInstallableUpdate({
    updater,
    isPackaged: false,
    platform: 'darwin',
    signedInstallEligible: true,
    feedConfigured: true,
    currentVersion: '1.2.3',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
  }), /not available/)
  assert.equal(updater.checkCalls, 0)
  assert.equal(updater.downloadCalls, 0)
  assert.deepEqual(events, [{
    status: 'unsupported',
    reason: 'dev',
    currentVersion: '1.2.3',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
  }])
})

test('download emits bounded progress and downloaded state after explicit action', async () => {
  resetUpdateInstallServiceForTests()
  const updater = new MockUpdater(availableResult())
  const events = captureEvents()

  assert.deepEqual(await downloadInstallableUpdate(supportedOptions(updater)), {
    status: 'downloaded',
    currentVersion: '1.2.3',
    latestVersion: '1.2.4',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
  })
  assert.equal(updater.checkCalls, 1)
  assert.equal(updater.downloadCalls, 1)
  assert.deepEqual(events.map((event) => event.status), ['checking', 'available', 'downloading', 'downloaded'])
  assert.deepEqual(events.find((event) => event.status === 'downloading'), {
    status: 'downloading',
    currentVersion: '1.2.3',
    latestVersion: '1.2.4',
    progress: {
      percent: 50,
      transferred: 512,
      total: 1024,
      bytesPerSecond: 2048,
    },
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
  })
})

test('quit and install requires a previously downloaded update', async () => {
  resetUpdateInstallServiceForTests()
  const updater = new MockUpdater(availableResult())

  await assert.rejects(() => quitAndInstallUpdate(supportedOptions(updater)), /No downloaded update/)
  await downloadInstallableUpdate(supportedOptions(updater))

  assert.deepEqual(await quitAndInstallUpdate(supportedOptions(updater)), {
    status: 'installing',
    currentVersion: '1.2.3',
    latestVersion: '1.2.4',
    manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
  })
  assert.deepEqual(updater.quitCalls, [{ isSilent: false, isForceRunAfter: true }])
})
