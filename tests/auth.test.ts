import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'

function testTempDir(prefix: string) {
  const parent = join(process.cwd(), '.open-cowork-test')
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, prefix))
}

function writeGoogleOAuthConfig(configDir: string) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify({
    auth: {
      mode: 'google-oauth',
      googleOAuth: {
        clientId: 'test-client-id.apps.googleusercontent.com',
        clientSecret: 'test-secret',
      },
    },
  }))
}

function writeTokens(userDataDir: string, tokens: {
  access_token: string
  refresh_token: string
  expiry_date: number
  email?: string
}) {
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'google-tokens.json'), JSON.stringify(tokens))
}

function writeAdc(userDataDir: string) {
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'application_default_credentials.json'), JSON.stringify({
    client_id: 'test-client-id.apps.googleusercontent.com',
    client_secret: 'test-secret',
    refresh_token: 'refresh-token',
    type: 'authorized_user',
  }))
}

async function importFreshAuthModule(label: string) {
  // auth now lives in @open-cowork/runtime-host; a package specifier can't carry
  // the cache-busting query, so reload the built dist module directly.
  return import(`../packages/runtime-host/dist/auth.js?${label}-${Date.now()}`)
}

async function withGoogleAuthFixture<T>(
  label: string,
  callback: (paths: { root: string; configDir: string; userDataDir: string }) => Promise<T> | T,
) {
  const root = testTempDir(`open-cowork-auth-${label}-`)
  const configDir = join(root, 'config')
  const userDataDir = join(root, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeGoogleOAuthConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    return await callback({ root, configDir, userDataDir })
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(root, { recursive: true, force: true })
  }
}

test('Google OAuth state is unauthenticated until a refresh token is stored', async () => {
  await withGoogleAuthFixture('empty', async () => {
    const auth = await importFreshAuthModule('empty')

    assert.deepEqual(auth.getAuthState(), { authenticated: false, email: null })
    assert.equal(auth.getCachedAccessToken(), null)
    assert.equal(auth.getAdcPathIfAvailable(), null)
  })
})

test('Google OAuth state exposes stored identity and only returns unexpired access tokens', async () => {
  await withGoogleAuthFixture('stored', async ({ userDataDir }) => {
    writeTokens(userDataDir, {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry_date: Date.now() + 3_600_000,
      email: 'user@example.com',
    })
    writeAdc(userDataDir)

    const auth = await importFreshAuthModule('stored')

    assert.deepEqual(auth.getAuthState(), { authenticated: true, email: 'user@example.com' })
    assert.equal(auth.getCachedAccessToken(), 'access-token')
    assert.equal(auth.getAdcPathIfAvailable(), join(userDataDir, 'application_default_credentials.json'))
  })
})

test('Google OAuth state stays authenticated with expired access token but does not reuse it', async () => {
  await withGoogleAuthFixture('expired', async ({ userDataDir }) => {
    writeTokens(userDataDir, {
      access_token: 'expired-access-token',
      refresh_token: 'refresh-token',
      expiry_date: Date.now() - 1_000,
      email: 'user@example.com',
    })

    const auth = await importFreshAuthModule('expired')

    assert.deepEqual(auth.getAuthState(), { authenticated: true, email: 'user@example.com' })
    assert.equal(auth.getCachedAccessToken(), null)
  })
})

test('Google OAuth userinfo email normalization accepts only non-empty strings', async () => {
  const auth = await importFreshAuthModule('userinfo-email')

  assert.equal(auth.normalizeGoogleUserInfoEmail({ email: ' user@example.com ' }), 'user@example.com')
  assert.equal(auth.normalizeGoogleUserInfoEmail({ email: '   ' }), null)
  assert.equal(auth.normalizeGoogleUserInfoEmail({ email: 42 }), null)
  assert.equal(auth.normalizeGoogleUserInfoEmail(null), null)
})
