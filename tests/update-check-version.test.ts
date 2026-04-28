import assert from 'node:assert/strict'
import test from 'node:test'
import { checkForUpdates, compareVersions } from '../apps/desktop/src/main/update-check.ts'

async function withMockedFetch<T>(mock: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await fn()
  } finally {
    globalThis.fetch = previous
  }
}

test('compareVersions treats v-prefixed and bare versions identically', () => {
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('V2.0.0', 'v2.0.0'), 0)
})

test('compareVersions orders semver core numerically', () => {
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1)
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1, 'handles double-digit minor')
  assert.equal(compareVersions('1.10.0', '1.9.0-rc.1'), 1, 'handles double-digit minor against prerelease')
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1)
})

test('compareVersions follows semver prerelease ordering', () => {
  assert.equal(compareVersions('0.2.0', '0.2.0-rc.1'), 1)
  assert.equal(compareVersions('0.2.0-rc.2', '0.2.0-rc.1'), 1)
})

test('compareVersions handles missing segments gracefully', () => {
  assert.equal(compareVersions('1', '1.0.0'), 0)
  assert.equal(compareVersions('1.0', '1.0.1'), -1)
})

test('checkForUpdates reports a newer GitHub release', async () => {
  await withMockedFetch(async (input) => {
    assert.equal(
      String(input),
      'https://api.github.com/repos/joe-broadhead/open-cowork/releases/latest',
    )
    return new Response(JSON.stringify({
      tag_name: 'v0.0.1',
      html_url: 'https://github.com/joe-broadhead/open-cowork/releases/tag/v0.0.1',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }, async () => {
    assert.deepEqual(await checkForUpdates(), {
      status: 'ok',
      currentVersion: '0.0.0',
      latestVersion: '0.0.1',
      hasUpdate: true,
      releaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases/tag/v0.0.1',
    })
  })
})

test('checkForUpdates still reports the current version when the network fails', async () => {
  await withMockedFetch(async () => {
    throw new Error('offline')
  }, async () => {
    assert.deepEqual(await checkForUpdates(), {
      status: 'error',
      currentVersion: '0.0.0',
      message: 'offline',
    })
  })
})
