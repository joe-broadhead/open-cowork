import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { EffectiveAppSettings } from '@open-cowork/shared'
import { WorkflowSettingsPanel } from './SettingsWorkflowsPanel'

function settings(overrides: Partial<EffectiveAppSettings> = {}): EffectiveAppSettings {
  return {
    selectedProviderId: null,
    selectedModelId: null,
    providerCredentials: {},
    integrationCredentials: {},
    integrationEnabled: {},
    bashPermission: 'deny',
    fileWritePermission: 'deny',
    webPermission: 'allow',
    webSearchEnabled: true,
    taskPermission: 'allow',
    externalDirectoryPermission: 'allow',
    mcpPermission: 'allow',
    requireApprovalBeforeSending: true,
    notificationVoiceReplies: true,
    notificationSmartSuggestions: true,
    notificationDailyDigest: false,
    notificationSounds: true,
    privacyKeepConversationHistory: true,
    privacyShareAnonymizedUsage: false,
    runtimeToolingBridgeEnabled: true,
    windowZoomFactor: 1,
    workflowLaunchAtLogin: false,
    workflowRunInBackground: true,
    workflowDesktopNotifications: true,
    workflowQuietHoursStart: '22:00',
    workflowQuietHoursEnd: null,
    effectiveProviderId: null,
    effectiveModel: null,
    ...overrides,
  }
}

describe('WorkflowSettingsPanel', () => {
  it('renders workflow toggles and emits precise setting patches', () => {
    const update = vi.fn()
    render(<WorkflowSettingsPanel settings={settings()} update={update} />)

    fireEvent.click(screen.getByRole('switch', { name: 'Launch at login' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Run in background' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Desktop notifications' }))

    expect(update).toHaveBeenNthCalledWith(1, { workflowLaunchAtLogin: true })
    expect(update).toHaveBeenNthCalledWith(2, { workflowRunInBackground: false })
    expect(update).toHaveBeenNthCalledWith(3, { workflowDesktopNotifications: false })
  })

  it('keeps autonomous learning controls out of workflow settings', () => {
    const update = vi.fn()
    render(<WorkflowSettingsPanel settings={settings()} update={update} />)

    expect(screen.queryByRole('switch', { name: 'Improvement proposals' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Scheduled consolidation' })).not.toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps legacy automation defaults and queue controls out of workflow settings', () => {
    const update = vi.fn()
    render(<WorkflowSettingsPanel settings={settings()} update={update} />)

    expect(screen.queryByLabelText('Default autonomy')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Default execution mode')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Maximum autonomy')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Write parallelism')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Queue budget USD')).not.toBeInTheDocument()

    expect(update).not.toHaveBeenCalled()
  })

  it('updates quiet-hour fields independently', () => {
    const update = vi.fn()
    render(<WorkflowSettingsPanel settings={settings()} update={update} />)

    fireEvent.change(screen.getByLabelText('Start'), {
      target: { value: '' },
    })
    fireEvent.change(screen.getByLabelText('End'), {
      target: { value: '07:30' },
    })

    expect(update).toHaveBeenNthCalledWith(1, { workflowQuietHoursStart: null })
    expect(update).toHaveBeenNthCalledWith(2, { workflowQuietHoursEnd: '07:30' })
  })
})
