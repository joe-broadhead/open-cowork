import type { OpencodeClient, QuestionAnswer, QuestionRequest } from '@opencode-ai/sdk/v2'

type QuestionListResult = {
  data?: QuestionRequest[]
}

export async function listPendingQuestions(client: OpencodeClient): Promise<QuestionListResult> {
  return client.question.list(undefined, { throwOnError: true })
}

export async function replyToQuestion(client: OpencodeClient, requestID: string, answers: string[][]) {
  return client.question.reply({
    requestID,
    answers: answers as QuestionAnswer[],
  }, { throwOnError: true })
}

export async function rejectQuestion(client: OpencodeClient, requestID: string) {
  return client.question.reject({
    requestID,
  }, { throwOnError: true })
}
