import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { EffectiveAppSettings } from '@open-cowork/shared'
import { AutomationSettingsPanel } from './SettingsAutomationPanel'

function settings(overrides: Partial<EffectiveAppSettings> = {}): EffectiveAppSettings {
  return {
    selectedProviderId: null,
    selectedModelId: null,
    providerCredentials: {},
    integrationCredentials: {},
    integrationEnabled: {},
    bashPermission: 'deny',
    fileWritePermission: 'deny',
    enableBash: false,
    enableFileWrite: false,
    runtimeToolingBridgeEnabled: true,
    automationLaunchAtLogin: false,
    automationRunInBackground: true,
    automationDesktopNotifications: true,
    automationQuietHoursStart: '22:00',
    automationQuietHoursEnd: null,
    defaultAutomationAutonomyPolicy: 'review-first',
    defaultAutomationExecutionMode: 'planning_only',
    operationalMaxAutonomy: 'supervised',
    operationalWriteMaxParallel: 1,
    operationalMaxRunDurationMinutes: 120,
    operationalMaxCostUsd: null,
    operationalMaxRetries: 10,
    improvementProposalsEnabled: true,
    improvementProposalsDisabledAgents: {},
    improvementProposalsDisabledProjects: {},
    improvementProposalsDisabledCrews: {},
    effectiveProviderId: null,
    effectiveModel: null,
    ...overrides,
  }
}

describe('AutomationSettingsPanel', () => {
  it('renders automation toggles and emits precise setting patches', () => {
    const update = vi.fn()
    render(<AutomationSettingsPanel settings={settings()} update={update} />)

    fireEvent.click(screen.getByRole('switch', { name: 'Launch at login' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Run in background' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Desktop notifications' }))

    expect(update).toHaveBeenNthCalledWith(1, { automationLaunchAtLogin: true })
    expect(update).toHaveBeenNthCalledWith(2, { automationRunInBackground: false })
    expect(update).toHaveBeenNthCalledWith(3, { automationDesktopNotifications: false })
  })

  it('updates governed learning policy independently', () => {
    const update = vi.fn()
    render(<AutomationSettingsPanel settings={settings()} update={update} />)

    fireEvent.click(screen.getByRole('switch', { name: 'Improvement proposals' }))
    fireEvent.change(screen.getByLabelText('Disabled agents'), {
      target: { value: 'build\n researcher \n' },
    })
    fireEvent.change(screen.getByLabelText('Disabled projects'), {
      target: { value: '/workspace/acme' },
    })
    fireEvent.change(screen.getByLabelText('Disabled crews'), {
      target: { value: 'growth-review' },
    })

    expect(update).toHaveBeenNthCalledWith(1, { improvementProposalsEnabled: false })
    expect(update).toHaveBeenNthCalledWith(2, { improvementProposalsDisabledAgents: { build: true, researcher: true } })
    expect(update).toHaveBeenNthCalledWith(3, { improvementProposalsDisabledProjects: { '/workspace/acme': true } })
    expect(update).toHaveBeenNthCalledWith(4, { improvementProposalsDisabledCrews: { 'growth-review': true } })
  })

  it('updates defaults and quiet-hour fields independently', () => {
    const update = vi.fn()
    render(<AutomationSettingsPanel settings={settings()} update={update} />)

    fireEvent.change(screen.getByLabelText('Default autonomy'), {
      target: { value: 'mostly-autonomous' },
    })
    fireEvent.change(screen.getByLabelText('Default execution mode'), {
      target: { value: 'scoped_execution' },
    })
    fireEvent.change(screen.getByLabelText('Start'), {
      target: { value: '' },
    })
    fireEvent.change(screen.getByLabelText('End'), {
      target: { value: '07:30' },
    })

    expect(update).toHaveBeenNthCalledWith(1, { defaultAutomationAutonomyPolicy: 'mostly-autonomous' })
    expect(update).toHaveBeenNthCalledWith(2, { defaultAutomationExecutionMode: 'scoped_execution' })
    expect(update).toHaveBeenNthCalledWith(3, { automationQuietHoursStart: null })
    expect(update).toHaveBeenNthCalledWith(4, { automationQuietHoursEnd: '07:30' })
  })

  it('updates operations guardrails independently', () => {
    const update = vi.fn()
    render(<AutomationSettingsPanel settings={settings()} update={update} />)

    fireEvent.change(screen.getByLabelText('Maximum autonomy'), {
      target: { value: 'approve' },
    })
    fireEvent.change(screen.getByLabelText('Write parallelism'), {
      target: { value: '3' },
    })
    fireEvent.change(screen.getByLabelText('Max run minutes'), {
      target: { value: '30' },
    })
    fireEvent.change(screen.getByLabelText('Queue budget USD'), {
      target: { value: '2.456' },
    })
    fireEvent.change(screen.getByLabelText('Max retries'), {
      target: { value: '1' },
    })

    expect(update).toHaveBeenNthCalledWith(1, { operationalMaxAutonomy: 'approve' })
    expect(update).toHaveBeenNthCalledWith(2, { operationalWriteMaxParallel: 3 })
    expect(update).toHaveBeenNthCalledWith(3, { operationalMaxRunDurationMinutes: 30 })
    expect(update).toHaveBeenNthCalledWith(4, { operationalMaxCostUsd: 2.46 })
    expect(update).toHaveBeenNthCalledWith(5, { operationalMaxRetries: 1 })
  })
})
