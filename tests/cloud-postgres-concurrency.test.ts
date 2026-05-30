import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import { createPostgresControlPlaneStore } from '../apps/desktop/src/main/cloud/postgres-control-plane-store.ts'
import { ControlPlaneQuotaExceededError } from '../apps/desktop/src/main/cloud/control-plane-store.ts'

const POSTGRES_URL = process.env.OPEN_COWORK_TEST_POSTGRES_URL
  || process.env.OPEN_COWORK_CLOUD_TEST_POSTGRES_URL
const POSTGRES_SKIP = POSTGRES_URL
  ? false
  : 'Set OPEN_COWORK_TEST_POSTGRES_URL to run real Postgres cloud concurrency tests.'
const require = createRequire(new URL('../apps/desktop/src/main/cloud/postgres-control-plane-store.ts', import.meta.url))

type PgPool = {
  query(text: string, values?: unknown[]): Promise<unknown>
  end(): Promise<void>
}

function pgPool(connectionString: string): PgPool {
  const pg = require('pg') as { Pool: new (options: { connectionString: string }) => PgPool }
  return new pg.Pool({ connectionString })
}

function withSearchPath(connectionString: string, schema: string) {
  const url = new URL(connectionString)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

async function withIsolatedPostgresSchema<T>(fn: (connectionString: string) => Promise<T>) {
  assert.ok(POSTGRES_URL)
  const schema = `ocw_${randomUUID().replaceAll('-', '_')}`
  assert.match(schema, /^ocw_[a-z0-9_]+$/)
  const pool = pgPool(POSTGRES_URL)
  try {
    await pool.query(`CREATE SCHEMA ${schema}`)
    return await fn(withSearchPath(POSTGRES_URL, schema))
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await pool.end()
  }
}

async function withPostgresStore<T>(fn: (store: Awaited<ReturnType<typeof createPostgresControlPlaneStore>>, ids: {
  tenantId: string
  userId: string
  sessionId: string
}) => Promise<T>) {
  assert.ok(POSTGRES_URL)
  const store = await createPostgresControlPlaneStore({ connectionString: POSTGRES_URL })
  const prefix = `pg-${randomUUID()}`
  const ids = {
    tenantId: `${prefix}-tenant`,
    userId: `${prefix}-user`,
    sessionId: `${prefix}-session`,
  }
  try {
    await store.createTenant({ tenantId: ids.tenantId, name: 'Postgres concurrency test' })
    await store.ensureUser({
      tenantId: ids.tenantId,
      userId: ids.userId,
      email: `${ids.userId}@example.test`,
      role: 'owner',
    })
    await store.createSession({
      tenantId: ids.tenantId,
      userId: ids.userId,
      sessionId: ids.sessionId,
      opencodeSessionId: `${prefix}-opencode`,
      profileName: 'full',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    return await fn(store, ids)
  } finally {
    await store.close?.()
  }
}

test('real Postgres cloud store serializes concurrent schema migrations', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withIsolatedPostgresSchema(async (connectionString) => {
    const stores = await Promise.all(Array.from({ length: 6 }, () => (
      createPostgresControlPlaneStore({ connectionString })
    )))
    try {
      const migrations = await stores[0]?.listSchemaMigrations()
      assert.deepEqual(migrations?.map((migration) => migration.id), [
        '001_cloud_control_plane',
        '002_org_identity_tokens_audit',
        '003_headless_channels',
        '004_byok_secrets',
        '005_usage_quotas_rate_limits',
        '006_billing_subscriptions',
        '007_scale_foundation',
      ])
    } finally {
      await Promise.all(stores.map((store) => store.close?.()))
    }
  })
})

test('real Postgres cloud store persists org identity, API tokens, and audit events', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const org = await store.ensureOrgForTenant({ tenantId: ids.tenantId, name: 'Tenant' })
    const account = await store.createAccount({
      accountId: 'pg-account-1',
      idpSubject: 'pg-subject-1',
      email: 'pg-account@example.test',
    })
    await store.upsertMembership({
      orgId: org.orgId,
      accountId: account.accountId,
      role: 'admin',
      status: 'active',
    })

    const issued = await store.issueApiToken({
      orgId: org.orgId,
      accountId: account.accountId,
      name: 'Postgres gateway',
      scopes: ['gateway'],
      secret: 'pg-secret',
    })
    assert.equal((await store.findApiTokenByPlaintext(issued.plaintext))?.tokenId, issued.token.tokenId)
    assert.equal((await store.listApiTokens(org.orgId))[0]?.tokenId, issued.token.tokenId)
    assert.equal(await store.revokeApiToken({ tokenId: issued.token.tokenId, orgId: 'other-org' }), null)
    await store.revokeApiToken({ tokenId: issued.token.tokenId, orgId: org.orgId })
    assert.equal(await store.findApiTokenByPlaintext(issued.plaintext), null)
    assert.equal((await store.listAuditEvents(org.orgId)).some((event) => event.eventType === 'api_token.created'), true)
  })
})

