import type {
  AutomationDetail,
  AutomationDraft,
  AutomationInboxItem,
  AutomationRun,
  ExecutionBrief,
} from '@open-cowork/shared'

function jsonSchemaHint() {
  return [
    '{',
    '  "goal": "string",',
    '  "deliverables": ["string"],',
    '  "assumptions": ["string"],',
    '  "missingContext": ["string"],',
    '  "successCriteria": ["string"],',
    '  "recommendedAgents": ["string"],',
    '  "approvalBoundary": "string",',
    '  "workItems": [',
    '    {',
    '      "id": "string",',
    '      "title": "string",',
    '      "description": "string",',
    '      "ownerAgent": "string|null",',
    '      "dependsOn": ["string"]',
    '    }',
    '  ]',
    '}',
  ].join('\n')
}

function heartbeatSchemaHint() {
  return [
    '{',
    '  "summary": "string",',
    '  "action": "noop|request_user|refresh_brief|run_execution",',
    '  "reason": "string",',
    '  "userMessage": "string|null"',
    '}',
  ].join('\n')
}

export type AutomationHeartbeatDecision = {
  summary: string
  action: 'noop' | 'request_user' | 'refresh_brief' | 'run_execution'
  reason: string
  userMessage: string | null
}

export function createAutomationEnrichmentPrompt(automation: AutomationDraft | AutomationDetail) {
  const preferredAgentInstruction = automation.preferredAgentNames.length > 0
    ? `Treat preferredAgentNames as the user-selected specialist team. Prefer routing work to them when they fit the task, and only recommend other agents when the preferred team clearly cannot cover the work.`
    : 'Prefer specialist agents only when they materially improve the outcome.'
  return [
    'Turn this automation request into an execution-ready brief.',
    'Use concise, structured thinking. If important context is missing, include it in missingContext instead of guessing.',
    preferredAgentInstruction,
    'Return ONLY one JSON object wrapped in a ```json code fence.',
    '',
    'Automation request:',
    JSON.stringify({
      title: automation.title,
      goal: automation.goal,
      kind: automation.kind,
      schedule: automation.schedule,
      heartbeatMinutes: automation.heartbeatMinutes,
      runPolicy: automation.runPolicy,
      executionMode: automation.executionMode,
      autonomyPolicy: automation.autonomyPolicy,
      projectDirectory: automation.projectDirectory || null,
      preferredAgentNames: automation.preferredAgentNames,
    }, null, 2),
    '',
    'JSON shape:',
    jsonSchemaHint(),
  ].join('\n')
}

export function createAutomationExecutionPrompt(automation: AutomationDetail, brief: ExecutionBrief) {
  const preferredAgentInstruction = automation.preferredAgentNames.length > 0
    ? `When delegating specialist work, prefer this user-selected agent team when they fit the task: ${automation.preferredAgentNames.join(', ')}. Only use other specialists when the preferred team clearly cannot cover the work.`
    : 'Delegate specialist work to the best-fit subagents instead of doing all specialist work in the parent.'
  return [
    'Execute this approved automation brief.',
    'Keep the parent thread focused on orchestration, synthesis, approvals, and final delivery.',
    preferredAgentInstruction,
    `Stay within the automation run policy: at most ${automation.runPolicy.dailyRunCap} non-heartbeat work-run attempts per day, counting retries, and ${automation.runPolicy.maxRunDurationMinutes} minutes per run.`,
    'Treat the approved brief as the source of truth. If new critical missing context appears, ask a question instead of guessing.',
    '',
    'Automation:',
    JSON.stringify({
      id: automation.id,
      title: automation.title,
      goal: automation.goal,
      kind: automation.kind,
      runPolicy: automation.runPolicy,
      executionMode: automation.executionMode,
      autonomyPolicy: automation.autonomyPolicy,
      projectDirectory: automation.projectDirectory || null,
      preferredAgentNames: automation.preferredAgentNames,
    }, null, 2),
    '',
    'Approved brief:',
    JSON.stringify(brief, null, 2),
  ].join('\n')
}

