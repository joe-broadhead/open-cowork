import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CrewRunDetail, SopRunLink } from '@open-cowork/shared'
import {
  approveChannelInboundItem,
  dismissChannelInboundReview,
} from '../apps/desktop/src/main/channel-dispatch.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  clearChannelStoreCache,
  createChannelDefinition,
  getChannelInboundItem,
  recordChannelInboundItem,
} from '../apps/desktop/src/main/channel-store.ts'
import {
  clearOperationalQueueStoreCache,
  getOperationalQueueItem,
  listOperationalQueueItems,
} from '../apps/desktop/src/main/operational-queue-store.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-channel-dispatch-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

async function withChannelDispatchStore(name: string, fn: () => Promise<void>) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
    clearConfigCaches()
    clearChannelStoreCache()
    clearOperationalQueueStoreCache()
    await fn()
  } finally {
    clearChannelStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

function sopLink(overrides: Partial<SopRunLink> = {}): SopRunLink {
  return {
    schemaVersion: 1,
    id: 'sop-link-1',
    sopId: 'sop-weekly',
    sopVersionId: 'sop-version-1',
    automationId: 'automation-1',
    automationRunId: 'automation-run-1',
    triggerType: 'webhook',
    inputs: {},
    createdAt: '2026-05-11T00:00:00.000Z',
    ...overrides,
  }
}

function crewDetail(overrides: Partial<CrewRunDetail> = {}): CrewRunDetail {
  return {
    run: {
      schemaVersion: 1,
      id: 'crew-run-1',
      crewId: 'crew-research',
      crewVersionId: 'crew-version-1',
      workItemId: 'work-channel-1',
      status: 'queued',
      title: 'Channel crew run',
      summary: null,
      rootSessionId: null,
      createdAt: '2026-05-11T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    },
    crew: {
      schemaVersion: 1,
      id: 'crew-research',
      name: 'Research crew',
      description: 'Researches inbound work.',
      status: 'active',
      activeVersionId: 'crew-version-1',
      createdAt: '2026-05-11T00:00:00.000Z',
      updatedAt: '2026-05-11T00:00:00.000Z',
    },
    version: {
      schemaVersion: 1,
      id: 'crew-version-1',
      crewId: 'crew-research',
      version: 1,
      members: [],
      workspaceProfileId: null,
      outcomeRubricId: null,
      evalSuiteId: null,
      certificationStatus: 'not_required',
      certifiedAt: null,
      budgetCapUsd: null,
      approvalPolicy: 'review-before-delivery',
      workflow: ['plan', 'delegate', 'join', 'evaluate', 'deliver'],
      createdAt: '2026-05-11T00:00:00.000Z',
      createdBy: 'local-user',
    },
    workItem: null,
    nodes: [],
    artifacts: [],
    approvals: [],
    policyDecisions: [],
    evaluations: [],
    traceEvents: [],
    ...overrides,
  }
}

test('approving a channel SOP item dispatches through the SOP service and records the run link', async () => withChannelDispatchStore('sop', async () => {
  const channel = createChannelDefinition({
    provider: 'local_webhook',
    name: 'Ops webhook',
    sourceKey: 'ops',
    senderAllowlist: ['ops@example.com'],
    allowedCapabilityIds: ['skill:chart-creator'],
    route: { activationMode: 'run_sop', targetSopId: 'sop-weekly' },
  })
  const item = recordChannelInboundItem({
    channelId: channel.id,
    sender: 'ops@example.com',
    subject: 'Weekly digest',
    body: 'Prepare the weekly support digest.',
    externalMessageId: 'msg-1',
  })
  const queueItem = listOperationalQueueItems()[0]
  assert.ok(queueItem)

  let published = false
  const approved = await approveChannelInboundItem(item.id, {
    publishAutomationUpdated: () => {
      published = true
    },
    runSopForTrigger: async (sopId, triggerType, inputs, publishAutomationUpdated, options) => {
      publishAutomationUpdated()
      assert.equal(sopId, 'sop-weekly')
      assert.equal(triggerType, 'webhook')
      assert.equal(inputs.source, 'channel')
      assert.deepEqual((inputs.channel as { allowedCapabilityIds: string[] }).allowedCapabilityIds, ['skill:chart-creator'])
      assert.equal((inputs.inbound as { id: string }).id, item.id)
      assert.deepEqual(options, {
        workspaceProfileId: 'channel-sandbox',
        channelId: channel.id,
      })
      return sopLink()
    },
  })

  assert.equal(published, true)
  assert.equal(approved?.status, 'dispatched')
  assert.equal(approved?.auditState, 'execution_dispatched')
  assert.equal(approved?.runKind, 'sop')
  assert.equal(approved?.runId, 'automation-run-1')
  assert.equal(approved?.approvedBy, 'local-user')
  assert.ok(approved?.approvedAt)
  assert.equal(getOperationalQueueItem(queueItem.id)?.status, 'completed')
}))

test('concurrent channel approvals claim once before dispatch awaits', async () => withChannelDispatchStore('concurrent', async () => {
  const channel = createChannelDefinition({
    provider: 'local_webhook',
    name: 'Ops webhook',
    sourceKey: 'ops',
    senderAllowlist: ['ops@example.com'],
    route: { activationMode: 'run_sop', targetSopId: 'sop-weekly' },
  })
  const item = recordChannelInboundItem({
    channelId: channel.id,
    sender: 'ops@example.com',
    body: 'Run the SOP once.',
  })

  let runCalls = 0
  let resolveRun: ((link: SopRunLink) => void) | null = null
  const first = approveChannelInboundItem(item.id, {
    runSopForTrigger: async () => {
      runCalls += 1
      return await new Promise<SopRunLink>((resolve) => {
        resolveRun = resolve
      })
    },
  })
  const second = await approveChannelInboundItem(item.id, {
    runSopForTrigger: async () => {
      runCalls += 1
      return sopLink({ automationRunId: 'duplicate-run' })
    },
  })

  assert.equal(second?.status, 'dispatching')
  assert.equal(runCalls, 1)
  assert.ok(resolveRun)
  resolveRun(sopLink())
  const completed = await first

  assert.equal(completed?.status, 'dispatched')
  assert.equal(completed?.runId, 'automation-run-1')
  assert.equal(runCalls, 1)
}))

test('approving a channel Crew item creates a channel-sourced work item', async () => withChannelDispatchStore('crew', async () => {
  const channel = createChannelDefinition({
    provider: 'email',
    name: 'Research inbox',
    sourceKey: 'research',
    senderAllowlist: ['lead@example.com'],
    route: { activationMode: 'run_crew', targetCrewId: 'crew-research' },
  })
  const item = recordChannelInboundItem({
    channelId: channel.id,
    sender: 'lead@example.com',
    subject: 'Market scan',
    body: 'Run a concise market scan.',
  })

  const approved = await approveChannelInboundItem(item.id, {
    createCrewRuntimeDriver: () => ({
      createRootSession: async () => ({ id: 'session-1' }),
      prompt: async () => {},
      evaluateOutcome: async () => ({ sessionId: 'eval-1', structured: null, text: '' }),
    }),
    startCrewRunWithOpenCode: async (draft, _driver, options) => {
      assert.equal(draft.crewId, 'crew-research')
      assert.equal(draft.workItemTitle, 'Market scan')
      assert.equal(draft.workItemSource, 'channel')
      assert.match(draft.workItemDescription || '', /Sender: lead@example\.com/)
      assert.deepEqual(options, {
        workspaceProfileId: 'channel-sandbox',
        channelId: channel.id,
      })
      return crewDetail()
    },
  })

  assert.equal(approved?.status, 'dispatched')
  assert.equal(approved?.auditState, 'execution_dispatched')
  assert.equal(approved?.runKind, 'crew')
  assert.equal(approved?.runId, 'crew-run-1')
  assert.equal(approved?.workItemId, 'work-channel-1')
}))

test('failed channel dispatch is recorded without losing the inbound item', async () => withChannelDispatchStore('failure', async () => {
  const channel = createChannelDefinition({
    provider: 'local_webhook',
    name: 'Ops webhook',
    sourceKey: 'ops',
    senderAllowlist: ['ops@example.com'],
    route: { activationMode: 'run_sop', targetSopId: 'sop-weekly' },
  })
  const item = recordChannelInboundItem({
    channelId: channel.id,
    sender: 'ops@example.com',
    body: 'Run the SOP.',
  })
  const queueItem = listOperationalQueueItems()[0]
  assert.ok(queueItem)

  const failed = await approveChannelInboundItem(item.id, {
    runSopForTrigger: async () => {
      throw new Error('SOP backing automation needs an approved execution brief before it can run.')
    },
  })

  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.auditState, 'failed')
  assert.match(failed?.error || '', /approved execution brief/)
  assert.equal(getOperationalQueueItem(queueItem.id)?.status, 'failed')
  assert.equal(getChannelInboundItem(item.id)?.id, item.id)
}))

test('dismissing a queued channel item cancels review queue state', async () => withChannelDispatchStore('dismiss', async () => {
  const channel = createChannelDefinition({
    provider: 'local_webhook',
    name: 'Ops webhook',
    sourceKey: 'ops',
    senderAllowlist: ['ops@example.com'],
    route: { activationMode: 'run_crew', targetCrewId: 'crew-research' },
  })
  const item = recordChannelInboundItem({
    channelId: channel.id,
    sender: 'ops@example.com',
    body: 'Do not run this.',
  })
  const queueItem = listOperationalQueueItems()[0]
  assert.ok(queueItem)

  const dismissed = dismissChannelInboundReview(item.id, 'Not useful.')

  assert.equal(dismissed?.status, 'denied')
  assert.equal(dismissed?.auditState, 'dismissed')
  assert.equal(dismissed?.reviewNote, 'Not useful.')
  assert.equal(getOperationalQueueItem(queueItem.id)?.status, 'cancelled')
}))

test('dismiss refuses failed channel items without erasing diagnostics', async () => withChannelDispatchStore('dismiss-failed', async () => {
  const channel = createChannelDefinition({
    provider: 'local_webhook',
    name: 'Ops webhook',
    sourceKey: 'ops',
    senderAllowlist: ['ops@example.com'],
    route: { activationMode: 'run_sop', targetSopId: 'sop-weekly' },
  })
  const item = recordChannelInboundItem({
    channelId: channel.id,
    sender: 'ops@example.com',
    body: 'Run the SOP.',
  })
  const failed = await approveChannelInboundItem(item.id, {
    runSopForTrigger: async () => {
      throw new Error('dispatch failed')
    },
  })

  assert.equal(failed?.status, 'failed')
  assert.throws(() => dismissChannelInboundReview(item.id, 'hide failure'), /not waiting for review/)
  const current = getChannelInboundItem(item.id)
  assert.equal(current?.status, 'failed')
  assert.equal(current?.auditState, 'failed')
  assert.equal(current?.error, 'dispatch failed')
}))
