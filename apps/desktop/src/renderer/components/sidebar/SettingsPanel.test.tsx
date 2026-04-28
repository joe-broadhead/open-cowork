import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from './SettingsPanel'

describe('SettingsPanel', () => {
  it('persists the developer config bridge permission toggle', async () => {
    const settingsSet = vi.mocked(window.coworkApi.settings.set)
    const user = userEvent.setup()

    render(<SettingsPanel onClose={vi.fn()} />)

    await screen.findByText('Settings')
    await user.click(screen.getByRole('button', { name: /Permissions/ }))

    const toolingBridge = await screen.findByRole('switch', { name: 'Developer config bridge' })
    expect(toolingBridge).toHaveAttribute('aria-checked', 'true')

    await user.click(toolingBridge)
    expect(toolingBridge).toHaveAttribute('aria-checked', 'false')

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1))
    expect(settingsSet.mock.calls[0]?.[0]).toMatchObject({
      enableBash: false,
      enableFileWrite: false,
      runtimeToolingBridgeEnabled: false,
    })
  })
})
