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

async function withIsolatedPostgresStore<T>(fn: (store: Awaited<ReturnType<typeof createPostgresControlPlaneStore>>, ids: {
  tenantId: string
  userId: string
  sessionId: string
}) => Promise<T>) {
  return await withIsolatedPostgresSchema(async (connectionString) => {
    const store = await createPostgresControlPlaneStore({ connectionString })
    const prefix = `pg-${randomUUID()}`
    const ids = {
      tenantId: `${prefix}-tenant`,
      userId: `${prefix}-user`,
      sessionId: `${prefix}-session`,
    }
    try {
      await store.createTenant({ tenantId: ids.tenantId, name: 'Postgres isolated concurrency test' })
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
  })
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
        '008_managed_workers',
        '009_managed_work_claims',
        '011_channel_provider_events',
        '010_managed_work_reaper_indexes',
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
    assert.equal(first.status, 'pending_validation')
    const activeFirst = await store.recordByokSecretValidation({
      orgId: org.orgId,
      providerId: 'anthropic',
      secretId: first.secretId,
      status: 'active',
    })
    assert.equal(activeFirst?.status, 'active')
    const second = await store.createByokSecret({
      secretId: `${ids.tenantId}-byok-2`,
      orgId: org.orgId,
      providerId: 'anthropic',
      ciphertext: 'enc:v1:second',
      last4: '2222',
      keyFingerprint: 'fingerprint-2',
    })
    assert.equal(second.status, 'pending_validation')
    assert.equal(second.rotatedFromSecretId, first.secretId)
    const activeSecond = await store.recordByokSecretValidation({
      orgId: org.orgId,
      providerId: 'anthropic',
      secretId: second.secretId,
      status: 'active',
    })
    assert.equal(activeSecond?.status, 'active')
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
    const now = new Date('2030-01-01T00:00:00.000Z')
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
      new Date('2030-01-01T00:00:31.000Z'),
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

    const commandAttempts = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
      try {
        await store.enqueueSessionCommand({
          commandId: `${ids.tenantId}-queue-cmd-${index}`,
          tenantId: ids.tenantId,
          userId: ids.userId,
          sessionId: ids.sessionId,
          kind: 'prompt',
          payload: { text: `prompt ${index}` },
          quota: {
            orgId: ids.tenantId,
            maxQueuedCommandsPerOrg: 2,
            policyCode: 'quota.queued_commands_exceeded',
          },
        })
        return 'queued'
      } catch (error) {
        assert.equal(error instanceof ControlPlaneQuotaExceededError, true)
        assert.equal((error as ControlPlaneQuotaExceededError).policyCode, 'quota.queued_commands_exceeded')
        return 'blocked'
      }
    }))
    assert.equal(commandAttempts.filter((result) => result === 'queued').length, 2)
    assert.equal(commandAttempts.filter((result) => result === 'blocked').length, 3)

    const workflowIds = Array.from({ length: 5 }, (_, index) => `${ids.tenantId}-workflow-quota-${index}`)
    await Promise.all(workflowIds.map((workflowId, index) => store.createWorkflow({
      tenantId: ids.tenantId,
      userId: ids.userId,
      workflowId,
      draft: {
        title: `Workflow quota ${index}`,
        instructions: 'Respect workflow quotas.',
        agentName: 'data-analyst',
        skillNames: [],
        toolIds: [],
        projectDirectory: null,
        draftSessionId: null,
        triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
      },
    })))
    const createdWorkflowRuns: Array<{ workflowId: string; runId: string }> = []
    const workflowAttempts = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
      const workflowId = workflowIds[index]
      const runId = `${ids.tenantId}-workflow-quota-run-${index}`
      try {
        await store.createWorkflowRun({
          tenantId: ids.tenantId,
          userId: ids.userId,
          workflowId,
          runId,
          triggerType: 'manual',
          quota: {
            orgId: ids.tenantId,
            maxConcurrentWorkflowRunsPerOrg: 2,
            maxWorkflowRunsPerHour: 20,
          },
        })
        createdWorkflowRuns.push({ workflowId, runId })
        return 'queued'
      } catch (error) {
        assert.equal(error instanceof ControlPlaneQuotaExceededError, true)
        assert.equal((error as ControlPlaneQuotaExceededError).policyCode, 'quota.concurrent_workflow_runs_exceeded')
        return 'blocked'
      }
    }))
    assert.equal(workflowAttempts.filter((result) => result === 'queued').length, 2)
    assert.equal(workflowAttempts.filter((result) => result === 'blocked').length, 3)
    await Promise.all(createdWorkflowRuns.map(({ workflowId, runId }) => store.failWorkflowRun({
      tenantId: ids.tenantId,
      workflowId,
      runId,
      error: 'test cleanup',
      nextStatus: 'active',
      nextRunAt: null,
    })))

    const customTenantId = `${ids.tenantId}-custom-org-tenant`
    const customOrgId = `${ids.tenantId}-custom-org`
    const customUserId = `${ids.userId}-custom-org-user`
    const customSessionId = `${ids.sessionId}-custom-org-session`
    await store.createTenant({ tenantId: customTenantId, name: 'Custom org tenant' })
    const rawPool = pgPool(POSTGRES_URL!)
    try {
      await rawPool.query(
        `UPDATE cloud_orgs SET org_id = $1 WHERE tenant_id = $2`,
        [customOrgId, customTenantId],
      )
    } finally {
      await rawPool.end()
    }
    await store.ensureUser({
      tenantId: customTenantId,
      userId: customUserId,
      email: `${customUserId}@example.test`,
      role: 'owner',
    })
    await store.createSession({
      tenantId: customTenantId,
      userId: customUserId,
      sessionId: customSessionId,
      opencodeSessionId: `${customSessionId}-oc`,
      profileName: 'full',
    })
    await store.enqueueSessionCommand({
      commandId: `${customTenantId}-queue-cmd-1`,
      tenantId: customTenantId,
      userId: customUserId,
      sessionId: customSessionId,
      kind: 'prompt',
      payload: { text: 'custom org queued prompt' },
      quota: {
        maxQueuedCommandsPerOrg: 1,
        policyCode: 'quota.queued_commands_exceeded',
      },
    })
    await assert.rejects(() => store.enqueueSessionCommand({
      commandId: `${customTenantId}-queue-cmd-2`,
      tenantId: customTenantId,
      userId: customUserId,
      sessionId: customSessionId,
      kind: 'prompt',
      payload: { text: 'custom org blocked prompt' },
      quota: {
        maxQueuedCommandsPerOrg: 1,
        policyCode: 'quota.queued_commands_exceeded',
      },
    }), (error) => (
      error instanceof ControlPlaneQuotaExceededError
      && error.policyCode === 'quota.queued_commands_exceeded'
    ))

    const customWorkflowIds = ['a', 'b', 'c'].map((suffix) => `${customTenantId}-workflow-${suffix}`)
    await Promise.all(customWorkflowIds.map((workflowId) => store.createWorkflow({
      tenantId: customTenantId,
      userId: customUserId,
      workflowId,
      draft: {
        title: `Custom org workflow ${workflowId}`,
        instructions: 'Respect custom org workflow quotas.',
        agentName: 'data-analyst',
        skillNames: [],
        toolIds: [],
        projectDirectory: null,
        draftSessionId: null,
        triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
      },
    })))
    await store.createWorkflowRun({
      tenantId: customTenantId,
      userId: customUserId,
      workflowId: customWorkflowIds[0]!,
      runId: `${customTenantId}-workflow-run-1`,
      triggerType: 'manual',
      quota: {
        maxConcurrentWorkflowRunsPerOrg: 1,
        maxWorkflowRunsPerHour: 10,
      },
    })
    await assert.rejects(() => store.createWorkflowRun({
      tenantId: customTenantId,
      userId: customUserId,
      workflowId: customWorkflowIds[1]!,
      runId: `${customTenantId}-workflow-run-2`,
      triggerType: 'manual',
      quota: {
        maxConcurrentWorkflowRunsPerOrg: 1,
        maxWorkflowRunsPerHour: 10,
      },
    }), (error) => (
      error instanceof ControlPlaneQuotaExceededError
      && error.policyCode === 'quota.concurrent_workflow_runs_exceeded'
    ))
    await store.failWorkflowRun({
      tenantId: customTenantId,
      workflowId: customWorkflowIds[0]!,
      runId: `${customTenantId}-workflow-run-1`,
      error: 'custom org quota cleanup',
      nextStatus: 'active',
      nextRunAt: null,
    })
    await store.createWorkflowRun({
      tenantId: customTenantId,
      userId: customUserId,
      workflowId: customWorkflowIds[2]!,
      runId: `${customTenantId}-workflow-run-3`,
      triggerType: 'manual',
      quota: {
        maxConcurrentWorkflowRunsPerOrg: 10,
        maxWorkflowRunsPerHour: 10,
      },
    })
    const customCounters = await store.listUsageQuotaCounters(customOrgId)
    assert.equal(customCounters.some((counter) => counter.quotaKey === 'workflow_runs:hour'), true)
    await store.failWorkflowRun({
      tenantId: customTenantId,
      workflowId: customWorkflowIds[2]!,
      runId: `${customTenantId}-workflow-run-3`,
      error: 'custom org quota cleanup',
      nextStatus: 'active',
      nextRunAt: null,
    })
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
    assert.deepEqual(await store.getWorkspaceEventCursor(ids.tenantId, ids.userId), {
      earliestSequence: 1,
      latestSequence: 3,
    })
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
      new Date('2030-01-01T00:00:00.000Z'),
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
      new Date('2030-01-01T00:00:31.000Z'),
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

