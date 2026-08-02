import { clearCoordinationStoreCache } from '@open-cowork/runtime-host/coordination/coordination-store'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { type CloudPrincipal } from '@open-cowork/cloud-server/session-service'
import { createFixture } from './helpers/cloud-http-fixture.ts'
import {
  readJson,
  asRecord,
  asArray,
  headerValue,
} from './helpers/cloud-http-test-support.ts'

async function eventually<T>(
  read: () => T | Promise<T>,
  accepts: (value: T) => boolean,
  label: string,
  timeoutMs = 1000,
): Promise<T> {
  const startedAt = Date.now()
  let lastValue: T | undefined
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await read()
    if (accepts(lastValue)) return lastValue
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`)
}

test('cloud HTTP coordination routes expose the desktop coordination model', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-cloud-coordination-'))
  process.env.OPEN_COWORK_USER_DATA_DIR = dataDir
  clearConfigCaches()
  clearCoordinationStoreCache()

  const tenant1Principal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'owner-1',
    accountId: 'owner-1',
    email: 'owner1@example.test',
    role: 'owner' as const,
    authSource: 'user' as const,
  }
  const tenant2Principal = {
    tenantId: 'tenant-2',
    tenantName: 'Tenant 2',
    orgId: 'tenant-2',
    userId: 'owner-2',
    accountId: 'owner-2',
    email: 'owner2@example.test',
    role: 'owner' as const,
    authSource: 'user' as const,
  }
  const fixture = createFixture({
    auth: (req) => headerValue(req.headers['x-test-tenant']) === 'tenant-2' ? tenant2Principal : tenant1Principal,
  })
  const baseUrl = await fixture.server.listen()
  try {
    await fixture.service.ensurePrincipal(tenant1Principal)
    await fixture.service.ensurePrincipal(tenant2Principal)

    const projectResponse = await fetch(`${baseUrl}/api/coordination/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Studio parity',
        objective: 'Coordinate the design parity roadmap.',
        team: ['cleo', 'builder'],
      }),
    })
    assert.equal(projectResponse.status, 201)
    const project = await readJson(projectResponse)
    const projectId = String(project.id)
    assert.equal(project.kind, 'project')
    assert.equal(project.workspaceId, 'cloud:tenant-1')
    assert.equal(project.objective, 'Coordinate the design parity roadmap.')
    assert.deepEqual(project.team, ['cleo', 'builder'])

    const taskResponse = await fetch(`${baseUrl}/api/coordination/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        title: 'Build the board backend',
        spec: 'Persist project tasks and expose them to Cloud Web.',
        priority: 'high',
        assigneeAgent: 'builder',
      }),
    })
    assert.equal(taskResponse.status, 201)
    const task = await readJson(taskResponse)
    const taskId = String(task.id)
    assert.equal(task.kind, 'task')
    assert.equal(task.workspaceId, 'cloud:tenant-1')
    assert.equal(task.projectId, projectId)
    assert.equal(task.column, 'backlog')
    assert.equal(task.priority, 'high')

    const board = await readJson(await fetch(`${baseUrl}/api/coordination/board`))
    assert.equal(asArray(board.projects).length, 1)
    assert.equal(asArray(board.tasks).length, 1)

    const moved = await readJson(await fetch(`${baseUrl}/api/coordination/tasks/${taskId}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ column: 'doing' }),
    }))
    assert.equal(moved.column, 'doing')

    const assigned = await readJson(await fetch(`${baseUrl}/api/coordination/tasks/${taskId}/assign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assigneeAgent: 'reviewer' }),
    }))
    assert.equal(assigned.assigneeAgent, 'reviewer')

    const cloudSession = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const cloudSessionRecord = asRecord(cloudSession.session)
    const cloudSessionId = String(cloudSessionRecord.sessionId)
    const linked = await readJson(await fetch(`${baseUrl}/api/coordination/tasks/${taskId}/link-work`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assignedSessionId: cloudSessionId,
        status: 'running',
      }),
    }))
    assert.equal(linked.assignedSessionId, cloudSessionId)
    assert.equal(linked.status, 'running')
    assert.equal(linked.column, 'doing')

    const workTarget = await readJson(await fetch(`${baseUrl}/api/coordination/tasks/${taskId}/work-target`))
    assert.equal(workTarget.id, cloudSessionId)
    assert.equal(workTarget.createdAt, cloudSessionRecord.createdAt)

    const tasks = await readJson(await fetch(`${baseUrl}/api/coordination/tasks?projectId=${encodeURIComponent(projectId)}`))
    const listedTask = asRecord(asArray(tasks)[0])
    assert.equal(listedTask.id, taskId)
    assert.equal(listedTask.column, 'doing')
    assert.equal(listedTask.assigneeAgent, 'reviewer')

    const cleoPlanResponse = await fetch(`${baseUrl}/api/coordination/projects/${projectId}/plan-with-cleo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tasks: [{
          spec: 'Review the board handoff.\n\nAcceptance: project tasks are ready for the human review lane.',
          priority: 'med',
          assigneeAgent: 'cleo',
        }],
      }),
    })
    assert.equal(cleoPlanResponse.status, 201)
    const cleoPlan = await readJson(cleoPlanResponse)
    const cleoTasks = asArray(cleoPlan.tasks).map(asRecord)
    assert.equal(cleoPlan.plannerAgent, 'chief-of-staff')
    assert.equal(cleoPlan.displayName, 'Cleo')
    assert.equal(cleoTasks.length, 1)
    assert.equal(cleoTasks[0]?.projectId, projectId)
    assert.equal(cleoTasks[0]?.workspaceId, 'cloud:tenant-1')
    assert.equal(cleoTasks[0]?.column, 'planning')
    assert.equal(cleoTasks[0]?.priority, 'med')
    assert.equal(cleoTasks[0]?.assigneeAgent, 'builder')

    const channelAgent = await readJson(await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-1', name: 'Watch delivery agent' }),
    }))
    const channelAgentId = String(asRecord(channelAgent.agent).agentId)
    assert.ok(channelAgentId)
    const channelBinding = await readJson(await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bindingId: 'binding-1',
        agentId: channelAgentId,
        provider: 'telegram',
        displayName: 'Project telegram',
      }),
    }))
    const channelBindingId = String(asRecord(channelBinding.binding).bindingId)
    assert.ok(channelBindingId)

    const unsupportedWorkflowWatch = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'workflow', id: 'workflow-1' },
        events: ['run.finished'],
        channel: {
          provider: 'telegram',
          agentId: channelAgentId,
          channelBindingId,
          target: { chatId: 'workflow-chat' },
        },
        recipient: { role: 'member' },
      }),
    })
    assert.equal(unsupportedWorkflowWatch.status, 400)
    assert.match(String((await readJson(unsupportedWorkflowWatch)).error), /not supported/i)
    const unsupportedWorkflowFilter = await fetch(`${baseUrl}/api/coordination/watches?targetKind=workflow&targetId=workflow-1`)
    assert.equal(unsupportedWorkflowFilter.status, 400)
    assert.match(String((await readJson(unsupportedWorkflowFilter)).error), /not supported/i)

    const watchResponse = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'project', id: projectId },
        events: ['task.moved', 'task.review_ready'],
        channel: {
          provider: 'telegram',
          agentId: channelAgentId,
          channelBindingId,
          target: { chatId: 'project-chat' },
        },
        recipient: { role: 'member', identityId: 'identity-1' },
      }),
    })
    assert.equal(watchResponse.status, 201)
    const watch = await readJson(watchResponse)
    const watchId = String(watch.id)
    assert.equal(watch.kind, 'watch')
    assert.equal(watch.workspaceId, 'cloud:tenant-1')
    assert.equal(watch.ownerAuthority, 'cloud_channel_gateway')
    assert.deepEqual(watch.events, ['task.moved', 'task.review_ready'])

    const movedToReview = await readJson(await fetch(`${baseUrl}/api/coordination/tasks/${taskId}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ column: 'review' }),
    }))
    assert.equal(movedToReview.column, 'review')
    const projectWatchDeliveries = await eventually(
      () => fixture.store.listChannelDeliveries({ orgId: 'tenant-1', channelBindingId, limit: 10 }),
      (deliveries) => {
        const watchEventTypes = deliveries
          .filter((delivery) => asRecord(delivery.payload).watchId === watchId)
          .map((delivery) => delivery.eventType)
        return watchEventTypes.includes('task.moved') && watchEventTypes.includes('task.review_ready')
      },
      'project task watch delivery',
    )
    const taskMovedDelivery = projectWatchDeliveries.find((delivery) => delivery.eventType === 'task.moved' && asRecord(delivery.payload).watchId === watchId)
    assert.ok(taskMovedDelivery)
    assert.equal(asRecord(asRecord(taskMovedDelivery.payload).target).id, taskId)
    assert.equal(asRecord(asArray(asRecord(taskMovedDelivery.payload).relatedTargets)[0]).id, projectId)

    const linkWatchTask = await readJson(await fetch(`${baseUrl}/api/coordination/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        title: 'Link-work watch task',
        spec: 'Linking work should emit the same moved watch event as direct task mutations.',
      }),
    }))
    const linkWatchTaskId = String(linkWatchTask.id)
    const linkWatchSession = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const linkedWatchTask = await readJson(await fetch(`${baseUrl}/api/coordination/tasks/${linkWatchTaskId}/link-work`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assignedSessionId: String(asRecord(linkWatchSession.session).sessionId),
        status: 'running',
      }),
    }))
    assert.equal(linkedWatchTask.column, 'doing')
    const linkWorkDelivery = await eventually(
      () => fixture.store.listChannelDeliveries({ orgId: 'tenant-1', channelBindingId, limit: 20 }),
      (deliveries) => deliveries.some((delivery) => (
        delivery.eventType === 'task.moved'
        && asRecord(delivery.payload).watchId === watchId
        && asRecord(asRecord(delivery.payload).target).id === linkWatchTaskId
      )),
      'link-work task moved watch delivery',
    )
    assert.ok(linkWorkDelivery.some((delivery) => (
      delivery.eventType === 'task.moved'
      && asRecord(delivery.payload).watchId === watchId
      && asRecord(asRecord(delivery.payload).target).id === linkWatchTaskId
    )))

    const watches = await readJson(await fetch(`${baseUrl}/api/coordination/watches?targetKind=project&targetId=${encodeURIComponent(projectId)}&status=active`))
    assert.deepEqual(asArray(watches).map((entry) => asRecord(entry).id), [watchId])

    const updatedWatch = await readJson(await fetch(`${baseUrl}/api/coordination/watches/${watchId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: ['task.review_ready'],
        recipient: { role: 'approver' },
      }),
    }))
    assert.deepEqual(updatedWatch.events, ['task.review_ready'])
    assert.equal(asRecord(updatedWatch.recipient).role, 'approver')

    const pausedWatch = await readJson(await fetch(`${baseUrl}/api/coordination/watches/${watchId}/pause`, { method: 'POST' }))
    assert.equal(pausedWatch.status, 'paused')
    const resumedWatch = await readJson(await fetch(`${baseUrl}/api/coordination/watches/${watchId}/resume`, { method: 'POST' }))
    assert.equal(resumedWatch.status, 'active')

    const tenantTwoBoard = await readJson(await fetch(`${baseUrl}/api/coordination/board`, {
      headers: { 'x-test-tenant': 'tenant-2' },
    }))
    assert.deepEqual(asArray(tenantTwoBoard.projects), [])
    assert.deepEqual(asArray(tenantTwoBoard.tasks), [])

    const tenantTwoProjectUpdate = await fetch(`${baseUrl}/api/coordination/projects/${projectId}`, {
      method: 'POST',
      headers: { 'x-test-tenant': 'tenant-2', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Should not update' }),
    })
    assert.equal(tenantTwoProjectUpdate.status, 404)

    const tenantTwoTaskMove = await fetch(`${baseUrl}/api/coordination/tasks/${taskId}/move`, {
      method: 'POST',
      headers: { 'x-test-tenant': 'tenant-2', 'content-type': 'application/json' },
      body: JSON.stringify({ column: 'done' }),
    })
    assert.equal(tenantTwoTaskMove.status, 404)

    const tenantTwoWatchUpdate = await fetch(`${baseUrl}/api/coordination/watches/${watchId}`, {
      method: 'POST',
      headers: { 'x-test-tenant': 'tenant-2', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    })
    assert.equal(tenantTwoWatchUpdate.status, 404)

    const tenantTwoWatchDelete = await fetch(`${baseUrl}/api/coordination/watches/${watchId}`, {
      method: 'DELETE',
      headers: { 'x-test-tenant': 'tenant-2' },
    })
    assert.equal(tenantTwoWatchDelete.status, 404)

    const tenantTwoTaskCreate = await fetch(`${baseUrl}/api/coordination/tasks`, {
      method: 'POST',
      headers: { 'x-test-tenant': 'tenant-2', 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        title: 'Cross tenant task',
        spec: 'This should not be allowed.',
      }),
    })
    assert.equal(tenantTwoTaskCreate.status, 404)

    const tenantTwoProject = await readJson(await fetch(`${baseUrl}/api/coordination/projects`, {
      method: 'POST',
      headers: { 'x-test-tenant': 'tenant-2', 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Tenant two project',
        objective: 'Prove Cloud work links resolve only tenant-owned sessions.',
      }),
    }))
    const tenantTwoTask = await readJson(await fetch(`${baseUrl}/api/coordination/tasks`, {
      method: 'POST',
      headers: { 'x-test-tenant': 'tenant-2', 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: tenantTwoProject.id,
        title: 'Tenant two task',
        spec: 'This task cannot link tenant one work.',
      }),
    }))
    const crossTenantSessionLink = await fetch(`${baseUrl}/api/coordination/tasks/${String(tenantTwoTask.id)}/link-work`, {
      method: 'POST',
      headers: { 'x-test-tenant': 'tenant-2', 'content-type': 'application/json' },
      body: JSON.stringify({ assignedSessionId: cloudSessionId }),
    })
    assert.equal(crossTenantSessionLink.status, 404)
    assert.match(String((await readJson(crossTenantSessionLink)).error), /session/i)

    const missingTitle = await fetch(`${baseUrl}/api/coordination/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective: 'Missing title should be a bad request.' }),
    })
    assert.equal(missingTitle.status, 400)
    assert.match(String((await readJson(missingTitle)).error), /title/i)

    const invalidMove = await fetch(`${baseUrl}/api/coordination/tasks/${taskId}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ column: 'blocked' }),
    })
    assert.equal(invalidMove.status, 400)
    assert.match(String((await readJson(invalidMove)).error), /column/i)

    const watchDelete = await readJson(await fetch(`${baseUrl}/api/coordination/watches/${watchId}`, { method: 'DELETE' }))
    assert.equal(watchDelete.deleted, true)
    const watchesAfterDelete = await readJson(await fetch(`${baseUrl}/api/coordination/watches?targetKind=project&targetId=${encodeURIComponent(projectId)}`))
    assert.deepEqual(asArray(watchesAfterDelete), [])
  } finally {
    await fixture.server.close()
    clearCoordinationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})
test('cloud watch delivery resolves channel org from tenant workspace id', async () => {
  const fixture = createFixture()
  const principal = {
    tenantId: 'tenant-slug',
    tenantName: 'Tenant Slug',
    orgId: 'org-real',
    userId: 'owner-1',
    accountId: 'owner-1',
    email: 'owner@example.test',
    role: 'owner' as const,
    authSource: 'local' as const,
  }
  await fixture.service.ensurePrincipal(principal)
  assert.equal(await fixture.service.resolveOrgIdForTenant('tenant-slug'), 'org-real')
})

test('cloud coordination stale watches remain visible and removable after channel targets disappear', async () => {
  clearCoordinationStoreCache()
  clearConfigCaches()
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  const ownerPrincipal: CloudPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'user-1',
    accountId: 'user-1',
    email: 'user@example.test',
    role: 'owner',
    authSource: 'local',
  }
  try {
    const project = await readJson(await fetch(`${baseUrl}/api/coordination/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Stale watch cleanup',
        objective: 'Prove watches can be cleaned up after channel targets are removed.',
      }),
    }))
    const projectId = String(asRecord(project).id)
    const staleWatch = await fixture.service.domains.coordination.createCloudCoordinationWatch(ownerPrincipal, {
      workspaceId: 'cloud:tenant-1',
      target: { kind: 'project', id: projectId },
      events: ['task.moved'],
      channel: {
        provider: 'telegram',
        agentId: 'deleted-agent',
        channelBindingId: 'deleted-binding',
        target: { chatId: 'stale-watch-chat' },
      },
      recipient: { role: 'member' },
    })

    const listed = await readJson(await fetch(`${baseUrl}/api/coordination/watches?targetKind=project&targetId=${encodeURIComponent(projectId)}`))
    assert.deepEqual(asArray(listed).map((entry) => asRecord(entry).id), [staleWatch.id])

    const paused = await readJson(await fetch(`${baseUrl}/api/coordination/watches/${staleWatch.id}/pause`, { method: 'POST' }))
    assert.equal(paused.status, 'paused')
    const resumed = await readJson(await fetch(`${baseUrl}/api/coordination/watches/${staleWatch.id}/resume`, { method: 'POST' }))
    assert.equal(resumed.status, 'active')
    const deleted = await readJson(await fetch(`${baseUrl}/api/coordination/watches/${staleWatch.id}`, { method: 'DELETE' }))
    assert.equal(deleted.deleted, true)
    const listedAfterDelete = await readJson(await fetch(`${baseUrl}/api/coordination/watches?targetKind=project&targetId=${encodeURIComponent(projectId)}`))
    assert.deepEqual(asArray(listedAfterDelete), [])

    const invalidNewWatch = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'project', id: projectId },
        events: ['task.moved'],
        channel: {
          provider: 'telegram',
          agentId: 'deleted-agent',
          channelBindingId: 'deleted-binding',
          target: { chatId: 'stale-watch-chat' },
        },
        recipient: { role: 'member' },
      }),
    })
    assert.equal(invalidNewWatch.status, 403)
    assert.match(String((await readJson(invalidNewWatch)).error), /not authorized/i)
  } finally {
    await fixture.server.close()
    clearCoordinationStoreCache()
    clearConfigCaches()
  }
})

