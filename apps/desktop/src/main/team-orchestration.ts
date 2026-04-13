import type { BrowserWindow } from 'electron'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { log } from './logger.ts'
import { shortSessionId } from './log-sanitizer.ts'
import type { RuntimeSessionEvent } from './session-event-dispatcher.ts'
import { dispatchRuntimeSessionEvent } from './session-event-dispatcher.ts'
import { getEffectiveSettings } from './settings.ts'
import {
  isDeterministicTeamCandidate,
} from './team-orchestration-utils.ts'
import {
  buildTeamContext,
  collectAssistantTranscript,
  collectLatestAssistantText,
  collectToolEvidence,
  type TeamContextFinding,
} from './team-context-utils.ts'
import {
  MAX_TEAM_BRANCHES,
  TEAM_AGENT_NAMES,
  TEAM_BRANCH_EXECUTION_RULES,
  TEAM_PLANNER_SYSTEM_LINES,
  TEAM_SYNTHESIZE_PREFIX,
  type TeamAgentName,
} from './team-policy.js'

type TeamBranch = {
  title: string
  agent: TeamAgentName
  prompt: string
}

type TeamPlan = {
  shouldFanOut: boolean
  reason: string
  branches: TeamBranch[]
}

function getActiveModelSelection() {
  const settings = getEffectiveSettings()
  return {
    providerID: settings.effectiveProviderId || 'anthropic',
    modelID: settings.effectiveModel,
  }
}

function getErrorMessage(err: any) {
  return String(
    err?.data?.message
      || err?.error?.data?.message
      || err?.message
      || err,
  )
}

function isContextLimitError(err: any) {
  const message = getErrorMessage(err).toLowerCase()
  return message.includes('context limit')
    || message.includes('input length and `max_tokens` exceed context limit')
}

function extractStructuredOutput(data: any) {
  return data?.structured
    || data?.info?.structured
    || data?.info?.structured_output
    || null
}

function normalizeBranch(raw: any): TeamBranch | null {
  const title = typeof raw?.title === 'string' ? raw.title.trim() : ''
  const prompt = typeof raw?.prompt === 'string' ? raw.prompt.trim() : ''
  const agent = typeof raw?.agent === 'string' ? raw.agent.trim().toLowerCase() : ''

  if (!title || !prompt || !TEAM_AGENT_NAMES.includes(agent as TeamAgentName)) return null

  return {
    title,
    prompt,
    agent: agent as TeamAgentName,
  }
}

function normalizePlan(raw: any): TeamPlan | null {
  if (!raw || typeof raw !== 'object') return null

  const branches = Array.isArray(raw.branches)
    ? raw.branches.map(normalizeBranch).filter(Boolean).slice(0, MAX_TEAM_BRANCHES) as TeamBranch[]
    : []

  return {
    shouldFanOut: raw.shouldFanOut === true && branches.length >= 2,
    reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
    branches,
  }
}

async function planTeamFanout(client: OpencodeClient, text: string) {
  const sessionResult = await client.session.create({
    throwOnError: true,
    body: { title: 'Open Cowork team planner' },
  })
  const planSessionId = (sessionResult.data as any)?.id as string

  try {
    const result = await client.session.prompt({
      throwOnError: true,
      path: { id: planSessionId },
      body: {
        agent: 'plan',
        system: TEAM_PLANNER_SYSTEM_LINES.join('\n'),
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              shouldFanOut: { type: 'boolean' },
              reason: { type: 'string' },
              branches: {
                type: 'array',
                maxItems: MAX_TEAM_BRANCHES,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string' },
                    agent: { type: 'string', enum: [...TEAM_AGENT_NAMES] },
                    prompt: { type: 'string' },
                  },
                  required: ['title', 'agent', 'prompt'],
                },
              },
            },
            required: ['shouldFanOut', 'reason', 'branches'],
          },
        },
        parts: [
          {
            type: 'text',
            text: `Decide if this request should fan out into a sub-agent team:\n\n${text}`,
          },
        ],
      } as any,
    })

    return normalizePlan(extractStructuredOutput(result.data))
  } finally {
    await client.session.delete({ path: { id: planSessionId } }).catch(() => {})
  }
}

async function collectChildFindings(client: OpencodeClient, branches: Array<TeamBranch & { sessionId: string }>) {
  const findings: TeamContextFinding[] = []

  for (const branch of branches) {
    const messagesResult = await client.session.messages({
      throwOnError: true,
      path: { id: branch.sessionId },
    })
    const messages = (messagesResult.data as any[]) || []
    const text = collectAssistantTranscript(messages)
    const evidence = collectToolEvidence(messages)
    findings.push({
      ...branch,
      text,
      evidence,
    })
  }

  return findings
}

