import type { IpcHandlerContext } from './context.ts'
import {
  approveAgentMemoryEntry,
  approveImprovementProposal,
  archiveAgentMemoryEntry,
  archiveImprovementProposal,
  buildImprovementDiagnosticsSummary,
  listImprovementReviewQueue,
  rejectAgentMemoryEntry,
  rejectImprovementProposal,
  updateImprovementProposal,
} from '../improvement-store.ts'
import { buildImprovementPolicyDiagnostics } from '../improvement-policy.ts'
import { getEffectiveSettings } from '../settings.ts'
import type { ImprovementProposalDraft } from '@open-cowork/shared'

const MAX_IMPROVEMENT_ID_BYTES = 512
const MAX_IMPROVEMENT_NOTE_BYTES = 4096
const MAX_IMPROVEMENT_DRAFT_BYTES = 256 * 1024

function assertString(value: unknown, label: string, maxBytes = MAX_IMPROVEMENT_ID_BYTES) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) throw new Error(`${label} is too large.`)
  return normalized
}

function optionalNote(value: unknown) {
  if (value === undefined || value === null) return null
  return assertString(value, 'Improvement review note', MAX_IMPROVEMENT_NOTE_BYTES)
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
}

function assertJsonSize(value: unknown, label: string) {
  const raw = JSON.stringify(value)
  if (raw === undefined) throw new Error(`${label} must be JSON-serializable.`)
  if (Buffer.byteLength(raw, 'utf8') > MAX_IMPROVEMENT_DRAFT_BYTES) throw new Error(`${label} is too large.`)
}

function assertProposalDraft(value: unknown): asserts value is ImprovementProposalDraft {
  assertObject(value, 'Improvement proposal draft')
  assertJsonSize(value, 'Improvement proposal draft')
  assertString(value.targetType, 'Improvement proposal target type')
  if (value.targetId !== undefined && value.targetId !== null) {
    assertString(value.targetId, 'Improvement proposal target id')
  }
  assertString(value.title, 'Improvement proposal title')
  assertString(value.summary, 'Improvement proposal summary', 4096)
  if (!Array.isArray(value.evidence)) throw new Error('Improvement proposal evidence must be an array.')
  if (!Array.isArray(value.candidateDiffs)) throw new Error('Improvement proposal candidate diffs must be an array.')
}

export function registerImprovementHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('improvements:summary', async () => {
    return buildImprovementDiagnosticsSummary(
      buildImprovementPolicyDiagnostics(getEffectiveSettings()),
    )
  })

  context.ipcMain.handle('improvements:inbox', async () => {
    return listImprovementReviewQueue()
  })

  context.ipcMain.handle('improvements:memory-approve', async (_event, id: unknown, note?: unknown) => {
    return approveAgentMemoryEntry(assertString(id, 'Memory id'), 'local-user', optionalNote(note))
  })

  context.ipcMain.handle('improvements:memory-reject', async (_event, id: unknown, note?: unknown) => {
    return rejectAgentMemoryEntry(assertString(id, 'Memory id'), 'local-user', optionalNote(note))
  })

  context.ipcMain.handle('improvements:memory-archive', async (_event, id: unknown, note?: unknown) => {
    return archiveAgentMemoryEntry(assertString(id, 'Memory id'), 'local-user', optionalNote(note))
  })

  context.ipcMain.handle('improvements:proposal-update', async (_event, id: unknown, draft: unknown) => {
    assertProposalDraft(draft)
    return updateImprovementProposal(assertString(id, 'Improvement proposal id'), draft)
  })

  context.ipcMain.handle('improvements:proposal-approve', async (_event, id: unknown, note?: unknown) => {
    return approveImprovementProposal(assertString(id, 'Improvement proposal id'), 'local-user', optionalNote(note))
  })

  context.ipcMain.handle('improvements:proposal-reject', async (_event, id: unknown, note?: unknown) => {
    return rejectImprovementProposal(assertString(id, 'Improvement proposal id'), 'local-user', optionalNote(note))
  })

  context.ipcMain.handle('improvements:proposal-archive', async (_event, id: unknown, note?: unknown) => {
    return archiveImprovementProposal(assertString(id, 'Improvement proposal id'), 'local-user', optionalNote(note))
  })
}
