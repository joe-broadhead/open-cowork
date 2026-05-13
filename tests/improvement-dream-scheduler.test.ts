import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings, AgentMemoryDraft, ImprovementEvidenceRef } from '../packages/shared/src/index.ts'
import {
  COWORK_IMPROVEMENT_SCHEMA_VERSION,
} from '../packages/shared/src/improvements.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { closeLogger } from '../apps/desktop/src/main/logger.ts'
import {
  approveAgentMemoryEntry,
  clearImprovementStoreCache,
  completeDreamRun,
  createAgentMemoryProposal,
  failDreamRun,
  getLatestCompletedDreamRun,
  getLatestDreamRun,
  getImprovementProposal,
  startDreamRun,
} from '../apps/desktop/src/main/improvement-store.ts'
import {
  isScheduledDreamConsolidationDue,
  runScheduledDreamConsolidationTick,
} from '../apps/desktop/src/main/improvement-dream-scheduler.ts'
import type { DreamRuntimeDriver } from '../apps/desktop/src/main/improvement-dream-runner.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-dream-scheduler-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

async function withImprovementStore(name: string, fn: () => Promise<void>) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    closeLogger()
    process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
    clearConfigCaches()
    clearImprovementStoreCache()
    await fn()
  } finally {
    closeLogger()
    clearImprovementStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    selectedProviderId: null,
    selectedModelId: null,
    providerCredentials: {},
    integrationCredentials: {},
    integrationEnabled: {},
    bashPermission: 'deny',
    fileWritePermission: 'deny',
    enableBash: false,
    enableFileWrite: false,
    runtimeToolingBridgeEnabled: true,
    automationLaunchAtLogin: false,
    automationRunInBackground: true,
    automationDesktopNotifications: true,
    automationQuietHoursStart: '22:00',
    automationQuietHoursEnd: '07:00',
    defaultAutomationAutonomyPolicy: 'review-first',
    defaultAutomationExecutionMode: 'planning_only',
    operationalMaxAutonomy: 'supervised',
    operationalWriteMaxParallel: 1,
    operationalMaxRunDurationMinutes: 120,
    operationalMaxCostUsd: null,
    operationalMaxRetries: 10,
    improvementProposalsEnabled: true,
    improvementProposalsDisabledAgents: {},
    improvementProposalsDisabledProjects: {},
    improvementProposalsDisabledCrews: {},
    dreamConsolidationScheduleEnabled: true,
    dreamConsolidationIntervalHours: 24,
    ...overrides,
  }
}

function evidence(id = 'trace-1'): ImprovementEvidenceRef {
  return {
    schemaVersion: COWORK_IMPROVEMENT_SCHEMA_VERSION,
    kind: 'trace',
    id,
    label: `Trace ${id}`,
    uri: null,
    hash: `sha256:${id}`,
  }
}

function memoryDraft(overrides: Partial<AgentMemoryDraft> = {}): AgentMemoryDraft {
  return {
    scopeKind: 'machine',
    scopeId: null,
    title: 'Use concise validation notes',
    summary: 'Keep validation notes concise.',
    body: 'Roadmap handoffs should name the validation commands and keep notes concise.',
    tags: ['validation'],
    privacy: 'internal',
    provenance: [evidence()],
    ...overrides,
  }
}

function driverForMemory(memoryId: string): DreamRuntimeDriver {
  return {
    async consolidate() {
      return {
        sessionId: 'scheduled-dream-session',
        structured: {
          type: 'open_cowork.dream_consolidation',
          version: 1,
          summary: 'Consolidate validation guidance.',
          candidates: [{
            operation: 'update',
            sourceMemoryEntryId: memoryId,
            title: 'Use concise validation notes',
            summary: 'Keep validation notes concise and source-backed.',
            body: 'Roadmap handoffs should name validation commands and keep notes concise.',
            tags: ['validation'],
            privacy: 'internal',
          }],
        },
        text: '',
      }
    },
  }
}

