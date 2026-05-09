import type { ChartSaveArtifactRequest, SessionView, ToolCall } from '@open-cowork/shared'

function isChartToolName(toolName: string) {
  return toolName === 'render_chart'
    || toolName.startsWith('charts_')
    || toolName.startsWith('charts.')
    || toolName.startsWith('mcp__charts__')
}

function toolMatchesChartArtifactRequest(tool: ToolCall, request: ChartSaveArtifactRequest) {
  return isChartToolName(tool.name)
    && tool.id === request.toolCallId
    && tool.name === request.toolName
}

export function findChartArtifactTool(view: SessionView, request: ChartSaveArtifactRequest): ToolCall | null {
  if (request.taskRunId) {
    const taskRun = view.taskRuns.find((entry) => entry.id === request.taskRunId)
    if (!taskRun) return null
    return taskRun.toolCalls.find((tool) => toolMatchesChartArtifactRequest(tool, request)) || null
  }

  const rootTool = view.toolCalls.find((tool) => toolMatchesChartArtifactRequest(tool, request))
  if (rootTool) return rootTool

  for (const taskRun of view.taskRuns) {
    const taskTool = taskRun.toolCalls.find((tool) => toolMatchesChartArtifactRequest(tool, request))
    if (taskTool) return taskTool
  }
  return null
}

export function isKnownChartArtifactToolCall(view: SessionView, request: ChartSaveArtifactRequest) {
  return Boolean(findChartArtifactTool(view, request))
}
