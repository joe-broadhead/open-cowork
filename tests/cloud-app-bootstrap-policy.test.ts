import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { createCloudSessionCookieManager } from '@open-cowork/cloud-server/session-cookie-auth'
import {
  assertCloudProductionDeploymentSafe,
  assertCloudAuthDeploymentSafe,
  describeUnacknowledgedEphemeralStorage,
  createControlPlaneStoreForCloud,
  createCloudAuthResolverForConfig,
  resolveCloudControlPlaneUrl,
  resolveCloudCookieSecret,
  resolveCloudBootstrapOptionsFromEnv,
  resolveCloudInternalToken,
  resolveCloudOidcClientSecret,
  resolveCloudPublicBranding,
  listConfiguredByokProviderIds,
  isLoopbackCloudHost,
  isNonPublicCloudHost,
  shouldRunCloudScheduler,
  shouldRunCloudWeb,
  shouldRunCloudWorker,
  startCloudApp,
} from '@open-cowork/cloud-server/app'
import {
  parseCloudDeploymentTier,
  resolveCloudAuthConfig,
  resolveCloudBillingConfig,
} from '@open-cowork/cloud-server/cloud-config'
import { getAppConfig } from '@open-cowork/runtime-host/config'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { createInMemoryObjectStore } from '@open-cowork/cloud-server/object-store'
import { FakeRuntime } from './helpers/cloud-app-runtime.ts'
import {
  STRONG_CLOUD_COOKIE_SECRET,
  STRONG_CLOUD_SECRET,
} from './helpers/cloud-app-test-support.ts'

test('cloud BYOK defaults include only provider descriptors with secret credentials', () => {
  const appConfig = getAppConfig()
  const providerIds = new Set(listConfiguredByokProviderIds(appConfig) || [])

  assert.equal(providerIds.has('openrouter'), true)
  assert.equal(providerIds.has('openai'), true)
  assert.equal(providerIds.has('github-copilot'), false)
  assert.deepEqual(listConfiguredByokProviderIds({
    ...appConfig,
    providers: {
      ...appConfig.providers,
      available: ['github-copilot'],
    },
  }), [])
})

test('cloud bootstrap parses env options and role helpers', () => {
  assert.deepEqual(resolveCloudBootstrapOptionsFromEnv({
    OPEN_COWORK_CLOUD_ROOT: '/tmp/open-cowork-cloud',
    OPEN_COWORK_CLOUD_HOST: '127.0.0.1',
    OPEN_COWORK_CLOUD_PORT: '9999',
    OPEN_COWORK_CLOUD_WORKER_POLL_MS: '25',
    OPEN_COWORK_CLOUD_SCHEDULER_POLL_MS: '40',
    OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS: '2500',
    OPEN_COWORK_CLOUD_RUNTIME_CACHE_MAX_ENTRIES: '42',
    OPEN_COWORK_CLOUD_RUNTIME_CACHE_IDLE_TTL_MS: '1234',
    OPEN_COWORK_CLOUD_RUNTIME_ADMISSION_QUEUE_MAX_ENTRIES: '17',
    OPEN_COWORK_CLOUD_RUNTIME_ADMISSION_TIMEOUT_MS: '4321',
    OPEN_COWORK_CLOUD_RUNTIME_PROVISION_TIMEOUT_MS: '9876',
    OPEN_COWORK_CLOUD_RUNTIME_TEARDOWN_TIMEOUT_MS: '6789',
    OPEN_COWORK_CLOUD_MAX_SSE_CONNECTIONS_PER_ORG: '321',
    OPEN_COWORK_CLOUD_MAX_CONNECTIONS: '4096',
    OPEN_COWORK_CLOUD_SSE_POLL_INTERVAL_MS: '250',
    OPEN_COWORK_CLOUD_SSE_PG_NOTIFY: 'true',
    OPEN_COWORK_CLOUD_AUTO_PROCESS_COMMANDS: 'false',
    OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED: 'true',
    OPEN_COWORK_CLOUD_COOKIE_SECURE: 'false',
    OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
    OPEN_COWORK_CLOUD_PUBLISHED_ADDR: '127.0.0.1',
    OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS: '127.0.0.0/8, ::1',
    OPEN_COWORK_CLOUD_DEPLOYMENT_TIER: 'private_beta',
  }), {
    orgMode: 'multi-org',
    singleOrgId: undefined,
    singleOrgName: undefined,
    deploymentTier: 'private_beta',
    root: '/tmp/open-cowork-cloud',
    hostname: '127.0.0.1',
    port: 9999,
    workerPollMs: 25,
    schedulerPollMs: 40,
    shutdownGraceMs: 2500,
    runtimeCacheMaxEntries: 42,
    runtimeCacheIdleTtlMs: 1234,
    runtimeAdmissionQueueMaxEntries: 17,
    runtimeAdmissionQueueTimeoutMs: 4321,
    runtimeProvisionTimeoutMs: 9876,
    runtimeTeardownTimeoutMs: 6789,
    maxSseConnectionsPerOrg: 321,
    maxConnections: 4096,
    ssePollIntervalMs: 250,
    ssePgNotifyEnabled: true,
    sseNotifyBackstopPollMs: 15000,
    corsOrigin: null,
    autoProcessCommands: false,
    checkpointsEnabled: true,
    cookieSecure: false,
    publicUrl: 'https://cloud.example.test',
    publishedAddr: '127.0.0.1',
    trustProxyHeaders: false,
    trustedProxyCidrs: ['127.0.0.0/8', '::1'],
  })

  assert.equal(shouldRunCloudWeb('all-in-one'), true)
  assert.equal(shouldRunCloudWeb('worker'), false)
  assert.equal(shouldRunCloudWorker('all-in-one'), true)
  assert.equal(shouldRunCloudWorker('web'), false)
  assert.equal(shouldRunCloudScheduler('all-in-one'), true)
  assert.equal(shouldRunCloudScheduler('scheduler'), true)
  assert.equal(shouldRunCloudScheduler('web'), false)
  assert.equal(shouldRunCloudScheduler('worker'), false)
  assert.equal(parseCloudDeploymentTier(null), 'local')
  assert.equal(parseCloudDeploymentTier('public_production'), 'public_production')
  assert.throws(() => parseCloudDeploymentTier('ga'), /Invalid OPEN_COWORK_CLOUD_DEPLOYMENT_TIER/)
})

