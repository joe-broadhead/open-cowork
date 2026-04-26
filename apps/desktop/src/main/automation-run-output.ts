import type { ExecutionBrief } from '@open-cowork/shared'
import type { NormalizedSessionMessage } from './opencode-adapter.ts'
import {
  extractBriefFromAssistantText,
  extractBriefFromStructured,
  extractHeartbeatDecisionFromAssistantText,
  extractHeartbeatDecisionFromStructured,
  type AutomationHeartbeatDecision,
} from './automation-prompts.ts'

function getLatestAssistantMessage(messages: NormalizedSessionMessage[]) {
  return [...messages].reverse().find((message) => message.role === 'assistant') || null
}

export function summarizeAutomationMessages(sessionId: string, messages: NormalizedSessionMessage[]) {
  const assistant = getLatestAssistantMessage(messages)
  if (!assistant) return `Automation session ${sessionId} completed.`
  const text = assistant.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text?.trim() || '')
    .filter(Boolean)
    .join('\n\n')
  return text || `Automation session ${sessionId} completed.`
}

export function extractExecutionBriefFromMessages(messages: NormalizedSessionMessage[]): ExecutionBrief | null {
  const assistant = getLatestAssistantMessage(messages)
  if (!assistant) return null
  return extractBriefFromStructured(assistant.structured)
    || extractBriefFromAssistantText(
      assistant.parts
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text?.trim() || '')
        .filter(Boolean)
        .join('\n\n'),
    )
}

export function extractHeartbeatDecisionFromMessages(
  messages: NormalizedSessionMessage[],
): AutomationHeartbeatDecision | null {
  const assistant = getLatestAssistantMessage(messages)
  if (!assistant) return null
  return extractHeartbeatDecisionFromStructured(assistant.structured)
    || extractHeartbeatDecisionFromAssistantText(
      assistant.parts
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text?.trim() || '')
        .filter(Boolean)
        .join('\n\n'),
    )
}