test('real Postgres cloud store reaps expired session leases with bounded retries', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const firstLeaseStart = new Date('2030-01-01T00:00:00.000Z')
    const firstLeaseExpired = new Date('2030-01-01T00:00:02.000Z')
    const secondLeaseStart = new Date('2030-01-01T00:00:03.000Z')
    const secondLeaseExpired = new Date('2030-01-01T00:00:05.000Z')

    await store.enqueueSessionCommand({
      commandId: `${ids.tenantId}-reap-cmd`,
      tenantId: ids.tenantId,
      userId: ids.userId,
      sessionId: ids.sessionId,
      kind: 'prompt',
      payload: { text: 'retry this command' },
    })
    const firstLease = await store.claimSessionLease(ids.tenantId, ids.sessionId, 'worker-reap-a', firstLeaseStart, 1_000)
    assert.ok(firstLease)
    assert.equal((await store.claimNextSessionCommand(firstLease, firstLeaseStart))?.attemptCount, 1)

    const retried = (await store.reapExpiredSessionLeases({ maxCommandAttempts: 2, now: firstLeaseExpired }))
      .find((record) => record.tenantId === ids.tenantId && record.sessionId === ids.sessionId)
    assert.equal(retried?.action, 'retried')
    assert.deepEqual(retried?.retriedCommandIds, [`${ids.tenantId}-reap-cmd`])

    const secondLease = await store.claimSessionLease(ids.tenantId, ids.sessionId, 'worker-reap-b', secondLeaseStart, 1_000)
    assert.ok(secondLease)
    assert.equal((await store.claimNextSessionCommand(secondLease, secondLeaseStart))?.attemptCount, 2)

    const failed = (await store.reapExpiredSessionLeases({ maxCommandAttempts: 2, now: secondLeaseExpired }))
      .find((record) => record.tenantId === ids.tenantId && record.sessionId === ids.sessionId)
    assert.equal(failed?.action, 'failed')
    assert.deepEqual(failed?.failedCommandIds, [`${ids.tenantId}-reap-cmd`])
    assert.equal((await store.getSessionForTenant(ids.tenantId, ids.sessionId))?.status, 'errored')
  })
})

