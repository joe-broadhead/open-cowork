import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { createEnvelopeSecretAdapter, createPlaintextSecretAdapter } from '@open-cowork/cloud-server/secret-adapter'
import type { SecretAdapter } from '@open-cowork/cloud-server/secret-adapter'
import {
  assertCloudProductionDeploymentSafe,
  assertSecretAdapterRoundTrips,
  createHeaderCloudAuthResolver,
  signHeaderCloudAuthRequest,
  startCloudApp,
} from '@open-cowork/cloud-server/app'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { createInMemoryObjectStore, createUnavailableObjectStore } from '@open-cowork/cloud-server/object-store'
import { createUnavailableSecretAdapter } from '@open-cowork/cloud-server/secret-adapter'
import { createCloudReadinessCheck } from '../packages/cloud-server/src/readiness.ts'
import { FakeRuntime } from './helpers/cloud-app-runtime.ts'
import {
  asArray,
  asRecord,
  readJson,
  reserveLoopbackPort,
  STRONG_CLOUD_COOKIE_SECRET,
  STRONG_CLOUD_SECRET,
  TEST_COOKIE_KEY,
  waitForResponse,
} from './helpers/cloud-app-test-support.ts'

test('cloud app wires OIDC auth mode instead of header demo auth', async () => {
  const runtime = new FakeRuntime()
  const app = await startCloudApp({
    config: {
      ...DEFAULT_CONFIG,
      cloud: {
        ...DEFAULT_CONFIG.cloud,
        auth: {
          mode: 'oidc',
          issuerUrl: 'https://auth.example.test',
          clientId: 'open-cowork-cloud',
        },
      },
    },
    runtime,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  try {
    const liveness = await readJson(await fetch(`${app.url}/livez`))
    assert.equal(liveness.ok, true)

    const response = await fetch(`${app.url}/api/config`, {
      headers: {
        'x-open-cowork-tenant-id': 'tenant-from-header',
        'x-open-cowork-user-id': 'user-from-header',
        'x-open-cowork-user-email': 'header@example.test',
      },
    })
    assert.equal(response.status, 401)
    assert.match(await response.text(), /bearer authorization/i)
  } finally {
    await app.close()
  }
})

test('cloud app exposes separate liveness and dependency readiness endpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-readyz-'))
  const runtime = new FakeRuntime()
  const app = await startCloudApp({
    runtime,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
      OPEN_COWORK_CLOUD_ROOT: root,
      OPEN_COWORK_CLOUD_SECRET_KEY: 'z'.repeat(32),
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  try {
    const live = await readJson(await fetch(`${app.url}/livez`))
    assert.equal(live.ok, true)

    const response = await fetch(`${app.url}/readyz`)
    const ready = await readJson(response)
    assert.equal(response.status, 200)
    assert.equal(ready.ok, true)
    const checks = asArray(ready.checks)
    assert.equal(checks.some((entry) => asRecord(entry).name === 'control_plane'), true)
    assert.equal(checks.some((entry) => asRecord(entry).name === 'object_store'), true)
    assert.equal(checks.some((entry) => asRecord(entry).name === 'secret_adapter'), true)
    const progressResponse = await fetch(`${app.url}/progressz`)
    assert.equal(progressResponse.status, 200)
    const progress = await readJson(progressResponse)
    assert.equal(progress.mode, 'off')
    assert.deepEqual(progress.counts, { healthy: 0, waiting: 0, suspect: 0, stalled: 0 })
  } finally {
    await app.close()
  }
})

test('cloud worker operational server exposes only canonical liveness and privacy-safe progress routes', async () => {
  const livenessPort = await reserveLoopbackPort()
  const app = await startCloudApp({
    store: new InMemoryControlPlaneStore(),
    runtime: new FakeRuntime(),
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
      OPEN_COWORK_CLOUD_LIVENESS_PORT: String(livenessPort),
    },
    hostname: '127.0.0.1',
    workerPollMs: 60_000,
  })

  try {
    assert.equal(app.server, null)
    const baseUrl = `http://127.0.0.1:${livenessPort}`
    const live = await waitForResponse(`${baseUrl}/livez`)
    assert.equal(live.status, 200)
    assert.equal((await readJson(live)).ok, true)
    const progressResponse = await fetch(`${baseUrl}/progressz`)
    assert.equal(progressResponse.status, 200)
    const progress = await readJson(progressResponse)
    assert.equal(progress.mode, 'off')
    assert.deepEqual(progress.counts, { healthy: 0, waiting: 0, suspect: 0, stalled: 0 })
    assert.deepEqual(progress.samples, [])
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 404)
  } finally {
    await app.close()
  }
})