test('real Postgres cloud store persists and rotates BYOK secrets atomically', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const org = await store.ensureOrgForTenant({ tenantId: ids.tenantId, name: 'Tenant' })
    const first = await store.createByokSecret({
      secretId: `${ids.tenantId}-byok-1`,
      orgId: org.orgId,
      providerId: 'anthropic',
      ciphertext: 'enc:v1:first',
      last4: '1111',
      keyFingerprint: 'fingerprint-1',
    })
    assert.equal(first.status, 'active')
    const second = await store.createByokSecret({
      secretId: `${ids.tenantId}-byok-2`,
      orgId: org.orgId,
      providerId: 'anthropic',
      ciphertext: 'enc:v1:second',
      last4: '2222',
      keyFingerprint: 'fingerprint-2',
    })
    assert.equal(second.status, 'active')
    assert.equal(second.rotatedFromSecretId, first.secretId)
    const records = await store.listByokSecrets(org.orgId)
    assert.equal(records.filter((record) => record.providerId === 'anthropic' && record.status === 'active').length, 1)
    assert.equal(records.find((record) => record.secretId === first.secretId)?.status, 'disabled')
    assert.equal((await store.disableByokSecret({ orgId: org.orgId, providerId: 'anthropic' }))?.status, 'disabled')
    assert.equal(await store.getActiveByokSecret(org.orgId, 'anthropic'), null)
  })
})

test('real Postgres cloud store serializes worker leases and fences stale projection writes', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => (
      store.claimSessionLease(ids.tenantId, ids.sessionId, `worker-${index}`, now, 30_000)
    )))
    const leases = claims.filter((lease) => lease !== null)

    assert.equal(leases.length, 1)
    const firstLease = leases[0]
    assert.ok(firstLease)
    await store.writeSessionProjection({
      tenantId: ids.tenantId,
      sessionId: ids.sessionId,
      sequence: 1,
      view: { messages: [] },
      leaseToken: firstLease.leaseToken,
    })

    const secondLease = await store.claimSessionLease(
      ids.tenantId,
      ids.sessionId,
      'worker-after-expiry',
      new Date('2026-01-01T00:00:31.000Z'),
      30_000,
    )
    assert.ok(secondLease)
    await assert.rejects(
      () => store.writeSessionProjection({
        tenantId: ids.tenantId,
        sessionId: ids.sessionId,
        sequence: 2,
        view: { messages: ['stale'] },
        leaseToken: firstLease.leaseToken,
      }),
      /stale/,
    )
    assert.equal((await store.writeSessionProjection({
      tenantId: ids.tenantId,
      sessionId: ids.sessionId,
      sequence: 2,
      view: { messages: ['current'] },
      leaseToken: secondLease.leaseToken,
    })).sequence, 2)
  })
})