test('real Postgres cloud store limits expired session lease reaping to oldest leases', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withIsolatedPostgresStore(async (store, ids) => {
    await store.createSession({
      tenantId: ids.tenantId,
      userId: ids.userId,
      sessionId: `${ids.tenantId}-session-2`,
      opencodeSessionId: `${ids.tenantId}-opencode-2`,
      profileName: 'full',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    })
    await store.createSession({
      tenantId: ids.tenantId,
      userId: ids.userId,
      sessionId: `${ids.tenantId}-session-3`,
      opencodeSessionId: `${ids.tenantId}-opencode-3`,
      profileName: 'full',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    })

    assert.ok(await store.claimSessionLease(ids.tenantId, ids.sessionId, 'worker-limit', new Date('2030-01-01T00:00:00.000Z'), 1_000))
    assert.ok(await store.claimSessionLease(ids.tenantId, `${ids.tenantId}-session-2`, 'worker-limit', new Date('2030-01-01T00:00:01.000Z'), 1_000))
    assert.ok(await store.claimSessionLease(ids.tenantId, `${ids.tenantId}-session-3`, 'worker-limit', new Date('2030-01-01T00:00:02.000Z'), 1_000))

    const first = (await store.reapExpiredSessionLeases({
      limit: 2,
      now: new Date('2030-01-01T00:00:05.000Z'),
    })).filter((record) => record.tenantId === ids.tenantId)
    assert.deepEqual(first.map((record) => record.sessionId), [
      ids.sessionId,
      `${ids.tenantId}-session-2`,
    ])

    const second = (await store.reapExpiredSessionLeases({
      limit: 2,
      now: new Date('2030-01-01T00:00:05.000Z'),
    })).filter((record) => record.tenantId === ids.tenantId)
    assert.deepEqual(second.map((record) => record.sessionId), [`${ids.tenantId}-session-3`])
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
    const updatedCursor = await store.updateChannelCursor({
      orgId: org.orgId,
      bindingId: sessionBinding.bindingId,
      lastEventSequence: 10,
      lastWorkspaceSequence: 8,
    })
    assert.equal(updatedCursor.ok, true)
    if (!updatedCursor.ok) assert.fail(`Expected cursor update to succeed, got ${updatedCursor.reason}`)
    assert.equal(updatedCursor.binding.lastEventSequence, 10)
    const staleCursor = await store.updateChannelCursor({
      orgId: org.orgId,
      bindingId: sessionBinding.bindingId,
      lastEventSequence: 9,
      lastWorkspaceSequence: 8,
    })
    assert.equal(staleCursor.ok, false)
    if (staleCursor.ok) assert.fail('Expected stale cursor update to be rejected.')
    assert.equal(staleCursor.reason, 'stale')
    assert.equal(staleCursor.binding.lastEventSequence, 10)

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

test('real Postgres cloud store atomically claims one provider event across gateways', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const org = await store.ensureOrgForTenant({ tenantId: ids.tenantId, name: 'Provider events' })
    const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => (
      store.claimChannelProviderEvent({
        orgId: org.orgId,
        provider: 'telegram',
        providerInstanceId: 'telegram-prod',
        externalWorkspaceId: 'bot-1',
        providerEventId: `${ids.tenantId}-event`,
        eventType: 'message',
        claimedBy: `gateway-${index}`,
        ttlMs: 30_000,
        now: new Date('2026-01-01T00:00:00.000Z'),
      })
    )))
    assert.equal(claims.filter((claim) => claim.claimed).length, 1)
    assert.equal(claims.filter((claim) => claim.duplicate).length, 7)
    const winner = claims.find((claim) => claim.claimed)
    assert.ok(winner)
    assert.equal(winner.event.status, 'processing')
    assert.equal((await store.completeChannelProviderEvent({
      orgId: org.orgId,
      eventId: winner.event.eventId,
      claimedBy: winner.event.claimedBy,
      status: 'processed',
      updatedAt: new Date('2026-01-01T00:00:01.000Z'),
    }))?.status, 'processed')
    const duplicate = await store.claimChannelProviderEvent({
      orgId: org.orgId,
      provider: 'telegram',
      providerInstanceId: 'telegram-prod',
      externalWorkspaceId: 'bot-1',
      providerEventId: `${ids.tenantId}-event`,
      eventType: 'message',
      claimedBy: 'gateway-late',
      now: new Date('2026-01-01T00:00:02.000Z'),
    })
    assert.equal(duplicate.claimed, false)
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.event.status, 'processed')
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

test('real Postgres cloud store retries and fails expired workflow start claims', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const workflowId = `${ids.tenantId}-workflow-claim-retry`
    const retryRunId = `${ids.tenantId}-workflow-retry-run`
    await store.createWorkflow({
      tenantId: ids.tenantId,
      userId: ids.userId,
      workflowId,
      draft: {
        title: 'Workflow claim retry',
        instructions: 'Retry failed scheduler starts.',
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
      nextRunAt: '2030-01-01T09:00:00.000Z',
    })
    const first = await store.claimDueWorkflowRun({
      runId: retryRunId,
      claimedBy: 'scheduler-a',
      leaseTtlMs: 1,
      now: new Date('2030-01-01T09:00:00.000Z'),
    })
    assert.ok(first?.run.claimToken)
    const firstToken = first.run.claimToken

    const retried = (await store.reapExpiredWorkflowClaims({
      maxAttempts: 2,
      now: new Date('2030-01-01T09:00:00.002Z'),
    })).find((record) => record.tenantId === ids.tenantId && record.runId === retryRunId)
    assert.equal(retried?.action, 'retried')

    let second: Awaited<ReturnType<typeof store.claimDueWorkflowRun>> = null
    for (let attempt = 0; attempt < 5 && !second; attempt += 1) {
      const candidate = await store.claimDueWorkflowRun({
        runId: `${ids.tenantId}-unused-run-${attempt}`,
        claimedBy: 'scheduler-b',
        leaseTtlMs: 1,
        now: new Date('2030-01-01T09:00:00.003Z'),
      })
      if (candidate?.run.id === retryRunId) second = candidate
    }
    assert.equal(second?.run.id, retryRunId)
    assert.equal(second?.run.attemptCount, 2)
    assert.notEqual(second?.run.claimToken, firstToken)
    await assert.rejects(
      () => store.attachWorkflowRunSession({
        tenantId: ids.tenantId,
        workflowId,
        runId: retryRunId,
        sessionId: ids.sessionId,
        claimToken: firstToken,
      }),
      /stale/,
    )

    const failed = (await store.reapExpiredWorkflowClaims({
      maxAttempts: 2,
      now: new Date('2030-01-01T09:00:00.005Z'),
    })).find((record) => record.tenantId === ids.tenantId && record.runId === retryRunId)
    assert.equal(failed?.action, 'failed')
    assert.equal((await store.getWorkflowForTenant(ids.tenantId, workflowId))?.status, 'failed')
    assert.equal((await store.getWorkflowRun(ids.tenantId, retryRunId))?.status, 'failed')
  })
})

