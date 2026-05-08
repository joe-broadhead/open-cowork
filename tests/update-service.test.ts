import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getUpdateInstallCapability } from '../apps/desktop/src/main/update-service.ts'

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
  })
})

test('update install capability is macOS-only for the first signed installer phase', async () => {
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
  })
})

test('update install capability reads signed feed eligibility from packaged resources', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-update-service-'))
  try {
    const markerPath = join(root, 'open-cowork-update-capability.json')
    writeFileSync(markerPath, `${JSON.stringify({
      schemaVersion: 1,
      signedInstallEligible: true,
      feedConfigured: true,
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
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('update install capability ignores malformed packaged resource markers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-update-service-'))
  try {
    const markerPath = join(root, 'open-cowork-update-capability.json')
    writeFileSync(markerPath, '{"schemaVersion":2,"signedInstallEligible":true,"feedConfigured":true}\n')

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
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