test('describeUnacknowledgedEphemeralStorage warns beta tiers on ephemeral storage unless acknowledged', () => {
  const ephemeralStore = new InMemoryControlPlaneStore()
  const durableStore = { __durable: true } as never // any non-InMemoryControlPlaneStore instance
  const filesystemObjectStore = { kind: 'filesystem' } as never
  const durableObjectStore = { kind: 's3' } as never

  // Beta tier on in-memory control plane + filesystem object store → flagged (both ephemeral).
  assert.deepEqual(
    describeUnacknowledgedEphemeralStorage({ tier: 'self_host_beta', store: ephemeralStore, objectStore: filesystemObjectStore, env: {} }),
    { controlPlane: 'in-memory', objectStore: 'filesystem' },
  )
  // private_beta with a durable control plane but filesystem object store → still flagged (object store is ephemeral).
  assert.deepEqual(
    describeUnacknowledgedEphemeralStorage({ tier: 'private_beta', store: durableStore, objectStore: filesystemObjectStore, env: {} }),
    { controlPlane: 'durable', objectStore: 'filesystem' },
  )
  // Acknowledged via env opt-in → no warning.
  assert.equal(
    describeUnacknowledgedEphemeralStorage({ tier: 'self_host_beta', store: ephemeralStore, objectStore: filesystemObjectStore, env: { OPEN_COWORK_CLOUD_ALLOW_EPHEMERAL_STORAGE: 'true' } }),
    null,
  )
  // Fully durable storage → no warning.
  assert.equal(
    describeUnacknowledgedEphemeralStorage({ tier: 'self_host_beta', store: durableStore, objectStore: durableObjectStore, env: {} }),
    null,
  )
  // `local` (dev) and `public_production` (hard-blocked elsewhere) are out of scope → never warns here.
  assert.equal(
    describeUnacknowledgedEphemeralStorage({ tier: 'local', store: ephemeralStore, objectStore: filesystemObjectStore, env: {} }),
    null,
  )
  assert.equal(
    describeUnacknowledgedEphemeralStorage({ tier: 'public_production', store: ephemeralStore, objectStore: filesystemObjectStore, env: {} }),
    null,
  )
})

test('cloud public branding resolves from config and env JSON', () => {
  const config = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      publicBranding: {
        ...DEFAULT_CONFIG.cloud.publicBranding,
        productName: 'Config Cowork',
        supportUrl: 'https://support.config.example/cowork',
      },
    },
  }
  const branding = resolveCloudPublicBranding(config, {
    OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON: JSON.stringify({
      productName: 'Acme Cowork',
      managedOrgConnectionLabels: {
        desktopToken: 'Acme Desktop token',
      },
    }),
    OPEN_COWORK_CLOUD_BRAND_SHORT_NAME: 'AC',
  })

  assert.equal(branding.productName, 'Acme Cowork')
  assert.equal(branding.shortName, 'AC')
  assert.equal(branding.supportUrl, 'https://support.config.example/cowork')
  assert.equal(branding.managedOrgConnectionLabels?.desktopToken, 'Acme Desktop token')
  assert.equal(branding.managedOrgConnectionLabels?.gatewayToken, 'Gateway token')
})

