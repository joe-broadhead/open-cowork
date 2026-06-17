import { randomBytes } from 'node:crypto'

import type {
  ChannelButton,
  ChannelProvider,
  ChannelTarget,
} from '@open-cowork/gateway-channel'
import { chunkText } from '@open-cowork/gateway-channel'

import type {
  ChannelSessionBindingRecord,
  CloudTransportSessionEvent,
} from '@open-cowork/cloud-client'

import type { CloudGateway } from '../cloud-gateway.js'
import {
  answerToken,
  rejectionToken,
} from './interaction-tokens.js'
import {
  executeRenderOperation,
  normalizeChannelCapabilities,
} from './operations.js'
import { sanitizeChannelText } from './sanitize.js'

export type RenderQuestionRequestInput = {
  cloud: CloudGateway
  provider: ChannelProvider
  target: ChannelTarget
  binding: ChannelSessionBindingRecord
  event: CloudTransportSessionEvent
}

export type RenderQuestionRequestResult = {
  handled: boolean
  lastChatMessageId?: string | null
}

type QuestionPrompt = {
  header: string
  question: string
  options: Array<{ label: string, description: string }>
  multiple: boolean
  custom: boolean
}

export async function renderQuestionRequest(input: RenderQuestionRequestInput): Promise<RenderQuestionRequestResult> {
  const requestId = stringField(input.event.payload, 'requestId')
    || stringField(input.event.payload, 'requestID')
    || stringField(input.event.payload, 'id')
  if (!requestId) return { handled: false }

  const issued = await input.cloud.createChannelInteraction({
    interactionId: `gw_question_${randomBytes(9).toString('base64url')}`,
    agentId: input.binding.agentId,
    sessionId: input.binding.sessionId,
    provider: input.binding.provider,
    kind: 'question',
    targetId: requestId,
  })
  const questions = readQuestions(input.event.payload)
  const text = questionText(questions, issued.plaintextToken)
  const capabilities = normalizeChannelCapabilities(input.provider.capabilities)
  const buttons = questionButtons(questions, issued.plaintextToken, capabilities.maxButtonTokenBytes)

  const buttonText = baseQuestionText(questions)
  if (
    capabilities.inlineButtons
    && buttons
    && buttonText.length <= capabilities.maxTextLength
    && buttonsFit(buttons, capabilities.maxButtonsPerMessage, capabilities.maxButtonRowsPerMessage)
  ) {
    const result = await executeRenderOperation(input.provider, {
      type: 'send_buttons',
      target: input.target,
      text: buttonText,
      buttons,
    })
    return { handled: true, lastChatMessageId: result.sentMessage?.messageId ?? null }
  }

  let lastChatMessageId: string | null = null
  for (const chunk of chunkText(text, capabilities.maxTextLength)) {
    const result = await executeRenderOperation(input.provider, {
      type: 'send_text',
      target: input.target,
      text: chunk,
    })
    lastChatMessageId = result.sentMessage?.messageId ?? lastChatMessageId
  }
  return { handled: true, lastChatMessageId }
}

function questionText(questions: QuestionPrompt[], token: string) {
  return `${baseQuestionText(questions)}\n/answer ${token} <response>\n/reject ${token}`
}

function baseQuestionText(questions: QuestionPrompt[]) {
  if (questions.length === 0) return 'Question requested'
  return questions.map((question, index) => {
    const header = question.header || (questions.length > 1 ? `Question ${index + 1}` : 'Question requested')
    const options = question.options.length
      ? `\n${question.options.map((option) => {
          const label = sanitizeChannelText(option.label, 80)
          const description = sanitizeChannelText(option.description, 120)
          return description ? `- ${label}: ${description}` : `- ${label}`
        }).join('\n')}`
      : ''
    return `${sanitizeChannelText(header, 120)}\n${sanitizeChannelText(question.question, 320)}${options}`
  }).join('\n\n')
}

function questionButtons(
  questions: QuestionPrompt[],
  token: string,
  maxTokenBytes: number,
): ChannelButton[][] | null {
  if (questions.length !== 1) return null
  const question = questions[0]
  if (!question || question.multiple || question.options.length === 0) return null
  const buttons: ChannelButton[][] = [question.options.map((option) => ({
    label: sanitizeChannelText(option.label, 40),
    token: answerToken(token, option.label),
  }))]
  buttons.push([{ label: 'Reject', token: rejectionToken(token), style: 'danger' }])
  return buttons.flat().every((button) => button.label && Buffer.byteLength(button.token, 'utf8') <= maxTokenBytes)
    ? buttons
    : null
}

function buttonsFit(buttons: ChannelButton[][], maxButtons: number, maxRows: number) {
  return buttons.length <= maxRows && buttons.flat().length <= maxButtons
}

function readQuestions(payload: Record<string, unknown>): QuestionPrompt[] {
  if (!Array.isArray(payload.questions)) {
    const question = stringField(payload, 'question') || stringField(payload, 'prompt')
    return question
      ? [{
          header: stringField(payload, 'title') || '',
          question,
          options: [],
          multiple: false,
          custom: true,
        }]
      : []
  }
  return payload.questions.map((entry): QuestionPrompt | null => {
    if (!entry || typeof entry !== 'object') return null
    const record = entry as Record<string, unknown>
    const question = stringField(record, 'question') || stringField(record, 'prompt') || stringField(record, 'text')
    if (!question) return null
    return {
      header: stringField(record, 'header') || '',
      question,
      options: Array.isArray(record.options)
        ? record.options.map(readQuestionOption).filter((option): option is { label: string, description: string } => Boolean(option))
        : [],
      multiple: record.multiple === true,
      custom: record.custom !== false,
    }
  }).filter((entry): entry is QuestionPrompt => Boolean(entry))
}

function readQuestionOption(value: unknown): { label: string, description: string } | null {
  if (typeof value === 'string' && value.trim()) return { label: value.trim(), description: '' }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const label = stringField(record, 'label')
  const description = stringField(record, 'description') || ''
  return label || description ? { label: label || description, description } : null
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
