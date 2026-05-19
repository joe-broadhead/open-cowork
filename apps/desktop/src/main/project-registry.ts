import type { RecentProject } from '@open-cowork/shared'
import { listSessionRecords } from './session-registry.ts'

export function listRecentProjects(limit = 9): RecentProject[] {
  const byDirectory = new Map<string, RecentProject>()
  for (const record of listSessionRecords()) {
    if (!record.directory) continue
    const existing = byDirectory.get(record.directory)
    if (existing && new Date(existing.updatedAt).getTime() >= new Date(record.updatedAt).getTime()) continue
    byDirectory.set(record.directory, {
      index: 0,
      directory: record.directory,
      latestSessionId: record.id,
      latestTitle: record.title || null,
      updatedAt: record.updatedAt,
    })
  }

  return Array.from(byDirectory.values())
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
    .map((project, index) => ({ ...project, index: index + 1 }))
}

export function getRecentProjectByIndex(index: number) {
  return listRecentProjects(9).find((project) => project.index === index) || null
}