test('cloud runtime events deliver coordination watches through channel delivery', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-cloud-runtime-watch-'))
  process.env.OPEN_COWORK_USER_DATA_DIR = dataDir
  clearConfigCaches()
  clearCoordinationStoreCache()

  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const channelAgent = await readJson(await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-runtime-watch', name: 'Runtime watch agent' }),
    }))
    assert.equal(asRecord(channelAgent.agent).agentId, 'agent-runtime-watch')
    const channelBinding = await readJson(await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bindingId: 'binding-runtime-watch',
        agentId: 'agent-runtime-watch',
        provider: 'telegram',
        displayName: 'Runtime watch telegram',
      }),
    }))
    assert.equal(asRecord(channelBinding.binding).bindingId, 'binding-runtime-watch')

    const createdSession = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(createdSession.session).sessionId)

    const watchResponse = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'session', id: sessionId },
        events: ['run.finished', 'needs_input'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-runtime-watch',
          channelBindingId: 'binding-runtime-watch',
          target: { chatId: 'runtime-watch-chat' },
        },
        recipient: { role: 'member' },
      }),
    })
    assert.equal(watchResponse.status, 201)

    const promptResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'finish this run' }),
    })
    assert.equal(promptResponse.status, 202)

    const deliveriesAfterRun = await eventually(
      () => fixture.store.listChannelDeliveries({ orgId: 'tenant-1', channelBindingId: 'binding-runtime-watch', limit: 10 }),
      (deliveries) => deliveries.some((delivery) => delivery.eventType === 'run.finished'),
      'run.finished watch delivery',
    )
    const runFinished = deliveriesAfterRun.find((delivery) => delivery.eventType === 'run.finished')
    assert.ok(runFinished)
    assert.equal(runFinished.provider, 'telegram')
    assert.equal(asRecord(runFinished.payload).eventType, 'run.finished')
    assert.equal(asRecord(asRecord(runFinished.payload).target).id, sessionId)

    const appended = await fixture.worker.appendRuntimeEvent('tenant-1', sessionId, {
      type: 'permission.requested',
      payload: {
        sessionId: fixture.runtime.createdSessions[0],
        permissionId: 'permission-runtime-watch',
        description: 'Approve the cloud command.',
        tool: 'bash',
      },
    })
    assert.equal(appended, true)

    const deliveriesAfterInput = await eventually(
      () => fixture.store.listChannelDeliveries({ orgId: 'tenant-1', channelBindingId: 'binding-runtime-watch', limit: 10 }),
      (deliveries) => deliveries.some((delivery) => delivery.eventType === 'needs_input'),
      'needs_input watch delivery',
    )
    const needsInput = deliveriesAfterInput.find((delivery) => delivery.eventType === 'needs_input')
    assert.ok(needsInput)
    assert.equal(asRecord(needsInput.payload).eventType, 'needs_input')
    assert.equal(asRecord(asRecord(needsInput.payload).target).id, sessionId)
    assert.equal(asRecord(asRecord(needsInput.payload).metadata).requestId, 'permission-runtime-watch')
    assert.equal(fixture.store.resolvePrincipalMembership({
      tenantId: 'tenant-1',
      userId: 'coordination-watch',
      accountId: 'coordination-watch',
      email: 'coordination-watch@local.open-cowork',
    }), null)
  } finally {
    await fixture.server.close()
    clearCoordinationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('cloud HTTP watch creation validates channel authority before persisting subscriptions', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-cloud-watch-auth-'))
  process.env.OPEN_COWORK_USER_DATA_DIR = dataDir
  clearConfigCaches()
  clearCoordinationStoreCache()

  const ownerPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'owner-1',
    accountId: 'owner-1',
    email: 'owner@example.test',
    role: 'owner' as const,
    authSource: 'local' as const,
  }
  const memberPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'member-1',
    accountId: 'member-1',
    email: 'member@example.test',
    role: 'member' as const,
    authSource: 'user' as const,
  }
  const fixture = createFixture({
    auth: (req) => headerValue(req.headers['x-test-user']) === 'owner' ? ownerPrincipal : memberPrincipal,
  })
  const baseUrl = await fixture.server.listen()
  try {
    await fixture.service.domains.channels.createHeadlessAgent(ownerPrincipal, {
      agentId: 'agent-1',
      name: 'Watch delivery agent',
    })
    await fixture.service.domains.channels.createChannelBinding(ownerPrincipal, {
      bindingId: 'binding-1',
      agentId: 'agent-1',
      provider: 'telegram',
      displayName: 'Project telegram',
    })
    const project = await readJson(await fetch(`${baseUrl}/api/coordination/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Member project',
        objective: 'Prove watch creation does not launder channel delivery authority.',
      }),
    }))

    const unauthorizedWatch = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'project', id: project.id },
        events: ['task.moved'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-1',
          target: { chatId: 'project-chat' },
        },
        recipient: { role: 'member' },
      }),
    })
    assert.equal(unauthorizedWatch.status, 403)
    assert.match(String((await readJson(unauthorizedWatch)).error), /gateway|administration|access/i)
    const watches = await readJson(await fetch(`${baseUrl}/api/coordination/watches?targetKind=project&targetId=${encodeURIComponent(String(project.id))}`))
    assert.deepEqual(asArray(watches), [])

    const ownerWatch = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'x-test-user': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'project', id: project.id },
        events: ['task.moved'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-1',
          target: { chatId: 'project-chat' },
        },
        recipient: { role: 'member' },
      }),
    })
    assert.equal(ownerWatch.status, 201)
    const watchId = String((await readJson(ownerWatch)).id)

    const ownerViewerWatch = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'x-test-user': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'project', id: project.id },
        events: ['task.review_ready'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-1',
          target: { chatId: 'viewer-watch-chat' },
        },
        recipient: { role: 'viewer' },
      }),
    })
    assert.equal(ownerViewerWatch.status, 201)
    const viewerWatchId = String((await readJson(ownerViewerWatch)).id)

    const forgedWatch = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'x-test-user': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({
        watchId,
        createdAt: 'not-a-date',
        target: { kind: 'project', id: project.id },
        events: ['task.moved'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-1',
          target: { chatId: 'forged-watch-chat' },
        },
        recipient: { role: 'viewer' },
      }),
    })
    assert.equal(forgedWatch.status, 201)
    const forgedWatchBody = await readJson(forgedWatch)
    assert.notEqual(String(forgedWatchBody.id), watchId)
    assert.notEqual(String(forgedWatchBody.createdAt), 'not-a-date')

    const unauthorizedUpdate = await fetch(`${baseUrl}/api/coordination/watches/${watchId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: ['task.review_ready'],
        status: 'paused',
      }),
    })
    assert.equal(unauthorizedUpdate.status, 403)

    const unauthorizedPause = await fetch(`${baseUrl}/api/coordination/watches/${watchId}/pause`, { method: 'POST' })
    assert.equal(unauthorizedPause.status, 403)

    const unauthorizedDelete = await fetch(`${baseUrl}/api/coordination/watches/${watchId}`, { method: 'DELETE' })
    assert.equal(unauthorizedDelete.status, 403)

    const unauthorizedViewerUpdate = await fetch(`${baseUrl}/api/coordination/watches/${viewerWatchId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    })
    assert.equal(unauthorizedViewerUpdate.status, 403)

    const unauthorizedViewerDelete = await fetch(`${baseUrl}/api/coordination/watches/${viewerWatchId}`, { method: 'DELETE' })
    assert.equal(unauthorizedViewerDelete.status, 403)

    const watchesAfterDeniedMutation = await readJson(await fetch(`${baseUrl}/api/coordination/watches?targetKind=project&targetId=${encodeURIComponent(String(project.id))}`))
    assert.deepEqual(asArray(watchesAfterDeniedMutation), [])
    const ownerVisibleWatches = await readJson(await fetch(`${baseUrl}/api/coordination/watches?targetKind=project&targetId=${encodeURIComponent(String(project.id))}`, {
      headers: { 'x-test-user': 'owner' },
    }))
    const persistedWatch = asArray(ownerVisibleWatches).map(asRecord).find((watch) => watch.id === watchId)
    assert.ok(persistedWatch)
    assert.equal(persistedWatch.id, watchId)
    assert.equal(persistedWatch.status, 'active')
    assert.deepEqual(persistedWatch.events, ['task.moved'])
    assert.ok(asArray(ownerVisibleWatches).map(asRecord).some((watch) => watch.id === viewerWatchId))

    const memberSession = await readJson(await fetch(`${baseUrl}/api/sessions`, { method: 'POST' }))
    const memberSessionId = String(asRecord(memberSession.session).sessionId)
    const unauthorizedSessionWatch = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'x-test-user': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'session', id: memberSessionId },
        events: ['run.finished'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-1',
          target: { chatId: 'project-chat' },
        },
        recipient: { role: 'member' },
      }),
    })
    assert.equal(unauthorizedSessionWatch.status, 404)
  } finally {
    await fixture.server.close()
    clearCoordinationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('cloud gateway principals cannot create or mutate coordination watches', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-cloud-watch-recipient-'))
  process.env.OPEN_COWORK_USER_DATA_DIR = dataDir
  clearConfigCaches()
  clearCoordinationStoreCache()

  const ownerPrincipal: CloudPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'owner-1',
    accountId: 'owner-1',
    email: 'owner@example.test',
    role: 'owner',
    authSource: 'local',
  }
  let gatewayTokenId = 'gateway-token-pending'
  const gatewayPrincipal = (): CloudPrincipal => ({
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'gateway-token-user',
    accountId: 'gateway-token-user',
    email: 'gateway-token@example.test',
    role: 'admin',
    authSource: 'api_token',
    tokenId: gatewayTokenId,
    tokenScopes: ['gateway'],
  })
  const fixture = createFixture({
    auth: (req) => headerValue(req.headers['x-test-auth']) === 'gateway' ? gatewayPrincipal() : ownerPrincipal,
  })
  let listening = false
  try {
    await fixture.service.ensurePrincipal(ownerPrincipal)
    const issued = await fixture.store.issueApiToken({
      orgId: 'tenant-1',
      accountId: 'owner-1',
      name: 'Gateway-only watch token',
      scopes: ['gateway'],
    })
    gatewayTokenId = issued.token.tokenId
    await fixture.service.domains.channels.createHeadlessAgent(ownerPrincipal, {
      agentId: 'agent-watch-recipient',
      name: 'Watch recipient agent',
    })
    await fixture.service.domains.channels.createChannelBinding(ownerPrincipal, {
      bindingId: 'binding-watch-recipient',
      agentId: 'agent-watch-recipient',
      provider: 'telegram',
      displayName: 'Watch recipient telegram',
    })
    fixture.store.grantApiTokenChannelBinding({
      orgId: 'tenant-1',
      tokenId: gatewayTokenId,
      channelBindingId: 'binding-watch-recipient',
      actor: {
        actorType: 'user',
        actorId: 'owner-1',
        accountId: 'owner-1',
      },
    })

    const baseUrl = await fixture.server.listen()
    listening = true

    const gatewayHeaders = {
      'x-test-auth': 'gateway',
      'content-type': 'application/json',
    }
    const gateway = gatewayPrincipal()
    await fixture.service.ensurePrincipal(gateway)
    const gatewaySessionId = 'watch-recipient-session'
    fixture.store.createSession({
      tenantId: gateway.tenantId,
      userId: gateway.userId,
      sessionId: gatewaySessionId,
      opencodeSessionId: 'watch-recipient-opencode-session',
      profileName: 'full',
    })
    fixture.store.bindChannelSession({
      bindingId: 'binding-watch-recipient-session',
      orgId: 'tenant-1',
      agentId: 'agent-watch-recipient',
      channelBindingId: 'binding-watch-recipient',
      provider: 'telegram',
      externalChatId: 'watch-recipient-chat',
      externalThreadId: 'watch-recipient-thread',
      sessionId: gatewaySessionId,
    })

    const gatewayWatchResponse = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: gatewayHeaders,
      body: JSON.stringify({
        target: { kind: 'session', id: gatewaySessionId },
        events: ['needs_input'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-watch-recipient',
          channelBindingId: 'binding-watch-recipient',
          target: { chatId: 'watch-recipient-chat' },
        },
      }),
    })
    const gatewayWatch = await readJson(gatewayWatchResponse)
    assert.equal(gatewayWatchResponse.status, 403, JSON.stringify(gatewayWatch))
    assert.equal(asRecord(gatewayWatch.verdict).policyCode, 'authorization.scope_required')

    const gatewayNoRoleRecipientWatchResponse = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: gatewayHeaders,
      body: JSON.stringify({
        target: { kind: 'session', id: gatewaySessionId },
        events: ['needs_input'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-watch-recipient',
          channelBindingId: 'binding-watch-recipient',
          target: { chatId: 'watch-recipient-chat' },
        },
        recipient: { identityId: 'identity-watch-recipient' },
      }),
    })
    const gatewayNoRoleRecipientWatch = await readJson(gatewayNoRoleRecipientWatchResponse)
    assert.equal(gatewayNoRoleRecipientWatchResponse.status, 403, JSON.stringify(gatewayNoRoleRecipientWatch))
    assert.equal(asRecord(gatewayNoRoleRecipientWatch.verdict).policyCode, 'authorization.scope_required')

    const ownerLegacyWatch = await fixture.service.domains.coordination.createCloudCoordinationWatch(ownerPrincipal, {
      workspaceId: 'cloud:tenant-1',
      target: { kind: 'session', id: gatewaySessionId },
      events: ['needs_input'],
      channel: {
        provider: 'telegram',
        agentId: 'agent-watch-recipient',
        channelBindingId: 'binding-watch-recipient',
        target: { chatId: 'watch-recipient-chat' },
      },
    })
    assert.equal(ownerLegacyWatch.recipient ?? null, null)

    const appended = await fixture.worker.appendRuntimeEvent('tenant-1', gatewaySessionId, {
      type: 'permission.requested',
      payload: {
        sessionId: fixture.runtime.createdSessions[0],
        permissionId: 'permission-watch-recipient',
        description: 'Approve the cloud command.',
        tool: 'bash',
      },
    })
    assert.equal(appended, true)

    const deliveries = await eventually(
      () => fixture.store.listChannelDeliveries({ orgId: 'tenant-1', channelBindingId: 'binding-watch-recipient', limit: 10 }),
      (records) => records.some((delivery) => asRecord(delivery.payload).watchId === ownerLegacyWatch.id),
      'owner watch needs_input delivery',
    )
    assert.equal(deliveries.length, 1)

    const deniedUpdate = await fetch(`${baseUrl}/api/coordination/watches/${String(ownerLegacyWatch.id)}`, {
      method: 'POST',
      headers: gatewayHeaders,
      body: JSON.stringify({ status: 'paused' }),
    })
    assert.equal(deniedUpdate.status, 403)
    assert.equal(
      asRecord(asRecord(await readJson(deniedUpdate)).verdict).policyCode,
      'authorization.scope_required',
    )
  } finally {
    if (listening) await fixture.server.close()
    clearCoordinationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('cloud HTTP launchpad feed reads waiting summaries and honors disabled artifacts', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        artifacts: false,
      },
    },
  })
  const summaryLimits: Array<number | null | undefined> = []
  let listSessionsCalled = false
  let artifactIndexCalled = false
  fixture.service.listSessions = async () => {
    listSessionsCalled = true
    throw new Error('launchpad feed must not list sessions')
  }
  fixture.service.listSessionsPage = async () => {
    throw new Error('launchpad feed must not page sessions')
  }
  fixture.service.getSessionView = async () => {
    throw new Error('launchpad feed must not hydrate session views')
  }
  fixture.service.listCloudLaunchpadSessionSummaries = async (_principal, input = {}) => {
    summaryLimits.push(input.limit)
    return {
      items: [],
      truncated: true,
      totalEstimate: 101,
    }
  }
  fixture.artifacts.listArtifactIndex = async () => {
    artifactIndexCalled = true
    throw new Error('launchpad feed must not read artifacts when artifacts are disabled')
  }
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/launchpad/feed?limit=4`)
    assert.equal(response.status, 200)
    const feed = await readJson(response)
    assert.equal(listSessionsCalled, false)
    assert.deepEqual(summaryLimits, [100])
    assert.equal(artifactIndexCalled, false)
    assert.deepEqual(asArray(feed.freshArtifacts), [])
    assert.equal(asRecord(feed.totals).freshArtifacts, 0)
    assert.equal(asRecord(feed.truncated).freshArtifacts, false)
    assert.deepEqual(asArray(feed.waitingOnYou), [])
    assert.equal(asRecord(feed.totals).waitingOnYou, 1)
    assert.equal(asRecord(feed.truncated).waitingOnYou, true)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP launchpad filters task-linked artifacts after project enrichment', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-cloud-launchpad-'))
  process.env.OPEN_COWORK_USER_DATA_DIR = dataDir
  clearConfigCaches()
  clearCoordinationStoreCache()

  const fixture = createFixture()
  let artifactRequestProjectId: unknown = 'not-called'
  let artifactRequestTaskIds: unknown = 'not-called'
  let artifactRequestLimit: unknown = 'not-called'
  const baseUrl = await fixture.server.listen()
  try {
    const project = await readJson(await fetch(`${baseUrl}/api/coordination/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Launchpad project',
        objective: 'Surface task-linked artifacts.',
      }),
    }))
    const projectId = String(project.id)
    const task = await readJson(await fetch(`${baseUrl}/api/coordination/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        title: 'Collect artifacts',
        spec: 'Return fresh artifacts linked only by task id.',
      }),
    }))
    const taskId = String(task.id)
    fixture.artifacts.listArtifactIndex = async (_principal, request = {}) => {
      artifactRequestProjectId = request.projectId
      artifactRequestTaskIds = request.taskIds
      artifactRequestLimit = request.limit
      return {
        artifacts: [{
          id: 'cloud-artifact-task-only',
          cloudArtifactId: 'cloud-artifact-task-only',
          source: 'cloud',
          toolId: 'cloud-artifact',
          toolName: 'cloud.artifact',
          filePath: 'cloud-artifact://cloud-artifact-task-only/report.md',
          filename: 'report.md',
          order: 1,
          sessionId: 'session-artifacts',
          workspaceId: 'cloud:tenant-1',
          kind: 'document',
          status: 'draft',
          projectId: null,
          taskId,
          authorAgentId: 'builder',
          createdAt: '2026-06-09T11:00:00.000Z',
          updatedAt: '2026-06-09T11:00:00.000Z',
        }],
        total: 1,
      }
    }

    const feed = await readJson(await fetch(`${baseUrl}/api/launchpad/feed?projectId=${encodeURIComponent(projectId)}`))
    assert.equal(artifactRequestProjectId, projectId)
    assert.deepEqual(artifactRequestTaskIds, [taskId])
    assert.equal(artifactRequestLimit, 9)
    const freshArtifacts = asArray(feed.freshArtifacts)
    assert.equal(freshArtifacts.length, 1)
    assert.equal(asRecord(freshArtifacts[0]).artifactId, 'cloud-artifact-task-only')
    assert.equal(asRecord(freshArtifacts[0]).projectId, projectId)
  } finally {
    await fixture.server.close()
    clearCoordinationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})
