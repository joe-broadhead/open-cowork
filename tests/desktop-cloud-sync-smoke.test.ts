import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { createApiTokenCloudAuthResolver } from '@open-cowork/cloud-server/app'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { createCloudHttpServer } from '@open-cowork/cloud-server/http-server'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import type {
  CloudRuntimeAdapter,
  CloudRuntimeEvent,
  CloudRuntimePromptPart,
} from '@open-cowork/cloud-server/runtime-adapter'
import { CloudSessionService } from '@open-cowork/cloud-server/session-service'
import { CloudWorker } from '@open-cowork/cloud-server/worker'

class DesktopSmokeRuntime implements CloudRuntimeAdapter {
  prompts: Array<{ sessionId: string; text: string }> = []
  private nextSession = 0
  private readonly options: { failPrompt?: boolean }

  constructor(options: { failPrompt?: boolean } = {}) {
    this.options = options
  }

  async createSession() {
    this.nextSession += 1
    return {
      id: `desktop-smoke-runtime-${this.nextSession}`,
      title: `Desktop smoke runtime ${this.nextSession}`,
      createdAt: '2026-05-30T10:00:00.000Z',
      updatedAt: '2026-05-30T10:00:00.000Z',
    }
  }

  async promptSession(input: { sessionId: string; parts: CloudRuntimePromptPart[] }) {
    const text = input.parts
      .filter((part): part is Extract<CloudRuntimePromptPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    this.prompts.push({ sessionId: input.sessionId, text })
    const index = this.prompts.length
    const taskRunId = `${input.sessionId}:task:${index}`
    const permissionId = `${input.sessionId}:permission:${index}`
    const questionId = `${input.sessionId}:question:${index}`
    const artifactId = `${input.sessionId}:artifact:${index}`
    if (this.options.failPrompt) {
      return {
        events: [{
          type: 'runtime.error',
          payload: {
            sessionId: input.sessionId,
            id: `${input.sessionId}:error:${index}`,
            message: 'BYOK/model credentials are missing in the smoke fixture.',
          },
        }],
      }
    }
    const events: CloudRuntimeEvent[] = [
      {
        type: 'session.status',
        payload: { sessionId: input.sessionId, statusType: 'running' },
      },
      {
        type: 'task.run',
        payload: {
          sessionId: input.sessionId,
          id: taskRunId,
          title: 'Desktop sync smoke',
          status: 'running',
        },
      },
      {
        type: 'assistant.message',
        payload: {
          sessionId: input.sessionId,
          messageId: `${input.sessionId}:assistant:${index}`,
          content: `desktop smoke observed ${text}`,
        },
      },
      {
        type: 'permission.requested',
        payload: {
          sessionId: input.sessionId,
          permissionId,
          tool: 'shell',
          input: { command: 'echo smoke' },
          description: 'Desktop smoke permission fixture',
        },
      },
      {
        type: 'question.asked',
        payload: {
          sessionId: input.sessionId,
          requestId: questionId,
          questions: [{
            header: 'Desktop',
            question: 'Continue the deployed smoke?',
            options: [{ label: 'Yes', description: 'Continue.' }],
          }],
        },
      },
      {
        type: 'artifact.created',
        payload: {
          sessionId: input.sessionId,
          taskRunId,
          artifactId,
          filename: 'desktop-sync-smoke.txt',
          contentType: 'text/plain',
          size: 12,
        },
      },
      {
        type: 'session.idle',
        payload: { sessionId: input.sessionId },
      },
    ]
    return { events }
  }

  async abortSession() {}
}

function runDesktopSmokeScript(baseUrl: string, adminToken: string, env: Record<string, string> = {}) {
  const smokeTimeoutMs = 15_000
  const processTimeoutMs = 45_000
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--no-warnings',
      '--experimental-strip-types',
      'scripts/desktop-cloud-sync-smoke.mjs',
      '--cloud-url',
      baseUrl,
      '--timeout-ms',
      String(smokeTimeoutMs),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN: adminToken,
        OPEN_COWORK_DESKTOP_SMOKE_DEBUG: 'true',
        OPEN_COWORK_DESKTOP_SMOKE_PROMPT: 'desktop deployed smoke fixture',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Desktop smoke script timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, processTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

async function createDesktopSmokeFixture(input: {
  runtime?: DesktopSmokeRuntime
  desktopAuth?: Parameters<typeof createCloudHttpServer>[0]['desktopAuth']
} = {}) {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-desktop-smoke', name: 'Desktop Smoke Tenant' })
  const org = store.ensureOrgForTenant({ tenantId: 'tenant-desktop-smoke', name: 'Desktop Smoke Tenant' })
  const account = store.createAccount({
    accountId: 'account-desktop-smoke',
    idpSubject: 'subject-desktop-smoke',
    email: 'owner@example.test',
  })
  store.ensureUser({
    tenantId: 'tenant-desktop-smoke',
    userId: account.accountId,
    email: account.email,
    role: 'admin',
  })
  store.upsertMembership({
    orgId: org.orgId,
    accountId: account.accountId,
    role: 'admin',
    status: 'active',
  })
  const adminToken = (await store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Desktop smoke admin token',
    scopes: ['admin'],
  })).plaintext
  const runtime = input.runtime || new DesktopSmokeRuntime()
  const policy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const service = new CloudSessionService(store, runtime, policy)
  const worker = new CloudWorker(store, service, 'desktop-smoke-worker')
  const server = createCloudHttpServer({
    service,
    worker,
    policy,
    auth: createApiTokenCloudAuthResolver(store),
    autoProcessCommands: true,
    ssePollMs: 10,
    desktopAuth: input.desktopAuth === undefined ? {
      mode: 'oidc',
      issuerUrl: 'https://issuer.example.test',
      clientId: 'open-cowork-desktop',
      scope: 'openid email profile offline_access',
    } : input.desktopAuth,
  })
  return { store, runtime, server, adminToken, org }
}