test('real Postgres cloud store limits expired workflow claim reaping to oldest claims', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withIsolatedPostgresStore(async (store, ids) => {
    for (const index of [1, 2, 3]) {
      const workflowId = `${ids.tenantId}-workflow-claim-limit-${index}`
      await store.createWorkflow({
        tenantId: ids.tenantId,
        userId: ids.userId,
        workflowId,
        draft: {
          title: `Workflow claim limit ${index}`,
          instructions: 'Exercise bounded Postgres workflow-claim reaping.',
          agentName: 'data-analyst',
          skillNames: [],
          toolIds: [],
          projectDirectory: null,
          draftSessionId: null,
          triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
        },
      })
      const run = await store.createWorkflowRun({
        tenantId: ids.tenantId,
        userId: ids.userId,
        workflowId,
        runId: `${ids.tenantId}-workflow-run-claim-limit-${index}`,
        triggerType: 'manual',
        claimedBy: `scheduler-${index}`,
        leaseTtlMs: 1,
        createdAt: new Date(`2030-01-01T09:00:0${index}.000Z`),
      })
      assert.ok(run.claimToken)
    }

    const first = (await store.reapExpiredWorkflowClaims({
      limit: 2,
      now: new Date('2030-01-01T09:00:10.000Z'),
    })).filter((record) => record.tenantId === ids.tenantId)
    assert.deepEqual(first.map((record) => record.runId), [
      `${ids.tenantId}-workflow-run-claim-limit-1`,
      `${ids.tenantId}-workflow-run-claim-limit-2`,
    ])

    const second = (await store.reapExpiredWorkflowClaims({
      limit: 2,
      now: new Date('2030-01-01T09:00:10.000Z'),
    })).filter((record) => record.tenantId === ids.tenantId)
    assert.deepEqual(second.map((record) => record.runId), [`${ids.tenantId}-workflow-run-claim-limit-3`])
  })
})