test('real Postgres cloud store enforces quota counters under concurrent requests', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const attempts = await Promise.all(Array.from({ length: 8 }, () => (
      store.consumeUsageQuota({
        orgId: ids.tenantId,
        quotaKey: 'prompts:hour',
        limit: 3,
        quantity: 1,
        windowMs: 60_000,
        now: new Date('2026-01-01T00:00:00.000Z'),
        policyCode: 'quota.prompts_per_hour_exceeded',
      })
    )))
    assert.equal(attempts.filter((attempt) => attempt.allowed).length, 3)
    assert.equal(attempts.filter((attempt) => !attempt.allowed).length, 5)

    const createAttempts = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
      try {
        await store.createSession({
          tenantId: ids.tenantId,
          userId: ids.userId,
          sessionId: `${ids.tenantId}-quota-session-${index}`,
          opencodeSessionId: `${ids.tenantId}-quota-oc-${index}`,
          profileName: 'full',
          quota: {
            orgId: ids.tenantId,
            maxConcurrentSessionsPerOrg: 2,
            policyCode: 'quota.concurrent_sessions_exceeded',
          },
        })
        return 'created'
      } catch (error) {
        assert.equal(error instanceof ControlPlaneQuotaExceededError, true)
        return 'blocked'
      }
    }))
    assert.equal(createAttempts.filter((result) => result === 'created').length, 1)
    assert.equal(createAttempts.filter((result) => result === 'blocked').length, 4)

    const workerSessionId = `${ids.tenantId}-worker-quota-session`
    await store.createSession({
      tenantId: ids.tenantId,
      userId: ids.userId,
      sessionId: workerSessionId,
      opencodeSessionId: `${ids.tenantId}-worker-quota-oc`,
      profileName: 'full',
    })
    const leases = await Promise.all([ids.sessionId, workerSessionId].map((sessionId, index) => (
      store.claimSessionLease(
        ids.tenantId,
        sessionId,
        `quota-worker-${index}`,
        new Date('2026-01-01T00:00:00.000Z'),
        30_000,
        {
          orgId: ids.tenantId,
          maxActiveWorkersPerOrg: 1,
          policyCode: 'quota.active_workers_exceeded',
        },
      )
    )))
    assert.equal(leases.filter(Boolean).length, 1)
  })
})

test('real Postgres cloud store assigns unique ordered event sequences under concurrent writes', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const events = await Promise.all(Array.from({ length: 12 }, (_, index) => (
      store.appendSessionEvent({
        tenantId: ids.tenantId,
        sessionId: ids.sessionId,
        eventId: `event-${index}`,
        type: 'assistant.message',
        payload: { messageId: `m-${index}`, content: `message ${index}` },
      })
    )))

    assert.deepEqual(
      events.map((event) => event.sequence).sort((left, right) => left - right),
      Array.from({ length: 12 }, (_, index) => index + 1),
    )
    assert.deepEqual(
      (await store.listSessionEvents(ids.tenantId, ids.sessionId))
        .map((event) => event.sequence),
      Array.from({ length: 12 }, (_, index) => index + 1),
    )
  })
})

test('real Postgres cloud store assigns one ordered workspace stream across sessions', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const secondSessionId = `${ids.sessionId}-two`
    await store.createSession({
      tenantId: ids.tenantId,
      userId: ids.userId,
      sessionId: secondSessionId,
      opencodeSessionId: `${secondSessionId}-opencode`,
      profileName: 'full',
    })

    const writes = await Promise.all([
      store.appendWorkspaceEvent({
        tenantId: ids.tenantId,
        userId: ids.userId,
        sessionId: ids.sessionId,
        eventId: `${ids.sessionId}:event-1`,
        type: 'assistant.message',
        payload: { messageId: 'm-1', content: 'first' },
      }),
      store.appendWorkspaceEvent({
        tenantId: ids.tenantId,
        userId: ids.userId,
        sessionId: secondSessionId,
        eventId: `${secondSessionId}:event-1`,
        type: 'assistant.message',
        payload: { messageId: 'm-2', content: 'second' },
      }),
      store.appendWorkspaceEvent({
        tenantId: ids.tenantId,
        userId: ids.userId,
        sessionId: ids.sessionId,
        eventId: `${ids.sessionId}:event-2`,
        type: 'assistant.message',
        payload: { messageId: 'm-3', content: 'third' },
      }),
    ])

    assert.deepEqual(
      writes.map((event) => event.sequence).sort((left, right) => left - right),
      [1, 2, 3],
    )
    assert.deepEqual(
      (await store.listWorkspaceEvents(ids.tenantId, ids.userId, 0)).map((event) => event.sequence),
      [1, 2, 3],
    )
  })
})