test('desktop cloud sync smoke validates deployed-cloud desktop continuation path', async () => {
  const { store, runtime, server, adminToken, org } = await createDesktopSmokeFixture()
  const baseUrl = await server.listen()

  try {
    const result = await runDesktopSmokeScript(baseUrl, adminToken)

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(result.stdout.includes(adminToken), false)
    assert.equal(result.stderr.includes(adminToken), false)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      results: {
        prompt: {
          skipped: boolean
          artifactCount: number
          desktopPromptObservedByWebSse: { sequence: number }
          webPromptObservedByDesktopSse: { sequence: number }
        }
        cache: { offlineMutationsBlocked: boolean; cachedSessions: number }
        localWorkspace: { workspaceId: string; localFiles: string }
        tokenRevocation: { rejected: boolean; revokedAt: string }
      }
    }
    assert.equal(payload.ok, true)
    assert.equal(payload.results.prompt.skipped, false)
    assert.ok(payload.results.prompt.desktopPromptObservedByWebSse.sequence > 0)
    assert.ok(payload.results.prompt.webPromptObservedByDesktopSse.sequence > 0)
    assert.equal(payload.results.prompt.artifactCount, 1)
    assert.equal(payload.results.cache.offlineMutationsBlocked, true)
    assert.ok(payload.results.cache.cachedSessions >= 2)
    assert.equal(payload.results.localWorkspace.workspaceId, 'local')
    assert.equal(payload.results.localWorkspace.localFiles, 'not uploaded')
    assert.equal(payload.results.tokenRevocation.rejected, true)
    assert.ok(payload.results.tokenRevocation.revokedAt)
    assert.equal(runtime.prompts.length, 2)
    assert.ok(runtime.prompts.some((prompt) => prompt.text === 'desktop deployed smoke fixture'))
    assert.ok(runtime.prompts.some((prompt) => prompt.text === 'desktop deployed smoke fixture from web'))
    const smokeTokens = store.listApiTokens(org.orgId)
      .filter((token) => token.name.startsWith('Desktop GCP sync smoke'))
    assert.equal(smokeTokens.length, 1)
    assert.ok(smokeTokens[0]?.revokedAt)
  } finally {
    await server.close()
  }
})

test('desktop cloud sync smoke revokes ephemeral token when prompt validation fails', async () => {
  const runtime = new DesktopSmokeRuntime({ failPrompt: true })
  const { store, server, adminToken, org } = await createDesktopSmokeFixture({ runtime })
  const baseUrl = await server.listen()

  try {
    const result = await runDesktopSmokeScript(baseUrl, adminToken)

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /reported cloud session errors/)
    const smokeTokens = store.listApiTokens(org.orgId)
      .filter((token) => token.name.startsWith('Desktop GCP sync smoke'))
    assert.equal(smokeTokens.length, 1)
    assert.ok(smokeTokens[0]?.revokedAt)
  } finally {
    await server.close()
  }
})

test('desktop cloud sync smoke skips OIDC metadata when deployed auth does not expose desktop config', async () => {
  const { server, adminToken } = await createDesktopSmokeFixture({ desktopAuth: null })
  const baseUrl = await server.listen()

  try {
    const result = await runDesktopSmokeScript(baseUrl, adminToken, {
      OPEN_COWORK_DESKTOP_SMOKE_SKIP_PROMPT: 'true',
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      results: { authConfig: { skipped?: boolean; reason?: string } }
    }
    assert.equal(payload.ok, true)
    assert.equal(payload.results.authConfig.skipped, true)
    assert.match(payload.results.authConfig.reason || '', /API-token smoke/)
  } finally {
    await server.close()
  }
})
