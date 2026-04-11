export interface StoredSessionRecord {
  id?: string
  title?: string
  directory?: string | null
  opencodeDirectory?: string
  createdAt?: string
  updatedAt?: string
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

  return {
    id: item.id,
    title: item.title,
    directory: item.directory ?? toDisplayDirectory(opencodeDirectory),
    opencodeDirectory,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    managedByCowork: true as const,
  }
}
