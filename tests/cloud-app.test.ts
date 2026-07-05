import { clearKnowledgeStoreCache } from '@open-cowork/runtime-host/knowledge/knowledge-store'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { createEnvelopeSecretAdapter } from '@open-cowork/cloud-server/secret-adapter'
import type { SecretAdapter } from '@open-cowork/cloud-server/secret-adapter'
import {
  assertCloudProductionDeploymentSafe,
  assertCloudAuthDeploymentSafe,
  assertSecretAdapterRoundTrips,
  describeUnacknowledgedEphemeralStorage,
  createControlPlaneStoreForCloud,
  createHeaderCloudAuthResolver,
  createCloudAuthResolverForConfig,
  parseCloudDeploymentTier,
  resolveCloudAuthConfig,
  resolveCloudControlPlaneUrl,
  resolveCloudCookieSecret,
  resolveCloudBootstrapOptionsFromEnv,
  resolveCloudBillingConfig,
  resolveCloudInternalToken,
  resolveCloudOidcClientSecret,
  resolveCloudPublicBranding,
  listConfiguredByokProviderIds,
  signHeaderCloudAuthRequest,
  shouldRunCloudScheduler,
  shouldRunCloudWeb,
  shouldRunCloudWorker,
  startCloudApp,
} from '@open-cowork/cloud-server/app'
import { getAppConfig } from '../apps/desktop/src/main/config-loader.ts'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { createInMemoryObjectStore, createUnavailableObjectStore } from '@open-cowork/cloud-server/object-store'
import { createCloudPathProvider } from '@open-cowork/cloud-server/path-provider'
import { createUnavailableSecretAdapter } from '@open-cowork/cloud-server/secret-adapter'
import type {
  CloudRuntimeAdapter,
  CloudRuntimeEventListener,
  CloudRuntimePromptPart,
} from '@open-cowork/cloud-server/runtime-adapter'
import { sessionCheckpointLatestKey } from '@open-cowork/cloud-server/workspace-checkpoint-store'
const TEST_COOKIE_KEY = 'not-a-real-cookie-key-for-tests'
const STRONG_CLOUD_SECRET = 'Pp4J9_kV2rTq8YzLmN6bHwC3sDxF7uAaG1eOiR5v'
const STRONG_CLOUD_COOKIE_SECRET = 'Vs7Qm2_ZxHa93LpNuR4TwE8cYbK6jFoDiG1rS5el'

class FakeRuntime implements CloudRuntimeAdapter {
  prompts: Array<{ sessionId: string, parts: CloudRuntimePromptPart[], agent: string }> = []
  questionReplies: Array<{ requestId: string, answers: unknown[] }> = []
  questionRejects: Array<{ requestId: string }> = []
  permissionResponses: Array<{ permissionId: string, allowed: boolean }> = []
  listeners: CloudRuntimeEventListener[] = []
  closed = false
  private nextSession = 0

