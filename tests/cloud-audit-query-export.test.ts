import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decodeAuditQueryCursor,
  encodeAuditQueryCursor,
  InvalidAuditQueryCursorError,
  normalizeAuditQueryLimit,
  type AuditQueryCursorScope,
} from '@open-cowork/cloud-server/control-plane-store'
import {
  auditEventMatchesQuery,
  compareAuditEventsDescending,
  isAuditEventAfterCursor,
  paginateAuditEvents,
} from '@open-cowork/cloud-server/audit-query'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import {
  CloudAuditService,
  CloudPrincipalService,
  CloudRoleService,
} from '@open-cowork/cloud-server/services/index'
import type {
  AuditEventRecord,
} from '@open-cowork/cloud-server/control-plane-store'
import type {
  CloudMetricRecord,
  CloudObservabilityAdapter,
} from '@open-cowork/cloud-server/observability'
import type { CloudPrincipal } from '@open-cowork/cloud-server/session-service'

// ---------------------------------------------------------------------------
// Pure cursor + query helpers
// ---------------------------------------------------------------------------

const SCOPE: AuditQueryCursorScope = { orgId: 'org-1', eventTypePrefix: 'session.' }

test('audit query cursor: round-trips, rejects a scope mismatch, and rejects garbage', () => {
  const encoded = encodeAuditQueryCursor({ createdAt: '2026-01-01T00:00:00.000Z', eventId: 'audit_1' }, SCOPE)
  assert.deepEqual(decodeAuditQueryCursor(encoded, SCOPE), { createdAt: '2026-01-01T00:00:00.000Z', eventId: 'audit_1' })
  assert.equal(decodeAuditQueryCursor(null, SCOPE), null)
  assert.equal(decodeAuditQueryCursor(undefined, SCOPE), null)
  // A cursor is only valid for the identical filter scope it was minted for.
  assert.throws(() => decodeAuditQueryCursor(encoded, { orgId: 'org-1', eventTypePrefix: 'command.' }), InvalidAuditQueryCursorError)
  assert.throws(() => decodeAuditQueryCursor('!!!not-base64-json', SCOPE), InvalidAuditQueryCursorError)
  assert.throws(() => decodeAuditQueryCursor(Buffer.from('{"v":1}', 'utf8').toString('base64url'), SCOPE), InvalidAuditQueryCursorError)
})

test('audit query helpers: limit clamp, filter matching, ordering, keyset, pagination', () => {
  assert.equal(normalizeAuditQueryLimit(undefined), 100)
  assert.equal(normalizeAuditQueryLimit(0), 1)
  assert.equal(normalizeAuditQueryLimit(-5), 1)
  assert.equal(normalizeAuditQueryLimit(5000), 500)
  assert.equal(normalizeAuditQueryLimit(42), 42)

  const base: AuditEventRecord = {
    eventId: 'audit_b', orgId: 'org-1', accountId: 'acc-1', actorType: 'user', actorId: 'user-1',
    eventType: 'session.created', targetType: 'session', targetId: 'sess-1',
    metadata: { result: 'success' }, createdAt: '2026-03-02T00:00:00.000Z',
  }
  assert.equal(auditEventMatchesQuery(base, { orgId: 'org-1', actorId: 'user-1' }), true)
  assert.equal(auditEventMatchesQuery(base, { orgId: 'org-1', actorId: 'other' }), false)
  assert.equal(auditEventMatchesQuery(base, { orgId: 'org-1', actorType: 'system' }), false)
  assert.equal(auditEventMatchesQuery(base, { orgId: 'org-1', eventTypePrefix: 'session.' }), true)
  assert.equal(auditEventMatchesQuery(base, { orgId: 'org-1', eventTypePrefix: 'command.' }), false)
  assert.equal(auditEventMatchesQuery(base, { orgId: 'org-1', targetType: 'session', targetId: 'sess-1' }), true)
  assert.equal(auditEventMatchesQuery(base, { orgId: 'org-1', targetId: 'other' }), false)
  assert.equal(auditEventMatchesQuery(base, { orgId: 'org-1', result: 'success' }), true)
  assert.equal(auditEventMatchesQuery(base, { orgId: 'org-1', result: 'failure' }), false)
  assert.equal(auditEventMatchesQuery(base, { orgId: 'org-1', from: new Date('2026-03-01T00:00:00.000Z') }), true)
  assert.equal(auditEventMatchesQuery(base, { orgId: 'org-1', from: new Date('2026-03-03T00:00:00.000Z') }), false)
  assert.equal(auditEventMatchesQuery(base, { orgId: 'org-1', to: new Date('2026-03-01T00:00:00.000Z') }), false)

  const older: AuditEventRecord = { ...base, eventId: 'audit_a', createdAt: '2026-03-01T00:00:00.000Z' }
  const sameStampLower: AuditEventRecord = { ...base, eventId: 'audit_a' }
  assert.ok(compareAuditEventsDescending(base, older) < 0) // base is newer → sorts first
  assert.ok(compareAuditEventsDescending(base, sameStampLower) < 0) // equal stamp, higher eventId first
  assert.equal(isAuditEventAfterCursor(older, { createdAt: base.createdAt, eventId: base.eventId }), true)
  assert.equal(isAuditEventAfterCursor(base, { createdAt: base.createdAt, eventId: base.eventId }), false)
  assert.equal(isAuditEventAfterCursor(sameStampLower, { createdAt: base.createdAt, eventId: base.eventId }), true)

  assert.deepEqual(paginateAuditEvents([base], 2), { events: [base], nextCursor: null })
  const paged = paginateAuditEvents([base, older], 1)
  assert.deepEqual(paged.events, [base])
  assert.deepEqual(paged.nextCursor, { createdAt: base.createdAt, eventId: base.eventId })
})

