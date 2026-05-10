import { render, screen } from '@testing-library/react'
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

describe('PulseImprovementInbox', () => {
  it('renders inspectable evidence, candidate diffs, memory provenance, and dream-run metadata', () => {
    render(<PulseImprovementInbox inbox={reviewQueue} actionId={null} onReview={vi.fn()} />)

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
})
