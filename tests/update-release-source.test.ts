import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_CONFIG, type OpenCoworkConfig } from '../apps/desktop/src/main/config-types.ts'
import { resolveUpdateReleaseSource, UpdateReleaseSourceError } from '../apps/desktop/src/main/update/update-release-source.ts'
import { checkForUpdates } from '../apps/desktop/src/main/update/update-check.ts'
import { sanitizeLogMessage } from '../apps/desktop/src/main/log-sanitizer.ts'

function baseConfig(): OpenCoworkConfig {
  return {
    ...DEFAULT_CONFIG,
    branding: {
      ...DEFAULT_CONFIG.branding,
      helpUrl: 'https://github.com/joe-broadhead/open-cowork',
    },
    auth: {
      mode: 'none',
    },
  }
}

test('update release source resolver preserves the upstream GitHub default', async () => {
  const source = await resolveUpdateReleaseSource({
    config: baseConfig(),
    currentVersion: '1.0.0',
  })

  assert.deepEqual(source.descriptor, {
    kind: 'github-releases',
    label: 'GitHub Releases',
    channel: 'latest',
    requiresAuth: false,
    authKind: 'none',
  })
  assert.deepEqual(source.installProvider, {
    provider: 'github',
    owner: 'joe-broadhead',
    repo: 'open-cowork',
    channel: 'latest',
  })
  assert.equal(source.manualReleaseUrl, 'https://github.com/joe-broadhead/open-cowork/releases')
})

test('generic update release source discovers latest version from updater metadata', async () => {
  const config = baseConfig()
  config.updates = {
    enabled: true,
    manualFallbackUrl: 'https://updates.example.test/cowork?download_token=private',
    releaseSource: {
      kind: 'generic-http',
      url: 'https://updates.example.test/cowork',
      channel: 'beta',
    },
  }

  const result = await checkForUpdates({
    config,
    currentVersion: '1.2.3',
    fetchImpl: async (input) => {
      assert.equal(String(input), 'https://updates.example.test/cowork/beta-mac.yml')
      return new Response('version: 1.2.4\nfiles: []\n', { status: 200 })
    },
  })

  assert.deepEqual(result, {
    status: 'ok',
    currentVersion: '1.2.3',
    latestVersion: '1.2.4',
    hasUpdate: true,
    releaseUrl: 'https://updates.example.test/cowork',
  })
})

test('generic update release source allows localhost only outside packaged builds', async () => {
  const config = baseConfig()
  config.updates = {
    enabled: true,
    releaseSource: {
      kind: 'generic-http',
      url: 'http://localhost:4321/cowork',
      channel: 'latest',
    },
  }

  const devSource = await resolveUpdateReleaseSource({
    config,
    currentVersion: '1.0.0',
    isPackaged: false,
  })
  assert.deepEqual(devSource.installProvider, {
    provider: 'generic',
    url: 'http://localhost:4321/cowork',
    channel: 'latest',
  })

  await assert.rejects(
    () => resolveUpdateReleaseSource({
      config,
      currentVersion: '1.0.0',
      isPackaged: true,
    }),
    (error) => error instanceof UpdateReleaseSourceError && error.reason === 'source-misconfigured',
  )
})