// ---------------------------------------------------------------------------
// Service harness
// ---------------------------------------------------------------------------

type Captured = { adapter: CloudObservabilityAdapter, metrics: CloudMetricRecord[] }

function captureObservability(): Captured {
  const metrics: CloudMetricRecord[] = []
  return {
    metrics,
    adapter: { log() {}, metric(record) { metrics.push(record) }, span() {} },
  }
}

function makeAudit(observability: Captured = captureObservability()) {
  const store = new InMemoryControlPlaneStore()
  const identityPolicy = { allowSelfServiceSignup: true }
  const principalService = new CloudPrincipalService({ store, identityPolicy })
  const ensurePrincipal = (principal: CloudPrincipal) => principalService.ensurePrincipal(principal)
  const principalOrgId = (principal: CloudPrincipal) => principalService.principalOrgId(principal)
  const roleService = new CloudRoleService({
    store,
    ensurePrincipal,
    assertPermission: (principal, permission) => principalService.assertPermission(principal, permission),
    principalOrgId,
    auditActor: (principal) => principalService.auditActor(principal),
  })
  const audit = new CloudAuditService({
    store,
    observability: observability.adapter,
    ensurePrincipal,
    assertPermission: (principal, permission) => principalService.assertPermission(principal, permission),
    assertOrgAdmin: (principal) => principalService.assertOrgAdmin(principal),
    principalOrgId,
    auditActor: (principal) => principalService.auditActor(principal),
  })
  return { store, principalService, roleService, audit, observability }
}

async function bootstrapOrg(store: InMemoryControlPlaneStore, principalService: CloudPrincipalService) {
  await store.createTenant({ tenantId: 't1', name: 'T1', orgId: 'org-1' })
  await store.ensureUser({ tenantId: 't1', userId: 'owner', email: 'owner@example.test', role: 'owner' })
  const owner: CloudPrincipal = { tenantId: 't1', userId: 'owner', email: 'owner@example.test', authSource: 'user' }
  await principalService.ensurePrincipal(owner)
  return owner
}

async function seedMember(store: InMemoryControlPlaneStore, principalService: CloudPrincipalService, accountId: string) {
  await store.createAccount({ accountId, email: `${accountId}@example.test` })
  await store.upsertMembership({ orgId: 'org-1', accountId, role: 'member', status: 'active' })
  const member: CloudPrincipal = { tenantId: 't1', userId: accountId, accountId, email: `${accountId}@example.test`, authSource: 'user' }
  await principalService.ensurePrincipal(member)
  return member
}

// ---------------------------------------------------------------------------
// emit → telemetry, query gate + filters + cursor
// ---------------------------------------------------------------------------

test('audit service: emitDataPlaneEvent records the event and fans out a telemetry counter', async () => {
  const { store, principalService, audit, observability } = makeAudit()
  await bootstrapOrg(store, principalService)

  await audit.emitDataPlaneEvent({
    orgId: 'org-1',
    actor: { actorType: 'user', actorId: 'owner', accountId: 'owner' },
    eventType: 'session.created',
    targetType: 'session',
    targetId: 'sess-1',
    result: 'success',
    metadata: { profileName: 'default' },
  })

  const events = store.listAuditEvents('org-1', 50)
  const recorded = events.find((event) => event.eventType === 'session.created')
  assert.ok(recorded)
  assert.equal(recorded?.metadata.result, 'success')
  assert.equal(recorded?.metadata.profileName, 'default')

  const counter = observability.metrics.find((metric) => metric.name === 'open_cowork_cloud_audit_events_total')
  assert.ok(counter, 'audit counter emitted to telemetry')
  assert.equal(counter?.value, 1)
  assert.equal(counter?.attributes?.event_type, 'session.created')
  assert.equal(counter?.attributes?.result, 'success')
})