test('real Postgres cloud store keeps session commands idempotent and lease-fenced', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const lease = await store.claimSessionLease(
      ids.tenantId,
      ids.sessionId,
      'worker-command-owner',
      new Date('2026-01-01T00:00:00.000Z'),
      30_000,
    )
    assert.ok(lease)

    const commands = await Promise.all(Array.from({ length: 8 }, () => (
      store.enqueueSessionCommand({
        commandId: `${ids.tenantId}-cmd`,
        tenantId: ids.tenantId,
        userId: ids.userId,
        sessionId: ids.sessionId,
        kind: 'prompt',
        payload: { text: 'run this once' },
      })
    )))
    assert.equal(new Set(commands.map((command) => command.createdSequence)).size, 1)
    assert.equal(new Set(commands.map((command) => command.commandId)).size, 1)
    assert.equal(commands[0]?.status, 'pending')

    await assert.rejects(
      () => store.enqueueSessionCommand({
        commandId: `${ids.tenantId}-cmd`,
        tenantId: ids.tenantId,
        userId: ids.userId,
        sessionId: ids.sessionId,
        kind: 'prompt',
        payload: { text: 'different command body' },
      }),
      /reused/,
    )

    const claims = await Promise.all(Array.from({ length: 8 }, () => store.claimNextSessionCommand(lease)))
    const claimed = claims.filter((command) => command !== null)
    assert.equal(claimed.length, 1)
    assert.equal(claimed[0]?.claimedLeaseToken, lease.leaseToken)

    const takeoverLease = await store.claimSessionLease(
      ids.tenantId,
      ids.sessionId,
      'worker-command-takeover',
      new Date('2026-01-01T00:00:31.000Z'),
      30_000,
    )
    assert.ok(takeoverLease)
    await assert.rejects(
      () => store.ackSessionCommand(lease, `${ids.tenantId}-cmd`),
      /stale/,
    )

    const reclaimed = await store.claimNextSessionCommand(takeoverLease)
    assert.equal(reclaimed?.commandId, `${ids.tenantId}-cmd`)
    assert.equal(reclaimed?.claimedLeaseToken, takeoverLease.leaseToken)
    assert.equal((await store.ackSessionCommand(takeoverLease, `${ids.tenantId}-cmd`)).status, 'acked')
  })
})

