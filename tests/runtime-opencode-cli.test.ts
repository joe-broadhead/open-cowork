import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'fs'
import { delimiter, dirname } from 'path'
import { applyBundledOpencodeCliEnvironment } from '../apps/desktop/src/main/runtime-opencode-cli.ts'

test('applyBundledOpencodeCliEnvironment exposes a usable bundled OpenCode binary path', () => {
  const previousPath = process.env.PATH
  const previousBin = process.env.OPENCODE_BIN_PATH

  try {
    assert.doesNotThrow(() => applyBundledOpencodeCliEnvironment())

    const binary = process.env.OPENCODE_BIN_PATH
    if (typeof binary === 'string' && binary.length > 0) {
      assert.equal(existsSync(binary), true)
      const pathEntries = (process.env.PATH || '').split(delimiter).filter(Boolean)
      assert.equal(pathEntries.includes(dirname(binary)), false)
      assert.ok(pathEntries.some((entry) => entry.includes('opencode-ai')))
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousBin === undefined) delete process.env.OPENCODE_BIN_PATH
    else process.env.OPENCODE_BIN_PATH = previousBin
  }
})
