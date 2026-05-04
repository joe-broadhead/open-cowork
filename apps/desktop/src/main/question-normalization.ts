import type { QuestionAnswer } from '@opencode-ai/sdk/v2'

const MAX_QUESTION_REQUEST_ID_BYTES = 256
const MAX_QUESTION_ANSWERS = 32
const MAX_QUESTION_ANSWER_CHOICES = 16
const MAX_QUESTION_ANSWER_BYTES = 4 * 1024

function byteLength(value: string) {
  return Buffer.byteLength(value, 'utf8')
}

function requireBoundedString(value: unknown, fieldName: string, maxBytes: number) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`)
  }
  if (byteLength(value) > maxBytes) {
    throw new Error(`${fieldName} exceeds ${maxBytes} bytes`)
  }
  return value
}

export function normalizeQuestionRequestId(value: unknown) {
  const requestId = requireBoundedString(value, 'Question request id', MAX_QUESTION_REQUEST_ID_BYTES).trim()
  if (!requestId) throw new Error('Question request id is required')
  return requestId
}

export function normalizeQuestionAnswers(value: unknown): QuestionAnswer[] {
  if (!Array.isArray(value)) throw new Error('Question answers must be an array')
  if (value.length > MAX_QUESTION_ANSWERS) throw new Error('Too many question answers')
  return value.map((answer) => {
    if (!Array.isArray(answer)) throw new Error('Question answer must be an array')
    if (answer.length > MAX_QUESTION_ANSWER_CHOICES) throw new Error('Too many question answer choices')
    return answer.map((choice) => {
      const normalized = requireBoundedString(choice, 'Question answer choice', MAX_QUESTION_ANSWER_BYTES).trim()
      if (!normalized) throw new Error('Question answer choice is required')
      return normalized
    })
  })
}

export function normalizeSingleQuestionAnswer(value: unknown) {
  const answers = normalizeQuestionAnswers([[value]])
  return answers[0]![0]!
}