test('cloud public branding derives desktop theme keys without legacy palette shims', () => {
  const branding = resolveCloudPublicBranding(DEFAULT_CONFIG, {
    OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON: JSON.stringify({
      theme: {
        background: '#f5f6f3',
        surface: '#ffffff',
        mutedSurface: '#ecefed',
        border: '#d8ddd7',
        text: '#18211c',
        mutedText: '#66736b',
        accent: '#0f6b4b',
        accentStrong: '#13845d',
      },
    }),
  })

  assert.equal(branding.theme?.elevated, '#ffffff')
  assert.equal(branding.theme?.surfaceHover, '#ecefed')
  assert.equal(branding.theme?.surfaceActive, '#ecefed')
  assert.equal(branding.theme?.borderSubtle, '#d8ddd7')
  assert.equal(branding.theme?.textSecondary, '#66736b')
  assert.equal(branding.theme?.accentHover, '#13845d')
  assert.equal(branding.theme?.accentForeground, '#ffffff')
  assert.equal(branding.theme?.green, '#3f9a8f')
  assert.equal(branding.theme?.amber, '#e0913a')
  assert.equal(branding.theme?.red, '#d6587e')
  assert.equal(branding.theme?.focus, 'rgba(47, 107, 240, 0.52)')
  assert.equal(branding.theme?.bgImage, 'none')
})

test('cloud public branding ignores unsafe env URLs', () => {
  const config = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      publicBranding: {
        ...DEFAULT_CONFIG.cloud.publicBranding,
        supportUrl: 'https://support.config.example/cowork',
      },
    },
  }
  const branding = resolveCloudPublicBranding(config, {
    OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON: JSON.stringify({
      logoUrl: 'http://assets.example.test/logo.png',
      faviconUrl: 'http://assets.example.test/favicon.png',
      ogImageUrl: 'https://cdn.example.test/social.png',
      description: 'Custom deployment description.',
      supportUrl: 'javascript:alert(1)',
      privacyUrl: 'mailto:privacy@example.test',
    }),
  })

  assert.equal(branding.logoUrl, undefined)
  // Favicon enforces https (non-https rejected); og image + description pass through.
  assert.equal(branding.faviconUrl, undefined)
  assert.equal(branding.ogImageUrl, 'https://cdn.example.test/social.png')
  assert.equal(branding.description, 'Custom deployment description.')
  assert.equal(branding.supportUrl, 'https://support.config.example/cowork')
  assert.equal(branding.privacyUrl, DEFAULT_CONFIG.cloud.publicBranding.privacyUrl)
})

test('cloud control plane URL resolves from env and config refs', () => {
  const config = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      storage: {
        ...DEFAULT_CONFIG.cloud.storage,
        controlPlane: {
          kind: 'postgres' as const,
          urlRef: 'OPEN_COWORK_DATABASE_URL',
        },
      },
    },
  }

  assert.equal(resolveCloudControlPlaneUrl(config, {
    OPEN_COWORK_DATABASE_URL: 'postgres://from-ref',
  }), 'postgres://from-ref')
  assert.equal(resolveCloudControlPlaneUrl(config, {
    OPEN_COWORK_CLOUD_CONTROL_PLANE_URL: 'postgres://from-env',
    OPEN_COWORK_DATABASE_URL: 'postgres://from-ref',
  }), 'postgres://from-env')
})

test('cloud OIDC client secret resolves from explicit env before config refs', () => {
  const config = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      auth: {
        ...DEFAULT_CONFIG.cloud.auth,
        mode: 'oidc' as const,
        clientSecretRef: 'OIDC_SECRET_REF',
      },
    },
  }

  assert.equal(resolveCloudOidcClientSecret(config, {
    OIDC_SECRET_REF: 'from-ref',
  }), 'from-ref')
  assert.equal(resolveCloudOidcClientSecret(config, {
    OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET: 'from-env',
    OIDC_SECRET_REF: 'from-ref',
  }), 'from-env')
})

test('cloud internal token resolves from explicit env before env refs', () => {
  assert.equal(resolveCloudInternalToken({
    OPEN_COWORK_CLOUD_INTERNAL_TOKEN_REF: 'INTERNAL_TOKEN_REF',
    INTERNAL_TOKEN_REF: 'from-ref',
  }), 'from-ref')
  assert.equal(resolveCloudInternalToken({
    OPEN_COWORK_CLOUD_INTERNAL_TOKEN: 'from-env',
    OPEN_COWORK_CLOUD_INTERNAL_TOKEN_REF: 'INTERNAL_TOKEN_REF',
    INTERNAL_TOKEN_REF: 'from-ref',
  }), 'from-env')
})

