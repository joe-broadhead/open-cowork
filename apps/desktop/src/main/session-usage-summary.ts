import { cloneTokens } from '@open-cowork/shared'
import type {
  AgentUsageEntry,
  SessionUsageSummary,
  SessionView,
} from '@open-cowork/shared'
export function buildSessionUsageSummary(view: SessionView): SessionUsageSummary {
  const messages = view.messages.length
  const userMessages = view.messages.filter((message) => message.role === 'user').length
  const assistantMessages = view.messages.filter((message) => message.role === 'assistant').length
  const taskToolCalls = view.taskRuns.reduce((sum, taskRun) => sum + taskRun.toolCalls.length, 0)

  // Per-sub-agent rollup — iterates task runs, keying by the agent name.
  // Unnamed tasks (agent == null) bucket together so persisted summaries
  // can still account for unattributed delegated work.
  const byAgent = new Map<string | null, AgentUsageEntry>()
  for (const taskRun of view.taskRuns) {
    const key = taskRun.agent || null
    const existing = byAgent.get(key)
    if (existing) {
      existing.taskRuns += 1
      existing.cost += taskRun.sessionCost || 0
      existing.tokens.input += taskRun.sessionTokens.input
      existing.tokens.output += taskRun.sessionTokens.output
      existing.tokens.reasoning += taskRun.sessionTokens.reasoning
      existing.tokens.cacheRead += taskRun.sessionTokens.cacheRead
      existing.tokens.cacheWrite += taskRun.sessionTokens.cacheWrite
    } else {
      byAgent.set(key, {
        agent: key,
        taskRuns: 1,
        cost: taskRun.sessionCost || 0,
        tokens: cloneTokens(taskRun.sessionTokens),
      })
    }
  }
  const agentBreakdown = Array.from(byAgent.values())

  return {
    messages,
    userMessages,
    assistantMessages,
    toolCalls: view.toolCalls.length + taskToolCalls,
    taskRuns: view.taskRuns.length,
    cost: view.sessionCost,
    tokens: cloneTokens(view.sessionTokens),
    agentBreakdown: agentBreakdown.length > 0 ? agentBreakdown : undefined,
  }
}
