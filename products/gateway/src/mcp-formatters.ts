/**
 * MCP response text formatters (JOE-992 progressive façade peel).
 * Leaf relative to mcp.ts — no tool registration side effects.
 */
import {
  buildMissionControlDashboardSummary,
  buildMissionControlDataPlaneV2,
  formatMissionControlDataPlaneText,
  formatMissionControlEnvironmentCounts,
  type MissionControlDataPlaneV2,
  type MissionControlSourceContract,
} from './mission-control-view-model.js'
import { formatTaskCounts } from './task-summary.js'

export function formatGatewayDashboardText(input: { health: any; taskData: any; sessions: any; questions: any; permissions: any; attention?: any; environments?: any; operationsCockpit?: any; sourceContracts?: MissionControlSourceContract[]; dataPlane?: MissionControlDataPlaneV2 }): string {
  const summary = buildMissionControlDashboardSummary(input)
  const dataPlane = input.dataPlane || (input.sourceContracts?.length
    ? buildMissionControlDataPlaneV2({ sourceContracts: input.sourceContracts, consumers: ['mcp', 'dashboard', 'support'] })
    : undefined)
  let text = '# Gateway Dashboard\n\n'
  text += `Status: ${summary.status}\n`
  text += `Scheduler: ${summary.scheduler}\n`
  text += `Issues (tasks): ${summary.taskCounts}\n`
  text += `Gateway Sessions: ${summary.gatewaySessions}\n`
  if (summary.environments) text += `Environments: ${summary.environments}\n`
  text += `Requests: ${summary.requests}\n\n`
  if (summary.sources) {
    text += `Sources: ${summary.sources.summary}\n`
    const sourceAttention = summary.sources.items.filter(item => item.severity !== 'ok' && item.state !== 'empty')
    if (sourceAttention.length) text += sourceAttention.slice(0, 8).map(item => `- [${item.state}] ${item.key}: ${item.nextAction}`).join('\n') + '\n'
    text += '\n'
  }
  if (dataPlane) text += `${formatMissionControlDataPlaneText(dataPlane).join('\n')}\n\n`
  if (summary.attention) text += `Needs Attention: ${summary.attention}\n\n`
  if (summary.operationsCockpit) {
    text += `Operations Cockpit: ${summary.operationsCockpit.status} — ${summary.operationsCockpit.summary}\n`
    const nonReady = summary.operationsCockpit.items.filter(item => item.status !== 'ready')
    if (nonReady.length) text += nonReady.slice(0, 8).map(item => `- [${item.status}] ${item.id}: ${item.nextAction}`).join('\n') + '\n'
    text += '\n'
  }
  text += '## Active Issues\n\n'
  text += summary.activeIssues.length ? summary.activeIssues.map(task => `- [${task.status}] ${task.priority}: ${task.title} (${task.id}) — ${task.agent} / ${task.currentStage}`).join('\n') : 'No active work.'
  text += '\n\n## Initiatives (roadmaps)\n\n'
  text += summary.initiatives.length ? summary.initiatives.map(roadmap => `- [${roadmap.status}] ${roadmap.priority}: ${roadmap.title} (${roadmap.id})`).join('\n') : 'No active roadmaps.'
  return text
}

export function formatBulkTaskCreateText(result: any): string {
  const tasks = result?.tasks || []
  if (!tasks.length) return 'No tasks created.'
  return `Created ${result?.created || tasks.length} task(s)\n\n${tasks.map((task: any) => `- ${task.title} (${task.id}) — ${task.priority || 'MEDIUM'} / ${(task.pipeline || []).join(' -> ') || task.currentStage || 'implement'}`).join('\n')}`
}

export function formatSchedulerRunOnceText(result: any): string {
  const counts = result?.counts || {}
  const lines = [
    'Scheduler cycle complete.',
    `Tasks: ${formatTaskCounts(counts, { includeCancelled: true })}`,
  ]
  const activeTasks = result?.activeTasks || []
  if (activeTasks.length) lines.push('', 'Active work:', ...activeTasks.map((task: any) => `- [${task.status}] ${task.title} (${task.id}) — ${task.currentStage || 'complete'}`))
  const recentRuns = result?.recentRuns || []
  if (recentRuns.length) lines.push('', 'Recent runs:', ...recentRuns.slice(-5).map((run: any) => `- [${run.status}] ${run.stage}: ${run.sessionId} (${run.id})`))
  return lines.join('\n')
}

export function formatEnvironmentListText(result: any): string {
  const environments = result?.environments || []
  const lines = [`${environments.length} environment(s): ${formatMissionControlEnvironmentCounts(environments)}`]
  if (environments.length) {
    lines.push('', ...environments.map((environment: any) => {
      const runtime = environment.runtimeProfile
      const runtimeText = runtime ? ` / runtime ${runtime.filesystem?.policy || '?'} net=${runtime.network?.mode || '?'} cwd=${runtime.cwd?.redacted || '?'}` : ''
      const diagnostics = Array.isArray(environment.lifecycleDiagnostics) ? environment.lifecycleDiagnostics : []
      const worst = diagnostics.find((row: any) => row.severity === 'critical') || diagnostics.find((row: any) => row.severity === 'warning') || diagnostics[0]
      const diagnosticText = worst ? ` / diagnostic ${worst.severity}:${worst.code}` : ''
      return `- [${environment.status}] ${environment.name || environment.id} (${environment.id}) — ${environment.backend || '?'} / run ${environment.runId || '?'} / cleanup ${environment.cleanup?.state || '?'}${runtimeText}${diagnosticText}`
    }))
  }
  return lines.join('\n')
}

export function formatEnvironmentActionText(result: any): string {
  const environment = result?.environment || {}
  return [
    `${result?.eventType || 'environment.action'}: ${environment.name || environment.id || 'environment'}`,
    `Environment: ${environment.id || '?'}`,
    `Status: ${environment.status || '?'} / cleanup ${environment.cleanup?.state || '?'}`,
    result?.abortedSessionId ? `Aborted session: ${result.abortedSessionId}` : '',
  ].filter(Boolean).join('\n')
}

export function formatEnvironmentReconcileText(result: any): string {
  const summary = result?.reconciliation || result || {}
  const evidence = (summary.evidence || []).slice(0, 10)
  return [`Environment reconciliation complete: checked=${summary.checked || 0} active=${summary.active || 0} retained=${summary.retained || 0} cleanupFailed=${summary.cleanupFailed || 0}`, ...evidence.map((line: string) => `- ${line}`)].join('\n')
}

