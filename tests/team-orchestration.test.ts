import test from 'node:test'
import assert from 'node:assert/strict'
import { isDeterministicTeamCandidate, isInternalCoworkMessage } from '../apps/desktop/src/main/team-orchestration-utils.ts'

test('detects obvious deterministic team fanout candidates for cowork', () => {
  assert.equal(
    isDeterministicTeamCandidate(
      'cowork',
      'For my meeting, deep research model context protocol, the open skills standard, and the opencode framework in parallel.',
    ),
    true,
  )

  assert.equal(
    isDeterministicTeamCandidate(
      'cowork',
      'Audit this codebase across security, testing, and architecture.',
    ),
    true,
  )
})

test('does not trigger deterministic team fanout for direct sub-agent prompts or attachments', () => {
  assert.equal(
    isDeterministicTeamCandidate(
      'research',
      'Deep research model context protocol, the open skills standard, and the opencode framework.',
    ),
    false,
  )

  assert.equal(
    isDeterministicTeamCandidate(
      'cowork',
      'Deep research model context protocol, the open skills standard, and the opencode framework.',
      [{ mime: 'image/png', url: 'file:///tmp/example.png', filename: 'example.png' }],
    ),
    false,
  )
})

test('identifies hidden internal cowork team messages', () => {
  assert.equal(isInternalCoworkMessage('[[COWORK_INTERNAL_TEAM_CONTEXT]]\nHello'), true)
  assert.equal(isInternalCoworkMessage('[[COWORK_INTERNAL_TEAM_SYNTHESIZE]]\nHello'), true)
  assert.equal(isInternalCoworkMessage('Normal user message'), false)
})