test('real Postgres cloud store fences workflow finalization by active worker lease', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const workflowId = `${ids.tenantId}-workflow-fenced-finalize`
    const runId = `${ids.tenantId}-run-fenced-finalize`
    await store.createWorkflow({
      tenantId: ids.tenantId,
      userId: ids.userId,
      workflowId,
      draft: {
        title: 'Fenced workflow',
        instructions: 'Finalize once.',
        agentName: 'data-analyst',
        skillNames: [],
        toolIds: [],
        projectDirectory: null,
        draftSessionId: null,
        triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
      },
    })
    await store.createWorkflowRun({
      tenantId: ids.tenantId,
      userId: ids.userId,
      workflowId,
      runId,
      triggerType: 'manual',
    })
    await store.attachWorkflowRunSession({
      tenantId: ids.tenantId,
      workflowId,
      runId,
      sessionId: ids.sessionId,
    })
    const staleLease = await store.claimSessionLease(
      ids.tenantId,
      ids.sessionId,
      'pg-worker-stale',
      new Date('2030-01-01T09:00:00.000Z'),
      1,
    )
    assert.ok(staleLease)
    const currentLease = await store.claimSessionLease(
      ids.tenantId,
      ids.sessionId,
      'pg-worker-current',
      new Date('2030-01-01T09:00:00.002Z'),
      30_000,
    )
    assert.ok(currentLease)

    await assert.rejects(
      () => store.completeWorkflowRun({
        tenantId: ids.tenantId,
        workflowId,
        runId,
        summary: 'stale result',
        nextStatus: 'active',
        nextRunAt: null,
        leaseToken: staleLease.leaseToken,
      }),
      /stale/,
    )
    assert.equal((await store.getWorkflowRun(ids.tenantId, runId))?.status, 'running')

    const completed = await store.completeWorkflowRun({
      tenantId: ids.tenantId,
      workflowId,
      runId,
      summary: 'current result',
      nextStatus: 'active',
      nextRunAt: null,
      leaseToken: currentLease.leaseToken,
    })
    assert.equal(completed?.status, 'completed')
    assert.equal(completed?.summary, 'current result')
  })
})

