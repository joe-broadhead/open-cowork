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
      id: 'proposal-routing',
      targetType: 'routing',
      targetId: 'analyst-routing',
      title: 'Tune analyst routing',
      candidateDiffs: [
        {
          ...reviewQueue.proposals[0]!.candidateDiffs[0]!,
          targetType: 'routing',
          targetId: 'analyst-routing',
          summary: 'Update analyst routing.',
          payload: {
            route: 'prefer-data-analyst',
          },
        },
      ],
    },
  ],
}

const agentProposalQueue: ImprovementReviewQueue = {
  memory: [],
  dreamRuns: [],
  proposals: [
    {
      ...unsupportedProposalQueue.proposals[0]!,
      id: 'proposal-agent',
      targetType: 'agent',
      targetId: 'analyst',
      title: 'Tune analyst agent',
      candidateDiffs: [
        {
          ...unsupportedProposalQueue.proposals[0]!.candidateDiffs[0]!,
          targetType: 'agent',
          targetId: 'analyst',
          summary: 'Update analyst instructions.',
          payload: {
            scope: 'machine',
            name: 'analyst',
            description: 'Evidence analyst.',
            instructions: 'Prefer concise evidence notes.',
          },
        },
      ],
    },
  ],
}

const projectAgentProposalQueue: ImprovementReviewQueue = {
  memory: [],
  dreamRuns: [],
  proposals: [
    {
      ...agentProposalQueue.proposals[0]!,
      id: 'proposal-project-agent',
      targetId: 'project-analyst',
      title: 'Update project analyst agent',
      candidateDiffs: [
        {
          ...agentProposalQueue.proposals[0]!.candidateDiffs[0]!,
          targetId: 'project-analyst',
          payload: {
            scope: 'project',
            directory: '/tmp/project',
            name: 'project-analyst',
            description: 'Project analyst.',
            instructions: 'Use project-local evidence only.',
          },
        },
      ],
    },
  ],
}

const skillProposalQueue: ImprovementReviewQueue = {
  memory: [],
  dreamRuns: [],
  proposals: [
    {
      ...unsupportedProposalQueue.proposals[0]!,
      id: 'proposal-skill',
      targetType: 'skill',
      targetId: 'analyst-notes',
      title: 'Update analyst notes skill',
      candidateDiffs: [
        {
          ...unsupportedProposalQueue.proposals[0]!.candidateDiffs[0]!,
          targetType: 'skill',
          targetId: 'analyst-notes',
          summary: 'Update analyst notes skill.',
          payload: {
            scope: 'machine',
            name: 'analyst-notes',
            content: '---\nname: analyst-notes\ndescription: Analyst notes.\n---\n\nPrefer concise evidence notes.\n',
          },
        },
      ],
    },
  ],
}

const projectSkillProposalQueue: ImprovementReviewQueue = {
  memory: [],
  dreamRuns: [],
  proposals: [
    {
      ...skillProposalQueue.proposals[0]!,
      id: 'proposal-project-skill',
      targetId: 'project-notes',
      title: 'Update project notes skill',
      candidateDiffs: [
        {
          ...skillProposalQueue.proposals[0]!.candidateDiffs[0]!,
          targetId: 'project-notes',
          payload: {
            scope: 'project',
            directory: '/tmp/project',
            name: 'project-notes',
            content: '---\nname: project-notes\ndescription: Project notes.\n---\n\nPrefer local project notes.\n',
          },
        },
      ],
    },
  ],
}

const crewProposalQueue: ImprovementReviewQueue = {
  memory: [],
  dreamRuns: [],
  proposals: [
    {
      ...unsupportedProposalQueue.proposals[0]!,
      id: 'proposal-crew',
      targetType: 'crew',
      targetId: null,
      title: 'Create reporting crew',
      candidateDiffs: [
        {
          ...unsupportedProposalQueue.proposals[0]!.candidateDiffs[0]!,
          targetType: 'crew',
          targetId: null,
          summary: 'Create reporting crew.',
          payload: {
            name: 'Reporting Crew',
            description: 'Prepares weekly reporting packages.',
            members: [
              { role: 'lead', agentName: 'build' },
              { role: 'specialist', agentName: 'plan' },
              { role: 'specialist', agentName: 'general' },
              { role: 'evaluator', agentName: 'explore' },
            ],
          },
        },
      ],
    },
  ],
}

const crewDeleteProposalQueue: ImprovementReviewQueue = {
  memory: [],
  dreamRuns: [],
  proposals: [
    {
      ...crewProposalQueue.proposals[0]!,
      id: 'proposal-crew-delete',
      targetId: 'crew-1',
      title: 'Delete reporting crew',
      candidateDiffs: [
        {
          ...crewProposalQueue.proposals[0]!.candidateDiffs[0]!,
          targetId: 'crew-1',
          operation: 'delete',
          summary: 'Delete reporting crew.',
          payload: {
            id: 'crew-1',
          },
        },
      ],
    },
  ],
}

