import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const SCRIPT = '.github/scripts/release-windows-signing-mode.mjs'
const SIGNING_ENV_KEYS = [
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'SIGNPATH_API_TOKEN',
  'SIGNPATH_ORGANIZATION_ID',
  'SIGNPATH_PROJECT_SLUG',
  'OPEN_COWORK_ALLOW_UNSIGNED_RELEASES',
  'GITHUB_REF_NAME',
] as const

function runSigningMode(env: Record<string, string | undefined>) {
  const cleanEnv = { ...process.env }
  for (const key of SIGNING_ENV_KEYS) delete cleanEnv[key]
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...cleanEnv,
      ...env,
    },
  })
}

test('Windows signing mode accepts the native Authenticode certificate path', () => {
  const result = runSigningMode({
    GITHUB_REF_NAME: 'v1.0.0',
    WIN_CSC_LINK: 'base64-pfx',
    WIN_CSC_KEY_PASSWORD: 'password',
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /^mode=signed$/m)
  assert.match(result.stdout, /^mechanism=native-certificate$/m)
})

test('Windows signing mode allows unsigned v0 preview releases only with explicit override', () => {
  const result = runSigningMode({
    GITHUB_REF_NAME: 'v0.8.0',
    OPEN_COWORK_ALLOW_UNSIGNED_RELEASES: 'true',
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /^mode=unsigned$/m)
  assert.match(result.stdout, /^mechanism=none$/m)
})

test('Windows signing mode fails closed when signing is missing for production tags', () => {
  const result = runSigningMode({
    GITHUB_REF_NAME: 'v1.0.0',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Missing Windows signing configuration/)
})

test('Windows signing mode rejects unsigned override outside v0 previews', () => {
  const result = runSigningMode({
    GITHUB_REF_NAME: 'v1.0.0',
    OPEN_COWORK_ALLOW_UNSIGNED_RELEASES: 'true',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /only valid for v0\.x preview tags/)
})

test('Windows signing mode rejects partial native certificate configuration', () => {
  const result = runSigningMode({
    GITHUB_REF_NAME: 'v1.0.0',
    WIN_CSC_LINK: 'base64-pfx',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Provide both WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD/)
})

test('Windows signing mode rejects SignPath-only configuration as unsupported', () => {
  const result = runSigningMode({
    GITHUB_REF_NAME: 'v1.0.0',
    SIGNPATH_API_TOKEN: 'token',
    SIGNPATH_ORGANIZATION_ID: 'org',
    SIGNPATH_PROJECT_SLUG: 'project',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /SignPath Windows signing is not wired/)
})

test('Windows signing mode rejects mixed native and SignPath configuration as unsupported', () => {
  const result = runSigningMode({
    GITHUB_REF_NAME: 'v1.0.0',
    WIN_CSC_LINK: 'base64-pfx',
    WIN_CSC_KEY_PASSWORD: 'password',
    SIGNPATH_API_TOKEN: 'token',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /SignPath Windows signing is not wired/)
})