test('cloud billing config resolves provider, plan, and Stripe refs from env', () => {
  const resolved = resolveCloudBillingConfig(DEFAULT_CONFIG, {
    OPEN_COWORK_CLOUD_BILLING_ENABLED: 'true',
    OPEN_COWORK_CLOUD_BILLING_PROVIDER: 'stripe',
    OPEN_COWORK_CLOUD_BILLING_DEFAULT_PLAN: 'pro',
    OPEN_COWORK_CLOUD_STRIPE_API_KEY_REF: 'env:STRIPE_API_KEY',
    OPEN_COWORK_CLOUD_STRIPE_WEBHOOK_SECRET_REF: 'env:STRIPE_WEBHOOK_SECRET',
    OPEN_COWORK_CLOUD_STRIPE_PRICE_ID: 'price_pro',
    OPEN_COWORK_CLOUD_STRIPE_SUCCESS_URL: 'https://app.example.test/success',
    OPEN_COWORK_CLOUD_STRIPE_CANCEL_URL: 'https://app.example.test/cancel',
    OPEN_COWORK_CLOUD_STRIPE_PORTAL_RETURN_URL: 'https://app.example.test/billing',
  })

  assert.equal(resolved.enabled, true)
  assert.equal(resolved.provider, 'stripe')
  assert.equal(resolved.defaultPlanKey, 'pro')
  assert.equal(resolved.stripe?.apiKeyRef, 'env:STRIPE_API_KEY')
  assert.equal(resolved.stripe?.webhookSecretRef, 'env:STRIPE_WEBHOOK_SECRET')
  assert.equal(resolved.stripe?.defaultPriceId, 'price_pro')
})

test('cloud auth config resolves OIDC deployment settings from env', () => {
  const resolved = resolveCloudAuthConfig(DEFAULT_CONFIG, {
    OPEN_COWORK_CLOUD_AUTH_MODE: 'oidc',
    OPEN_COWORK_CLOUD_OIDC_ISSUER_URL: 'https://issuer.example.test',
    OPEN_COWORK_CLOUD_OIDC_CLIENT_ID: 'open-cowork-cloud',
    OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET_REF: 'env:OIDC_CLIENT_SECRET',
    OPEN_COWORK_CLOUD_OIDC_CALLBACK_PATH: '/auth/oidc/callback',
    OPEN_COWORK_CLOUD_COOKIE_SECRET_REF: 'env:COOKIE_SECRET',
    OPEN_COWORK_CLOUD_ALLOWED_EMAIL_DOMAINS: 'example.test,example.org',
  })

  assert.equal(resolved.mode, 'oidc')
  assert.equal(resolved.issuerUrl, 'https://issuer.example.test')
  assert.equal(resolved.clientId, 'open-cowork-cloud')
  assert.equal(resolved.clientSecretRef, 'env:OIDC_CLIENT_SECRET')
  assert.equal(resolved.callbackPath, '/auth/oidc/callback')
  assert.equal(resolved.cookieSecretRef, 'env:COOKIE_SECRET')
  assert.deepEqual(resolved.allowedEmailDomains, ['example.test', 'example.org'])
  assert.equal(resolved.allowSelfServiceSignup, false)
  assert.equal(resolved.signupMode, 'invite')
})

test('cloud auth config requires explicit self-service opt-in for managed OIDC signup', () => {
  assert.equal(resolveCloudAuthConfig(DEFAULT_CONFIG, {
    OPEN_COWORK_CLOUD_AUTH_MODE: 'oidc',
  }).allowSelfServiceSignup, false)
  assert.equal(resolveCloudAuthConfig(DEFAULT_CONFIG, {
    OPEN_COWORK_CLOUD_AUTH_MODE: 'oidc',
  }).signupMode, 'invite')
  assert.equal(resolveCloudAuthConfig(DEFAULT_CONFIG, {
    OPEN_COWORK_CLOUD_AUTH_MODE: 'oidc',
    OPEN_COWORK_CLOUD_ALLOW_SELF_SERVICE_SIGNUP: 'true',
  }).allowSelfServiceSignup, true)
  assert.equal(resolveCloudAuthConfig(DEFAULT_CONFIG, {
    OPEN_COWORK_CLOUD_AUTH_MODE: 'oidc',
    OPEN_COWORK_CLOUD_ALLOWED_EMAIL_DOMAINS: 'example.test',
    OPEN_COWORK_CLOUD_ALLOW_SELF_SERVICE_SIGNUP: 'true',
  }).signupMode, 'domain')
  assert.throws(() => resolveCloudAuthConfig(DEFAULT_CONFIG, {
    OPEN_COWORK_CLOUD_AUTH_MODE: 'oidc',
    OPEN_COWORK_CLOUD_SIGNUP_MODE: 'closed',
  }), /Invalid cloud signup mode/)
  assert.equal(resolveCloudAuthConfig(DEFAULT_CONFIG, {
    OPEN_COWORK_CLOUD_AUTH_MODE: 'oidc',
    OPEN_COWORK_CLOUD_SIGNUP_MODE: 'disabled',
  }).signupMode, 'disabled')

  const explicitConfig = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      auth: {
        mode: 'oidc' as const,
        allowSelfServiceSignup: true,
      },
    },
  }
  assert.equal(resolveCloudAuthConfig(explicitConfig, {}).allowSelfServiceSignup, true)

  const staticOidcConfig = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      auth: {
        mode: 'oidc' as const,
      },
    },
  }
  assert.equal(resolveCloudAuthConfig(staticOidcConfig, {}).allowSelfServiceSignup, false)
  assert.equal(resolveCloudAuthConfig(staticOidcConfig, {}).signupMode, 'invite')
})

