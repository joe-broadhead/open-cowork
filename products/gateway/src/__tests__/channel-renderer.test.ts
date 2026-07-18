import { describe, expect, it } from 'vitest'
import { telegramChannel } from '../channels/telegram.js'
import { whatsappChannel } from '../channels/whatsapp.js'
import {
  gateApprovalCard,
  messageCapabilities,
  normalizeChannelCapabilities,
  planNativeActionDelivery,
  progressCard,
  renderStructuredMessage,
  runResultCard,
  selectRenderMode,
} from '../channels/renderer.js'

describe('channel renderer contract', () => {
  it('normalizes plain text as the universal fallback capability', () => {
    expect(normalizeChannelCapabilities({})).toMatchObject({ plainText: true, markdown: false, richBlocks: false })
    expect(normalizeChannelCapabilities({ plainText: false }).plainText).toBe(false)
  })

  it('selects rich output only when the channel supports the message features', () => {
    const message = progressCard({
      title: 'Open issues',
      status: 'running',
      steps: [
        { label: 'JOE-47 Renderer contract', status: 'In Progress' },
        { label: 'JOE-48 Telegram rich messages', status: 'Backlog' },
      ],
    })

    const discordLike = { plainText: true, markdown: true, richBlocks: true, tables: true, buttons: true }

    expect(messageCapabilities(message)).toEqual(['plainText', 'tables'])
    expect(selectRenderMode(message, discordLike).mode).toBe('rich')
    expect(selectRenderMode(message, telegramChannel.capabilities).mode).toBe('rich')
    expect(selectRenderMode(message, whatsappChannel.capabilities).mode).toBe('plainText')
  })

  it('renders deterministic plain fallback for interactive gate approvals', () => {
    const message = gateApprovalCard({
      gateId: 'gate_1',
      title: 'Approve deploy',
      reason: 'Production deploy requires operator approval',
      taskId: 'task_1',
      stage: 'deploy',
      approveCommand: '/gate approve gate_1 once',
      rejectCommand: '/gate reject gate_1',
    })

    const rendered = renderStructuredMessage(message, whatsappChannel.capabilities)

    expect(rendered.mode).toBe('plainText')
    expect(rendered.plainText).toBe([
      'Approve deploy',
      'Status: approval_required',
      'Severity: warning',
      'Summary: Production deploy requires operator approval',
      'Gate: gate_1',
      'Task: task_1',
      'Stage: deploy',
      'Next action: Review the request and choose Approve once or Reject.',
      'Actions:',
      '- Approve once: /gate approve gate_1 once',
      '- Reject: /gate reject gate_1',
    ].join('\n'))
  })

  it('renders core card examples with non-empty plain text fallbacks', () => {
    const cards = [
      progressCard({ title: 'Roadmap progress', status: 'running', completed: 2, total: 5, steps: [{ label: 'Implement', status: 'done' }] }),
      runResultCard({ runId: 'run_1', title: 'Run finished', status: 'passed', stage: 'verify', summary: 'All checks passed' }),
    ]

    for (const card of cards) {
      const first = renderStructuredMessage(card, {})
      const second = renderStructuredMessage(card, {})
      expect(first.mode).toBe('plainText')
      expect(first.plainText).toBe(second.plainText)
      expect(first.plainText.length).toBeGreaterThan(0)
      expect(first.plainText).not.toMatch(/telegram|whatsapp|discord/i)
    }
  })

  it('keeps large fallback card text bounded and useful', () => {
    const message = progressCard({
      title: 'Open issues',
      status: 'running',
      summary: 'Needs triage before the planning run',
      nextAction: 'Pick the top blocker and assign an owner',
      steps: Array.from({ length: 140 }, (_value, index) => ({
        label: `JOE-${index + 1} Issue ${index + 1} ${'needs investigation '.repeat(8)}`,
        status: 'Backlog',
      })),
    })

    const rendered = renderStructuredMessage(message, whatsappChannel.capabilities)

    expect(rendered.plainText.length).toBeLessThanOrEqual(3900)
    expect(rendered.markdown?.length).toBeLessThanOrEqual(3900)
    expect(rendered.plainText).toContain('Open issues')
    expect(rendered.plainText).toContain('Next action: Pick the top blocker and assign an owner')
    expect(rendered.plainText).toContain('... truncated')
  })

  it('selects rich output for Telegram when rich messages are enabled', () => {
    const message = progressCard({
      title: 'Project alpha',
      status: 'blocked',
      summary: 'Waiting for approval',
      actions: [{ label: 'Open', command: '/open' }],
    })

    const rendered = renderStructuredMessage(message, telegramChannel.capabilities)

    expect(rendered.mode).toBe('rich')
    expect(rendered.richBlocks).toBe(message.blocks)
    expect(rendered.actions).toBe(message.actions)
  })

  it('plans native actions without silently changing command identifiers', () => {
    const longCommand = `/run ${'x'.repeat(120)}`

    const telegramPlan = planNativeActionDelivery([
      { label: 'Open run', url: 'https://example.com/runs/run_1', style: 'primary' },
      { label: 'Copy long command', command: longCommand },
      { label: 'Bad URL', url: 'file:///private/token' },
    ], {
      maxActions: 12,
      maxLabelChars: 64,
      maxIdentifierChars: 256,
      maxCallbackBytes: 64,
      maxCopyTextChars: 256,
      supportsCopyText: true,
      urlMode: 'native',
    })

    expect(telegramPlan.actions).toEqual([
      expect.objectContaining({ kind: 'url', label: 'Open run', identifier: 'https://example.com/runs/run_1' }),
      expect.objectContaining({ kind: 'copy', label: 'Copy long command', identifier: longCommand }),
    ])
    expect(telegramPlan.omitted).toEqual([
      expect.objectContaining({ sourceIndex: 2, reason: 'unsafe_url' }),
    ])

    const discordPlan = planNativeActionDelivery([
      { label: 'Too long', command: longCommand },
    ], {
      maxActions: 25,
      maxLabelChars: 80,
      maxIdentifierChars: 100,
      urlMode: 'native',
    })

    expect(discordPlan.actions).toEqual([])
    expect(discordPlan.omitted).toEqual([
      expect.objectContaining({ sourceIndex: 0, reason: 'identifier_too_large', identifier: longCommand }),
    ])
  })
})
