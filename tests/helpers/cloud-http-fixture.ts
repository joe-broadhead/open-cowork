import type { IncomingMessage } from 'node:http'

import {
  DEFAULT_CONFIG,
  type CloudAbuseConfig,
  type CloudBillingConfig,
  type OpenCoworkConfig,
} from '@open-cowork/shared'
import type { WorkflowWebhookSecurityStore } from '@open-cowork/shared/node'
import { CloudArtifactService } from '@open-cowork/cloud-server/artifact-service'
import type { BillingAdapter } from '@open-cowork/cloud-server/billing-adapter'
import { createManagedWorkerCloudAuthResolver } from '@open-cowork/cloud-server/app'
import {
  createByokSecretStore,
  type ByokSecretStoreOptions,
} from '@open-cowork/cloud-server/byok-secret-store'
import {
  resolveCloudRuntimePolicy,
  type CloudRuntimePolicy,
} from '@open-cowork/cloud-server/cloud-config'
import { compileCloudRuntimeCapabilityPolicy } from '@open-cowork/cloud-server/cloud-runtime-capability-policy'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import {
  createCloudHttpServer,
  type CloudAuthResolver,
  type CloudBrowserAuthProvider,
  type CloudDesktopAuthConfig,
} from '@open-cowork/cloud-server/http-server'
import {
  createInMemoryObjectStore,
  type ObjectStoreAdapter,
} from '@open-cowork/cloud-server/object-store'
import type { CloudObservabilityAdapter } from '@open-cowork/cloud-server/observability'
import type {
  CloudRuntimeAdapter,
  CloudRuntimePromptPart,
} from '@open-cowork/cloud-server/runtime-adapter'
import { createEnvelopeSecretAdapter } from '@open-cowork/cloud-server/secret-adapter'
import { createCloudSessionCookieManager } from '@open-cowork/cloud-server/session-cookie-auth'
import {
  CloudSessionService,
  type ByokManagementPolicy,
  type CloudEmailSender,
  type CloudIdentityPolicy,
} from '@open-cowork/cloud-server/session-service'
import { CloudWorker } from '@open-cowork/cloud-server/worker'

export class FakeRuntimeAdapter implements CloudRuntimeAdapter {
  prompts: Array<{ sessionId: string, parts: CloudRuntimePromptPart[], agent: string }> = []
  createdSessions: string[] = []
  aborted: string[] = []
  permissions: Array<{ permissionId: string, allowed: boolean }> = []
  questionReplies: Array<{ requestId: string, answers: unknown[] }> = []
  questionRejects: Array<{ requestId: string }> = []
  private nextSession = 0

