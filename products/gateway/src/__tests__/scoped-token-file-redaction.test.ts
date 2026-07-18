import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { configuredHttpTokenValues, redactSensitiveText } from '../security.js'
import { configuredRedactionValues, readScopedHttpTokenFile } from '../secrets-lifecycle.js'

const SCOPED_HTTP_TOKEN_NAMES = [
  'OPENCODE_GATEWAY_HTTP_READ_TOKEN',
  'OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN',
  'OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN',
  'OPENCODE_GATEWAY_HTTP_ASSET_WRITE_TOKEN',
  'OPENCODE_GATEWAY_HTTP_WEBHOOK_TOKEN',
] as const

describe('scoped HTTP token-file redaction', () => {
  let testDir = ''

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-token-files-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const name of SCOPED_HTTP_TOKEN_NAMES) {
      delete process.env[name]
      delete process.env[`${name}_FILE`]
    }
    if (testDir) fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('loads every scoped token file through authentication and exact-value redaction', () => {
    const env: NodeJS.ProcessEnv = {}
    const tokens: string[] = []
    for (const [index, name] of SCOPED_HTTP_TOKEN_NAMES.entries()) {
      const token = `scoped-file-token-${index}-value`
      const file = writeOwnerOnlyFile(path.join(testDir, `${index}.token`), `${token}\n`)
      env[`${name}_FILE`] = file
      process.env[`${name}_FILE`] = file
      tokens.push(token)
    }

    expect(configuredRedactionValues(undefined, env)).toEqual(expect.arrayContaining(tokens))
    expect(configuredHttpTokenValues()).toEqual(expect.arrayContaining(tokens))
    const redacted = redactSensitiveText(`configured=${tokens.join(',')}`, undefined, env)
    for (const token of tokens) expect(redacted).not.toContain(token)
  })

  it('rejects symlinks, non-regular files, oversized values, and non-owner-only modes', () => {
    const valid = writeOwnerOnlyFile(path.join(testDir, 'valid.token'), 'valid-owner-token')
    const symlink = path.join(testDir, 'symlink.token')
    const directory = path.join(testDir, 'directory.token')
    const oversized = path.join(testDir, 'oversized.token')
    const broadMode = path.join(testDir, 'broad-mode.token')
    fs.symlinkSync(valid, symlink)
    fs.mkdirSync(directory)
    writeOwnerOnlyFile(oversized, 'x'.repeat(8 * 1024 + 1))
    fs.writeFileSync(broadMode, 'broad-mode-token', { mode: 0o644 })
    fs.chmodSync(broadMode, 0o644)

    expect(readScopedHttpTokenFile(valid)).toBe('valid-owner-token')
    expect(readScopedHttpTokenFile(symlink)).toBeUndefined()
    expect(readScopedHttpTokenFile(directory)).toBeUndefined()
    expect(readScopedHttpTokenFile(oversized)).toBeUndefined()
    if (process.platform !== 'win32') expect(readScopedHttpTokenFile(broadMode)).toBeUndefined()
  })

  it('rejects files not owned by the effective Gateway service user', () => {
    if (typeof process.getuid !== 'function') return
    const file = writeOwnerOnlyFile(path.join(testDir, 'owner.token'), 'owner-bound-token')
    const actualUid = process.getuid()
    vi.spyOn(process, 'getuid').mockReturnValue(actualUid + 1)

    expect(readScopedHttpTokenFile(file)).toBeUndefined()
    expect(configuredRedactionValues(undefined, { OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE: file })).not.toContain('owner-bound-token')
  })
})

function writeOwnerOnlyFile(file: string, value: string): string {
  fs.writeFileSync(file, value, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  return file
}
