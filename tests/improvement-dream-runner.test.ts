import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COWORK_IMPROVEMENT_SCHEMA_VERSION,
  type AgentMemoryDraft,
  type ImprovementEvidenceRef,
} from '../packages/shared/src/improvements.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { closeLogger } from '../apps/desktop/src/main/logger.ts'
import {
  approveAgentMemoryEntry,
  clearImprovementStoreCache,
  createAgentMemoryProposal,
  getAgentMemoryEntry,
  getImprovementProposal,
  listImprovementProposals,
  startDreamRun,
} from '../apps/desktop/src/main/improvement-store.ts'
import {
  dreamConsolidationOutputFormat,
  extractDreamConsolidationFromAssistantText,
  extractDreamConsolidationFromStructured,
} from '../apps/desktop/src/main/improvement-dream-contract.ts'
import { runManualDreamConsolidation, type DreamRuntimeDriver } from '../apps/desktop/src/main/improvement-dream-runner.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-dream-runner-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
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

function evidenceRefs(prefix: string, count: number) {
  return Array.from({ length: count }, (_value, index) => evidence(`${prefix}-${index + 1}`))
}

function memoryDraft(overrides: Partial<AgentMemoryDraft> = {}): AgentMemoryDraft {
  return {
    scopeKind: 'machine',
    scopeId: null,
    title: 'Prefer short evidence notes',
    summary: 'Use concise evidence notes.',
    body: 'When producing weekly reporting output, cite the source run and keep the recommendation section concise.',
    tags: ['reporting', 'evidence'],
    privacy: 'internal',
    provenance: [evidence()],
    ...overrides,
  }
}

test('dream consolidation output contract is bounded and parseable', () => {
  const format = dreamConsolidationOutputFormat()
  assert.equal(format.type, 'json_schema')
  assert.equal(format.retryCount, 2)
  assert.equal((format.schema.properties as Record<string, unknown>).candidates instanceof Object, true)

  const parsed = extractDreamConsolidationFromStructured({
    type: 'open_cowork.dream_consolidation',
    version: 1,
    summary: 'Merge duplicate reporting memories.',
    candidates: [{
      operation: 'update',
      sourceMemoryEntryId: 'memory-1',
      title: 'Prefer concise evidence notes',
      summary: 'Keep evidence concise.',
      body: 'Use concise evidence notes and cite the source run.',
      tags: ['Reporting', 'reporting', 'Evidence'],
      privacy: 'internal',
    }],
  })

  assert.equal(parsed?.summary, 'Merge duplicate reporting memories.')
  assert.deepEqual(parsed?.candidates[0]?.tags, ['reporting', 'evidence'])
  assert.equal(extractDreamConsolidationFromStructured({
    type: 'open_cowork.dream_consolidation',
    version: 1,
    summary: 'Invalid.',
    candidates: [{ operation: 'create', sourceMemoryEntryId: null, title: 'Missing body', summary: 'No body.', body: '', tags: [], privacy: 'internal' }],
  })?.candidates.length, 0)
})

test('dream consolidation parser accepts fenced JSON fallback', () => {
  const parsed = extractDreamConsolidationFromAssistantText([
    '```json',
    JSON.stringify({
      type: 'open_cowork.dream_consolidation',
      version: 1,
      summary: 'Create one candidate.',
      candidates: [{
        operation: 'create',
        sourceMemoryEntryId: null,
        title: 'Add handoff memory',
        summary: 'Capture a reusable handoff lesson.',
        body: 'Always include validation commands in roadmap handoffs.',
        tags: ['handoff'],
        privacy: 'internal',
      }],
    }),
    '```',
  ].join('\n'))

  assert.equal(parsed?.candidates[0]?.operation, 'create')
  assert.equal(parsed?.candidates[0]?.title, 'Add handoff memory')
})

test('manual dream consolidation runs through the OpenCode driver and creates review-only proposals', async () => {
  await withImprovementStore('manual-dream', async () => {
    const memory = createAgentMemoryProposal(memoryDraft())
    approveAgentMemoryEntry(memory.id, 'reviewer')
    const before = getAgentMemoryEntry(memory.id)
    assert.ok(before)
    const prompts: Array<{ prompt: string; format: unknown }> = []
    const driver: DreamRuntimeDriver = {
      async consolidate(input) {
        prompts.push({ prompt: input.prompt, format: input.format })
        return {
          sessionId: 'dream-session-1',
          structured: {
            type: 'open_cowork.dream_consolidation',
            version: 1,
            summary: 'Tighten one memory.',
            candidates: [{
              operation: 'update',
              sourceMemoryEntryId: memory.id,
              title: 'Prefer short evidence notes',
              summary: 'Keep reporting recommendations concise and sourced.',
              body: 'When producing weekly reporting output, cite the source run and keep recommendations concise.',
              tags: ['reporting', 'evidence'],
              privacy: 'internal',
            }],
          },
          text: '',
          tokenUsage: { input: 10, output: 20, reasoning: 0 },
          costUsd: 0.01,
        }
      },
    }

    const run = await runManualDreamConsolidation(driver)
    const after = getAgentMemoryEntry(memory.id)
    const proposal = getImprovementProposal(run.candidateProposalIds[0]!)

    assert.equal(run.status, 'completed')
    assert.equal(run.candidateProposalIds.length, 1)
    assert.equal(run.tokenUsage?.input, 10)
    assert.equal(run.costUsd, 0.01)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0]!.prompt, new RegExp(memory.id))
    assert.equal((prompts[0]!.format as { type?: string }).type, 'json_schema')
    assert.equal(proposal?.status, 'proposed')
    assert.equal(proposal?.targetType, 'memory')
    assert.equal(proposal?.targetId, memory.id)
    assert.equal(proposal?.candidateDiffs[0]?.operation, 'update')
    assert.equal(proposal?.evidence.some((entry) => entry.kind === 'run' && entry.id === run.id), true)
    assert.equal(proposal?.evidence.some((entry) => entry.kind === 'session' && entry.id === 'dream-session-1'), true)
    assert.equal(proposal?.evidence.some((entry) => entry.kind === 'trace' && entry.id === 'trace-1'), true)
    assert.equal(after?.contentHash, before.contentHash)
    assert.equal(after?.status, before.status)
  })
})