test('audit service: emit never throws on a bad write but still records telemetry', async () => {
  const { audit, observability } = makeAudit()
  // Unknown org ⇒ recordAuditEvent throws inside the store; emit must swallow it.
  await audit.emitDataPlaneEvent({
    orgId: 'missing-org',
    actor: { actorType: 'system', actorId: 'worker-1' },
    eventType: 'worker.lease_claimed',
  })
  assert.ok(observability.metrics.some((metric) => metric.name === 'open_cowork_cloud_audit_events_total'))
})

test('audit service: query is gated on audit:read and filters + keyset-pages deterministically', async () => {
  const { store, principalService, audit } = makeAudit()
  const owner = await bootstrapOrg(store, principalService)
  const member = await seedMember(store, principalService, 'mem-1')

  // Seed a deterministic, ordered set across two actors + event families.
  const seeds = [
    { eventType: 'session.created', actorId: 'owner', createdAt: '2026-05-01T00:00:00.000Z', result: 'success' },
    { eventType: 'session.imported', actorId: 'owner', createdAt: '2026-05-02T00:00:00.000Z', result: 'success' },
    { eventType: 'command.prompt', actorId: 'mem-1', createdAt: '2026-05-03T00:00:00.000Z', result: 'success' },
    { eventType: 'command.aborted', actorId: 'mem-1', createdAt: '2026-05-04T00:00:00.000Z', result: 'failure' },
    { eventType: 'artifact.uploaded', actorId: 'owner', createdAt: '2026-05-05T00:00:00.000Z', result: 'success' },
  ]
  for (const seed of seeds) {
    await store.recordAuditEvent({
      orgId: 'org-1', actorType: 'user', actorId: seed.actorId,
      eventType: seed.eventType, targetType: 'session', targetId: 'sess-1',
      metadata: { result: seed.result }, createdAt: new Date(seed.createdAt),
    })
  }

  // Members lack audit:read.
  await assert.rejects(() => audit.queryAuditEvents(member), /audit:read/)

  // Prefix filter: session.* only, newest first.
  const sessionEvents = await audit.queryAuditEvents(owner, { eventTypePrefix: 'session.' })
  assert.deepEqual(sessionEvents.events.map((event) => event.eventType), ['session.imported', 'session.created'])
  assert.equal(sessionEvents.nextCursor, null)

  // Actor + result filters compose.
  const memberFailures = await audit.queryAuditEvents(owner, { actorId: 'mem-1', result: 'failure' })
  assert.deepEqual(memberFailures.events.map((event) => event.eventType), ['command.aborted'])

  // Time-range filter.
  const windowed = await audit.queryAuditEvents(owner, {
    from: new Date('2026-05-02T00:00:00.000Z'),
    to: new Date('2026-05-04T00:00:00.000Z'),
  })
  assert.deepEqual(windowed.events.map((event) => event.eventType), ['command.aborted', 'command.prompt', 'session.imported'])

  // Keyset paging: page size 2 walks the seeded log (scoped to sess-1) with no overlap.
  const seen: string[] = []
  let cursor: string | null = null
  for (let page = 0; page < 10; page += 1) {
    const result: { events: AuditEventRecord[], nextCursor: string | null } =
      await audit.queryAuditEvents(owner, { targetId: 'sess-1', limit: 2, cursor })
    seen.push(...result.events.map((event) => event.eventType))
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }
  assert.deepEqual(seen, ['artifact.uploaded', 'command.aborted', 'command.prompt', 'session.imported', 'session.created'])
  assert.equal(new Set(seen).size, seen.length, 'no row is repeated across pages')

  // A cursor minted for one filter set is rejected against a different one.
  const firstPage = await audit.queryAuditEvents(owner, { targetId: 'sess-1', limit: 2 })
  await assert.rejects(
    () => audit.queryAuditEvents(owner, { limit: 2, cursor: firstPage.nextCursor, eventTypePrefix: 'command.' }),
    /cursor is invalid/,
  )
})