export function createAutomationHeartbeatPrompt(input: {
  automation: AutomationDetail
  openInbox: AutomationInboxItem[]
  recentRuns: AutomationRun[]
}) {
  return [
    'Review this automation and decide the single best next action.',
    'You are supervising durable work, not doing the specialist work yourself.',
    'Return ONLY one JSON object wrapped in a ```json code fence.',
    'Use request_user only when the automation genuinely needs human input or approval.',
    'Use refresh_brief when the execution brief is stale, incomplete, or needs replanning before execution.',
    'Use run_execution only when the brief is approved, the automation is ready, and no human input is blocking execution.',
    'Use noop when the best action is to leave things alone and just summarize the current state.',
    '',
    'Automation:',
    JSON.stringify({
      id: input.automation.id,
      title: input.automation.title,
      goal: input.automation.goal,
      kind: input.automation.kind,
      status: input.automation.status,
      schedule: input.automation.schedule,
      runPolicy: input.automation.runPolicy,
      executionMode: input.automation.executionMode,
      autonomyPolicy: input.automation.autonomyPolicy,
      projectDirectory: input.automation.projectDirectory || null,
      preferredAgentNames: input.automation.preferredAgentNames,
      heartbeatMinutes: input.automation.heartbeatMinutes,
      nextRunAt: input.automation.nextRunAt,
      brief: input.automation.brief,
      latestRunId: input.automation.latestRunId,
      latestRunStatus: input.automation.latestRunStatus,
    }, null, 2),
    '',
    'Open inbox items:',
    JSON.stringify(input.openInbox.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      body: item.body,
      createdAt: item.createdAt,
    })), null, 2),
    '',
    'Recent runs:',
    JSON.stringify(input.recentRuns.map((run) => ({
      id: run.id,
      kind: run.kind,
      status: run.status,
      title: run.title,
      summary: run.summary,
      error: run.error,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
    })), null, 2),
    '',
    'JSON shape:',
    heartbeatSchemaHint(),
  ].join('\n')
}

export function extractBriefFromAssistantText(text: string): ExecutionBrief | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  const raw = fenced?.[1] || text
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const missingContext = Array.isArray(parsed.missingContext) ? parsed.missingContext.filter((entry): entry is string => typeof entry === 'string') : []
    const brief: ExecutionBrief = {
      version: 1,
      status: missingContext.length > 0 ? 'needs_user' : 'ready',
      goal: typeof parsed.goal === 'string' ? parsed.goal : '',
      deliverables: Array.isArray(parsed.deliverables) ? parsed.deliverables.filter((entry): entry is string => typeof entry === 'string') : [],
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.filter((entry): entry is string => typeof entry === 'string') : [],
      missingContext,
      successCriteria: Array.isArray(parsed.successCriteria) ? parsed.successCriteria.filter((entry): entry is string => typeof entry === 'string') : [],
      recommendedAgents: Array.isArray(parsed.recommendedAgents) ? parsed.recommendedAgents.filter((entry): entry is string => typeof entry === 'string') : [],
      approvalBoundary: typeof parsed.approvalBoundary === 'string' ? parsed.approvalBoundary : 'Approve the brief before execution.',
      workItems: Array.isArray(parsed.workItems)
        ? parsed.workItems
          .map((entry, index) => {
            const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null
            if (!record) return null
            return {
              id: typeof record.id === 'string' && record.id ? record.id : `work-item-${index + 1}`,
              title: typeof record.title === 'string' ? record.title : `Work item ${index + 1}`,
              description: typeof record.description === 'string' ? record.description : '',
              ownerAgent: typeof record.ownerAgent === 'string' ? record.ownerAgent : null,
              dependsOn: Array.isArray(record.dependsOn) ? record.dependsOn.filter((dependency): dependency is string => typeof dependency === 'string') : [],
            }
          })
          .filter((entry): entry is ExecutionBrief['workItems'][number] => Boolean(entry))
        : [],
      generatedAt: new Date().toISOString(),
    }
    if (!brief.goal) return null
    return brief
  } catch {
    return null
  }
}

export function extractHeartbeatDecisionFromAssistantText(text: string): AutomationHeartbeatDecision | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  const raw = fenced?.[1] || text
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const action = typeof parsed.action === 'string' ? parsed.action : ''
    if (action !== 'noop' && action !== 'request_user' && action !== 'refresh_brief' && action !== 'run_execution') {
      return null
    }
    const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim()
        : 'Heartbeat review completed.'
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : summary
    const userMessage = typeof parsed.userMessage === 'string' && parsed.userMessage.trim()
      ? parsed.userMessage.trim()
      : null
    return { summary, action, reason, userMessage }
  } catch {
    return null
  }
}