const sopProposalQueue: ImprovementReviewQueue = {
  memory: [],
  dreamRuns: [],
  proposals: [
    {
      ...unsupportedProposalQueue.proposals[0]!,
      id: 'proposal-sop',
      targetType: 'sop',
      targetId: null,
      title: 'Create reporting SOP',
      candidateDiffs: [
        {
          ...unsupportedProposalQueue.proposals[0]!.candidateDiffs[0]!,
          targetType: 'sop',
          targetId: null,
          summary: 'Create reporting SOP.',
          payload: {
            name: 'Reporting SOP',
            description: 'Prepares weekly reporting packages.',
            triggerTypes: ['manual'],
            retryPolicy: { maxRetries: 1, baseDelayMinutes: 30, maxDelayMinutes: 120 },
            runPolicy: { dailyRunCap: 1, maxRunDurationMinutes: 60 },
          },
        },
      ],
    },
  ],
}

const sopDeleteProposalQueue: ImprovementReviewQueue = {
  memory: [],
  dreamRuns: [],
  proposals: [
    {
      ...sopProposalQueue.proposals[0]!,
      id: 'proposal-sop-delete',
      targetId: 'sop-1',
      title: 'Delete reporting SOP',
      candidateDiffs: [
        {
          ...sopProposalQueue.proposals[0]!.candidateDiffs[0]!,
          targetId: 'sop-1',
          operation: 'delete',
          summary: 'Delete reporting SOP.',
          payload: {
            id: 'sop-1',
          },
        },
      ],
    },
  ],
}

const evalCaseProposalQueue: ImprovementReviewQueue = {
  memory: [],
  dreamRuns: [],
  proposals: [
    {
      ...unsupportedProposalQueue.proposals[0]!,
      id: 'proposal-eval-case',
      targetType: 'eval_case',
      targetId: null,
      title: 'Create eval case',
      candidateDiffs: [
        {
          ...unsupportedProposalQueue.proposals[0]!.candidateDiffs[0]!,
          targetType: 'eval_case',
          targetId: null,
          operation: 'create',
          summary: 'Create eval case.',
          payload: {
            suiteId: 'suite-1',
            name: 'Evidence coverage',
            inputRef: 'trace://crew-run/evidence-coverage',
            expectedOutcome: 'Material claims are backed by traceable evidence.',
          },
        },
      ],
    },
  ],
}

const evalCaseUpdateProposalQueue: ImprovementReviewQueue = {
  memory: [],
  dreamRuns: [],
  proposals: [
    {
      ...evalCaseProposalQueue.proposals[0]!,
      id: 'proposal-eval-case-update',
      targetId: 'eval-case-1',
      title: 'Update eval case',
      candidateDiffs: [
        {
          ...evalCaseProposalQueue.proposals[0]!.candidateDiffs[0]!,
          targetId: 'eval-case-1',
          operation: 'update',
          summary: 'Update eval case.',
          payload: {
            id: 'eval-case-1',
            suiteId: 'suite-1',
            name: 'Evidence coverage update',
            inputRef: 'trace://crew-run/evidence-coverage',
            expectedOutcome: 'Updated expected outcome.',
          },
        },
      ],
    },
  ],
}

