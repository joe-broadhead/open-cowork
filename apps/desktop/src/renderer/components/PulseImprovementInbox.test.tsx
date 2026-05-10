import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ImprovementReviewQueue } from '@open-cowork/shared'
import { PulseImprovementInbox } from './PulseImprovementInbox'

const reviewQueue: ImprovementReviewQueue = {
  proposals: [
    {
      schemaVersion: 1,
      id: 'proposal-1',
      targetType: 'memory',
      targetId: 'memory-1',
      status: 'proposed',
      title: 'Tighten analyst memory',
      summary: 'Candidate improvement from evaluated work.',
      evidence: [
        {
          schemaVersion: 1,
          kind: 'eval',
          id: 'eval-1',
          label: 'Eval pass',
          uri: 'cowork://evals/eval-1',
          hash: 'sha256:eval-hash',
        },
      ],
      candidateDiffs: [
        {
          schemaVersion: 1,
          targetType: 'memory',
          targetId: 'memory-1',
          operation: 'update',
          summary: 'Prefer a sharper analyst instruction.',
          beforeHash: 'sha256:before',
          afterHash: 'sha256:after',
          payload: {
            title: 'Analyst guidance',
            body: 'Prefer concise evidence notes.',
          },
        },
      ],
      createdAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T01:00:00.000Z',
      reviewedAt: null,
      reviewedBy: null,
      reviewNote: null,
    },
  ],
  memory: [
    {
      schemaVersion: 1,
      id: 'memory-1',
      scopeKind: 'agent',
      scopeId: 'analyst',
      status: 'proposed',
      title: 'Prefer concise evidence notes',
      body: 'Keep weekly reporting recommendations concise and tie them to source evidence.',
      summary: 'Use concise evidence notes in weekly reporting.',
      tags: ['reporting', 'evidence'],
      privacy: 'internal',
      provenance: [
        {
          schemaVersion: 1,
          kind: 'trace',
          id: 'trace-1',
          label: 'Trace event',
          uri: null,
          hash: 'sha256:trace-hash',
        },
      ],
      sourceProposalId: 'proposal-1',
      contentHash: 'sha256:memory-hash',
      createdAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T01:00:00.000Z',
      reviewedAt: null,
      reviewedBy: null,
      reviewNote: null,
    },
  ],
  dreamRuns: [
    {
      schemaVersion: 1,
      id: 'dream-1',
      status: 'failed',
      title: 'Consolidate reporting lessons',
      modelId: 'openrouter/example',
      instructionsHash: 'sha256:instructions',
      sourceMemoryEntryIds: ['memory-1'],
      sourceTraceEventIds: ['trace-1'],
      candidateProposalIds: ['proposal-1'],
      tokenUsage: { input: 10, output: 4, reasoning: 2 },
      costUsd: 0.0123,
      error: 'Provider unavailable.',
      createdAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T01:00:00.000Z',
      startedAt: '2026-05-07T00:00:00.000Z',
      finishedAt: '2026-05-07T01:00:00.000Z',
    },
  ],
}

const unsupportedProposalQueue: ImprovementReviewQueue = {
  memory: [],
  dreamRuns: [],
  proposals: [
    {
      ...reviewQueue.proposals[0]!,
      id: 'proposal-agent',
      targetType: 'agent',
      targetId: 'analyst',
      title: 'Tune analyst agent',
      candidateDiffs: [
        {
          ...reviewQueue.proposals[0]!.candidateDiffs[0]!,
          targetType: 'agent',
          targetId: 'analyst',
          summary: 'Update analyst instructions.',
          payload: {
            instructions: 'Prefer concise evidence notes.',
          },
        },
      ],
    },
  ],
}

describe('PulseImprovementInbox', () => {
  it('renders inspectable evidence, candidate diffs, memory provenance, and dream-run metadata', () => {
    render(<PulseImprovementInbox inbox={reviewQueue} actionId={null} onReview={vi.fn()} onUpdateProposal={vi.fn()} />)

    expect(screen.getByText('Inspect evidence and diffs')).toBeInTheDocument()
    expect(screen.getByText('1 evidence / 1 diff')).toBeInTheDocument()
    expect(screen.getByText('Eval pass')).toBeInTheDocument()
    expect(screen.getByText('Prefer a sharper analyst instruction.')).toBeInTheDocument()
    expect(screen.getAllByText(/Prefer concise evidence notes/).length).toBeGreaterThan(0)

    expect(screen.getByText('Inspect memory candidate')).toBeInTheDocument()
    expect(screen.getByText('internal / 1 source')).toBeInTheDocument()
    expect(screen.getByText('agent / analyst')).toBeInTheDocument()
    expect(screen.getByText('Trace event')).toBeInTheDocument()

    expect(screen.getByText('Inspect consolidation run')).toBeInTheDocument()
    expect(screen.getByText('1 memory / 1 proposal')).toBeInTheDocument()
    expect(screen.getByText('openrouter/example')).toBeInTheDocument()
    expect(screen.getByText('proposal-1')).toBeInTheDocument()
  })

  it('saves edited memory proposal drafts through the update handler', async () => {
    const user = userEvent.setup()
    const updateProposal = vi.fn(async () => true)
    render(<PulseImprovementInbox inbox={reviewQueue} actionId={null} onReview={vi.fn()} onUpdateProposal={updateProposal} />)

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByLabelText('Memory body'))
    await user.type(screen.getByLabelText('Memory body'), 'Use concise evidence notes with one source link per claim.')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(updateProposal).toHaveBeenCalledTimes(1)
    expect(updateProposal).toHaveBeenCalledWith('proposal-1', expect.objectContaining({
      title: 'Tighten analyst memory',
      summary: 'Candidate improvement from evaluated work.',
      candidateDiffs: [
        expect.objectContaining({
          afterHash: null,
          payload: expect.objectContaining({
            body: 'Use concise evidence notes with one source link per claim.',
          }),
        }),
      ],
    }))
  })

  it('pauses review actions while an edit is open', async () => {
    const user = userEvent.setup()
    render(<PulseImprovementInbox inbox={reviewQueue} actionId={null} onReview={vi.fn()} onUpdateProposal={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getAllByRole('button', { name: 'Approve' })[0]).toBeDisabled()
    expect(screen.getAllByRole('button', { name: 'Reject' })[0]).toBeDisabled()
    expect(screen.getAllByRole('button', { name: 'Archive' })[0]).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getAllByRole('button', { name: 'Approve' })[0]).not.toBeDisabled()
  })

  it('does not offer approval for proposal targets without a typed applicator', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    render(<PulseImprovementInbox inbox={unsupportedProposalQueue} actionId={null} onReview={onReview} onUpdateProposal={vi.fn()} />)

    expect(screen.getByText('Approval for this proposal type is waiting for a typed persistence path. Reject, archive, or leave it queued for now.')).toBeInTheDocument()
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).toBeDisabled()
    await user.click(approve)
    expect(onReview).not.toHaveBeenCalled()
  })

  it('clears the edit lock when the edited proposal leaves the visible inbox', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<PulseImprovementInbox inbox={reviewQueue} actionId={null} onReview={vi.fn()} onUpdateProposal={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getAllByRole('button', { name: 'Approve' })[0]).toBeDisabled()

    rerender(<PulseImprovementInbox inbox={{ ...reviewQueue, proposals: [] }} actionId={null} onReview={vi.fn()} onUpdateProposal={vi.fn()} />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).not.toBeDisabled())
  })
})