test('update release source resolver rejects unsafe identifiers defensively', async () => {
  const invalidGithub = baseConfig()
  invalidGithub.updates = {
    enabled: true,
    releaseSource: {
      kind: 'github-releases',
      owner: 'joe-broadhead/other',
      repo: 'open-cowork',
    },
  }
  await assert.rejects(
    () => resolveUpdateReleaseSource({ config: invalidGithub, currentVersion: '1.0.0' }),
    (error) => error instanceof UpdateReleaseSourceError && error.reason === 'source-misconfigured',
  )

  const invalidChannel = baseConfig()
  invalidChannel.updates = {
    enabled: true,
    releaseSource: {
      kind: 'generic-http',
      url: 'https://updates.example.test/cowork',
      channel: '../private',
    },
  }
  await assert.rejects(
    () => resolveUpdateReleaseSource({ config: invalidChannel, currentVersion: '1.0.0' }),
    (error) => error instanceof UpdateReleaseSourceError && error.reason === 'source-misconfigured',
  )

  const invalidBucket = baseConfig()
  invalidBucket.auth = { mode: 'google-oauth', googleOAuth: { clientId: 'client-id' } }
  invalidBucket.updates = {
    enabled: true,
    releaseSource: {
      kind: 'gcs',
      bucket: 'secret-bucket/private',
      auth: { kind: 'google-oauth' },
    },
  }
  await assert.rejects(
    () => resolveUpdateReleaseSource({
      config: invalidBucket,
      currentVersion: '1.0.0',
      getAuthState: () => ({ authenticated: true, email: 'user@example.test' }),
      refreshGoogleAccessToken: async () => 'ya29.private-token',
    }),
    (error) => error instanceof UpdateReleaseSourceError && error.reason === 'source-misconfigured',
  )
})

test('authenticated generic update release source does not expose feed URL without explicit fallback', async () => {
  const config = baseConfig()
  config.updates = {
    enabled: true,
    releaseSource: {
      kind: 'generic-http',
      url: 'https://private-updates.example.test/cowork',
      channel: 'latest',
      auth: {
        kind: 'static-headers',
        headers: { Authorization: 'Bearer private-token' },
      },
    },
  }

  const source = await resolveUpdateReleaseSource({
    config,
    currentVersion: '1.2.3',
    fetchImpl: async (input, init) => {
      assert.equal(String(input), 'https://private-updates.example.test/cowork/latest-mac.yml')
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer private-token')
      return new Response('version: 1.2.4\nfiles: []\n', { status: 200 })
    },
  })

  assert.equal(source.manualReleaseUrl, null)
  assert.deepEqual(await source.discoverLatest(), {
    status: 'ok',
    currentVersion: '1.2.3',
    latestVersion: '1.2.4',
    hasUpdate: true,
    releaseUrl: '',
  })
})

test('GCS OAuth release source requires Google sign-in before private metadata is read', async () => {
  const config = baseConfig()
  config.auth = { mode: 'google-oauth', googleOAuth: { clientId: 'client-id' } }
  config.updates = {
    enabled: true,
    releaseSource: {
      kind: 'gcs',
      bucket: 'acme-cowork-releases',
      prefix: 'desktop',
      channel: 'latest',
      auth: { kind: 'google-oauth' },
    },
  }

  await assert.rejects(
    () => resolveUpdateReleaseSource({
      config,
      currentVersion: '1.0.0',
      getAuthState: () => ({ authenticated: false, email: null }),
    }),
    (error) => error instanceof UpdateReleaseSourceError && error.reason === 'auth-required',
  )
})

test('GCS OAuth release source attaches bearer auth only inside main-process fetches', async () => {
  const config = baseConfig()
  config.auth = { mode: 'google-oauth', googleOAuth: { clientId: 'client-id' } }
  config.updates = {
    enabled: true,
    releaseSource: {
      kind: 'gcs',
      bucket: 'acme-cowork-releases',
      prefix: 'desktop/releases',
      channel: 'latest',
      auth: { kind: 'google-oauth' },
    },
  }

  const source = await resolveUpdateReleaseSource({
    config,
    currentVersion: '1.2.3',
    getAuthState: () => ({ authenticated: true, email: 'user@example.test' }),
    refreshGoogleAccessToken: async () => 'ya29.private-token',
    fetchImpl: async (input, init) => {
      assert.equal(String(input), 'https://storage.googleapis.com/acme-cowork-releases/desktop/releases/latest/latest-mac.yml')
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer ya29.private-token')
      return new Response('version: 1.2.4\nfiles: []\n', { status: 200 })
    },
  })

  assert.deepEqual(source.descriptor, {
    kind: 'gcs',
    label: 'Private release feed',
    channel: 'latest',
    requiresAuth: true,
    authKind: 'google-oauth',
  })
  assert.deepEqual(source.installProvider, {
    provider: 'generic',
    url: 'https://storage.googleapis.com/acme-cowork-releases/desktop/releases/latest/',
    channel: 'latest',
    requestHeaders: { Authorization: 'Bearer ya29.private-token' },
  })
  assert.deepEqual(await source.discoverLatest(), {
    status: 'ok',
    currentVersion: '1.2.3',
    latestVersion: '1.2.4',
    hasUpdate: true,
    releaseUrl: 'https://storage.cloud.google.com/',
  })
})

