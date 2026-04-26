import type { SessionChangeSummary, SessionUsageSummary } from '@open-cowork/shared'

export interface StoredSessionRecord {
  id?: string
  title?: string
  directory?: string | null
  opencodeDirectory?: string
  createdAt?: string
  updatedAt?: string
  kind?: 'interactive' | 'automation'
  automationId?: string | null
  runId?: string | null
  providerId?: string | null
  modelId?: string | null
  summary?: SessionUsageSummary | null
  parentSessionId?: string | null
  changeSummary?: SessionChangeSummary | null
  revertedMessageId?: string | null
  managedByCowork?: true
}

const MANAGED_SESSION_PATTERNS = [
  /\bCreated session (ses_[A-Za-z0-9]+)\b/g,
  /\bForked [^\n]* -> (ses_[A-Za-z0-9]+)\b/g,
]

export function extractManagedSessionIdsFromLogContents(logContents: string[]) {
  const managed = new Set<string>()

  for (const content of logContents) {
    for (const pattern of MANAGED_SESSION_PATTERNS) {
      pattern.lastIndex = 0
      for (const match of content.matchAll(pattern)) {
        if (match[1]) managed.add(match[1])
      }
    }
  }

  return managed
}

export function normalizeStoredSessionRecord(
  item: StoredSessionRecord,
  normalizeDirectory: (directory: string) => string,
  toDisplayDirectory: (opencodeDirectory: string) => string | null,
  managedSessionIds?: Set<string>,
) {
  if (!item?.id || !item?.opencodeDirectory || !item?.createdAt || !item?.updatedAt) {
    return null
  }

  const opencodeDirectory = normalizeDirectory(item.opencodeDirectory)
  const managedByCowork = item.managedByCowork ?? (managedSessionIds?.has(item.id) ? true : undefined)
  if (managedByCowork !== true) return null
  const kind: 'interactive' | 'automation' = item.kind === 'automation' ? 'automation' : 'interactive'

  return {
    id: item.id,
    title: item.title,
    directory: item.directory ?? toDisplayDirectory(opencodeDirectory),
    opencodeDirectory,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    kind,
    automationId: typeof item.automationId === 'string' ? item.automationId : null,
    runId: typeof item.runId === 'string' ? item.runId : null,
    providerId: typeof item.providerId === 'string' ? item.providerId : null,
    modelId: typeof item.modelId === 'string' ? item.modelId : null,
    summary: item.summary && typeof item.summary === 'object'
      ? {
          messages: typeof item.summary.messages === 'number' ? item.summary.messages : 0,
          userMessages: typeof item.summary.userMessages === 'number' ? item.summary.userMessages : 0,
          assistantMessages: typeof item.summary.assistantMessages === 'number' ? item.summary.assistantMessages : 0,
          toolCalls: typeof item.summary.toolCalls === 'number' ? item.summary.toolCalls : 0,
          taskRuns: typeof item.summary.taskRuns === 'number' ? item.summary.taskRuns : 0,
          cost: typeof item.summary.cost === 'number' ? item.summary.cost : 0,
          tokens: {
            input: typeof item.summary.tokens?.input === 'number' ? item.summary.tokens.input : 0,
            output: typeof item.summary.tokens?.output === 'number' ? item.summary.tokens.output : 0,
            reasoning: typeof item.summary.tokens?.reasoning === 'number' ? item.summary.tokens.reasoning : 0,
            cacheRead: typeof item.summary.tokens?.cacheRead === 'number' ? item.summary.tokens.cacheRead : 0,
            cacheWrite: typeof item.summary.tokens?.cacheWrite === 'number' ? item.summary.tokens.cacheWrite : 0,
          },
        }
      : null,
    parentSessionId: typeof item.parentSessionId === 'string' ? item.parentSessionId : null,
    changeSummary: item.changeSummary && typeof item.changeSummary === 'object'
      ? {
          additions: typeof item.changeSummary.additions === 'number' ? item.changeSummary.additions : 0,
          deletions: typeof item.changeSummary.deletions === 'number' ? item.changeSummary.deletions : 0,
          files: typeof item.changeSummary.files === 'number' ? item.changeSummary.files : 0,
        }
      : null,
    revertedMessageId: typeof item.revertedMessageId === 'string' ? item.revertedMessageId : null,
    managedByCowork: true as const,
  }
}