test('cloud auth config supports explicit trusted header mode', async () => {
  const resolved = resolveCloudAuthConfig(DEFAULT_CONFIG, {
    OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
  })
  assert.equal(resolved.mode, 'header')

  const resolver = createCloudAuthResolverForConfig({
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      auth: resolved,
    },
  })
  const principal = await resolver({
    headers: {
      'x-open-cowork-tenant-id': 'tenant-from-proxy',
      'x-open-cowork-user-id': 'user-from-proxy',
      'x-open-cowork-user-email': 'proxy@example.test',
    },
  } as unknown as IncomingMessage)
  assert.equal(principal.tenantId, 'tenant-from-proxy')
  assert.equal(principal.userId, 'user-from-proxy')
})

test('cloud auth mode none is local-only and ignores caller identity headers', async () => {
  const resolver = createCloudAuthResolverForConfig(DEFAULT_CONFIG)
  const principal = await resolver({
    headers: {
      'x-open-cowork-tenant-id': 'attacker-tenant',
      'x-open-cowork-user-id': 'attacker-user',
      'x-open-cowork-user-email': 'attacker@example.test',
    },
  } as unknown as IncomingMessage)

  assert.equal(principal.tenantId, 'default')
  assert.equal(principal.userId, 'local-user')
  assert.equal(principal.email, 'local@example.test')
})

test('cloud auth mode none is local-only and insecure override refuses public exposure', () => {
  assert.throws(() => assertCloudAuthDeploymentSafe({
    role: 'web',
    hostname: '0.0.0.0',
    auth: DEFAULT_CONFIG.cloud.auth,
    env: {},
  }), /may only bind to loopback/)

  assert.doesNotThrow(() => assertCloudAuthDeploymentSafe({
    role: 'web',
    hostname: '127.0.0.1',
    auth: DEFAULT_CONFIG.cloud.auth,
    env: {},
  }))

  assert.doesNotThrow(() => assertCloudAuthDeploymentSafe({
    role: 'web',
    hostname: '0.0.0.0',
    auth: DEFAULT_CONFIG.cloud.auth,
    publicUrl: 'http://localhost:8787',
    env: {
      OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH: 'true',
      OPEN_COWORK_CLOUD_PUBLISHED_ADDR: '127.0.0.1',
    },
  }))

  assert.throws(() => assertCloudAuthDeploymentSafe({
    role: 'web',
    hostname: '0.0.0.0',
    auth: DEFAULT_CONFIG.cloud.auth,
    env: { OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH: 'true' },
  }), /OPEN_COWORK_CLOUD_HOST\/HOST/)

  assert.throws(() => assertCloudAuthDeploymentSafe({
    role: 'web',
    hostname: '0.0.0.0',
    auth: DEFAULT_CONFIG.cloud.auth,
    env: {
      OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH: 'true',
      OPEN_COWORK_CLOUD_PUBLISHED_ADDR: '0.0.0.0',
    },
  }), /OPEN_COWORK_CLOUD_PUBLISHED_ADDR/)

  assert.throws(() => assertCloudAuthDeploymentSafe({
    role: 'web',
    hostname: '0.0.0.0',
    auth: DEFAULT_CONFIG.cloud.auth,
    publicUrl: 'https://cloud.example.test',
    env: {
      OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH: 'true',
      OPEN_COWORK_CLOUD_PUBLISHED_ADDR: '127.0.0.1',
    },
  }), /OPEN_COWORK_CLOUD_PUBLIC_URL/)
})

test('cloud loopback policy validates IP literals and rejects prefix-spoofed DNS names', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:7f00:1', '[::ffff:7f00:1]']) {
    assert.equal(isLoopbackCloudHost(host), true, host)
  }
  for (const host of ['127.attacker.example', '127.0.0.1.attacker.example', 'fc-attacker.example', '203.0.113.10']) {
    assert.equal(isLoopbackCloudHost(host), false, host)
  }
  for (const host of ['10.0.0.1', '169.254.1.1', '192.168.1.1', 'fc00::1', 'fe80::1', '::ffff:a00:1']) {
    assert.equal(isNonPublicCloudHost(host), true, host)
  }
  for (const host of ['127.attacker.example', 'fc-attacker.example', '8.8.8.8', 'cloud.example.test']) {
    assert.equal(isNonPublicCloudHost(host), false, host)
  }

  assert.throws(() => assertCloudAuthDeploymentSafe({
    role: 'web',
    hostname: '127.attacker.example',
    auth: DEFAULT_CONFIG.cloud.auth,
    env: {},
  }), /may only bind to loopback/)
})

