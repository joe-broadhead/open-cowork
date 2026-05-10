import type { OutputFormat } from '@opencode-ai/sdk/v2'
import type {
  AgentMemoryEntry,
  DreamRun,
  ImprovementCandidateDiff,
  ImprovementEvidenceRef,
  ImprovementProposalDraft,
} from '@open-cowork/shared'
import {
  COWORK_IMPROVEMENT_SCHEMA_VERSION,
} from '@open-cowork/shared'
import { createHash } from 'node:crypto'
import {
  completeDreamRun,
  createImprovementProposal,
  failDreamRun,
  getRunningDreamRun,
  listAgentMemoryEntries,
  startDreamRun,
} from './improvement-store.ts'
import {
  dreamConsolidationOutputFormat,
  dreamConsolidationSchemaHint,
  extractDreamConsolidationFromAssistantText,
  extractDreamConsolidationFromStructured,
  type DreamConsolidationCandidate,
} from './improvement-dream-contract.ts'
import { getClientForDirectory, getRuntimeHomeDir } from './runtime.ts'
import { ensureRuntimeContextDirectory } from './runtime-context.ts'
import { getEffectiveSettings } from './settings.ts'
import { log } from './logger.ts'
import { normalizeSessionInfo, normalizeSessionMessages } from './opencode-adapter.ts'
import { shortSessionId } from './log-sanitizer.ts'
import { trackParentSession } from './event-task-state.ts'
import { toIsoTimestamp } from './task-run-utils.ts'
import { toSessionRecord, upsertSessionRecord, updateSessionRecord } from './session-registry.ts'
import { getThreadIndexService } from './thread-index-service.ts'

const MAX_DREAM_SOURCE_MEMORIES = 12

export type DreamRuntimeDriver = {
  consolidate: (input: {
    title: string
    prompt: string
    format: OutputFormat
  }) => Promise<{
    sessionId: string
    structured: unknown
    text: string
    tokenUsage?: DreamRun['tokenUsage']
    costUsd?: number | null
  }>
}

function sha256Text(value: string) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function evidenceKey(evidence: ImprovementEvidenceRef) {
  return `${evidence.kind}:${evidence.id}:${evidence.hash || ''}`
}

function dreamEvidence(run: DreamRun, sessionId: string, sourceMemories: AgentMemoryEntry[]): ImprovementEvidenceRef[] {
  const evidence = new Map<string, ImprovementEvidenceRef>()
  const add = (entry: ImprovementEvidenceRef) => evidence.set(evidenceKey(entry), entry)
  add({
    schemaVersion: COWORK_IMPROVEMENT_SCHEMA_VERSION,
    kind: 'run',
    id: run.id,
    label: `Dream run: ${run.title}`,
    uri: null,
    hash: null,
  })
  add({
    schemaVersion: COWORK_IMPROVEMENT_SCHEMA_VERSION,
    kind: 'session',
    id: sessionId,
    label: `OpenCode consolidation session ${shortSessionId(sessionId)}`,
    uri: null,
    hash: null,
  })
  for (const memory of sourceMemories) {
    for (const entry of memory.provenance) add(entry)
  }
  return [...evidence.values()]
}

function sourceTraceEventIds(sourceMemories: AgentMemoryEntry[]) {
  return Array.from(new Set(sourceMemories.flatMap((memory) => (
    memory.provenance.filter((entry) => entry.kind === 'trace').map((entry) => entry.id)
  )))).sort()
}

function selectDreamSourceMemories() {
  return listAgentMemoryEntries()
    .filter((entry) => entry.status === 'approved' && entry.privacy !== 'restricted')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, MAX_DREAM_SOURCE_MEMORIES)
}

function formatMemoryForPrompt(memory: AgentMemoryEntry, index: number) {
  return [
    `Memory ${index + 1}`,
    `id: ${memory.id}`,
    `scope: ${memory.scopeKind}${memory.scopeId ? `:${memory.scopeId}` : ''}`,
    `privacy: ${memory.privacy}`,
    `title: ${memory.title}`,
    `summary: ${memory.summary}`,
    `tags: ${memory.tags.join(', ') || '(none)'}`,
    'body:',
    memory.body,
  ].join('\n')
}

function buildDreamPrompt(sourceMemories: AgentMemoryEntry[]) {
  return [
    'You are consolidating Open Cowork governed memory.',
    '',
    'OpenCode owns execution. Open Cowork owns durable product memory and review gates.',
    'Do not claim that any memory, skill, SOP, crew, routing rule, or policy has been changed.',
    'Return only candidate improvements. Every candidate will require explicit user review before it can affect runtime behavior.',
    '',
    'Look for duplicate, stale, overly narrow, or mergeable memories. Prefer a small set of high-signal proposals over many weak ones.',
    'Use "create" for a new lesson, "update" to supersede an existing source memory, and "delete" only when an approved memory should be archived.',
    'For update/delete candidates, sourceMemoryEntryId must be one of the input memory ids.',
    'Use privacy "internal" unless the source material clearly requires a stricter classification.',
    '',
    'Return a structured JSON payload matching this schema:',
    dreamConsolidationSchemaHint(),
    '',
    'Approved source memories:',
    ...sourceMemories.map(formatMemoryForPrompt),
  ].join('\n\n')
}

