/**
 * Operator triage: one read that composes the operator's current attention set.
 *
 * `gateway_triage` (and its `GET /triage` route) collapses the four reads an
 * operator otherwise chains every time they sit down — attention, gates,
 * pending OpenCode questions/permissions, blocked tasks, stale runs (all
 * already computed by {@link buildNeedsAttentionReport}) plus active alerts —
 * into a single read-only payload. It never mutates state.
 */
import type { NeedsAttentionReport, AttentionKind } from './human-loop.js'
import { formatNeedsAttentionReport } from './human-loop.js'
import { formatAlerts } from './alerts.js'
import type { AlertRecord } from './work-store.js'

export interface TriageReport {
  generatedAt: string
  summary: string
  counts: {
    attention: number
    alerts: number
    alertsCritical: number
    gates: number
    questions: number
    permissions: number
    completionProposals: number
    blockedTasks: number
    staleRuns: number
  }
  attention: NeedsAttentionReport
  alerts: AlertRecord[]
}

export function buildTriageReport(input: { attention: NeedsAttentionReport; alerts: AlertRecord[]; now?: number }): TriageReport {
  const now = input.now ?? Date.now()
  const attentionCounts = input.attention.counts as Record<AttentionKind, number>
  const alertsCritical = input.alerts.filter(alert => alert.severity === 'critical').length
  const attentionTotal = input.attention.items.length
  const totalItems = attentionTotal + input.alerts.length
  return {
    generatedAt: new Date(now).toISOString(),
    summary: totalItems
      ? `${totalItems} item(s) need attention (${attentionTotal} attention, ${input.alerts.length} alert(s))`
      : 'Nothing needs attention',
    counts: {
      attention: attentionTotal,
      alerts: input.alerts.length,
      alertsCritical,
      gates: attentionCounts.gateway_gate,
      questions: attentionCounts.opencode_question,
      permissions: attentionCounts.opencode_permission,
      completionProposals: attentionCounts.completion_proposal,
      blockedTasks: attentionCounts.task,
      staleRuns: attentionCounts.stale_run,
    },
    attention: input.attention,
    alerts: input.alerts,
  }
}

export function formatTriageReport(report: TriageReport): string {
  const c = report.counts
  const lines = [
    `# Triage — ${report.summary}`,
    '',
    `Gates: ${c.gates} | Questions: ${c.questions} | Permissions: ${c.permissions} | Completion proposals: ${c.completionProposals} | Blocked/paused tasks: ${c.blockedTasks} | Stale runs: ${c.staleRuns} | Alerts: ${c.alerts} (${c.alertsCritical} critical)`,
    '',
    '## Needs Attention',
    formatNeedsAttentionReport(report.attention),
    '',
    '## Active Alerts',
    report.alerts.length ? formatAlerts(report.alerts) : 'No active alerts.',
  ]
  return lines.join('\n')
}