test('manual dream consolidation keeps create diffs untargeted when they cite source memory', async () => {
  await withImprovementStore('manual-dream-create-source', async () => {
    const memory = createAgentMemoryProposal(memoryDraft())
    approveAgentMemoryEntry(memory.id, 'reviewer')
    const driver: DreamRuntimeDriver = {
      async consolidate() {
        return {
          sessionId: 'dream-session-create',
          structured: {
            type: 'open_cowork.dream_consolidation',
            version: 1,
            summary: 'Create one derived memory.',
            candidates: [{
              operation: 'create',
              sourceMemoryEntryId: memory.id,
              title: 'Add roadmap validation handoff',
              summary: 'Capture validation commands in handoffs.',
              body: 'Roadmap handoffs should include the focused and full validation commands that were run.',
              tags: ['handoff'],
              privacy: 'internal',
            }],
          },
          text: '',
        }
      },
    }

    const run = await runManualDreamConsolidation(driver)
    const proposal = getImprovementProposal(run.candidateProposalIds[0]!)
    const diff = proposal?.candidateDiffs[0]

    assert.equal(run.status, 'completed')
    assert.equal(diff?.operation, 'create')
    assert.equal(diff?.targetId, null)
    assert.equal(diff?.beforeHash, null)
    assert.deepEqual(diff?.payload.sourceMemoryEntryIds, [memory.id])
  })
})

test('manual dream consolidation bounds evidence before creating proposals', async () => {
  await withImprovementStore('manual-dream-evidence-cap', async () => {
    for (let index = 0; index < 12; index += 1) {
      const memory = createAgentMemoryProposal(memoryDraft({
        title: `Memory ${index + 1}`,
        summary: `Memory ${index + 1} summary.`,
        body: `Memory ${index + 1} body.`,
        provenance: evidenceRefs(`memory-${index + 1}`, 10),
      }))
      approveAgentMemoryEntry(memory.id, 'reviewer')
    }
    const driver: DreamRuntimeDriver = {
      async consolidate() {
        return {
          sessionId: 'dream-session-evidence',
          structured: {
            type: 'open_cowork.dream_consolidation',
            version: 1,
            summary: 'Create one cross-memory candidate.',
            candidates: [{
              operation: 'create',
              sourceMemoryEntryId: null,
              title: 'Add consolidated reporting handoff',
              summary: 'Merge recurring reporting guidance.',
              body: 'Keep reporting handoffs concise, sourced, and explicit about validation.',
              tags: ['reporting'],
              privacy: 'internal',
            }],
          },
          text: '',
        }
      },
    }

    const run = await runManualDreamConsolidation(driver)
    const proposal = getImprovementProposal(run.candidateProposalIds[0]!)

    assert.equal(run.status, 'completed')
    assert.ok(proposal)
    assert.equal(proposal.evidence.some((entry) => entry.kind === 'run' && entry.id === run.id), true)
    assert.equal(proposal.evidence.some((entry) => entry.kind === 'session' && entry.id === 'dream-session-evidence'), true)
    assert.equal(proposal.evidence.length <= 100, true)
  })
})

test('manual dream consolidation records an inspectable failed run when no memory is available', async () => {
  await withImprovementStore('manual-dream-empty', async () => {
    let called = false
    const run = await runManualDreamConsolidation({
      async consolidate() {
        called = true
        throw new Error('not used')
      },
    })

    assert.equal(called, false)
    assert.equal(run.status, 'failed')
    assert.match(run.error || '', /No approved unrestricted memory/)
    assert.deepEqual(listImprovementProposals(), [])
  })
})

test('manual dream consolidation returns an existing running dream instead of overlapping runs', async () => {
  await withImprovementStore('manual-dream-running', async () => {
    const memory = createAgentMemoryProposal(memoryDraft())
    approveAgentMemoryEntry(memory.id, 'reviewer')
    const existing = startDreamRun({
      title: 'Existing consolidation',
      modelId: 'openrouter/test',
      instructions: 'Already running.',
      sourceMemoryEntryIds: [memory.id],
      sourceTraceEventIds: ['trace-1'],
    })
    let called = false

    const run = await runManualDreamConsolidation({
      async consolidate() {
        called = true
        throw new Error('not used')
      },
    })

    assert.equal(run.id, existing.id)
    assert.equal(run.status, 'running')
    assert.equal(called, false)
  })
})