function buildSynthesisPrompt() {
  return [
    TEAM_SYNTHESIZE_PREFIX,
    'Use the completed sub-agent findings already in context to answer the original user request.',
    'Do not launch new sub-agents.',
    'Do not repeat the research.',
    'Rely on the provided branch summaries, evidence, and artifacts instead of reloading detailed branch transcripts.',
    'Synthesize the branch findings into one concise, well-structured response.',
  ].join('\n')
}

function buildHelperSynthesisPrompt(input: { originalRequest: string; findings: TeamContextFinding[] }) {
  return [
    buildTeamContext(input.findings),
    '',
    'Original user request:',
    input.originalRequest,
    '',
    buildSynthesisPrompt(),
  ].join('\n')
}

function buildRootAnswerPrompt(finalAnswer: string) {
  return [
    TEAM_SYNTHESIZE_PREFIX,
    'A temporary Open Cowork synthesis helper has already produced the final answer for the user.',
    'Reply to the user using that final answer.',
    'Preserve facts, links, and structure.',
    'Do not mention internal synthesis, branch orchestration, or helper sessions.',
    '',
    'Final answer:',
    finalAnswer,
  ].join('\n')
}

function buildBranchPrompt(branch: TeamBranch) {
  return [
    `Branch title: ${branch.title}`,
    `Assigned sub-agent: ${branch.agent}`,
    '',
    'Execution rules for this branch:',
    ...TEAM_BRANCH_EXECUTION_RULES.map((rule) => `- ${rule}`),
    '',
    'Assigned branch work:',
    branch.prompt,
  ].join('\n')
}

function emitRuntimeSessionEvent(
  win: BrowserWindow | null | undefined,
  sessionId: string,
  data: NonNullable<RuntimeSessionEvent['data']>,
) {
  dispatchRuntimeSessionEvent(win, {
    type: String(data.type || 'unknown'),
    sessionId,
    data,
  })
}

async function compactRootSessionForSynthesis(client: OpencodeClient, sessionId: string) {
  const model = getActiveModelSelection()
  await client.session.summarize({
    throwOnError: true,
    path: { id: sessionId },
    body: {
      providerID: model.providerID,
      modelID: model.modelID,
      auto: true,
    },
  } as any)
}

async function synthesizeBranchFindingsInHelper(input: {
  client: OpencodeClient
  originalRequest: string
  requestedAgent: string
  findings: TeamContextFinding[]
}) {
  const helperResult = await input.client.session.create({
    throwOnError: true,
    body: { title: 'Open Cowork synthesis helper' },
  })
  const helperSessionId = (helperResult.data as any)?.id as string

  try {
    await input.client.session.prompt({
      throwOnError: true,
      path: { id: helperSessionId },
      body: {
        agent: input.requestedAgent,
        tools: {
          task: false,
          todowrite: false,
        },
        parts: [{
          type: 'text',
          text: buildHelperSynthesisPrompt({
            originalRequest: input.originalRequest,
            findings: input.findings,
          }),
        }],
      } as any,
    })

    const messagesResult = await input.client.session.messages({
      throwOnError: true,
      path: { id: helperSessionId },
    })
    const messages = (messagesResult.data as any[]) || []
    const finalAnswer = collectLatestAssistantText(messages, 12000)

    if (!finalAnswer) {
      throw new Error('Synthesis helper did not produce a final answer')
    }

    return finalAnswer
  } finally {
    await input.client.session.delete({
      path: { id: helperSessionId },
    } as any).catch(() => {})
  }
}

async function appendFinalAnswerToRoot(input: {
  client: OpencodeClient
  sessionId: string
  requestedAgent: string
  finalAnswer: string
  getMainWindow: () => BrowserWindow | null
}) {
  const synthesisBody = {
    agent: input.requestedAgent,
    tools: {
      task: false,
      todowrite: false,
    },
    parts: [{
      type: 'text',
      text: buildRootAnswerPrompt(input.finalAnswer),
    }],
  } as any

  try {
    await input.client.session.prompt({
      throwOnError: true,
      path: { id: input.sessionId },
      body: synthesisBody,
    })
    return
  } catch (err: any) {
    if (!isContextLimitError(err)) throw err

    log('team', `Root answer handoff exceeded context limit for ${shortSessionId(input.sessionId)}; compacting and retrying`)
    await compactRootSessionForSynthesis(input.client, input.sessionId)
    emitRuntimeSessionEvent(input.getMainWindow(), input.sessionId, { type: 'history_refresh' })

    await input.client.session.prompt({
      throwOnError: true,
      path: { id: input.sessionId },
      body: synthesisBody,
    })
  }
}

