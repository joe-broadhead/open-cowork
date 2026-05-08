import assert from 'node:assert/strict'
import test from 'node:test'
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
