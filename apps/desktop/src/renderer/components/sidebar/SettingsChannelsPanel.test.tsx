import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ChannelDefinition,
  CrewListPayload,
  LocalWebhookChannelPairing,
  LocalWebhookChannelPairingResult,
  LocalWebhookReceiverStatus,
  SopListPayload,
  WorkspaceProfile,
} from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { ChannelsPanel } from './SettingsChannelsPanel'

const now = '2026-05-11T12:00:00.000Z'

const channelWorkspaceProfile: WorkspaceProfile = {
  schemaVersion: 1,
  id: 'channel-sandbox',
  kind: 'channel_sandbox',
  name: 'Channel sandbox',
  description: 'Channel-bound sandbox',
  authority: {
    schemaVersion: 1,
    filesystem: {
      mode: 'sandbox',
      roots: [],
      writeAllowed: true,
    },
    externalSystems: [],
    cleanup: {
      retentionDays: 14,
      deletesUnreferencedArtifacts: true,
    },
    isolation: {
      projectBound: false,
      channelBound: true,
      highRiskIsolated: false,
    },
  },
  createdAt: now,
  updatedAt: now,
}

const receiverStatus: LocalWebhookReceiverStatus = {
  schemaVersion: 1,
  enabled: true,
  listening: true,
  host: '127.0.0.1',
  port: 49152,
  url: 'http://127.0.0.1:49152/channels/local-webhook/:sourceKey',
  pairedChannels: 0,
  lastError: null,
}