export async function runDeterministicTeamOrchestration(input: {
  client: OpencodeClient
  sessionId: string
  text: string
  requestedAgent: string
  getMainWindow: () => BrowserWindow | null
}) {
  const plan = await planTeamFanout(input.client, input.text)
  if (!plan?.shouldFanOut || plan.branches.length < 2) return false

  log('team', `Launching deterministic sub-agent team for ${shortSessionId(input.sessionId)} with ${plan.branches.length} branches`)
  emitRuntimeSessionEvent(input.getMainWindow(), input.sessionId, { type: 'busy' })

  try {
    await input.client.session.prompt({
      throwOnError: true,
      path: { id: input.sessionId },
      body: {
        noReply: true,
        agent: input.requestedAgent,
        parts: [{ type: 'text', text: input.text }],
      },
    })

    const launchedBranches = await Promise.all(plan.branches.map(async (branch) => {
      const childResult = await input.client.session.create({
        throwOnError: true,
        body: {
          parentID: input.sessionId,
          title: branch.title,
        },
      })
      const childSessionId = (childResult.data as any)?.id as string

      emitRuntimeSessionEvent(input.getMainWindow(), input.sessionId, {
        type: 'task_run',
        id: `child:${childSessionId}`,
        title: branch.title,
        agent: branch.agent,
        status: 'queued',
        sourceSessionId: childSessionId,
      })

      return {
        ...branch,
        sessionId: childSessionId,
      }
    }))

    const branchResults = await Promise.allSettled(launchedBranches.map(async (branch) => {
      emitRuntimeSessionEvent(input.getMainWindow(), input.sessionId, {
        type: 'task_run',
        id: `child:${branch.sessionId}`,
        title: branch.title,
        agent: branch.agent,
        status: 'running',
        sourceSessionId: branch.sessionId,
      })

      await input.client.session.prompt({
        throwOnError: true,
        path: { id: branch.sessionId },
        body: {
          agent: branch.agent,
          parts: [{ type: 'text', text: buildBranchPrompt(branch) }],
        },
      })

      return branch
    }))

    const failedBranches = branchResults
      .map((result, index) => ({ result, branch: launchedBranches[index] }))
      .filter((entry): entry is { result: PromiseRejectedResult; branch: typeof launchedBranches[number] } => entry.result.status === 'rejected')

    if (failedBranches.length > 0) {
      for (const failure of failedBranches) {
        emitRuntimeSessionEvent(input.getMainWindow(), input.sessionId, {
          type: 'error',
          message: `Sub-agent branch failed: ${failure.branch.title}`,
          taskRunId: `child:${failure.branch.sessionId}`,
          sourceSessionId: failure.branch.sessionId,
        })
      }
    }

    const completedBranches = branchResults
      .map((result, index) => ({ result, branch: launchedBranches[index] }))
      .filter((entry): entry is { result: PromiseFulfilledResult<typeof launchedBranches[number]>; branch: typeof launchedBranches[number] } => entry.result.status === 'fulfilled')
      .map((entry) => entry.branch)

    if (completedBranches.length === 0) {
      throw new Error('All deterministic sub-agent branches failed')
    }

    log('team', `Completed ${launchedBranches.length} sub-agent branches for ${shortSessionId(input.sessionId)}`)
    const findings = await collectChildFindings(input.client, completedBranches)
    log('team', `Synthesizing parent result for ${shortSessionId(input.sessionId)}`)

    const finalAnswer = await synthesizeBranchFindingsInHelper({
      client: input.client,
      originalRequest: input.text,
      requestedAgent: input.requestedAgent,
      findings,
    })

    await appendFinalAnswerToRoot({
      client: input.client,
      sessionId: input.sessionId,
      requestedAgent: input.requestedAgent,
      finalAnswer,
      getMainWindow: input.getMainWindow,
    })

    emitRuntimeSessionEvent(input.getMainWindow(), input.sessionId, { type: 'history_refresh' })
    emitRuntimeSessionEvent(input.getMainWindow(), input.sessionId, { type: 'done', synthetic: true })
    log('team', `Completed deterministic sub-agent team for ${shortSessionId(input.sessionId)}`)

    return true
  } catch (err: any) {
    emitRuntimeSessionEvent(input.getMainWindow(), input.sessionId, {
      type: 'error',
      message: err?.message || 'Deterministic sub-agent orchestration failed',
    })
    emitRuntimeSessionEvent(input.getMainWindow(), input.sessionId, { type: 'done' })
    throw err
  }
}
