import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAuthenticatedOpencodeV2ClientConfig,
  createOpencodeV2Client,
  probeOpencodeV2Health,
} from '@open-cowork/runtime-host/opencode-client-kernel'

test('buildAuthenticatedOpencodeV2ClientConfig sets Authorization and optional directory', () => {
  const config = buildAuthenticatedOpencodeV2ClientConfig(
    'http://127.0.0.1:4096',
    { authorizationHeader: 'Basic abc' },
    '/tmp/runtime',
  )
  assert.equal(config.baseUrl, 'http://127.0.0.1:4096')
  assert.equal(config.headers?.Authorization, 'Basic abc')
  assert.equal(config.directory, '/tmp/runtime')

  const withoutDir = buildAuthenticatedOpencodeV2ClientConfig(
    'http://127.0.0.1:4096',
    { authorizationHeader: 'Basic abc' },
  )
  assert.equal(withoutDir.directory, undefined)
})

test('createOpencodeV2Client returns an object from the native SDK factory', () => {
  const client = createOpencodeV2Client({ baseUrl: 'http://127.0.0.1:1' })
  assert.equal(typeof client, 'object')
  assert.ok(client)
})

test('probeOpencodeV2Health fails closed without a live health API', async () => {
  const result = await probeOpencodeV2Health({} as never)
  assert.equal(result.ok, false)
  assert.match(String(result.detail || ''), /unavailable|health/i)
})