  async createSession() {
    this.nextSession += 1
    return {
      id: `session-${this.nextSession}`,
      title: `Session ${this.nextSession}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }

  async promptSession(input: { sessionId: string, parts: CloudRuntimePromptPart[], agent: string }) {
    this.prompts.push({ sessionId: input.sessionId, parts: input.parts, agent: input.agent })
    return {
      events: [{
        type: 'assistant.message',
        payload: {
          sessionId: input.sessionId,
          messageId: `${input.sessionId}:assistant`,
          content: 'runtime answer',
        },
      }, {
        type: 'session.idle',
        payload: {
          sessionId: input.sessionId,
        },
      }],
    }
  }

  async abortSession() {}

  async replyToQuestion(input: { requestId: string, answers: unknown[] }) {
    this.questionReplies.push({ requestId: input.requestId, answers: input.answers })
  }

  async rejectQuestion(input: { requestId: string }) {
    this.questionRejects.push({ requestId: input.requestId })
  }

  async respondToPermission(input: { permissionId: string, allowed: boolean }) {
    this.permissionResponses.push({ permissionId: input.permissionId, allowed: input.allowed })
  }

  subscribeEvents(listener: CloudRuntimeEventListener) {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener)
    }
  }

  async emitAssistant(sessionId: string, content: string) {
    for (const listener of this.listeners) {
      await listener({
        type: 'assistant.message',
        payload: {
          sessionId,
          messageId: `${sessionId}:external`,
          content,
        },
      })
    }
  }

  close() {
    this.closed = true
  }
}

class SlowPromptRuntime extends FakeRuntime {
  private startedResolve!: () => void
  private releaseResolve!: () => void
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve
  })
  private readonly released = new Promise<void>((resolve) => {
    this.releaseResolve = resolve
  })

  async promptSession(input: { sessionId: string, parts: CloudRuntimePromptPart[], agent: string }) {
    this.startedResolve()
    await this.released
    return super.promptSession(input)
  }

  release() {
    this.releaseResolve()
  }
}

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

async function readJson(response: Response) {
  return JSON.parse(await response.text()) as Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(Boolean(value && typeof value === 'object' && !Array.isArray(value)), true)
  return value as Record<string, unknown>
}

function asArray(value: unknown): unknown[] {
  assert.equal(Array.isArray(value), true)
  return value as unknown[]
}

function cloudConfigWithRemoteApprovalResponses() {
  return {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      runtime: {
        ...DEFAULT_CONFIG.cloud.runtime,
        allowRemoteApprovalResponses: true,
      },
      profiles: {
        ...DEFAULT_CONFIG.cloud.profiles,
        full: {
          ...DEFAULT_CONFIG.cloud.profiles.full,
          runtime: {
            ...DEFAULT_CONFIG.cloud.runtime,
            ...(DEFAULT_CONFIG.cloud.profiles.full.runtime || {}),
            allowRemoteApprovalResponses: true,
          },
        },
      },
    },
  }
}

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
    OPEN_COWORK_CLOUD_MAX_SSE_CONNECTIONS_PER_ORG: '321',
    OPEN_COWORK_CLOUD_MAX_CONNECTIONS: '4096',
    OPEN_COWORK_CLOUD_SSE_POLL_INTERVAL_MS: '250',
    OPEN_COWORK_CLOUD_SSE_PG_NOTIFY: 'true',
    OPEN_COWORK_CLOUD_AUTO_PROCESS_COMMANDS: 'false',
    OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED: 'true',
    OPEN_COWORK_CLOUD_COOKIE_SECURE: 'false',
    OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
    OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS: '127.0.0.0/8, ::1',
    OPEN_COWORK_CLOUD_DEPLOYMENT_TIER: 'private_beta',
  }), {
    deploymentTier: 'private_beta',
    root: '/tmp/open-cowork-cloud',
    hostname: '127.0.0.1',
    port: 9999,
    workerPollMs: 25,
    schedulerPollMs: 40,
    shutdownGraceMs: 2500,
    runtimeCacheMaxEntries: 42,
    runtimeCacheIdleTtlMs: 1234,
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

test('cloud public branding derives desktop theme keys from legacy theme overlays', () => {
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
  assert.equal(branding.theme?.green, '#1f6b46')
  assert.equal(branding.theme?.amber, '#8a5a14')
  assert.equal(branding.theme?.red, '#9d3630')
  assert.equal(branding.theme?.focus, 'rgba(45, 107, 86, 0.28)')
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
  assert.equal(resolveCloudAuthConfig(DEFAULT_CONFIG, {
    OPEN_COWORK_CLOUD_AUTH_MODE: 'oidc',
    OPEN_COWORK_CLOUD_SIGNUP_MODE: 'closed',
  }).allowSelfServiceSignup, false)
  assert.equal(resolveCloudAuthConfig(DEFAULT_CONFIG, {
    OPEN_COWORK_CLOUD_AUTH_MODE: 'oidc',
    OPEN_COWORK_CLOUD_SIGNUP_MODE: 'closed',
  }).signupMode, 'closed')
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

test('cloud auth mode none refuses non-loopback web binds without explicit local override', () => {
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
    env: { OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH: 'true' },
  }))
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

  for (const publicUrl of ['http://cloud.example.test', 'https://localhost', 'not-a-url']) {
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
    OPEN_COWORK_CLOUD_CONTROL_PLANE_URL: 'postgres://user:pass@db.example.test:5432/open_cowork',
    OPEN_COWORK_CLOUD_SECRET_KEY: STRONG_CLOUD_SECRET,
    OPEN_COWORK_CLOUD_COOKIE_SECRET: STRONG_CLOUD_COOKIE_SECRET,
    OPEN_COWORK_CLOUD_SIGNUP_MODE: 'invite',
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
    OPEN_COWORK_CLOUD_CONTROL_PLANE_URL: 'postgres://user:pass@db.example.test:5432/open_cowork',
    OPEN_COWORK_CLOUD_SECRET_KEY: STRONG_CLOUD_SECRET,
    OPEN_COWORK_CLOUD_COOKIE_SECRET: STRONG_CLOUD_COOKIE_SECRET,
    OPEN_COWORK_CLOUD_SIGNUP_MODE: 'invite',
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
      OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
      OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET: STRONG_CLOUD_SECRET,
      OPEN_COWORK_CLOUD_SIGNUP_MODE: 'invite',
      OPEN_COWORK_CLOUD_CONTROL_PLANE_URL: 'postgres://user:pass@db.example.test:5432/open_cowork',
      OPEN_COWORK_CLOUD_SECRET_KEY: STRONG_CLOUD_SECRET,
      OPEN_COWORK_CLOUD_COOKIE_SECRET: STRONG_CLOUD_COOKIE_SECRET,
      OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
      OPEN_COWORK_CLOUD_OBJECT_STORE_KIND: 'gcs',
      OPEN_COWORK_CLOUD_OBJECT_STORE_BUCKET: 'open-cowork-test-bucket',
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

test('cloud all-in-one app starts web and worker and routes runtime events into projections', async () => {
  const runtime = new FakeRuntime()
  const paths = createCloudPathProvider(await mkdtemp(join(tmpdir(), 'open-cowork-cloud-blank-')))
  const app = await startCloudApp({
    config: DEFAULT_CONFIG,
    runtime,
    paths,
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'all-in-one',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  try {
    assert.ok(app.url)
    assert.ok(app.worker)
    assert.ok(app.server)

    const created = await readJson(await fetch(`${app.url}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
      body: JSON.stringify({}),
    }))
    assert.equal(asRecord(created.session).tenantId, 'tenant-a')
    const coworkSessionId = String(asRecord(created.session).sessionId)
    assert.equal(asRecord(created.session).opencodeSessionId, '')

    const prompted = await readJson(await fetch(`${app.url}/api/sessions/${coworkSessionId}/prompt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
      body: JSON.stringify({ text: 'hello', agent: 'build' }),
    }))
    assert.equal(prompted.processed, 1)
    assert.equal(runtime.prompts.length, 1)
    assert.equal((await stat(paths.resolveWorkspacePath('tenant-a', coworkSessionId))).isDirectory(), true)

    await runtime.emitAssistant('session-1', 'external event')
    const view = await readJson(await fetch(`${app.url}/api/sessions/${coworkSessionId}`, {
      headers: {
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
    }))
    const messages = asArray(asRecord(asRecord(view.projection).view).messages)
    assert.equal(asRecord(messages.at(-1)).content, 'external event')
  } finally {
    await app.close()
  }

  assert.equal(runtime.closed, true)
})

test('cloud web role starts transport without processing worker commands inline', async () => {
  const runtime = new FakeRuntime()
  const app = await startCloudApp({
    config: DEFAULT_CONFIG,
    runtime,
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'web',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  try {
    assert.ok(app.url)
    assert.equal(app.worker, null)

    const created = await readJson(await fetch(`${app.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)
    assert.equal(asRecord(created.session).opencodeSessionId, '')

    const prompted = await readJson(await fetch(`${app.url}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'queued only' }),
    }))
    assert.equal(prompted.processed, 0)
    assert.equal(runtime.prompts.length, 0)
  } finally {
    await app.close()
  }
})

test('cloud app stores Knowledge data under the configured cloud app data root', async () => {
  const runtime = new FakeRuntime()
  const paths = createCloudPathProvider(await mkdtemp(join(tmpdir(), 'open-cowork-cloud-knowledge-')))
  const app = await startCloudApp({
    config: DEFAULT_CONFIG,
    runtime,
    paths,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  try {
    assert.ok(app.url)
    const response = await fetch(`${app.url}/api/knowledge`, {
      headers: {
        'x-open-cowork-tenant-id': 'tenant-knowledge',
        'x-open-cowork-user-id': 'user-knowledge',
        'x-open-cowork-user-email': 'knowledge@example.test',
        'x-open-cowork-user-role': 'owner',
      },
    })
    assert.equal(response.status, 200)
    const dbStat = await stat(join(paths.getAppDataDir(), 'knowledge.sqlite'))
    assert.equal(dbStat.isFile(), true)
  } finally {
    await app.close()
    clearKnowledgeStoreCache()
  }
})

test('cloud all-in-one app rejects malformed project source payloads', async () => {
  const app = await startCloudApp({
    config: DEFAULT_CONFIG,
    runtime: new FakeRuntime(),
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'all-in-one',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  try {
    assert.ok(app.url)
    const response = await fetch(`${app.url}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
      body: JSON.stringify({ projectSource: { kind: 'git' } }),
    })
    assert.equal(response.status, 400)
    const body = await readJson(response)
    assert.match(String(body.error), /project source/i)
  } finally {
    await app.close()
  }
})

