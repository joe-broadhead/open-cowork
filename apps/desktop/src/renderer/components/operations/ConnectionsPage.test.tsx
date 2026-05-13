import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelListPayload, LocalWebhookReceiverStatus } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { ConnectionsPage } from './ConnectionsPage'

const channelState: ChannelListPayload = {
  channels: [{
    schemaVersion: 1,
    id: 'channel-ops',
    provider: 'local_webhook',
    name: 'Ops Intake',
    description: 'Operational intake',
    sourceKey: 'ops',
    enabled: true,
    senderAllowlist: ['ops@example.com'],
    allowedCapabilityIds: ['tool:browser'],
    route: {
      schemaVersion: 1,
      activationMode: 'run_crew',
      targetSopId: null,
      targetCrewId: 'crew-field',
    },
    workspaceProfileId: 'channel-sandbox',
    createdAt: '2026-05-13T00:00:00.000Z',
    updatedAt: '2026-05-13T09:00:00.000Z',
  }],
  inboundItems: [{
    schemaVersion: 1,
    id: 'item-1',
    channelId: 'channel-ops',
    provider: 'local_webhook',
    source: {
      schemaVersion: 1,
      provider: 'local_webhook',
      sourceKey: 'ops',
      externalMessageId: null,
      replyTarget: null,
    },
    sender: 'ops@example.com',
    subject: 'Ship report',
    body: 'Please ship the report.',
    route: {
      schemaVersion: 1,
      activationMode: 'run_crew',
      targetSopId: null,
      targetCrewId: 'crew-field',
    },
    status: 'needs_user',
    auditState: 'user_review_required',
    allowedCapabilityIds: ['tool:browser'],
    workspaceProfileId: 'channel-sandbox',
    queueItemId: null,
    deliveryRecordId: null,
    workItemId: null,
    runKind: 'crew',
    runId: 'run-1',
    runStatus: 'needs_user',
    approvedAt: null,
    approvedBy: null,
    reviewNote: null,
    receivedAt: '2026-05-13T09:00:00.000Z',
    updatedAt: '2026-05-13T09:00:00.000Z',
    error: null,
  }],
  deliveries: [],
}

const webhookStatus: LocalWebhookReceiverStatus = {
  schemaVersion: 1,
  enabled: true,
  listening: true,
  host: '127.0.0.1',
  port: 3929,
  url: 'http://127.0.0.1:3929/hooks/:sourceKey',
  pairedChannels: 1,
  lastError: null,
}

describe('ConnectionsPage', () => {
  it('shows channel route targets and webhook health as an operational view', async () => {
    installRendererTestCoworkApi({
      capabilities: {
        skills: vi.fn(async () => []),
        tools: vi.fn(async () => []),
      },
      channels: {
        list: vi.fn(async () => channelState),
        localWebhookStatus: vi.fn(async () => webhookStatus),
      },
      model: {
        info: vi.fn(async () => null),
      },
    })

    render(<ConnectionsPage onOpenSettings={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Connections' })).toBeInTheDocument()
    expect(await screen.findByText('Ops Intake')).toBeInTheDocument()
    expect(screen.getAllByText(/Run crew/).length).toBeGreaterThan(0)
    expect(screen.getByText('Crew: crew-field')).toBeInTheDocument()
    expect(screen.getByText('tool:browser')).toBeInTheDocument()
    expect(screen.getAllByText('Listening').length).toBeGreaterThan(0)
    expect(screen.getByText('Ship report')).toBeInTheDocument()
  })
})