test('cloud readiness fails closed when required object storage or secret adapter checks fail', async () => {
  const runtime = new FakeRuntime()
  const app = await startCloudApp({
    runtime,
    objectStore: createUnavailableObjectStore('test object store unavailable'),
    secretAdapter: createUnavailableSecretAdapter('test secret adapter unavailable'),
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  try {
    const response = await fetch(`${app.url}/readyz`)
    const ready = await readJson(response)
    assert.equal(response.status, 503)
    assert.equal(ready.ok, false)
    const checks = asArray(ready.checks).map(asRecord)
    assert.equal(checks.some((entry) => entry.name === 'object_store' && entry.status === 'error'), true)
    assert.equal(checks.some((entry) => entry.name === 'secret_adapter' && entry.status === 'error'), true)
  } finally {
    await app.close()
  }
})

test('cloud readiness rejects an HTTP direct-upload provider for an HTTPS browser deployment', async () => {
  const objectStore = {
    ...createInMemoryObjectStore(),
    presignedUpload: {
      enforcement: 'exact-content-length',
      maxBytes: 1024,
      origin: 'http://objects.example.test',
      verifyCleanupSafety: async () => true,
      verifyBrowserPostSafety: async () => true,
      presignPost: async () => null,
      inspect: async () => null,
      promote: async () => undefined,
      delete: async () => undefined,
    },
  } as never
  const report = await createCloudReadinessCheck({
    policy: { role: 'web' } as never,
    store: new InMemoryControlPlaneStore(),
    objectStore,
    secretAdapter: createPlaintextSecretAdapter(),
    billingConfig: { enabled: false, provider: 'none' } as never,
    publicUrl: 'https://cloud.example.test',
    artifactDirectUpload: {
      requested: true,
      configStatus: 'valid',
      durableStore: true,
      cleanupOwnerReady: true,
    },
  })()

  assert.deepEqual(report.checks.find((entry) => entry.name === 'artifact_direct_upload'), {
    name: 'artifact_direct_upload',
    status: 'error',
    detail: 'provider_unattested',
  })
  assert.equal(report.ok, false)
})

test('cloud app wires OIDC browser login when session cookies are configured', async () => {
  const originalFetch = globalThis.fetch
  const issuer = 'https://auth.example.test'
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify({
        issuer,
        jwks_uri: `${issuer}/jwks.json`,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  let app: Awaited<ReturnType<typeof startCloudApp>> | null = null
  try {
    app = await startCloudApp({
      config: {
        ...DEFAULT_CONFIG,
        cloud: {
          ...DEFAULT_CONFIG.cloud,
          auth: {
            mode: 'oidc',
            issuerUrl: issuer,
            clientId: 'open-cowork-cloud',
          },
        },
      },
      env: {
        OPEN_COWORK_CLOUD_ROLE: 'web',
        OPEN_COWORK_CLOUD_COOKIE_SECRET: TEST_COOKIE_KEY,
        OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
      },
      hostname: '127.0.0.1',
      port: 0,
    })
    const response = await originalFetch(`${app.url}/auth/login?returnTo=/cloud`, { redirect: 'manual' })
    assert.equal(response.status, 302)
    const location = new URL(response.headers.get('location') || '')
    assert.equal(location.origin, issuer)
    assert.equal(location.pathname, '/authorize')
    assert.equal(location.searchParams.get('redirect_uri'), 'https://cloud.example.test/auth/callback')
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256')
    assert.match(response.headers.get('set-cookie') || '', /open_cowork_cloud_oidc=/)
  } finally {
    await app?.close()
    globalThis.fetch = originalFetch
  }
})

test('cloud header auth requires signatures whenever a secret is configured (JOE-832)', async () => {
  const timestamp = Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000).toString()
  const baseHeaders = {
    'x-open-cowork-header-auth-secret': 'trusted-proxy-secret',
    'x-open-cowork-header-auth-timestamp': timestamp,
    'x-open-cowork-tenant-id': 'tenant-1',
    'x-open-cowork-tenant-name': 'Tenant 1',
    'x-open-cowork-user-id': 'user-1',
    'x-open-cowork-user-email': 'user@example.test',
  }
  // Secret present ⇒ signatures mandatory even when requireSignedHeaders is omitted.
  const auth = createHeaderCloudAuthResolver({}, {
    headerSecret: 'trusted-proxy-secret',
    now: () => new Date('2026-01-01T00:01:00.000Z'),
  })
  await assert.rejects(async () => {
    await auth({
      headers: baseHeaders,
    } as unknown as IncomingMessage)
  }, /signature is required/)
  const principal = await auth({
    headers: {
      ...baseHeaders,
      'x-open-cowork-header-auth-signature': signHeaderCloudAuthRequest({
        headers: baseHeaders,
        secret: 'trusted-proxy-secret',
        timestamp,
      }),
    },
  } as unknown as IncomingMessage)
  assert.equal(principal.role, 'member')

  // Without a shared secret, elevated roles are refused (cannot mint owner).
  const unsigned = createHeaderCloudAuthResolver({}, {})
  await assert.rejects(async () => {
    await unsigned({
      headers: {
        'x-open-cowork-user-role': 'owner',
        'x-open-cowork-user-id': 'u',
        'x-open-cowork-user-email': 'u@example.test',
      },
    } as unknown as IncomingMessage)
  }, /elevated roles without signed headers/)
})

test('cloud header auth resolver maps request headers to tenant principal', async () => {
  const timestamp = Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000).toString()
  const baseHeaders = {
    'x-open-cowork-header-auth-secret': 'trusted-proxy-secret',
    'x-open-cowork-header-auth-timestamp': timestamp,
    'x-open-cowork-tenant-id': 'tenant-1',
    'x-open-cowork-tenant-name': 'Tenant 1',
    'x-open-cowork-user-id': 'user-1',
    'x-open-cowork-user-email': 'user@example.test',
  }
  const auth = createHeaderCloudAuthResolver({}, {
    headerSecret: 'trusted-proxy-secret',
    requireSignedHeaders: true,
    now: () => new Date('2026-01-01T00:01:00.000Z'),
  })
  await assert.rejects(async () => {
    await auth({
      headers: {
        'x-open-cowork-header-auth-secret': 'wrong',
        'x-open-cowork-tenant-id': 'tenant-1',
        'x-open-cowork-user-id': 'user-1',
        'x-open-cowork-user-email': 'user@example.test',
      },
    } as unknown as IncomingMessage)
  }, /secret is invalid/)
  await assert.rejects(async () => {
    await auth({
      headers: baseHeaders,
    } as unknown as IncomingMessage)
  }, /signature is required/)
  await assert.rejects(async () => {
    await auth({
      headers: {
        ...baseHeaders,
        'x-open-cowork-header-auth-signature': 'v1=bad',
      },
    } as unknown as IncomingMessage)
  }, /signature is invalid/)
  const principal = await auth({
    headers: {
      ...baseHeaders,
      'x-open-cowork-header-auth-signature': signHeaderCloudAuthRequest({
        headers: baseHeaders,
        secret: 'trusted-proxy-secret',
        timestamp,
      }),
    },
  } as unknown as IncomingMessage)

  assert.deepEqual(principal, {
    tenantId: 'tenant-1',
    orgId: 'tenant-1',
    tenantName: 'Tenant 1',
    userId: 'user-1',
    accountId: 'user-1',
    email: 'user@example.test',
    role: 'member',
    authSource: 'header',
  })

  const spoofed = {
    ...baseHeaders,
    'x-open-cowork-user-role': 'owner',
    'x-open-cowork-header-auth-signature': signHeaderCloudAuthRequest({
      headers: baseHeaders,
      secret: 'trusted-proxy-secret',
      timestamp,
    }),
  }
  await assert.rejects(async () => {
    await auth({ headers: spoofed } as unknown as IncomingMessage)
  }, /signature is invalid/)
})

test('public production deployment guard rejects reusing the secret key as the cookie secret (P2-17)', () => {
  const productionConfig = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      storage: {
        controlPlane: { kind: 'postgres' as const },
        objectStore: { kind: 'gcs' as const, bucket: 'open-cowork-test-bucket' },
      },
    },
  }
  const reusedKeyEnv = {
    OPEN_COWORK_CLOUD_CONTROL_PLANE_URL: 'postgres://db.example.test:5432/open_cowork',
    OPEN_COWORK_CLOUD_RUN_MIGRATIONS: 'false',
    OPEN_COWORK_CLOUD_SECRET_KEY: STRONG_CLOUD_SECRET,
    OPEN_COWORK_CLOUD_COOKIE_SECRET: STRONG_CLOUD_SECRET, // identical → crypto key reuse
    OPEN_COWORK_CLOUD_SIGNUP_MODE: 'invite',
    OPEN_COWORK_CLOUD_RETENTION_SESSION_EVENT_MS: String(14 * 24 * 60 * 60 * 1000),
    OPEN_COWORK_CLOUD_RETENTION_WORKSPACE_EVENT_MS: String(14 * 24 * 60 * 60 * 1000),
  }
  assert.throws(() => assertCloudProductionDeploymentSafe({
    tier: 'public_production',
    role: 'web',
    config: productionConfig,
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    env: reusedKeyEnv,
    checkpointsEnabled: false,
    autoProcessCommands: false,
    publicUrl: 'https://cloud.example.test',
  }), /distinct from OPEN_COWORK_CLOUD_SECRET_KEY/)

  // A distinct cookie secret passes the reuse check.
  assert.doesNotThrow(() => assertCloudProductionDeploymentSafe({
    tier: 'public_production',
    role: 'web',
    config: productionConfig,
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    env: { ...reusedKeyEnv, OPEN_COWORK_CLOUD_COOKIE_SECRET: STRONG_CLOUD_COOKIE_SECRET },
    checkpointsEnabled: false,
    autoProcessCommands: false,
    publicUrl: 'https://cloud.example.test',
  }))
})

