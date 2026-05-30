export type PromptCommandPayload = {
  text: string
  agent: string
}

export type QuestionReplyPayload = {
  requestId: string
  answers: unknown[]
}

export type QuestionRejectPayload = {
  requestId: string
}

export type PermissionRespondPayload = {
  permissionId: string
  response: unknown
}

function readString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value : fallback
}

export function normalizePromptPayload(payload: Record<string, unknown>): PromptCommandPayload {
  return {
    text: readString(payload.text),
    agent: readString(payload.agent, 'build'),
  }
}

export function normalizeQuestionReplyPayload(payload: Record<string, unknown>): QuestionReplyPayload {
  return {
    requestId: readString(payload.requestId),
    answers: Array.isArray(payload.answers) ? payload.answers : [],
  }
}

export function normalizeQuestionRejectPayload(payload: Record<string, unknown>): QuestionRejectPayload {
  return {
    requestId: readString(payload.requestId),
  }
}

export function normalizePermissionPayload(payload: Record<string, unknown>): PermissionRespondPayload {
  return {
    permissionId: readString(payload.permissionId),
    response: payload.response ?? null,
  }
}