test('cloud web and worker roles hand off session runtime creation through the control plane', async () => {
  const store = new InMemoryControlPlaneStore()
  const runtime = new FakeRuntime()
  const web = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'web',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
    },
    hostname: '127.0.0.1',
    port: 0,
  })
  const worker = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    runtime,
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'worker',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
      OPEN_COWORK_CLOUD_WORKER_ID: 'worker-a',
    },
    workerPollMs: 60_000,
  })

  try {
    const created = await readJson(await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
      body: JSON.stringify({}),
    }))
    const coworkSessionId = String(asRecord(created.session).sessionId)
    assert.equal(asRecord(created.session).opencodeSessionId, '')

    const prompted = await readJson(await fetch(`${web.url}/api/sessions/${coworkSessionId}/prompt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
      body: JSON.stringify({ text: 'from stateless web', agent: 'build' }),
    }))
    assert.equal(prompted.processed, 0)
    assert.equal(runtime.prompts.length, 0)

    assert.equal(await worker.worker?.processAllSessionCommands(), 1)
    assert.equal(runtime.prompts.length, 1)
    assert.equal(runtime.prompts[0]?.sessionId, 'session-1')
    assert.notEqual(runtime.prompts[0]?.sessionId, coworkSessionId)

    const stored = store.getSession('tenant-a', 'user-a', coworkSessionId)
    assert.equal(stored?.opencodeSessionId, 'session-1')

    const view = await readJson(await fetch(`${web.url}/api/sessions/${coworkSessionId}`, {
      headers: {
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
    }))
    const messages = asArray(asRecord(asRecord(view.projection).view).messages)
    assert.equal(asRecord(messages.at(-1)).content, 'runtime answer')

    await runtime.emitAssistant('session-1', 'subscription event')
    const streamed = await readJson(await fetch(`${web.url}/api/sessions/${coworkSessionId}`, {
      headers: {
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
    }))
    const streamedMessages = asArray(asRecord(asRecord(streamed.projection).view).messages)
    assert.equal(asRecord(streamedMessages.at(-1)).content, 'subscription event')
  } finally {
    await worker.close()
    await web.close()
  }
})

test('cloud worker shutdown waits for an active command loop before closing runtime', async () => {
  const store = new InMemoryControlPlaneStore()
  const runtime = new SlowPromptRuntime()
  const web = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
    },
    hostname: '127.0.0.1',
    port: 0,
  })
  const worker = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    runtime,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
      OPEN_COWORK_CLOUD_WORKER_ID: 'worker-drain',
    },
    workerPollMs: 1,
    shutdownGraceMs: 1000,
  })
  let workerClosed = false

  try {
    const created = await readJson(await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-tenant-id': 'tenant-drain',
        'x-open-cowork-user-id': 'user-drain',
        'x-open-cowork-user-email': 'drain@example.test',
      },
      body: JSON.stringify({}),
    }))
    const coworkSessionId = String(asRecord(created.session).sessionId)

    await fetch(`${web.url}/api/sessions/${coworkSessionId}/prompt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-tenant-id': 'tenant-drain',
        'x-open-cowork-user-id': 'user-drain',
        'x-open-cowork-user-email': 'drain@example.test',
      },
      body: JSON.stringify({ text: 'close during active worker loop', agent: 'build' }),
    })

    await runtime.started
    let closeReturned = false
    const closePromise = worker.close().then(() => {
      closeReturned = true
      workerClosed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(closeReturned, false)
    assert.equal(runtime.closed, false)

    runtime.release()
    await closePromise
    assert.equal(runtime.closed, true)
    assert.equal(runtime.prompts.length, 1)
  } finally {
    runtime.release()
    if (!workerClosed) await worker.close()
    await web.close()
  }
})