test('cloud public header and OIDC auth require spoofing-resistant deployment settings', () => {
  assert.throws(() => assertCloudAuthDeploymentSafe({
    role: 'web',
    hostname: '0.0.0.0',
    auth: { mode: 'header' },
    env: {},
  }), /HEADER_AUTH_SECRET/)

  assert.throws(() => assertCloudAuthDeploymentSafe({
    role: 'web',
    hostname: '0.0.0.0',
    auth: { mode: 'header', headerSecretRef: 'env:MISSING_HEADER_AUTH_SECRET' },
    env: {},
  }), /HEADER_AUTH_SECRET/)

  assert.throws(() => assertCloudAuthDeploymentSafe({
    role: 'web',
    hostname: '0.0.0.0',
    auth: { mode: 'header', headerSecret: 'trusted-proxy-secret', headerAllowUnsigned: true },
    env: {},
  }), /signed trusted headers/)

  assert.doesNotThrow(() => assertCloudAuthDeploymentSafe({
    role: 'web',
    hostname: '0.0.0.0',
    auth: { mode: 'header', headerSecret: 'trusted-proxy-secret' },
    env: {},
  }))

  assert.throws(() => assertCloudAuthDeploymentSafe({
    role: 'web',
    hostname: '0.0.0.0',
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    env: {},
  }), /PUBLIC_URL/)

  assert.doesNotThrow(() => assertCloudAuthDeploymentSafe({
    role: 'web',
    hostname: '0.0.0.0',
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    publicUrl: 'https://cloud.example.test',
    env: {},
  }))

  for (const publicUrl of [
    'http://cloud.example.test',
    'https://localhost',
    'https://[::ffff:127.0.0.1]',
    'https://10.0.0.1',
    'https://169.254.1.1',
    'https://[fc00::1]',
    'https://[fe80::1]',
    'not-a-url',
  ]) {
    assert.throws(() => assertCloudAuthDeploymentSafe({
      role: 'web',
      hostname: '0.0.0.0',
      auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
      publicUrl,
      env: {},
    }), /PUBLIC_URL|valid URL|HTTPS/)
  }

  assert.throws(() => assertCloudAuthDeploymentSafe({
    role: 'web',
    hostname: '0.0.0.0',
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    publicUrl: 'https://cloud.example.test',
    cookieSecure: false,
    env: {},
  }), /cookies must be Secure/)

  assert.throws(() => assertCloudAuthDeploymentSafe({
    role: 'web',
    hostname: '0.0.0.0',
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    publicUrl: 'https://cloud.example.test',
    corsOrigin: '*',
    env: {},
  }), /cannot be "\*"/)

  assert.throws(() => assertCloudAuthDeploymentSafe({
    role: 'web',
    hostname: '0.0.0.0',
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    publicUrl: 'https://cloud.example.test',
    corsOrigin: 'http://app.example.test',
    env: {},
  }), /CORS_ORIGIN.*HTTPS/)
})

test('public production deployment guard fails closed without durable dependencies', () => {
  assert.throws(() => assertCloudProductionDeploymentSafe({
    tier: 'public_production',
    role: 'web',
    config: DEFAULT_CONFIG,
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    env: {},
    checkpointsEnabled: false,
    autoProcessCommands: false,
  }), /durable Postgres/)

  const productionConfig = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      storage: {
        controlPlane: { kind: 'postgres' as const },
        objectStore: {
          kind: 'gcs' as const,
          bucket: 'open-cowork-test-bucket',
        },
      },
    },
  }
  const productionEnv = {
    OPEN_COWORK_CLOUD_CONTROL_PLANE_URL: 'postgres://db.example.test:5432/open_cowork',
    OPEN_COWORK_CLOUD_RUN_MIGRATIONS: 'false',
    OPEN_COWORK_CLOUD_SECRET_KEY: STRONG_CLOUD_SECRET,
    OPEN_COWORK_CLOUD_COOKIE_SECRET: STRONG_CLOUD_COOKIE_SECRET,
    OPEN_COWORK_CLOUD_SIGNUP_MODE: 'invite',
    // JOE-835: production requires explicit durable event retention windows.
    OPEN_COWORK_CLOUD_RETENTION_SESSION_EVENT_MS: String(14 * 24 * 60 * 60 * 1000),
    OPEN_COWORK_CLOUD_RETENTION_WORKSPACE_EVENT_MS: String(14 * 24 * 60 * 60 * 1000),
  }

  assert.throws(() => assertCloudProductionDeploymentSafe({
    tier: 'public_production',
    role: 'all-in-one',
    config: productionConfig,
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    env: productionEnv,
    checkpointsEnabled: true,
    autoProcessCommands: false,
  }), /split cloud roles/)

  assert.throws(() => assertCloudProductionDeploymentSafe({
    tier: 'public_production',
    role: 'worker',
    config: productionConfig,
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    env: productionEnv,
    checkpointsEnabled: false,
    autoProcessCommands: false,
  }), /CHECKPOINTS_ENABLED=true/)

  assert.throws(() => assertCloudProductionDeploymentSafe({
    tier: 'public_production',
    role: 'web',
    config: productionConfig,
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    env: { ...productionEnv, OPEN_COWORK_CLOUD_RUN_MIGRATIONS: undefined },
    checkpointsEnabled: false,
    autoProcessCommands: false,
    publicUrl: 'https://cloud.example.test',
  }), /RUN_MIGRATIONS=false/)

  assert.throws(() => assertCloudProductionDeploymentSafe({
    tier: 'public_production',
    role: 'web',
    config: productionConfig,
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    env: {
      ...productionEnv,
      OPEN_COWORK_CLOUD_RETENTION_SESSION_EVENT_MS: undefined,
    },
    checkpointsEnabled: false,
    autoProcessCommands: false,
    publicUrl: 'https://cloud.example.test',
  }), /RETENTION_SESSION_EVENT_MS/)

  assert.throws(() => assertCloudProductionDeploymentSafe({
    tier: 'public_production',
    role: 'web',
    config: productionConfig,
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    env: {
      ...productionEnv,
      OPEN_COWORK_CLOUD_RETENTION_WORKSPACE_EVENT_MS: undefined,
    },
    checkpointsEnabled: false,
    autoProcessCommands: false,
    publicUrl: 'https://cloud.example.test',
  }), /RETENTION_WORKSPACE_EVENT_MS/)

  assert.doesNotThrow(() => assertCloudProductionDeploymentSafe({
    tier: 'public_production',
    role: 'web',
    config: productionConfig,
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    env: productionEnv,
    checkpointsEnabled: false,
    autoProcessCommands: false,
    publicUrl: 'https://cloud.example.test',
  }))
})

