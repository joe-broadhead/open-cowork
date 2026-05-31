import assert from 'node:assert/strict'

const root = await import('@open-cowork/cloud-client')
const adapter = await import('@open-cowork/cloud-client/adapter')
const domains = [
  'artifacts',
  'billing',
  'byok',
  'capabilities',
  'channels',
  'config',
  'identity',
  'sessions',
  'settings',
  'threads',
  'transport',
  'workflows',
]

assert.equal(typeof root.createHttpSseCloudTransportAdapter, 'function')
assert.equal(typeof adapter.createHttpSseCloudTransportAdapter, 'function')

for (const domain of domains) {
  const imported = await import(`@open-cowork/cloud-client/domains/${domain}`)
  assert.equal(typeof imported, 'object', domain)
}

await assert.rejects(
  import('@open-cowork/cloud-client/src/adapter.ts'),
  /Package subpath|Cannot find package|not defined by "exports"/,
)