  async createSession() {
    this.nextSession += 1
    const id = `oc-session-${this.nextSession}`
    this.createdSessions.push(id)
    return {
      id,
      title: `Session ${this.nextSession}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }

  async promptSession(input: {
    sessionId: string
    parts: CloudRuntimePromptPart[]
    agent: string
  }) {
    this.prompts.push({
      sessionId: input.sessionId,
      parts: input.parts,
      agent: input.agent,
    })
    const text = input.parts.find((part) => part.type === 'text')?.text || ''
    return {
      events: [{
        type: 'assistant.message',
        payload: {
          messageId: `${input.sessionId}:assistant:${this.prompts.length}`,
          content: `echo: ${text}`,
        },
      }, {
        type: 'session.idle',
        payload: {
          sessionId: input.sessionId,
        },
      }],
    }
  }

  async abortSession(input: { sessionId: string }) {
    this.aborted.push(input.sessionId)
  }

  async respondToPermission(input: { permissionId: string, allowed: boolean }) {
    this.permissions.push({
      permissionId: input.permissionId,
      allowed: input.allowed,
    })
  }

  async replyToQuestion(input: { requestId: string, answers: unknown[] }) {
    this.questionReplies.push({
      requestId: input.requestId,
      answers: input.answers,
    })
  }

  async rejectQuestion(input: { requestId: string }) {
    this.questionRejects.push({ requestId: input.requestId })
  }
}

export function createFixture(options: {
  appConfig?: OpenCoworkConfig
  autoProcessCommands?: boolean
  ssePollMs?: number
  maxSseConnectionsPerOrg?: number
  policy?: CloudRuntimePolicy
  sessionCookies?: ReturnType<typeof createCloudSessionCookieManager> | null
  auth?: CloudAuthResolver
  browserAuth?: CloudBrowserAuthProvider | null
  desktopAuth?: CloudDesktopAuthConfig | null
  observability?: CloudObservabilityAdapter | null
  internalToken?: string | null
  byokPolicy?: ByokManagementPolicy
  abuse?: CloudAbuseConfig
  billing?: CloudBillingConfig | null
  billingAdapter?: BillingAdapter | null
  identityPolicy?: CloudIdentityPolicy
  byokSecretStoreOptions?: Omit<ByokSecretStoreOptions, 'ids'>
  webhookSecurity?: WorkflowWebhookSecurityStore | null
  trustProxyHeaders?: boolean
  trustedProxyCidrs?: readonly string[] | null
  inviteSigningSecret?: string | null
  emailSender?: CloudEmailSender | null
  knowledgeAgentTokenSecret?: string | null
  objectStore?: ObjectStoreAdapter
} = {}) {
  const runtime = new FakeRuntimeAdapter()
  const store = new InMemoryControlPlaneStore()
  const objectStore = options.objectStore || createInMemoryObjectStore()
  const policy = options.policy
    || resolveCloudRuntimePolicy(options.appConfig || DEFAULT_CONFIG)
  const runtimeCapabilityPolicy = options.appConfig
    ? compileCloudRuntimeCapabilityPolicy({
        appConfig: options.appConfig,
        policy,
      })
    : null
  let nextId = 0
  const byokSecrets = createByokSecretStore(
    store,
    createEnvelopeSecretAdapter('cloud-http-test-byok-key'),
    {
      ids: { randomUUID: () => `byok-${nextId += 1}` },
      ...options.byokSecretStoreOptions,
    },
  )
  const service = new CloudSessionService(
    store,
    runtime,
    policy,
    undefined,
    {
      randomUUID: () => `cmd-${nextId += 1}`,
    },
    undefined,
    byokSecrets,
    options.byokPolicy,
    options.abuse,
    options.billing || null,
    options.billingAdapter || null,
    options.identityPolicy,
    null,
    options.inviteSigningSecret ?? null,
    options.emailSender ?? null,
    undefined,
    options.observability ?? null,
    createEnvelopeSecretAdapter('cloud-http-workflow-secret-encryption-key'),
  )
  const artifacts = new CloudArtifactService(service, objectStore, {
    randomUUID: () => `artifact-${nextId += 1}`,
  })
  const worker = new CloudWorker(
    store,
    service,
    'worker-1',
    30_000,
    {},
    options.abuse || null,
    options.observability || null,
  )
  const workerAuth = createManagedWorkerCloudAuthResolver(store)
  const server = createCloudHttpServer({
    service,
    artifacts,
    worker,
    policy,
    publicBranding: DEFAULT_CONFIG.cloud.publicBranding,
    autoProcessCommands: options.autoProcessCommands ?? true,
    ssePollMs: options.ssePollMs,
    maxSseConnectionsPerOrg: options.maxSseConnectionsPerOrg,
    sessionCookies: options.sessionCookies,
    browserAuth: options.browserAuth,
    desktopAuth: options.desktopAuth,
    observability: options.observability,
    internalToken: options.internalToken,
    webhookSecurity: options.webhookSecurity,
    trustProxyHeaders: options.trustProxyHeaders,
    trustedProxyCidrs: options.trustedProxyCidrs,
    knowledgeAgentTokenSecret: options.knowledgeAgentTokenSecret,
    runtimeCapabilityPolicy,
    auth: options.auth || (async (req: IncomingMessage) => {
      const authorization = String(req.headers.authorization || '')
      if (authorization.startsWith('Bearer ocw_')) return workerAuth(req)
      return {
        tenantId: 'tenant-1',
        tenantName: 'Tenant 1',
        orgId: 'tenant-1',
        userId: 'user-1',
        accountId: 'user-1',
        email: 'user@example.test',
        role: 'owner',
        authSource: 'local',
      }
    }),
  })
  return {
    runtime,
    store,
    objectStore,
    policy,
    service,
    artifacts,
    worker,
    server,
  }
}

export async function processOneSessionCommand(
  fixture: ReturnType<typeof createFixture>,
  tenantId: string,
  sessionId: string,
) {
  const lease = await fixture.store.claimSessionLease(
    tenantId,
    sessionId,
    'single-command-worker',
  )
  if (!lease) return 0
  try {
    const command = await fixture.store.claimNextSessionCommand(lease)
    if (!command) return 0
    await fixture.service.executeCommand(lease, command)
    return 1
  } finally {
    await fixture.store.releaseSessionLease(lease)
  }
}