test('public production deployment guard enforces strong secrets and web auth policy independent of bind host', () => {
  const productionConfig = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      storage: {
        controlPlane: { kind: 'postgres' as const },
        objectStore: {
          kind: 'gcs' as const,
          bucket: 'open-cowork-test-bucket',
        },
      },
    },
  }
  const baseEnv = {
    OPEN_COWORK_CLOUD_CONTROL_PLANE_URL: 'postgres://db.example.test:5432/open_cowork',
    OPEN_COWORK_CLOUD_RUN_MIGRATIONS: 'false',
    OPEN_COWORK_CLOUD_SECRET_KEY: STRONG_CLOUD_SECRET,
    OPEN_COWORK_CLOUD_COOKIE_SECRET: STRONG_CLOUD_COOKIE_SECRET,
    OPEN_COWORK_CLOUD_SIGNUP_MODE: 'invite',
    OPEN_COWORK_CLOUD_RETENTION_SESSION_EVENT_MS: String(14 * 24 * 60 * 60 * 1000),
    OPEN_COWORK_CLOUD_RETENTION_WORKSPACE_EVENT_MS: String(14 * 24 * 60 * 60 * 1000),
  }

  assert.throws(() => assertCloudProductionDeploymentSafe({
    tier: 'public_production',
    role: 'web',
    config: productionConfig,
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    env: { ...baseEnv, OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH: 'true' },
    checkpointsEnabled: false,
    autoProcessCommands: false,
    publicUrl: 'https://cloud.example.test',
  }), /ALLOW_INSECURE_AUTH/)

  assert.throws(() => assertCloudProductionDeploymentSafe({
    tier: 'public_production',
    role: 'web',
    config: productionConfig,
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    env: { ...baseEnv, OPEN_COWORK_CLOUD_SECRET_KEY: 'x'.repeat(32) },
    checkpointsEnabled: false,
    autoProcessCommands: false,
    publicUrl: 'https://cloud.example.test',
  }), /too weak/)

  assert.throws(() => assertCloudProductionDeploymentSafe({
    tier: 'public_production',
    role: 'web',
    config: productionConfig,
    auth: { mode: 'oidc', issuerUrl: 'https://auth.example.test', clientId: 'open-cowork-cloud' },
    env: baseEnv,
    checkpointsEnabled: false,
    autoProcessCommands: false,
  }), /PUBLIC_URL/)

  assert.throws(() => assertCloudProductionDeploymentSafe({
    tier: 'public_production',
    role: 'web',
    config: productionConfig,
    auth: { mode: 'header', headerSecret: STRONG_CLOUD_SECRET, headerAllowUnsigned: true },
    env: { ...baseEnv, OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET: STRONG_CLOUD_SECRET },
    checkpointsEnabled: false,
    autoProcessCommands: false,
    publicUrl: 'https://cloud.example.test',
  }), /signed identity headers/)

  assert.throws(() => assertCloudProductionDeploymentSafe({
    tier: 'public_production',
    role: 'web',
    config: productionConfig,
    auth: { mode: 'header', headerSecret: STRONG_CLOUD_SECRET },
    env: { ...baseEnv, OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET: STRONG_CLOUD_SECRET },
    checkpointsEnabled: false,
    autoProcessCommands: false,
  }), /PUBLIC_URL/)

  assert.doesNotThrow(() => assertCloudProductionDeploymentSafe({
    tier: 'public_production',
    role: 'web',
    config: productionConfig,
    auth: { mode: 'header', headerSecret: STRONG_CLOUD_SECRET },
    env: { ...baseEnv, OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET: STRONG_CLOUD_SECRET },
    checkpointsEnabled: false,
    autoProcessCommands: false,
    publicUrl: 'https://cloud.example.test',
  }))
})

