import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopPairingPublicRecord, RuntimeInputDiagnostics, WorkspaceInfo } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { HealthCenterPage } from './HealthCenterPage'

const runtimeInputs: RuntimeInputDiagnostics = {
  opencodeVersion: '1.0.0',
  providerId: 'openrouter',
  providerName: 'OpenRouter',
  providerPackage: null,
  modelId: 'anthropic/claude-sonnet-4',
  runtimeModel: 'anthropic/claude-sonnet-4',
  defaultProviderId: 'openrouter',
  defaultModelId: 'anthropic/claude-sonnet-4',
  providerSource: 'settings',
  modelSource: 'settings',
  providerOptions: {},
  credentialOverrideKeys: ['apiKey'],
  capabilities: [
    {
      id: 'openrouter',
      kind: 'provider',
      status: 'active',
      reasonCode: 'provider.settings',
      source: 'settings',
      productMode: 'desktop-local',
      evidence: {
        providerName: 'OpenRouter',
        credentialOverrideKeys: ['apiKey'],
      },
      redacted: true,
    },
    {
      id: 'oauth-example',
      kind: 'mcp',
      status: 'auth-pending',
      reasonCode: 'mcp.awaiting-oauth-opt-in',
      source: 'builtin',
      productMode: 'desktop-local',
      evidence: {
        authMode: 'oauth',
        credentialKeys: ['account'],
      },
      redacted: true,
    },
    {
      id: 'opencode-plugin-remote-fail-closed',
      kind: 'opencode-plugin',
      status: 'unsupported',
      reasonCode: 'plugin.product-mode-unsupported',
      source: 'opencode-compatibility-registry',
      productMode: 'cloud-worker,desktop-local',
      redacted: true,
    },
  ],
  conflicts: [
    {
      id: 'anthropic/claude-sonnet-4',
      kind: 'model',
      winnerSource: 'settings',
      loserSources: ['default:openrouter/gpt-5-mini'],
      reasonCode: 'model.source-conflict-winner',
      redacted: true,
    },
  ],
}

const workspaces: WorkspaceInfo[] = [
  {
    id: 'local',
    kind: 'local',
    authority: 'desktop_local',
    label: 'Local',
    status: 'online',
    active: true,
    lastSyncedAt: null,
  },
  {
    id: 'cloud:acme',
    kind: 'cloud',
    authority: 'cloud_worker',
    label: 'Acme Cloud',
    status: 'auth_required',
    active: false,
    baseUrl: 'https://cloud.acme.test',
    lastSyncedAt: null,
  },
]

const pairing: DesktopPairingPublicRecord = {
  id: 'pairing-1',
  label: 'Laptop Pairing',
  deviceName: 'Laptop',
  status: 'paired_online',
  enabled: true,
  brokerUrl: 'https://broker.example.test',
  allowedWorkspaceIds: ['local'],
  allowedSessionIds: null,
  policy: {
    allowRemotePrompts: true,
    allowRemoteAbort: true,
    remoteApprovals: 'local_confirmation',
    remoteQuestions: 'local_confirmation',
    exposeArtifactBodies: false,
    exposeLocalPaths: false,
    exposeLocalMcpDetails: false,
    allowRemoteAttachments: false,
  },
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
  lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
  lastCommandSequence: 12,
  error: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  revokedAt: null,
  credential: {
    hasToken: true,
    deviceId: 'device-1',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
}

describe('HealthCenterPage', () => {
  it('renders setup paths, authority health, pairings, and recovery actions', async () => {
    const login = vi.fn(async () => ({
      ...workspaces[1],
      status: 'online',
    }))
    const restart = vi.fn(async () => ({ ready: true, error: null }))
    installRendererTestCoworkApi({
      runtime: {
        status: vi.fn(async () => ({ ready: true, error: null })),
        restart,
      },
      app: {
        runtimeInputs: vi.fn(async () => runtimeInputs),
      },
      workspace: {
        list: vi.fn(async () => workspaces),
        login,
        support: vi.fn(async (workspaceId?: string) => workspaceId === 'cloud:acme'
          ? [{
              api: 'sessions.prompt',
              status: 'blocked_by_policy',
              verdict: { allowed: false, reason: 'auth required' },
            }]
          : [{
              api: 'sessions.prompt',
              status: 'supported',
              verdict: { allowed: true, reason: null },
            }]),
      },
      desktopPairing: {
        list: vi.fn(async () => [pairing]),
      },
    })

    render(<HealthCenterPage />)

    expect(await screen.findByText('Health Center')).toBeTruthy()
    expect(screen.getByText('Run Desktop locally')).toBeTruthy()
    expect(screen.getByText('Deploy Gateway')).toBeTruthy()
    expect(screen.getByText('Connect Cloud')).toBeTruthy()
    expect(screen.getByText('Acme Cloud')).toBeTruthy()
    expect(screen.getByText('Laptop Pairing')).toBeTruthy()
    expect(screen.getByText('Desktop runtime ready')).toBeTruthy()
    expect(screen.getByText('Cloud workspace authenticated')).toBeTruthy()
    expect(screen.getByText('Runtime Capability Provenance')).toBeTruthy()
    expect(screen.getByTestId('runtime-capability-mcp-oauth-example')).toBeTruthy()
    expect(screen.getByText('mcp.awaiting-oauth-opt-in')).toBeTruthy()
    expect(screen.getByText('plugin.product-mode-unsupported')).toBeTruthy()
    expect(screen.getByText('model.source-conflict-winner')).toBeTruthy()
    expect(screen.getByText(/winner settings/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(login).toHaveBeenCalledWith('cloud:acme'))

    await userEvent.click(screen.getByRole('button', { name: 'Restart runtime' }))
    await waitFor(() => expect(restart).toHaveBeenCalledTimes(1))
  })
})
