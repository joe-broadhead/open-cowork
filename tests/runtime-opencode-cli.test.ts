import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'fs'
import { delimiter, dirname } from 'path'
import {
  applyBundledOpencodeCliEnvironment,
  resolveBundledOpencodeCliEnvironment,
} from '../apps/desktop/src/main/runtime-opencode-cli.ts'

test('applyBundledOpencodeCliEnvironment returns a usable bundled OpenCode binary path without trusting inherited overrides', () => {
  const previousPath = process.env.PATH
  const previousBin = process.env.OPENCODE_BIN_PATH

  try {
    process.env.OPENCODE_BIN_PATH = '/tmp/user-controlled-opencode'
    const env = applyBundledOpencodeCliEnvironment()

    const binary = env.opencodeBinPath
    if (typeof binary === 'string' && binary.length > 0) {
      assert.equal(process.env.OPENCODE_BIN_PATH, '/tmp/user-controlled-opencode')
      assert.equal(existsSync(binary), true)
      const pathEntries = (process.env.PATH || '').split(delimiter).filter(Boolean)
      assert.equal(pathEntries[0], dirname(binary))

      process.env.PATH = ['/usr/local/bin', dirname(binary), '/usr/bin'].join(delimiter)
      applyBundledOpencodeCliEnvironment()
      assert.equal((process.env.PATH || '').split(delimiter).filter(Boolean)[0], dirname(binary))
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousBin === undefined) delete process.env.OPENCODE_BIN_PATH
    else process.env.OPENCODE_BIN_PATH = previousBin
  }
})

test('resolveBundledOpencodeCliEnvironment prefers the native binary', () => {
  const env = resolveBundledOpencodeCliEnvironment({
    binary: '/app/node_modules/opencode-darwin-arm64/bin/opencode',
    currentPath: ['/usr/local/bin', '/app/node_modules/opencode-darwin-arm64/bin', '/usr/bin'].join(delimiter),
    isPackaged: true,
    wrapper: '/app/node_modules/opencode-ai/bin/opencode',
  })

  assert.equal(env.opencodeBinPath, '/app/node_modules/opencode-darwin-arm64/bin/opencode')
  assert.equal(
    env.path?.split(delimiter).filter(Boolean)[0],
    '/app/node_modules/opencode-darwin-arm64/bin',
  )
})

test('resolveBundledOpencodeCliEnvironment refuses wrapper fallback in packaged builds', () => {
  assert.throws(
    () =>
      resolveBundledOpencodeCliEnvironment({
        binary: null,
        currentPath: '/usr/bin',
        isPackaged: true,
        wrapper: '/app/node_modules/opencode-ai/bin/opencode',
      }),
    /Bundled OpenCode native CLI is missing/,
  )
})

test('resolveBundledOpencodeCliEnvironment allows wrapper fallback in development', () => {
  const env = resolveBundledOpencodeCliEnvironment({
    binary: null,
    currentPath: '/usr/bin',
    isPackaged: false,
    wrapper: '/repo/node_modules/opencode-ai/bin/opencode',
  })

  assert.equal(env.opencodeBinPath, undefined)
  assert.equal(env.path?.split(delimiter).filter(Boolean)[0], '/repo/node_modules/opencode-ai/bin')
})
