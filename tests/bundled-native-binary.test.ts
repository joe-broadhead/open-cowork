import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  resolveBundledNativeBinary,
  resolveLocalMcpCommand,
} from '@open-cowork/runtime-host/runtime-mcp'

test('resolveBundledNativeBinary finds vendored time-keep for this platform when fetched', () => {
  const platformKey = `${process.platform}-${process.arch}`
  const expected = join(process.cwd(), 'third_party', 'time-keep', 'platforms', platformKey, process.platform === 'win32' ? 'time-keep.exe' : 'time-keep')
  if (!existsSync(expected)) {
    // Packaging hosts fetch binaries in CI; local may not have them yet.
    assert.equal(resolveBundledNativeBinary('time-keep'), null)
    return
  }
  const resolved = resolveBundledNativeBinary('time-keep')
  assert.equal(resolved, expected)
  assert.deepEqual(
    resolveLocalMcpCommand(['time-keep', 'server', 'start', '--transport', 'stdio']),
    [expected, 'server', 'start', '--transport', 'stdio'],
  )
})