test('cloud worker reclaims stale running commands after worker lease expiry', async () => {
  const store = new InMemoryControlPlaneStore()
  const runtime = new FakeRuntime()
  const web = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'web',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
    },
    hostname: '127.0.0.1',
    port: 0,
  })
  const replacementWorker = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    runtime,
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'worker',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
      OPEN_COWORK_CLOUD_WORKER_ID: 'worker-b',
    },
    workerPollMs: 60_000,
  })

  try {
    const headers = {
      'content-type': 'application/json',
      'x-open-cowork-tenant-id': 'tenant-a',
      'x-open-cowork-user-id': 'user-a',
      'x-open-cowork-user-email': 'a@example.test',
    }
    const created = await readJson(await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)
    const prompted = await readJson(await fetch(`${web.url}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'recover this command', agent: 'build' }),
    }))
    const commandId = String(asRecord(prompted.command).commandId)

    const staleLease = store.claimSessionLease(
      'tenant-a',
      sessionId,
      'worker-a-crashed',
      new Date(),
      20,
    )
    assert.ok(staleLease)
    assert.equal(store.claimNextSessionCommand(staleLease)?.commandId, commandId)
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.equal(await replacementWorker.worker?.processAllSessionCommands(), 1)
    assert.equal(runtime.prompts.length, 1)
    assert.equal(runtime.prompts[0]?.parts[0]?.text, 'recover this command')
    assert.throws(() => store.ackSessionCommand(staleLease, commandId), /stale/)
  } finally {
    await replacementWorker.close()
    await web.close()
  }
})

test('cloud worker applies durable question replies and permission responses to OpenCode', async () => {
  const store = new InMemoryControlPlaneStore()
  const runtime = new FakeRuntime()
  const config = cloudConfigWithRemoteApprovalResponses()
  const web = await startCloudApp({
    config,
    store,
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'web',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
    },
    hostname: '127.0.0.1',
    port: 0,
  })
  const worker = await startCloudApp({
    config,
    store,
    runtime,
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'worker',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
      OPEN_COWORK_CLOUD_WORKER_ID: 'worker-a',
    },
    workerPollMs: 60_000,
  })

  try {
    const headers = {
      'content-type': 'application/json',
      'x-open-cowork-tenant-id': 'tenant-a',
      'x-open-cowork-user-id': 'user-a',
      'x-open-cowork-user-email': 'a@example.test',
    }
    const created = await readJson(await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)

    const question = await readJson(await fetch(`${web.url}/api/sessions/${sessionId}/question-reply`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId: 'question-1', answers: [{ value: 'yes' }] }),
    }))
    const questionReject = await readJson(await fetch(`${web.url}/api/sessions/${sessionId}/question-reject`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId: 'question-2' }),
    }))
    const permission = await readJson(await fetch(`${web.url}/api/sessions/${sessionId}/permission-respond`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ permissionId: 'permission-1', response: { allowed: true } }),
    }))

    assert.equal(question.processed, 0)
    assert.equal(questionReject.processed, 0)
    assert.equal(permission.processed, 0)
    assert.equal(await worker.worker?.processAllSessionCommands(), 3)
    assert.deepEqual(runtime.questionReplies, [{ requestId: 'question-1', answers: [{ value: 'yes' }] }])
    assert.deepEqual(runtime.questionRejects, [{ requestId: 'question-2' }])
    assert.deepEqual(runtime.permissionResponses, [{ permissionId: 'permission-1', allowed: true }])

    const events = await store.listSessionEvents('tenant-a', sessionId)
    assert.equal(events.some((event) => event.type === 'question.resolved'), true)
    assert.equal(events.some((event) => event.type === 'permission.resolved'), true)
  } finally {
    await worker.close()
    await web.close()
  }
})

test('cloud worker can checkpoint workspace state to object storage after commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-cloud-checkpoint-app-'))
  const store = new InMemoryControlPlaneStore()
  const objectStore = createInMemoryObjectStore()
  const runtime = new FakeRuntime()
  const workerPaths = createCloudPathProvider(join(root, 'worker'))
  const web = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    objectStore,
    paths: createCloudPathProvider(join(root, 'web')),
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'web',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
    },
    hostname: '127.0.0.1',
    port: 0,
  })
  const worker = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    objectStore,
    runtime,
    paths: workerPaths,
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'worker',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
      OPEN_COWORK_CLOUD_WORKER_ID: 'worker-a',
      OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED: 'true',
      OPEN_COWORK_CLOUD_SECRET_KEY: 'local-test-secret',
    },
    workerPollMs: 60_000,
  })

  try {
    assert.ok(worker.checkpointStore)
    const principalHeaders = {
      'x-open-cowork-tenant-id': 'tenant-a',
      'x-open-cowork-user-id': 'user-a',
      'x-open-cowork-user-email': 'a@example.test',
    }
    const snapshot = await readJson(await fetch(`${web.url}/api/project-sources/snapshots`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...principalHeaders,
      },
      body: JSON.stringify({
        title: 'fixture',
        files: [{
          path: 'README.md',
          dataBase64: Buffer.from('checkpoint me').toString('base64'),
          byteCount: 'checkpoint me'.length,
        }],
        fileCount: 1,
        byteCount: 'checkpoint me'.length,
      }),
    }))
    const created = await readJson(await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...principalHeaders,
      },
      body: JSON.stringify({ projectSource: snapshot.projectSource }),
    }))
    const coworkSessionId = String(asRecord(created.session).sessionId)

    const prompted = await readJson(await fetch(`${web.url}/api/sessions/${coworkSessionId}/prompt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...principalHeaders,
      },
      body: JSON.stringify({ text: 'from stateless web', agent: 'build' }),
    }))
    assert.equal(prompted.processed, 0)
    assert.equal(await worker.worker?.processAllSessionCommands(), 1)
    assert.equal(
      await readFile(workerPaths.resolveWorkspacePath('tenant-a', coworkSessionId, 'README.md'), 'utf8'),
      'checkpoint me',
    )

    const manifest = await worker.checkpointStore.readSessionCheckpoint({
      tenantId: 'tenant-a',
      sessionId: coworkSessionId,
    })
    assert.ok(manifest)
    assert.equal(manifest.checkpointVersion, 1)
    assert.equal(manifest.entries.some((entry) => entry.rootId === 'workspace' && entry.relativePath === 'README.md'), true)
    assert.equal((await objectStore.headObject(sessionCheckpointLatestKey({
      tenantId: 'tenant-a',
      sessionId: coworkSessionId,
    })))?.metadata.latest, 'true')
  } finally {
    await worker.close()
    await web.close()
  }
})