const evalCaseTargetedCreateProposalQueue: ImprovementReviewQueue = {
  memory: [],
  dreamRuns: [],
  proposals: [
    {
      ...evalCaseProposalQueue.proposals[0]!,
      id: 'proposal-eval-case-targeted-create',
      targetId: 'eval-case-1',
      title: 'Create targeted eval case',
      candidateDiffs: [
        {
          ...evalCaseProposalQueue.proposals[0]!.candidateDiffs[0]!,
          targetId: 'eval-case-1',
          operation: 'create',
          summary: 'Create targeted eval case.',
          payload: {
            id: 'eval-case-1',
            suiteId: 'suite-1',
            name: 'Evidence coverage',
            inputRef: 'trace://crew-run/evidence-coverage',
            expectedOutcome: 'Material claims are backed by traceable evidence.',
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

  it('offers approval for skill proposals with a typed persistence path', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    render(<PulseImprovementInbox inbox={skillProposalQueue} actionId={null} onReview={onReview} onUpdateProposal={vi.fn()} />)

    expect(screen.queryByText('Approval for this proposal type is waiting for a typed persistence path. Reject, archive, or leave it queued for now.')).not.toBeInTheDocument()
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).not.toBeDisabled()
    await user.click(approve)
    expect(onReview).toHaveBeenCalledWith('proposal-skill', 'approve-proposal')
  })

  it('offers approval for machine-scoped agent proposals with a typed persistence path', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    render(<PulseImprovementInbox inbox={agentProposalQueue} actionId={null} onReview={onReview} onUpdateProposal={vi.fn()} />)

    expect(screen.queryByText('Approval for this proposal type is waiting for a typed persistence path. Reject, archive, or leave it queued for now.')).not.toBeInTheDocument()
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).not.toBeDisabled()
    await user.click(approve)
    expect(onReview).toHaveBeenCalledWith('proposal-agent', 'approve-proposal')
  })

  it('offers approval for crew create/update proposals with a typed persistence path', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    render(<PulseImprovementInbox inbox={crewProposalQueue} actionId={null} onReview={onReview} onUpdateProposal={vi.fn()} />)

    expect(screen.queryByText('Approval for this proposal type is waiting for a typed persistence path. Reject, archive, or leave it queued for now.')).not.toBeInTheDocument()
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).not.toBeDisabled()
    await user.click(approve)
    expect(onReview).toHaveBeenCalledWith('proposal-crew', 'approve-proposal')
  })

  it('does not offer approval for crew operations without an existing typed path', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    render(<PulseImprovementInbox inbox={crewDeleteProposalQueue} actionId={null} onReview={onReview} onUpdateProposal={vi.fn()} />)

    expect(screen.getByText('This proposal includes an operation that does not have a typed approval path yet. Reject, archive, or leave it queued for now.')).toBeInTheDocument()
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).toBeDisabled()
    await user.click(approve)
    expect(onReview).not.toHaveBeenCalled()
  })

  it('offers approval for SOP create/update proposals with a typed persistence path', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    render(<PulseImprovementInbox inbox={sopProposalQueue} actionId={null} onReview={onReview} onUpdateProposal={vi.fn()} />)

    expect(screen.queryByText('Approval for this proposal type is waiting for a typed persistence path. Reject, archive, or leave it queued for now.')).not.toBeInTheDocument()
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).not.toBeDisabled()
    await user.click(approve)
    expect(onReview).toHaveBeenCalledWith('proposal-sop', 'approve-proposal')
  })

  it('does not offer approval for SOP operations without an existing typed path', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    render(<PulseImprovementInbox inbox={sopDeleteProposalQueue} actionId={null} onReview={onReview} onUpdateProposal={vi.fn()} />)

    expect(screen.getByText('This proposal includes an operation that does not have a typed approval path yet. Reject, archive, or leave it queued for now.')).toBeInTheDocument()
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).toBeDisabled()
    await user.click(approve)
    expect(onReview).not.toHaveBeenCalled()
  })

  it('offers approval for eval-case create proposals with a typed persistence path', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    render(<PulseImprovementInbox inbox={evalCaseProposalQueue} actionId={null} onReview={onReview} onUpdateProposal={vi.fn()} />)

    expect(screen.queryByText('Approval for this proposal type is waiting for a typed persistence path. Reject, archive, or leave it queued for now.')).not.toBeInTheDocument()
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).not.toBeDisabled()
    await user.click(approve)
    expect(onReview).toHaveBeenCalledWith('proposal-eval-case', 'approve-proposal')
  })

  it('does not offer approval for eval-case operations without an existing typed path', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    render(<PulseImprovementInbox inbox={evalCaseUpdateProposalQueue} actionId={null} onReview={onReview} onUpdateProposal={vi.fn()} />)

    expect(screen.getByText('This proposal includes an operation that does not have a typed approval path yet. Reject, archive, or leave it queued for now.')).toBeInTheDocument()
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).toBeDisabled()
    await user.click(approve)
    expect(onReview).not.toHaveBeenCalled()
  })

  it('does not offer approval for targeted eval-case create proposals', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    render(<PulseImprovementInbox inbox={evalCaseTargetedCreateProposalQueue} actionId={null} onReview={onReview} onUpdateProposal={vi.fn()} />)

    expect(screen.getByText('This proposal includes an operation that does not have a typed approval path yet. Reject, archive, or leave it queued for now.')).toBeInTheDocument()
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).toBeDisabled()
    await user.click(approve)
    expect(onReview).not.toHaveBeenCalled()
  })

  it('does not offer approval for project-scoped agent proposals until grants are wired', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    render(<PulseImprovementInbox inbox={projectAgentProposalQueue} actionId={null} onReview={onReview} onUpdateProposal={vi.fn()} />)

    expect(screen.getByText('Project-scoped agent proposals need an explicit project grant before approval. Reject, archive, or leave it queued for now.')).toBeInTheDocument()
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).toBeDisabled()
    await user.click(approve)
    expect(onReview).not.toHaveBeenCalled()
  })

  it('does not offer approval for project-scoped skill proposals until grants are wired', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    render(<PulseImprovementInbox inbox={projectSkillProposalQueue} actionId={null} onReview={onReview} onUpdateProposal={vi.fn()} />)

    expect(screen.getByText('Project-scoped skill proposals need an explicit project grant before approval. Reject, archive, or leave it queued for now.')).toBeInTheDocument()
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