test('real Postgres cloud store keeps channel identities, cursors, and delivery claims atomic', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const org = await store.ensureOrgForTenant({ tenantId: ids.tenantId, name: 'Tenant' })
    const agent = await store.createHeadlessAgent({
      agentId: `${ids.tenantId}-agent`,
      orgId: org.orgId,
      tenantId: ids.tenantId,
      profileName: 'data-analyst',
      name: 'Data analyst',
      createdByAccountId: ids.userId,
    })
    const channelBinding = await store.createChannelBinding({
      bindingId: `${ids.tenantId}-telegram`,
      orgId: org.orgId,
      agentId: agent.agentId,
      provider: 'telegram',
      externalWorkspaceId: 'bot-1',
      displayName: 'Telegram',
    })

    const identities = await Promise.all(Array.from({ length: 6 }, (_, index) => (
      store.upsertChannelIdentity({
        orgId: org.orgId,
        provider: 'telegram',
        externalWorkspaceId: 'bot-1',
        externalUserId: 'tg-user-1',
        accountId: ids.userId,
        role: index % 2 === 0 ? 'member' : 'approver',
        status: 'active',
        metadata: { index },
      })
    )))
    assert.equal(new Set(identities.map((identity) => identity.identityId)).size, 1)
    assert.equal((await store.findChannelIdentity({
      orgId: org.orgId,
      provider: 'telegram',
      externalWorkspaceId: 'bot-1',
      externalUserId: 'tg-user-1',
    }))?.status, 'active')

    const sessionBinding = await store.bindChannelSession({
      bindingId: `${ids.tenantId}-channel-session`,
      orgId: org.orgId,
      agentId: agent.agentId,
      channelBindingId: channelBinding.bindingId,
      provider: 'telegram',
      externalWorkspaceId: 'bot-1',
      externalChatId: 'chat-1',
      externalThreadId: 'thread-1',
      sessionId: ids.sessionId,
    })
    assert.equal((await store.updateChannelCursor({
      orgId: org.orgId,
      bindingId: sessionBinding.bindingId,
      lastEventSequence: 10,
      lastWorkspaceSequence: 8,
    }))?.lastEventSequence, 10)
    assert.equal(await store.updateChannelCursor({
      orgId: org.orgId,
      bindingId: sessionBinding.bindingId,
      lastEventSequence: 9,
      lastWorkspaceSequence: 8,
    }), null)

    await store.createChannelDelivery({
      deliveryId: `${ids.tenantId}-delivery`,
      orgId: org.orgId,
      agentId: agent.agentId,
      channelBindingId: channelBinding.bindingId,
      sessionBindingId: sessionBinding.bindingId,
      provider: 'telegram',
      target: { externalChatId: 'chat-1' },
      eventType: 'workflow.completed',
      payload: { runId: 'run-1' },
      nextAttemptAt: new Date('2026-01-01T00:00:10.000Z'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    assert.equal(await store.claimNextChannelDelivery({
      orgId: org.orgId,
      claimedBy: 'gateway-early',
      now: new Date('2026-01-01T00:00:01.000Z'),
      ttlMs: 30_000,
    }), null)
    const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => (
      store.claimNextChannelDelivery({
        orgId: org.orgId,
        claimedBy: `gateway-${index}`,
        now: new Date('2026-01-01T00:00:10.000Z'),
        ttlMs: 30_000,
      })
    )))
    const claimed = claims.filter((delivery) => delivery !== null)
    assert.equal(claimed.length, 1)
    assert.equal(claimed[0]?.deliveryId, `${ids.tenantId}-delivery`)
    assert.equal((await store.ackChannelDelivery({
      orgId: org.orgId,
      deliveryId: `${ids.tenantId}-delivery`,
      claimedBy: claimed[0]?.claimedBy,
      status: 'sent',
      updatedAt: new Date('2026-01-01T00:00:02.000Z'),
    }))?.status, 'sent')
  })
})

test('real Postgres cloud store atomically claims one due scheduled workflow across schedulers', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const workflowId = `${ids.tenantId}-workflow`
    await store.createWorkflow({
      tenantId: ids.tenantId,
      userId: ids.userId,
      workflowId,
      draft: {
        title: 'Scheduled revenue',
        instructions: 'Run on schedule.',
        agentName: 'data-analyst',
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
      nextRunAt: '2026-01-01T09:00:00.000Z',
    })

    const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => (
      store.claimDueWorkflowRun({
        runId: `${ids.tenantId}-run-${index}`,
        now: new Date('2026-01-01T09:00:00.000Z'),
      })
    )))
    const claimed = claims.filter((entry) => entry !== null)

    assert.equal(claimed.length, 1)
    assert.equal(claimed[0]?.workflow.status, 'running')
    assert.equal(claimed[0]?.run.status, 'queued')
    assert.equal((await store.listWorkflowRuns(ids.tenantId, workflowId)).length, 1)
    assert.equal((await store.getWorkflowForTenant(ids.tenantId, workflowId))?.status, 'running')
  })
})

test('real Postgres webhook replay claims are atomic across public replicas', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const replayKey = `${ids.tenantId}:webhook-signature`
    const claims = await Promise.all(Array.from({ length: 8 }, () => (
      store.claimSignature({
        key: replayKey,
        nowMs: Date.parse('2026-01-01T00:00:00.000Z'),
        windowMs: 300_000,
        cacheLimit: 512,
      })
    )))
    const claimed = claims.filter((entry) => entry !== null)

    assert.equal(claimed.length, 1)
    await claimed[0]?.accept()
    assert.equal(await store.claimSignature({
      key: replayKey,
      nowMs: Date.parse('2026-01-01T00:01:00.000Z'),
      windowMs: 300_000,
      cacheLimit: 512,
    }), null)
  })
})