test('scheduled dream consolidation due checks respect policy and interval', () => {
  const now = new Date('2026-05-10T12:00:00.000Z')
  const staleRun = {
    startedAt: '2026-05-09T11:00:00.000Z',
  } as Parameters<typeof isScheduledDreamConsolidationDue>[1]
  const recentRun = {
    startedAt: '2026-05-10T11:30:00.000Z',
  } as Parameters<typeof isScheduledDreamConsolidationDue>[1]

  assert.equal(isScheduledDreamConsolidationDue(settings(), null, now), true)
  assert.equal(isScheduledDreamConsolidationDue(settings({ dreamConsolidationScheduleEnabled: false }), null, now), false)
  assert.equal(isScheduledDreamConsolidationDue(settings({ improvementProposalsEnabled: false }), null, now), false)
  assert.equal(isScheduledDreamConsolidationDue(settings(), recentRun, now), false)
  assert.equal(isScheduledDreamConsolidationDue(settings(), staleRun, now), true)
})

test('scheduled dream consolidation runs through the shared dream runner when due', async () => {
  await withImprovementStore('scheduled-run', async () => {
    const memory = createAgentMemoryProposal(memoryDraft())
    approveAgentMemoryEntry(memory.id, 'reviewer')

    const run = await runScheduledDreamConsolidationTick(
      new Date('2026-05-10T12:00:00.000Z'),
      driverForMemory(memory.id),
      settings(),
    )
    const proposal = getImprovementProposal(run?.candidateProposalIds[0] || '')

    assert.equal(run?.status, 'completed')
    assert.equal(run?.title, 'Scheduled memory consolidation')
    assert.equal(proposal?.status, 'proposed')
    assert.equal(proposal?.targetId, memory.id)
  })
})

test('scheduled dream consolidation skips safely when not due or no memory exists', async () => {
  await withImprovementStore('scheduled-skip', async () => {
    let called = false
    const memory = createAgentMemoryProposal(memoryDraft())
    approveAgentMemoryEntry(memory.id, 'reviewer')
    const recent = startDreamRun({
      title: 'Recent successful consolidation',
      instructions: 'Recently completed.',
      sourceMemoryEntryIds: [memory.id],
    })
    completeDreamRun(recent.id)

    const notDue = await runScheduledDreamConsolidationTick(
      new Date(Date.parse(recent.startedAt) + 60 * 60 * 1000),
      {
        async consolidate() {
          called = true
          throw new Error('not used')
        },
      },
      settings(),
    )

    assert.equal(notDue, null)
    assert.equal(called, false)
  })

  await withImprovementStore('scheduled-empty', async () => {
    let called = false
    const skipped = await runScheduledDreamConsolidationTick(
      new Date('2026-05-10T12:00:00.000Z'),
      {
        async consolidate() {
          called = true
          throw new Error('not used')
        },
      },
      settings(),
    )

    assert.equal(skipped, null)
    assert.equal(called, false)
    assert.equal(getLatestDreamRun(), null)
  })
})

test('scheduled dream consolidation ignores failed attempts when deciding whether a successful run is due', async () => {
  await withImprovementStore('scheduled-ignore-failed', async () => {
    const memory = createAgentMemoryProposal(memoryDraft())
    approveAgentMemoryEntry(memory.id, 'reviewer')
    const failed = startDreamRun({
      title: 'Failed consolidation attempt',
      instructions: 'Recently attempted.',
      sourceMemoryEntryIds: [memory.id],
    })
    failDreamRun(failed.id, 'Provider unavailable.')

    const run = await runScheduledDreamConsolidationTick(
      new Date(Date.parse(failed.startedAt) + 60 * 60 * 1000),
      driverForMemory(memory.id),
      settings(),
    )

    assert.equal(run?.status, 'completed')
    assert.notEqual(run?.id, failed.id)
    assert.equal(getLatestCompletedDreamRun()?.id, run?.id)
  })
})