test('real Postgres cloud store recovers expired webhook workflow start claims', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const workflowId = `${ids.tenantId}-webhook-workflow-claim-retry`
    const retryRunId = `${ids.tenantId}-webhook-workflow-retry-run`
    await store.createWorkflow({
      tenantId: ids.tenantId,
      userId: ids.userId,
      workflowId,
      draft: {
        title: 'Webhook claim retry',
        instructions: 'Retry failed webhook starts.',
        agentName: 'data-analyst',
        skillNames: [],
        toolIds: [],
        projectDirectory: null,
        draftSessionId: null,
        triggers: [{
          id: 'webhook-1',
          type: 'webhook',
          enabled: true,
          webhookSecret: 'secret',
        }],
      },
    })
    const first = await store.createWorkflowRun({
      tenantId: ids.tenantId,
      userId: ids.userId,
      workflowId,
      runId: retryRunId,
      triggerType: 'webhook',
      triggerPayload: { source: 'test' },
      claimedBy: `workflow-webhook:${workflowId}`,
      leaseTtlMs: 1,
      createdAt: new Date('2030-01-01T09:00:00.000Z'),
    })
    assert.ok(first.claimToken)

    const retried = (await store.reapExpiredWorkflowClaims({
      maxAttempts: 2,
      now: new Date('2030-01-01T09:00:00.002Z'),
    })).find((record) => record.tenantId === ids.tenantId && record.runId === retryRunId)
    assert.equal(retried?.action, 'retried')

    let second: Awaited<ReturnType<typeof store.claimDueWorkflowRun>> = null
    for (let attempt = 0; attempt < 5 && !second; attempt += 1) {
      const candidate = await store.claimDueWorkflowRun({
        runId: `${ids.tenantId}-unused-webhook-run-${attempt}`,
        claimedBy: 'scheduler-recovery',
        now: new Date('2030-01-01T09:00:00.003Z'),
      })
      if (candidate?.run.id === retryRunId) second = candidate
    }
    assert.equal(second?.run.id, retryRunId)
    assert.equal(second?.run.triggerType, 'webhook')
    assert.equal(second?.run.attemptCount, 2)
    assert.notEqual(second?.run.claimToken, first.claimToken)
  })
})

