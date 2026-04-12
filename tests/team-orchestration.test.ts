import test from 'node:test'
import assert from 'node:assert/strict'
import { isDeterministicTeamCandidate, isInternalCoworkMessage } from '../apps/desktop/src/main/team-orchestration-utils.ts'
import { buildTeamContext, collectAssistantTranscript, collectLatestAssistantText } from '../apps/desktop/src/main/team-context-utils.ts'

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

test('detects two-topic research prompts as deterministic team candidates before planning', () => {
  assert.equal(
    isDeterministicTeamCandidate(
      'cowork',
      'Deep research model context protocol and the open skills standard for my meeting tomorrow.',
    ),
    true,
  )
})

test('identifies hidden internal cowork team messages', () => {
  assert.equal(isInternalCoworkMessage('[[COWORK_INTERNAL_TEAM_CONTEXT]]\nHello'), true)
  assert.equal(isInternalCoworkMessage('[[COWORK_INTERNAL_TEAM_SYNTHESIZE]]\nHello'), true)
  assert.equal(isInternalCoworkMessage('Normal user message'), false)
})

test('team context includes child tool evidence and artifacts for synthesis', () => {
  const context = buildTeamContext([
    {
      title: 'MCP research',
      agent: 'research',
      sessionId: 'child-a',
      text: 'MCP notes',
      evidence: ['webfetch: {"url":"https://modelcontextprotocol.io/docs"}'],
    },
    {
      title: 'Open Skills research',
      agent: 'research',
      sessionId: 'child-b',
      text: 'Open Skills notes',
      evidence: ['Artifact from webfetch: spec.pdf — https://example.com/spec.pdf'],
    },
  ])

  assert.match(context, /Completed sub-agent findings/)
  assert.match(context, /https:\/\/modelcontextprotocol\.io\/docs/)
  assert.match(context, /spec\.pdf/)
  assert.doesNotMatch(context, /Session: child-a/)
  assert.match(context, /Summary:/)
  assert.match(context, /Evidence and artifacts:/)
})

test('collectAssistantTranscript prefers the latest assistant summary and keeps it compact', () => {
  const summary = collectAssistantTranscript([
    {
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: 'Older long note that should not be preferred.' }],
    },
    {
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: 'Latest concise summary.' }],
    },
  ])

  assert.equal(summary, 'Latest concise summary.')
})

test('collectLatestAssistantText can preserve a longer final answer when needed', () => {
  const summary = collectLatestAssistantText([
    {
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: 'Short note.' }],
    },
    {
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: 'A'.repeat(2200) }],
    },
  ], 2500)

  assert.equal(summary.length, 2200)
})
