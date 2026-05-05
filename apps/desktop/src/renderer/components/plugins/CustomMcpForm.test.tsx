import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CustomMcpForm } from './CustomMcpForm'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CustomMcpForm', () => {
  it('requires explicit confirmation before allowing private network MCP URLs', async () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<CustomMcpForm onSave={onSave} onCancel={onCancel} />)

    fireEvent.click(screen.getByRole('button', { name: 'HTTP / SSE (remote)' }))
    const checkbox = await screen.findByLabelText(/Allow private network/)
    fireEvent.click(checkbox)

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(checkbox).not.toBeChecked()

    confirm.mockReturnValue(true)
    fireEvent.click(checkbox)
    expect(checkbox).toBeChecked()
  })
})