function normalizeCandidateDiff(candidate: DreamConsolidationCandidate, sourceById: Map<string, AgentMemoryEntry>): ImprovementCandidateDiff | null {
  const target = candidate.sourceMemoryEntryId ? sourceById.get(candidate.sourceMemoryEntryId) || null : null
  if (candidate.operation !== 'create' && !target) return null
  const payload = candidate.operation === 'delete'
    ? {
        title: target?.title || candidate.title,
        summary: candidate.summary,
      }
    : {
        scopeKind: target?.scopeKind || 'machine',
        scopeId: target?.scopeId || null,
        title: candidate.title,
        body: candidate.body,
        summary: candidate.summary,
        tags: candidate.tags,
        privacy: candidate.privacy,
        sourceMemoryEntryIds: candidate.sourceMemoryEntryId ? [candidate.sourceMemoryEntryId] : [],
      }
  return {
    schemaVersion: COWORK_IMPROVEMENT_SCHEMA_VERSION,
    targetType: 'memory',
    targetId: target?.id || null,
    operation: candidate.operation,
    summary: candidate.summary,
    beforeHash: target?.contentHash || null,
    afterHash: candidate.operation === 'delete' ? null : sha256Text(JSON.stringify(payload)),
    payload,
  }
}

function proposalDraftForCandidate(
  candidate: DreamConsolidationCandidate,
  diff: ImprovementCandidateDiff,
  evidence: ImprovementEvidenceRef[],
): ImprovementProposalDraft {
  return {
    targetType: 'memory',
    targetId: diff.targetId,
    title: candidate.title,
    summary: candidate.summary,
    evidence,
    candidateDiffs: [diff],
  }
}

export function createOpenCodeDreamRuntimeDriver(): DreamRuntimeDriver {
  const directory = getRuntimeHomeDir()

  function getRuntimeClient() {
    const client = getClientForDirectory(directory)
    if (!client) throw new Error('Runtime not started')
    return client
  }

  return {
    async consolidate(input) {
      await ensureRuntimeContextDirectory(directory)
      const client = getRuntimeClient()
      const settings = getEffectiveSettings()
      const created = await client.session.create({}, { throwOnError: true })
      const session = normalizeSessionInfo(created.data)
      if (!session?.id) throw new Error('Runtime returned an invalid dream session payload')
      try {
        await client.session.update({ sessionID: session.id, title: input.title })
      } catch (error) {
        log('improvement', `Could not title dream session ${shortSessionId(session.id)}: ${error instanceof Error ? error.message : String(error)}`)
      }
      trackParentSession(session.id)
      const record = upsertSessionRecord(toSessionRecord({
        id: session.id,
        title: input.title || session.title || 'Dream consolidation',
        createdAt: toIsoTimestamp(session.time.created),
        updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
        opencodeDirectory: directory,
        providerId: settings.effectiveProviderId || null,
        modelId: settings.effectiveModel || null,
        kind: 'interactive',
      }))
      if (record) getThreadIndexService().upsertThreadFromSessionRecord(record)

      await client.session.prompt({
        sessionID: session.id,
        parts: [{ type: 'text', text: input.prompt }],
        agent: 'plan',
        format: input.format,
      }, { throwOnError: true })

      const messages = normalizeSessionMessages((await client.session.messages({ sessionID: session.id }, { throwOnError: true })).data)
      const assistant = [...messages].reverse().find((message) => message.role === 'assistant') || null
      const text = assistant?.parts
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text?.trim() || '')
        .filter(Boolean)
        .join('\n\n') || ''
      const updated = updateSessionRecord(session.id, { updatedAt: new Date().toISOString() })
      if (updated) getThreadIndexService().upsertThreadFromSessionRecord(updated)
      log('improvement', `Recorded dream consolidation output from ${shortSessionId(session.id)}`)
      return {
        sessionId: session.id,
        structured: assistant?.structured,
        text,
      }
    },
  }
}

export async function runManualDreamConsolidation(
  driver: DreamRuntimeDriver = createOpenCodeDreamRuntimeDriver(),
): Promise<DreamRun> {
  const existingRun = getRunningDreamRun()
  if (existingRun) return existingRun

  const sourceMemories = selectDreamSourceMemories()
  const prompt = buildDreamPrompt(sourceMemories)
  const settings = getEffectiveSettings()
  const run = startDreamRun({
    title: 'Manual memory consolidation',
    modelId: settings.effectiveModel || null,
    instructions: prompt,
    sourceMemoryEntryIds: sourceMemories.map((memory) => memory.id),
    sourceTraceEventIds: sourceTraceEventIds(sourceMemories),
  })

  if (sourceMemories.length === 0) {
    return failDreamRun(run.id, 'No approved unrestricted memory is available to consolidate.')!
  }

  try {
    const output = await driver.consolidate({
      title: run.title,
      prompt,
      format: dreamConsolidationOutputFormat() as OutputFormat,
    })
    const parsed = extractDreamConsolidationFromStructured(output.structured)
      || extractDreamConsolidationFromAssistantText(output.text)
    if (!parsed) throw new Error('Dream consolidation did not return a valid candidate improvement payload.')

    const sourceById = new Map(sourceMemories.map((memory) => [memory.id, memory]))
    const evidence = dreamEvidence(run, output.sessionId, sourceMemories)
    const proposalIds: string[] = []
    for (const candidate of parsed.candidates) {
      const diff = normalizeCandidateDiff(candidate, sourceById)
      if (!diff) continue
      const proposal = createImprovementProposal(proposalDraftForCandidate(candidate, diff, evidence))
      proposalIds.push(proposal.id)
    }

    return completeDreamRun(run.id, {
      candidateProposalIds: proposalIds,
      tokenUsage: output.tokenUsage,
      costUsd: output.costUsd,
    })!
  } catch (error) {
    return failDreamRun(run.id, error instanceof Error ? error.message : String(error))!
  }
}