test('cloud web and worker roles hand off workflow run execution through the control plane', async () => {
  const store = new InMemoryControlPlaneStore()
  const runtime = new FakeRuntime()
  const web = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'web',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
    },
    hostname: '127.0.0.1',
    port: 0,
  })
  const worker = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    runtime,
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'worker',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
      OPEN_COWORK_CLOUD_WORKER_ID: 'worker-a',
    },
    workerPollMs: 60_000,
  })

  try {
    const principalHeaders = {
      'x-open-cowork-tenant-id': 'tenant-a',
      'x-open-cowork-user-id': 'user-a',
      'x-open-cowork-user-email': 'a@example.test',
    }
    const created = await readJson(await fetch(`${web.url}/api/workflows`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...principalHeaders,
      },
      body: JSON.stringify({
        title: 'Split workflow',
        instructions: 'Run from a web replica.',
        agentName: 'build',
        triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
      }),
    }))
    const workflowId = String(asRecord(created.workflow).id)

    const started = await readJson(await fetch(`${web.url}/api/workflows/${workflowId}/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...principalHeaders,
      },
      body: JSON.stringify({}),
    }))
    assert.equal(started.processed, 0)
    const runId = String(asRecord(started.run).id)
    const coworkSessionId = String(started.sessionId)
    assert.equal(runtime.prompts.length, 0)

    assert.equal(await worker.worker?.processAllSessionCommands(), 1)
    assert.equal(runtime.prompts[0]?.sessionId, 'session-1')
    assert.notEqual(runtime.prompts[0]?.sessionId, coworkSessionId)

    const workflow = asRecord((await readJson(await fetch(`${web.url}/api/workflows/${workflowId}`, {
      headers: principalHeaders,
    }))).workflow)
    const run = asRecord(asArray(workflow.runs).find((entry) => asRecord(entry).id === runId))
    assert.equal(run.status, 'completed')
    assert.equal(run.summary, 'runtime answer')
    assert.equal(workflow.latestRunStatus, 'completed')
  } finally {
    await worker.close()
    await web.close()
  }
})

test('cloud scheduler role claims due workflows for workers without owning runtime', async () => {
  const store = new InMemoryControlPlaneStore()
  const runtime = new FakeRuntime()
  store.createTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  store.ensureUser({ tenantId: 'tenant-a', userId: 'user-a', email: 'a@example.test' })
  store.createWorkflow({
    tenantId: 'tenant-a',
    userId: 'user-a',
    workflowId: 'workflow-scheduled',
    nextRunAt: '2030-01-01T09:00:00.000Z',
    draft: {
      title: 'Scheduled workflow',
      instructions: 'Run from the scheduler.',
      agentName: 'build',
      skillNames: [],
      toolIds: [],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{
        id: 'schedule-1',
        type: 'schedule',
        enabled: true,
        schedule: {
          type: 'daily',
          timezone: 'UTC',
          runAtHour: 9,
          runAtMinute: 0,
        },
      }],
    },
  })

  const scheduler = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'scheduler',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
      OPEN_COWORK_CLOUD_SCHEDULER_ID: 'scheduler-a',
    },
    schedulerPollMs: 60_000,
  })
  const worker = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    runtime,
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'worker',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
      OPEN_COWORK_CLOUD_WORKER_ID: 'worker-a',
    },
    workerPollMs: 60_000,
  })

  try {
    assert.equal(scheduler.server, null)
    assert.equal(scheduler.worker, null)
    assert.notEqual(scheduler.scheduler, null)
    assert.equal(worker.scheduler, null)

    const claimed = await scheduler.scheduler?.processDueWorkflows(new Date('2030-01-01T09:00:00.000Z'))
    assert.equal(claimed, 1)
    assert.equal(runtime.prompts.length, 0)

    const claimedWorkflow = await store.getWorkflowForTenant('tenant-a', 'workflow-scheduled')
    const coworkSessionId = claimedWorkflow?.latestRunSessionId
    assert.equal(claimedWorkflow?.status, 'running')
    assert.equal(claimedWorkflow?.latestRunStatus, 'running')
    assert.equal(typeof coworkSessionId, 'string')

    const session = await store.getSession('tenant-a', 'user-a', String(coworkSessionId))
    assert.equal(session?.opencodeSessionId, '')

    const schedulerHeartbeat = (await store.listWorkerHeartbeats())
      .find((heartbeat) => heartbeat.workerId === 'scheduler-a')
    assert.equal(schedulerHeartbeat?.role, 'scheduler')
    assert.deepEqual(schedulerHeartbeat?.activeSessionIds, [coworkSessionId])

    assert.equal(await worker.worker?.processAllSessionCommands(), 1)
    assert.equal(runtime.prompts[0]?.sessionId, 'session-1')
    assert.notEqual(runtime.prompts[0]?.sessionId, coworkSessionId)

    const completed = await store.getWorkflowForTenant('tenant-a', 'workflow-scheduled')
    assert.equal(completed?.status, 'active')
    assert.equal(completed?.latestRunStatus, 'completed')
    assert.equal(completed?.latestRunSummary, 'runtime answer')
    assert.equal((await store.getSession('tenant-a', 'user-a', String(coworkSessionId)))?.opencodeSessionId, 'session-1')
  } finally {
    await worker.close()
    await scheduler.close()
  }
})

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
    const health = await readJson(await fetch(`${app.url}/healthz`))
    assert.equal(health.ok, true)

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
    OPEN_COWORK_CLOUD_CONTROL_PLANE_URL: 'postgres://user:pass@db.example.test:5432/open_cowork',
    OPEN_COWORK_CLOUD_SECRET_KEY: STRONG_CLOUD_SECRET,
    OPEN_COWORK_CLOUD_COOKIE_SECRET: STRONG_CLOUD_SECRET, // identical → crypto key reuse
    OPEN_COWORK_CLOUD_SIGNUP_MODE: 'invite',
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

  const throwingAdapter: SecretAdapter = {
    mode: 'envelope-v1',
    protect: (value) => value,
    reveal: () => { throw new Error('key unavailable') },
  }
  assert.throws(() => assertSecretAdapterRoundTrips(throwingAdapter), /boot canary/)
})
