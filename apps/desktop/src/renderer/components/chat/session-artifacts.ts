import type { SessionArtifact, ToolCall, TaskRun, SessionView } from '@open-cowork/shared'

function artifactPathFromTool(tool: ToolCall): string | null {
  const input = tool.input || {}
  const candidate = typeof input.filePath === 'string'
    ? input.filePath
    : typeof input.path === 'string'
      ? input.path
      : null

  if (!candidate || !candidate.startsWith('/')) return null
  if (!['write', 'edit', 'multi_edit', 'str_replace', 'apply_patch'].includes(tool.name)) return null
  return candidate
}

function artifactFromTool(tool: ToolCall, taskRunId?: string | null): SessionArtifact | null {
  const filePath = artifactPathFromTool(tool)
  if (!filePath) return null
  const filename = filePath.split('/').filter(Boolean).pop() || filePath
  return {
    id: `${taskRunId || 'session'}:${tool.id}:${filePath}`,
    toolId: tool.id,
    toolName: tool.name,
    filePath,
    filename,
    order: tool.order,
    taskRunId: taskRunId || null,
  }
}

function dedupeArtifacts(artifacts: Array<SessionArtifact | null>) {
  const map = new Map<string, SessionArtifact>()
  for (const artifact of artifacts) {
    if (!artifact) continue
    const existing = map.get(artifact.filePath)
    if (!existing || artifact.order > existing.order) {
      map.set(artifact.filePath, artifact)
    }
  }
  return Array.from(map.values()).sort((left, right) => right.order - left.order)
}

export function listSessionArtifacts(view: SessionView): SessionArtifact[] {
  return dedupeArtifacts([
    ...view.toolCalls.map((tool) => artifactFromTool(tool)),
    ...view.taskRuns.flatMap((taskRun) =>
      taskRun.toolCalls.map((tool) => artifactFromTool(tool, taskRun.id)),
    ),
  ])
}

export function listArtifactsForTools(tools: ToolCall[], taskRun?: TaskRun | null): SessionArtifact[] {
  return dedupeArtifacts(tools.map((tool) => artifactFromTool(tool, taskRun?.id || null)))
}

export function artifactForTool(tool: ToolCall, taskRun?: TaskRun | null): SessionArtifact | null {
  return artifactFromTool(tool, taskRun?.id || null)
}

export function sanitizeArtifactToolInput(input: Record<string, unknown>, artifact: SessionArtifact | null) {
  if (!artifact) return input
  const next = { ...input }
  if (typeof next.filePath === 'string') next.filePath = `artifact://${artifact.filename}`
  if (typeof next.path === 'string') next.path = `artifact://${artifact.filename}`
  return next
}
