/**
 * JOE-842: Re-export composition policy from runtime-host.
 * Desktop no longer owns an SDK type import for question answers.
 */
export {
  normalizeQuestionAnswers,
  normalizeQuestionRequestId,
  normalizeSingleQuestionAnswer,
  type NormalizedQuestionAnswer,
} from '@open-cowork/runtime-host/question-normalization'