test('GCS signed-url broker does not expose brokered artifact URLs in check results', async () => {
  const config = baseConfig()
  config.auth = { mode: 'google-oauth', googleOAuth: { clientId: 'client-id' } }
  config.updates = {
    enabled: true,
    releaseSource: {
      kind: 'gcs',
      bucket: 'acme-cowork-releases',
      prefix: 'desktop/releases',
      channel: 'latest',
      auth: {
        kind: 'signed-url-broker',
        brokerUrl: 'https://updates.example.test/cowork/broker',
      },
    },
  }

  const source = await resolveUpdateReleaseSource({
    config,
    currentVersion: '1.2.3',
    getAuthState: () => ({ authenticated: true, email: 'user@example.test' }),
    refreshGoogleAccessToken: async () => 'ya29.private-token',
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url === 'https://updates.example.test/cowork/broker') {
        assert.equal(init?.method, 'POST')
        assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer ya29.private-token')
        return Response.json({
          providerUrl: 'https://brokered.example.test/releases/',
          releaseUrl: 'https://brokered.example.test/releases/Open-Cowork.dmg?X-Goog-Signature=private',
          requestHeaders: { 'X-Release-Token': 'private-feed-token' },
        })
      }
      assert.equal(url, 'https://brokered.example.test/releases/latest-mac.yml')
      assert.equal((init?.headers as Record<string, string>)['X-Release-Token'], 'private-feed-token')
      return new Response('version: 1.2.4\nfiles: []\n', { status: 200 })
    },
  })

  assert.equal(source.manualReleaseUrl, null)
  assert.deepEqual(await source.discoverLatest(), {
    status: 'ok',
    currentVersion: '1.2.3',
    latestVersion: '1.2.4',
    hasUpdate: true,
    releaseUrl: '',
  })
})

test('private release source authorization failures are non-sensitive', async () => {
  const config = baseConfig()
  config.auth = { mode: 'google-oauth', googleOAuth: { clientId: 'client-id' } }
  config.updates = {
    enabled: true,
    releaseSource: {
      kind: 'gcs',
      bucket: 'secret-bucket',
      prefix: 'desktop',
      auth: { kind: 'google-oauth' },
    },
  }
  const source = await resolveUpdateReleaseSource({
    config,
    currentVersion: '1.2.3',
    getAuthState: () => ({ authenticated: true, email: 'user@example.test' }),
    refreshGoogleAccessToken: async () => 'ya29.private-token',
    fetchImpl: async () => new Response('no', { status: 403 }),
  })

  await assert.rejects(
    () => source.discoverLatest(),
    (error) => error instanceof UpdateReleaseSourceError
      && error.reason === 'auth-forbidden'
      && !error.message.includes('secret-bucket'),
  )
})

test('signed update URLs have credential query strings redacted from logs', () => {
  const sanitized = sanitizeLogMessage('download https://updates.example.test/latest-mac.yml?X-Goog-Signature=abc&X-Goog-Credential=secret')
  assert.equal(sanitized, 'download https://updates.example.test/latest-mac.yml?[REDACTED_QUERY]')
})