test('cloud session cookie secret requires at least 32 bytes (JOE-828)', () => {
  assert.throws(() => createCloudSessionCookieManager({
    secret: 'x'.repeat(31),
  }), /at least 32 bytes/)
  assert.doesNotThrow(() => createCloudSessionCookieManager({
    secret: 'x'.repeat(32),
  }))
})

test('cloud secret resolver honors cookie secret env refs for runtime wiring', () => {
  assert.equal(resolveCloudCookieSecret(DEFAULT_CONFIG, {
    OPEN_COWORK_CLOUD_COOKIE_SECRET_REF: 'env:COOKIE_SECRET_FROM_REF',
    COOKIE_SECRET_FROM_REF: STRONG_CLOUD_COOKIE_SECRET,
  }), STRONG_CLOUD_COOKIE_SECRET)
})

test('public production cloud app rejects in-memory adapter overrides after dependency construction', async () => {
  const productionConfig = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      storage: {
        controlPlane: { kind: 'postgres' as const },
        objectStore: {
          kind: 'gcs' as const,
          bucket: 'open-cowork-test-bucket',
        },
      },
    },
  }

  await assert.rejects(() => startCloudApp({
    config: productionConfig,
    runtime: new FakeRuntime(),
    store: new InMemoryControlPlaneStore(),
    objectStore: createInMemoryObjectStore(),
    env: {
      OPEN_COWORK_CLOUD_DEPLOYMENT_TIER: 'public_production',
      OPEN_COWORK_CLOUD_ROLE: 'web',
      OPEN_COWORK_CLOUD_HOST: '127.0.0.1',
      OPEN_COWORK_CLOUD_AUTO_PROCESS_COMMANDS: 'false',
      OPEN_COWORK_CLOUD_RUN_MIGRATIONS: 'false',
      OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
      OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET: STRONG_CLOUD_SECRET,
      OPEN_COWORK_CLOUD_SIGNUP_MODE: 'invite',
      OPEN_COWORK_CLOUD_CONTROL_PLANE_URL: 'postgres://db.example.test:5432/open_cowork',
      OPEN_COWORK_CLOUD_SECRET_KEY: STRONG_CLOUD_SECRET,
      OPEN_COWORK_CLOUD_COOKIE_SECRET: STRONG_CLOUD_COOKIE_SECRET,
      OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
      OPEN_COWORK_CLOUD_OBJECT_STORE_KIND: 'gcs',
      OPEN_COWORK_CLOUD_OBJECT_STORE_BUCKET: 'open-cowork-test-bucket',
      OPEN_COWORK_CLOUD_RETENTION_SESSION_EVENT_MS: String(14 * 24 * 60 * 60 * 1000),
      OPEN_COWORK_CLOUD_RETENTION_WORKSPACE_EVENT_MS: String(14 * 24 * 60 * 60 * 1000),
    },
    hostname: '127.0.0.1',
    port: 0,
  }), /resolved control-plane store/)
})

test('cloud control plane local adapter remains default without a postgres URL', async () => {
  const store = await createControlPlaneStoreForCloud({
    config: DEFAULT_CONFIG,
    env: {},
  })
  try {
    assert.equal(store instanceof InMemoryControlPlaneStore, true)
  } finally {
    await store.close?.()
  }
})

test('cloud postgres control plane fails closed without a connection URL', async () => {
  const config = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      storage: {
        ...DEFAULT_CONFIG.cloud.storage,
        controlPlane: {
          kind: 'postgres' as const,
        },
      },
    },
  }

  await assert.rejects(() => createControlPlaneStoreForCloud({
    config,
    env: {},
  }), /no connection URL/)
})

test('non-local cloud web roles require durable webhook security storage', async () => {
  await assert.rejects(() => startCloudApp({
    config: DEFAULT_CONFIG,
    runtime: new FakeRuntime(),
    store: new InMemoryControlPlaneStore(),
    env: {
      OPEN_COWORK_CLOUD_DEPLOYMENT_TIER: 'private_beta',
      OPEN_COWORK_CLOUD_ROLE: 'web',
    },
    hostname: '127.0.0.1',
    port: 0,
  }), /durable workflow webhook security store/)
})

test('cloud app lets deployers inject a durable control-plane store factory', async () => {
  const runtime = new FakeRuntime()
  const store = new InMemoryControlPlaneStore()
  let factoryCalls = 0
  const app = await startCloudApp({
    config: DEFAULT_CONFIG,
    runtime,
    storeFactory(input) {
      factoryCalls += 1
      assert.equal(input.env.OPEN_COWORK_CLOUD_CONTROL_PLANE_URL, 'postgres://db.example.test/open_cowork')
      return store
    },
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
      OPEN_COWORK_CLOUD_CONTROL_PLANE_URL: 'postgres://db.example.test/open_cowork',
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  try {
    assert.equal(factoryCalls, 1)
    assert.equal(app.store, store)
  } finally {
    await app.close()
  }
})