test('secret adapter boot canary passes a healthy adapter and fails a broken one (P2-17)', () => {
  assert.doesNotThrow(() => assertSecretAdapterRoundTrips(createEnvelopeSecretAdapter(STRONG_CLOUD_SECRET)))

  // A non-envelope adapter is skipped (the canary only guards the encryption path).
  const plaintextAdapter: SecretAdapter = { mode: 'plaintext', protect: (value) => value, reveal: (value) => value }
  assert.doesNotThrow(() => assertSecretAdapterRoundTrips(plaintextAdapter))

  // An envelope adapter that cannot round-trip fails the canary instead of corrupting work.
  const brokenAdapter: SecretAdapter = { mode: 'envelope-v1', protect: (value) => value, reveal: () => 'tampered' }
  assert.throws(() => assertSecretAdapterRoundTrips(brokenAdapter), /did not round-trip/)

  const secretBackendSentinel = 'vault://tenant-a/key?access_key_id=AKIA_SENTINEL'
  const throwingAdapter: SecretAdapter = {
    mode: 'envelope-v1',
    protect: (value) => value,
    reveal: () => { throw new Error(secretBackendSentinel) },
  }
  let canaryFailure: Error | null = null
  try {
    assertSecretAdapterRoundTrips(throwingAdapter)
  } catch (error) {
    canaryFailure = error as Error
  }
  assert.ok(canaryFailure)
  assert.match(canaryFailure.message, /boot canary/)
  const serializedFailure = [
    canaryFailure.message,
    canaryFailure.stack || '',
    JSON.stringify(canaryFailure),
    JSON.stringify(canaryFailure.cause),
  ].join('\n')
  assert.equal(serializedFailure.includes(secretBackendSentinel), false)
})