test('real Postgres cloud store rejects stale workflow attaches after expired claims are cleared', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const workflowId = `${ids.tenantId}-workflow-stale-attach`
    const runId = `${ids.tenantId}-stale-attach-run`
    await store.createWorkflow({
      tenantId: ids.tenantId,
      userId: ids.userId,
      workflowId,
      draft: {
        title: 'Stale attach workflow',
        instructions: 'Do not attach stale starters.',
        agentName: 'data-analyst',
        skillNames: [],
        toolIds: [],
        projectDirectory: null,
        draftSessionId: null,
        triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
      },
    })
    const first = await store.createWorkflowRun({
      tenantId: ids.tenantId,
      userId: ids.userId,
      workflowId,
      runId,
      triggerType: 'manual',
      claimedBy: `workflow-api:${ids.userId}`,
      leaseTtlMs: 1,
      createdAt: new Date('2030-01-01T09:00:00.000Z'),
    })
    assert.ok(first.claimToken)
    assert.equal((await store.reapExpiredWorkflowClaims({
      maxAttempts: 2,
      now: new Date('2030-01-01T09:00:00.002Z'),
    })).find((record) => record.tenantId === ids.tenantId && record.runId === runId)?.action, 'retried')
    assert.equal((await store.getWorkflowRun(ids.tenantId, runId))?.claimToken, null)
    await assert.rejects(
      () => store.attachWorkflowRunSession({
        tenantId: ids.tenantId,
        workflowId,
        runId,
        sessionId: ids.sessionId,
        claimToken: first.claimToken,
      }),
      /stale/,
    )

    const terminalWorkflowId = `${ids.tenantId}-workflow-terminal-stale-attach`
    const terminalRunId = `${ids.tenantId}-terminal-stale-attach-run`
    await store.createWorkflow({
      tenantId: ids.tenantId,
      userId: ids.userId,
      workflowId: terminalWorkflowId,
      draft: {
        title: 'Terminal stale attach workflow',
        instructions: 'Do not attach failed runs.',
        agentName: 'data-analyst',
        skillNames: [],
        toolIds: [],
        projectDirectory: null,
        draftSessionId: null,
        triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
      },
    })
    const terminal = await store.createWorkflowRun({
      tenantId: ids.tenantId,
      userId: ids.userId,
      workflowId: terminalWorkflowId,
      runId: terminalRunId,
      triggerType: 'manual',
      claimedBy: `workflow-api:${ids.userId}`,
      leaseTtlMs: 1,
      createdAt: new Date('2030-01-01T09:00:00.000Z'),
    })
    assert.ok(terminal.claimToken)
    assert.equal((await store.reapExpiredWorkflowClaims({
      maxAttempts: 1,
      now: new Date('2030-01-01T09:00:00.002Z'),
    })).find((record) => record.tenantId === ids.tenantId && record.runId === terminalRunId)?.action, 'failed')
    assert.equal((await store.getWorkflowRun(ids.tenantId, terminalRunId))?.status, 'failed')
    await assert.rejects(
      () => store.attachWorkflowRunSession({
        tenantId: ids.tenantId,
        workflowId: terminalWorkflowId,
        runId: terminalRunId,
        sessionId: ids.sessionId,
        claimToken: terminal.claimToken,
      }),
      /not attachable/,
    )
    await assert.rejects(
      () => store.attachWorkflowRunSession({
        tenantId: ids.tenantId,
        workflowId: terminalWorkflowId,
        runId: terminalRunId,
        sessionId: ids.sessionId,
      }),
      /not attachable/,
    )
  })
})