function channel(overrides: Partial<ChannelDefinition> = {}): ChannelDefinition {
  return {
    schemaVersion: 1,
    id: 'channel-1',
    provider: 'local_webhook',
    name: 'Support inbox',
    description: 'Support messages',
    sourceKey: 'support-inbox',
    enabled: true,
    senderAllowlist: ['ops@example.com'],
    allowedCapabilityIds: ['support.reply'],
    route: {
      schemaVersion: 1,
      activationMode: 'ask_user',
      targetSopId: null,
      targetCrewId: null,
    },
    workspaceProfileId: 'channel-sandbox',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const sopPayload: SopListPayload = {
  sops: [
    {
      definition: {
        schemaVersion: 1,
        id: 'sop-1',
        name: 'Support triage',
        description: 'Triage inbound support',
        status: 'active',
        activeVersionId: 'sop-version-1',
        sourceAutomationId: null,
        createdAt: now,
        updatedAt: now,
      },
      activeVersion: null,
    },
  ],
}

const crewPayload: CrewListPayload = {
  crews: [
    {
      definition: {
        schemaVersion: 1,
        id: 'crew-1',
        name: 'Response crew',
        description: 'Draft channel responses',
        status: 'active',
        activeVersionId: 'crew-version-1',
        createdAt: now,
        updatedAt: now,
      },
      activeVersion: null,
      latestRun: null,
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('ChannelsPanel', () => {
  it('creates a local webhook pairing with explicit sender, route, capability, and workspace scope', async () => {
    const user = userEvent.setup()
    const createdChannel = channel({
      route: {
        schemaVersion: 1,
        activationMode: 'run_sop',
        targetSopId: 'sop-1',
        targetCrewId: null,
      },
    })
    const createLocalWebhook = vi.fn(async (): Promise<LocalWebhookChannelPairingResult> => ({
      channel: createdChannel,
      pairing: {
        schemaVersion: 1,
        channelId: createdChannel.id,
        sourceKey: createdChannel.sourceKey,
        tokenPrefix: 'ocw_wh_abcd',
        createdAt: now,
        rotatedAt: now,
      },
      token: 'ocw_wh_abcd_secret',
    }))
    installRendererTestCoworkApi({
      channels: {
        localWebhookStatus: vi.fn(async () => receiverStatus),
        definitions: vi.fn(async () => []),
        localWebhookPairings: vi.fn(async () => []),
        createLocalWebhook,
      },
      sops: {
        list: vi.fn(async () => sopPayload),
      },
      crews: {
        list: vi.fn(async () => crewPayload),
      },
    })

    render(<ChannelsPanel workspaceProfiles={[channelWorkspaceProfile]} />)

    await screen.findByText('Receiver status')
    await user.type(screen.getByLabelText('Name'), 'Support inbox')
    expect(screen.getByLabelText('Source key')).toHaveValue('support-inbox')
    await user.type(screen.getByLabelText('Sender allowlist'), 'ops@example.com\n*@trusted.example')
    await user.selectOptions(screen.getByLabelText('Activation mode'), 'run_sop')
    await user.selectOptions(screen.getByLabelText('Target workflow'), 'sop-1')
    await user.type(screen.getByLabelText('Allowed capability IDs'), 'support.reply\nsupport.lookup')
    await user.click(screen.getByRole('button', { name: 'Create pairing' }))

    await waitFor(() => expect(createLocalWebhook).toHaveBeenCalledTimes(1))
    expect(createLocalWebhook).toHaveBeenCalledWith({
      name: 'Support inbox',
      description: null,
      sourceKey: 'support-inbox',
      enabled: true,
      senderAllowlist: ['ops@example.com', '*@trusted.example'],
      allowedCapabilityIds: ['support.reply', 'support.lookup'],
      route: {
        activationMode: 'run_sop',
        targetSopId: 'sop-1',
        targetCrewId: null,
      },
      workspaceProfileId: 'channel-sandbox',
    })
    expect(await screen.findByText('ocw_wh_abcd_secret')).toBeInTheDocument()
    expect(screen.getByText('http://127.0.0.1:49152/channels/local-webhook/support-inbox')).toBeInTheDocument()
  })

  it('does not let a stale initial refresh overwrite state loaded after creating a pairing', async () => {
    const user = userEvent.setup()
    const initialStatus = deferred<LocalWebhookReceiverStatus>()
    const createdChannel = channel()
    const createdPairing: LocalWebhookChannelPairing = {
      schemaVersion: 1,
      channelId: createdChannel.id,
      sourceKey: createdChannel.sourceKey,
      tokenPrefix: 'ocw_wh_abcd',
      createdAt: now,
      rotatedAt: now,
    }
    const createLocalWebhook = vi.fn(async (): Promise<LocalWebhookChannelPairingResult> => ({
      channel: createdChannel,
      pairing: createdPairing,
      token: 'ocw_wh_abcd_secret',
    }))
    const localWebhookStatus = vi.fn()
      .mockImplementationOnce(() => initialStatus.promise)
      .mockResolvedValue(receiverStatus)
    installRendererTestCoworkApi({
      channels: {
        localWebhookStatus,
        definitions: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValue([createdChannel]),
        localWebhookPairings: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValue([createdPairing]),
        createLocalWebhook,
      },
      sops: {
        list: vi.fn(async () => ({ sops: [] })),
      },
      crews: {
        list: vi.fn(async () => ({ crews: [] })),
      },
    })

    render(<ChannelsPanel workspaceProfiles={[channelWorkspaceProfile]} />)

    await user.type(screen.getByLabelText('Name'), 'Support inbox')
    await user.type(screen.getByLabelText('Sender allowlist'), 'ops@example.com')
    await user.click(screen.getByRole('button', { name: 'Create pairing' }))

    await waitFor(() => expect(createLocalWebhook).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Support inbox')).toBeInTheDocument()

    initialStatus.resolve(receiverStatus)
    await waitFor(() => expect(localWebhookStatus).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Support inbox')).toBeInTheDocument()
    expect(screen.queryByText('No local webhook pairings yet.')).not.toBeInTheDocument()
  })

  it('rotates an existing local webhook token and reveals only the new token', async () => {
    const user = userEvent.setup()
    const existingChannel = channel()
    const existingPairing: LocalWebhookChannelPairing = {
      schemaVersion: 1,
      channelId: existingChannel.id,
      sourceKey: existingChannel.sourceKey,
      tokenPrefix: 'ocw_wh_old',
      createdAt: now,
      rotatedAt: now,
    }
    const rotateLocalWebhookToken = vi.fn(async (): Promise<LocalWebhookChannelPairingResult> => ({
      channel: existingChannel,
      pairing: {
        ...existingPairing,
        tokenPrefix: 'ocw_wh_new',
      },
      token: 'ocw_wh_new_secret',
    }))
    installRendererTestCoworkApi({
      channels: {
        localWebhookStatus: vi.fn(async () => ({ ...receiverStatus, pairedChannels: 1 })),
        definitions: vi.fn(async () => [existingChannel]),
        localWebhookPairings: vi.fn(async () => [existingPairing]),
        rotateLocalWebhookToken,
      },
      sops: {
        list: vi.fn(async () => ({ sops: [] })),
      },
      crews: {
        list: vi.fn(async () => ({ crews: [] })),
      },
    })

    render(<ChannelsPanel workspaceProfiles={[channelWorkspaceProfile]} />)

    await screen.findByText('Support inbox')
    expect(screen.queryByText('ocw_wh_new_secret')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Rotate token' }))

    await waitFor(() => expect(rotateLocalWebhookToken).toHaveBeenCalledWith('channel-1'))
    expect(await screen.findByText('ocw_wh_new_secret')).toBeInTheDocument()
  })
})
