import type { BrowserWindow } from 'electron'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { log } from './logger'
import { shortSessionId } from './log-sanitizer'
import {
  isDeterministicTeamCandidate,
} from './team-orchestration-utils'
import {
  MAX_TEAM_BRANCHES,
  TEAM_AGENT_NAMES,
  TEAM_BRANCH_EXECUTION_RULES,
  TEAM_CONTEXT_PREFIX,
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractStructuredOutput(data: any) {
  return data?.structured
    || data?.info?.structured
    || data?.info?.structured_output
    || null
}

function collectAssistantTranscript(messages: any[]) {
  const transcript = messages
    .filter((item) => (item?.info?.role || item?.role) === 'assistant')
    .map((message) => ((message?.parts || []) as any[])
      .filter((part) => part?.type === 'text' && typeof part?.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim())
    .filter(Boolean)
    .join('\n\n')
    .trim()

  if (!transcript) return ''
  if (transcript.length <= 8000) return transcript
  return `Earlier branch notes omitted.\n\n${transcript.slice(-(8000 - 26)).trimStart()}`
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
    body: { title: 'Cowork team planner' },
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

async function waitForChildSessions(client: OpencodeClient, childSessionIds: string[], timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const result = await client.session.status().catch(() => ({ data: {} }))
    const statuses = ((result as any)?.data as Record<string, any>) || {}

    const allIdle = childSessionIds.every((sessionId) => statuses[sessionId]?.type === 'idle')
    if (allIdle) return

    await sleep(1200)
  }

  throw new Error('Timed out waiting for sub-agent team to complete')
}

async function collectChildFindings(client: OpencodeClient, branches: Array<TeamBranch & { sessionId: string }>) {
  const findings = []

  for (const branch of branches) {
    const messagesResult = await client.session.messages({
      throwOnError: true,
      path: { id: branch.sessionId },
    })
    const text = collectAssistantTranscript((messagesResult.data as any[]) || [])
    findings.push({
      ...branch,
      text,
    })
  }

  return findings
}

function buildTeamContext(findings: Array<TeamBranch & { sessionId: string; text: string }>) {
  const sections = findings.map((finding, index) => [
    `## Branch ${index + 1}: ${finding.title}`,
    `Agent: ${finding.agent}`,
    `Session: ${finding.sessionId}`,
    '',
    finding.text || 'No assistant summary was produced for this branch.',
  ].join('\n'))

  return [
    TEAM_CONTEXT_PREFIX,
    'Completed sub-agent findings for the current user request:',
    '',
    sections.join('\n\n'),
  ].join('\n')
}

function buildSynthesisPrompt() {
  return [
    TEAM_SYNTHESIZE_PREFIX,
    'Use the completed sub-agent findings already in context to answer the original user request.',
    'Do not launch new sub-agents.',
    'Do not repeat the research.',
    'Synthesize the branch findings into one concise, well-structured response.',
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

function emitStreamEvent(win: BrowserWindow | null | undefined, sessionId: string, data: Record<string, unknown>) {
  if (!win) return
  win.webContents.send('stream:event', {
    type: data.type,
    sessionId,
    data,
  })
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
  emitStreamEvent(input.getMainWindow(), input.sessionId, { type: 'busy' })

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

      emitStreamEvent(input.getMainWindow(), input.sessionId, {
        type: 'task_run',
        id: `child:${childSessionId}`,
        title: branch.title,
        agent: branch.agent,
        status: 'queued',
        sourceSessionId: childSessionId,
      })

      await input.client.session.promptAsync({
        throwOnError: true,
        path: { id: childSessionId },
        body: {
          agent: branch.agent,
          parts: [{ type: 'text', text: buildBranchPrompt(branch) }],
        },
      })

      return {
        ...branch,
        sessionId: childSessionId,
      }
    }))

    await waitForChildSessions(input.client, launchedBranches.map((branch) => branch.sessionId))
    const findings = await collectChildFindings(input.client, launchedBranches)

    await input.client.session.prompt({
      throwOnError: true,
      path: { id: input.sessionId },
      body: {
        noReply: true,
        agent: input.requestedAgent,
        parts: [{ type: 'text', text: buildTeamContext(findings) }],
      },
    })

    await input.client.session.promptAsync({
      throwOnError: true,
      path: { id: input.sessionId },
      body: {
        agent: input.requestedAgent,
        parts: [{ type: 'text', text: buildSynthesisPrompt() }],
      },
    })

    return true
  } catch (err: any) {
    emitStreamEvent(input.getMainWindow(), input.sessionId, {
      type: 'error',
      message: err?.message || 'Deterministic sub-agent orchestration failed',
    })
    emitStreamEvent(input.getMainWindow(), input.sessionId, { type: 'done' })
    throw err
  }
}