test('real Postgres cloud store recovers workflow starts stranded after session attachment', {
  skip: POSTGRES_SKIP,
}, async () => {
  await withPostgresStore(async (store, ids) => {
    const workflowId = `${ids.tenantId}-attached-workflow-claim-retry`
    const retryRunId = `${ids.tenantId}-attached-workflow-retry-run`
    await store.createWorkflow({
      tenantId: ids.tenantId,
      userId: ids.userId,
      workflowId,
      draft: {
        title: 'Attached claim retry',
        instructions: 'Retry command enqueue after session attach.',
        agentName: 'data-analyst',
        skillNames: [],
        toolIds: [],
        projectDirectory: null,
        draftSessionId: null,
        triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
      },
    })
    const first = await store.createWorkflowRun({
      tenantId: ids.tenantId,
      userId: ids.userId,
      workflowId,
      runId: retryRunId,
      triggerType: 'manual',
      triggerPayload: { source: 'test' },
      claimedBy: `workflow-api:${ids.userId}`,
      leaseTtlMs: 30_000,
      createdAt: new Date('2030-01-01T09:00:00.000Z'),
    })
    assert.ok(first.claimToken)
    await store.attachWorkflowRunSession({
      tenantId: ids.tenantId,
      workflowId,
      runId: retryRunId,
      sessionId: ids.sessionId,
      claimToken: first.claimToken,
      startedAt: new Date('2030-01-01T09:00:00.001Z'),
    })
    assert.equal((await store.getWorkflowRun(ids.tenantId, retryRunId))?.claimToken, null)

    let claimed: Awaited<ReturnType<typeof store.claimDueWorkflowRun>> = null
    for (let attempt = 0; attempt < 5 && !claimed; attempt += 1) {
      const candidate = await store.claimDueWorkflowRun({
        runId: `${ids.tenantId}-unused-attached-run-${attempt}`,
        claimedBy: 'scheduler-recovery',
        leaseTtlMs: 1,
        now: new Date('2030-01-01T09:00:00.002Z'),
      })
      if (candidate?.run.id === retryRunId) claimed = candidate
    }
    assert.equal(claimed?.run.id, retryRunId)
    assert.equal(claimed?.run.status, 'running')
    assert.equal(claimed?.run.sessionId, ids.sessionId)
    assert.equal(claimed?.run.attemptCount, 2)
    assert.ok(claimed?.run.claimToken)

    const retried = (await store.reapExpiredWorkflowClaims({
      maxAttempts: 3,
      now: new Date('2030-01-01T09:00:00.004Z'),
    })).find((record) => record.tenantId === ids.tenantId && record.runId === retryRunId)
    assert.equal(retried?.action, 'retried')
    assert.equal((await store.getWorkflowRun(ids.tenantId, retryRunId))?.claimToken, null)
    assert.equal((await store.getWorkflowForTenant(ids.tenantId, workflowId))?.latestRunStatus, 'running')
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