// ---------------------------------------------------------------------------
// Export: redacted vs audited-unredacted, JSON + CSV
// ---------------------------------------------------------------------------

async function drain(stream: AsyncIterable<string>) {
  let out = ''
  for await (const chunk of stream) out += chunk
  return out
}

test('audit export: JSON is redacted by default and the unredacted admin export is itself audited', async () => {
  const { store, principalService, audit } = makeAudit()
  const owner = await bootstrapOrg(store, principalService)
  await store.recordAuditEvent({
    orgId: 'org-1', actorType: 'user', actorId: 'owner',
    eventType: 'artifact.uploaded', targetType: 'artifact', targetId: 'art-1',
    metadata: { result: 'success', path: '/Users/alice/project/design.fig' },
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
  })

  const redacted = await audit.exportAuditEvents(owner, { format: 'json' })
  assert.equal(redacted.contentType, 'application/json; charset=utf-8')
  const redactedBody = JSON.parse(await drain(redacted.chunks)) as { events: AuditEventRecord[] }
  const redactedEvent = redactedBody.events.find((event) => event.eventType === 'artifact.uploaded')
  assert.ok(redactedEvent)
  assert.equal(redactedEvent?.metadata.path, '/Users/[redacted]')
  assert.ok(!JSON.stringify(redactedBody).includes('alice'), 'local path is scrubbed from the default export')

  const unredacted = await audit.exportAuditEvents(owner, { format: 'json', unredacted: true })
  const unredactedBody = JSON.parse(await drain(unredacted.chunks)) as { events: AuditEventRecord[] }
  assert.ok(unredactedBody.events.some((event) => event.metadata.path === '/Users/alice/project/design.fig'))

  // The unredacted disclosure is durably recorded as its own audit event.
  const exportAudit = store.listAuditEvents('org-1', 50).find((event) => event.eventType === 'audit.exported')
  assert.ok(exportAudit, 'unredacted export writes an audit.exported event')
  assert.equal(exportAudit?.metadata.unredacted, true)
  assert.equal(exportAudit?.metadata.format, 'json')
})

test('audit export: CSV format emits a header + one row per event, escaping cells', async () => {
  const { store, principalService, audit } = makeAudit()
  const owner = await bootstrapOrg(store, principalService)
  await store.recordAuditEvent({
    orgId: 'org-1', actorType: 'user', actorId: 'owner',
    eventType: 'session.created', targetType: 'session', targetId: 'sess-1',
    metadata: { result: 'success', note: 'has,comma "quote"' },
    createdAt: new Date('2026-06-02T00:00:00.000Z'),
  })
  const csv = await audit.exportAuditEvents(owner, { format: 'csv', eventTypePrefix: 'session.' })
  assert.equal(csv.contentType, 'text/csv; charset=utf-8')
  assert.ok(csv.filename.endsWith('.csv'))
  const lines = (await drain(csv.chunks)).trim().split('\n')
  assert.equal(lines[0], 'eventId,createdAt,orgId,actorType,actorId,accountId,eventType,targetType,targetId,result,metadata')
  assert.equal(lines.length, 2)
  assert.ok(lines[1]?.includes('session.created'))
  // The metadata cell is JSON, so its quotes are CSV-escaped by doubling ("" ).
  assert.ok(lines[1]?.includes('""result""'), 'embedded quotes are CSV-escaped')
})

test('audit export: unredacted mode requires org admin even with audit:read', async () => {
  const { store, principalService, roleService, audit } = makeAudit()
  const owner = await bootstrapOrg(store, principalService)
  await seedMember(store, principalService, 'analyst-1')
  // A custom role that grants audit:read but NOT org-management.
  await roleService.createCustomRole(owner, { roleKey: 'auditor', name: 'Auditor', baseRole: 'member', permissions: ['audit:read', 'org:read'] })
  await roleService.assignMemberRole(owner, 'analyst-1', { roleKey: 'auditor' })
  const analyst: CloudPrincipal = { tenantId: 't1', userId: 'analyst-1', accountId: 'analyst-1', email: 'analyst-1@example.test', authSource: 'user' }
  await principalService.ensurePrincipal(analyst)

  // Redacted export + query are allowed for the auditor role.
  const redacted = await audit.exportAuditEvents(analyst, { format: 'json' })
  assert.ok((await drain(redacted.chunks)).startsWith('{"events":['))
  // ...but the unredacted disclosure is admin-only.
  await assert.rejects(() => audit.exportAuditEvents(analyst, { format: 'json', unredacted: true }), /admin/i)
})
