import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RUNTIME_EVENT_MAX_DEPTH,
  RUNTIME_EVENT_MAX_SERIALIZED_BYTES,
  RUNTIME_EVENT_REDACTED,
  RUNTIME_EVENT_TRUNCATED,
  sanitizeRuntimeEventRecord,
  sanitizeRuntimeEventValue,
} from '@open-cowork/shared'

test('runtime event sanitizer recursively redacts credentials and local paths', () => {
  const syntheticApiKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz012345'].join('-')
  const sanitized = sanitizeRuntimeEventRecord({
    input: {
      authorization: 'Bearer nested-secret',
      apiKey: syntheticApiKey,
      nested: { refreshToken: 'refresh-secret' },
      absolutePath: '/var/lib/open-cowork/private/result.json',
      fileUrl: 'file:///Users/alice/private/result.json',
      relativePath: 'src/index.ts',
    },
  })

  const input = sanitized.input as Record<string, unknown>
  assert.equal(input.authorization, RUNTIME_EVENT_REDACTED)
  assert.equal(input.apiKey, RUNTIME_EVENT_REDACTED)
  assert.deepEqual(input.nested, { refreshToken: RUNTIME_EVENT_REDACTED })
  assert.equal(input.absolutePath, '[REDACTED_LOCAL_PATH]')
  assert.equal(input.fileUrl, '[REDACTED_LOCAL_FILE_URL]')
  assert.equal(input.relativePath, 'src/index.ts')
  assert.equal(JSON.stringify(sanitized).includes('nested-secret'), false)
})

test('runtime event sanitizer bounds depth, cycles, strings, nodes, and serialized bytes', () => {
  const deep: Record<string, unknown> = {}
  let cursor = deep
  for (let index = 0; index < RUNTIME_EVENT_MAX_DEPTH + 10; index += 1) {
    cursor.next = {}
    cursor = cursor.next as Record<string, unknown>
  }
  cursor.cycle = deep

  const sanitizedDeep = sanitizeRuntimeEventValue(deep)
  assert.equal(JSON.stringify(sanitizedDeep).includes(RUNTIME_EVENT_TRUNCATED), true)

  const sanitizedLarge = sanitizeRuntimeEventValue({
    result: 'x'.repeat(RUNTIME_EVENT_MAX_SERIALIZED_BYTES * 2),
    items: Array.from({ length: 4_096 }, (_, index) => ({ index, value: `value-${index}` })),
  })
  const serialized = JSON.stringify(sanitizedLarge)
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= RUNTIME_EVENT_MAX_SERIALIZED_BYTES)
  assert.equal(serialized.includes(RUNTIME_EVENT_TRUNCATED), true)
})

test('runtime event sanitizer redacts explicitly managed paths embedded in output', () => {
  assert.equal(
    sanitizeRuntimeEventValue('saved /runtime/workspaces/org-a/result.csv', {
      managedPaths: ['/runtime/workspaces/org-a/result.csv'],
    }),
    'saved [REDACTED_MANAGED_PATH]',
  )
})

test('runtime event sanitizer scrubs object keys, URI credentials, and additional local roots', () => {
  const syntheticApiKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz012345'].join('-')
  const sanitized = sanitizeRuntimeEventRecord({
    [`artifact-${syntheticApiKey}`]: 'token-shaped key',
    '/Volumes/Private/project/result.txt': 'volume-key',
    connection: 'postgresql://runtime-user:runtime-password@127.0.0.1:5432/open_cowork',
    paths: [
      '/usr/local/bin/opencode',
      '/Library/Application Support/Open Cowork/config.json',
      '/Volumes/Private/project/result.txt',
    ],
  })
  const serialized = JSON.stringify(sanitized)

  assert.equal(serialized.includes(syntheticApiKey), false)
  assert.equal(serialized.includes('runtime-user'), false)
  assert.equal(serialized.includes('runtime-password'), false)
  assert.equal(serialized.includes('/Volumes/Private'), false)
  assert.equal(serialized.includes('/usr/local'), false)
  assert.equal(serialized.includes('/Library/Application'), false)
  assert.match(serialized, /REDACTED_(?:TOKEN|LOCAL_PATH|USERINFO)/)
})

test('runtime event sanitizer stops reading wide objects at the collection bound', () => {
  let reads = 0
  const wide: Record<string, unknown> = {}
  for (let index = 0; index < 2_000; index += 1) {
    Object.defineProperty(wide, `key-${index}`, {
      enumerable: true,
      get() {
        reads += 1
        return index
      },
    })
  }

  const sanitized = sanitizeRuntimeEventRecord(wide)
  assert.ok(reads <= 256)
  assert.equal(sanitized.truncated, RUNTIME_EVENT_TRUNCATED)
})

test('runtime event sanitizer can bound intentional product content without rewriting it', () => {
  const content = {
    email: 'alice@example.com',
    path: '/Users/alice/private-project/report.md',
    attachment: {
      type: 'file',
      url: 'https://files.example/report?signature=keep-this-query',
    },
  }

  assert.deepEqual(
    sanitizeRuntimeEventRecord(content, { redactSensitive: false }),
    content,
  )
})
