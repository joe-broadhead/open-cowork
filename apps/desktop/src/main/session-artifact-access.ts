import { resolve } from 'path'
import type { SessionView, ToolCall } from '@open-cowork/shared'

function artifactPathFromTool(tool: ToolCall): string | null {
  const input = tool.input || {}
  const candidate = typeof input.filePath === 'string'
    ? input.filePath
    : typeof input.path === 'string'
      ? input.path
      : null

  if (!candidate || !candidate.startsWith('/')) return null
  if (!['write', 'edit', 'multi_edit', 'str_replace', 'apply_patch'].includes(tool.name)) return null
  return resolve(candidate)
}

export function listKnownSessionArtifactPaths(view: SessionView): Set<string> {
  const known = new Set<string>()
  for (const tool of view.toolCalls) {
    const artifactPath = artifactPathFromTool(tool)
    if (artifactPath) known.add(artifactPath)
  }
  for (const taskRun of view.taskRuns) {
    for (const tool of taskRun.toolCalls) {
      const artifactPath = artifactPathFromTool(tool)
      if (artifactPath) known.add(artifactPath)
    }
  }
  return known
}

export function isReadableSessionArtifact(view: SessionView, source: string): boolean {
  return listKnownSessionArtifactPaths(view).has(resolve(source))
}
