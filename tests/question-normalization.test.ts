import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeQuestionAnswers,
  normalizeQuestionRequestId,
  normalizeSingleQuestionAnswer,
} from '../apps/desktop/src/main/question-normalization.ts'

test('question normalization accepts bounded answer matrices', () => {
  assert.deepEqual(normalizeQuestionAnswers([[' A ', 'B']]), [['A', 'B']])
})

test('question normalization rejects oversized answers', () => {
  assert.throws(
    () => normalizeSingleQuestionAnswer('x'.repeat(4 * 1024 + 1)),
    /Question answer choice exceeds 4096 bytes/,
  )
})

test('question normalization rejects empty choices and malformed request ids', () => {
  assert.throws(() => normalizeQuestionAnswers([['   ']]), /Question answer choice is required/)
  assert.throws(() => normalizeQuestionRequestId('   '), /Question request id is required/)
})
