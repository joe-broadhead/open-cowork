import type { OpencodeClient } from '@opencode-ai/sdk'

type RawQuestionOption = {
  label?: string
  description?: string
}

type RawQuestionPrompt = {
  header?: string
  question?: string
  options?: RawQuestionOption[]
  multiple?: boolean
  custom?: boolean
}

type RawQuestionRequest = {
  id?: string
  sessionID?: string
  questions?: RawQuestionPrompt[]
  tool?: {
    messageID?: string
    callID?: string
  }
}

type QuestionListResult = {
  data?: RawQuestionRequest[]
}

type QuestionReplyBody = {
  requestID: string
  answers: string[][]
}

type QuestionRejectBody = {
  requestID: string
}

type QuestionClient = {
  list?: () => Promise<QuestionListResult>
  reply?: (body: QuestionReplyBody) => Promise<unknown>
  reject?: (body: QuestionRejectBody) => Promise<unknown>
}

type QuestionCapableClient = OpencodeClient & {
  question?: QuestionClient
}

function getQuestionClient(client: OpencodeClient): QuestionClient | undefined {
  return (client as QuestionCapableClient).question
}

export async function listPendingQuestions(client: OpencodeClient) {
  return getQuestionClient(client)?.list?.() ?? { data: [] }
}

export async function replyToQuestion(client: OpencodeClient, requestID: string, answers: string[][]) {
  const question = getQuestionClient(client)
  if (!question?.reply) {
    throw new Error('Runtime question client is unavailable')
  }
  return question.reply({ requestID, answers })
}

export async function rejectQuestion(client: OpencodeClient, requestID: string) {
  const question = getQuestionClient(client)
  if (!question?.reject) {
    throw new Error('Runtime question client is unavailable')
  }
  return question.reject({ requestID })
}
