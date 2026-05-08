import type { SessionTokens } from '@open-cowork/shared'

import {
  withTaskRun,
  type SessionViewState,
} from '../lib/session-view-model.ts'
import type { RuntimeSessionEvent } from './session-event-dispatcher.ts'

type RuntimeCostEventData = NonNullable<RuntimeSessionEvent['data']>

function normalizeCostTokens(tokens: RuntimeCostEventData['tokens']): SessionTokens {
  return {
    input: typeof tokens?.input === 'number' ? tokens.input : 0,
    output: typeof tokens?.output === 'number' ? tokens.output : 0,
    reasoning: typeof tokens?.reasoning === 'number' ? tokens.reasoning : 0,
    cacheRead: typeof tokens?.cache?.read === 'number' ? tokens.cache.read : 0,
    cacheWrite: typeof tokens?.cache?.write === 'number' ? tokens.cache.write : 0,
  }
}

function addCostTokens(current: SessionTokens, delta: SessionTokens): SessionTokens {
  return {
    input: current.input + delta.input,
    output: current.output + delta.output,
    reasoning: current.reasoning + delta.reasoning,
    cacheRead: current.cacheRead + delta.cacheRead,
    cacheWrite: current.cacheWrite + delta.cacheWrite,
  }
}

export function applyCostEventToSessionState(
  current: SessionViewState,
  data: RuntimeCostEventData,
): SessionViewState {
  const tokenDelta = normalizeCostTokens(data.tokens)
  const sessionTokens = addCostTokens(current.sessionTokens, tokenDelta)
  const cost = data.cost || 0
  if (data.taskRunId) {
    return {
      ...current,
      sessionCost: current.sessionCost + cost,
      sessionTokens,
      taskRuns: withTaskRun(current.taskRuns, data.taskRunId, (taskRun) => ({
        ...taskRun,
        sessionCost: taskRun.sessionCost + cost,
        sessionTokens: addCostTokens(taskRun.sessionTokens, tokenDelta),
      })),
    }
  }
  return {
    ...current,
    sessionCost: current.sessionCost + cost,
    lastInputTokens: tokenDelta.input > 0 ? tokenDelta.input : current.lastInputTokens,
    contextState: tokenDelta.input > 0 ? 'measured' : current.contextState,
    sessionTokens,
  }
}
