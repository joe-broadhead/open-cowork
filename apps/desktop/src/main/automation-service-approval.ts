import type { AutomationDetail, ExecutionBrief } from '@open-cowork/shared'

export function requiresManualApproval(automation: AutomationDetail) {
  return automation.autonomyPolicy === 'review-first'
}

export function buildAutomationApprovalBody(brief: ExecutionBrief) {
  const lines = [
    'The execution brief is ready.',
    '',
    `Deliverables: ${brief.deliverables.join(', ') || 'None specified.'}`,
    `Recommended agents: ${brief.recommendedAgents.join(', ') || 'Use standard plan/build routing.'}`,
    `Approval boundary: ${brief.approvalBoundary}`,
  ]
  if (brief.missingContext.length > 0) {
    lines.push('', 'Missing context:', ...brief.missingContext)
  }
  return lines.join('\n')
}
