import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { installRendererTestCoworkApi } from '../../test/setup'
import { useSessionStore } from '../../stores/session'
import { McpStatusBadge } from './McpStatusBadge'

function setConnections() {
  useSessionStore.setState({
    mcpConnections: [
      { name: 'charts', connected: true },
      { name: 'github', connected: false, rawStatus: 'disconnected' },
      { name: 'google-drive', connected: false, rawStatus: 'auth_required' },
    ],
  })
}

describe('McpStatusBadge', () => {
  it('renders a compact summary and reuses MCP reconnect/auth actions', async () => {
    const connect = vi.fn(async () => undefined)
    const auth = vi.fn(async () => true)
    installRendererTestCoworkApi({ mcp: { connect, auth } })
    setConnections()

    render(<McpStatusBadge />)

    fireEvent.click(screen.getByRole('button', { name: /1\/3 MCPs 1 auth 1 failed/i }))
    expect(screen.getByText('charts')).toBeInTheDocument()
    expect(screen.getByText('google-drive')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Auth' }))

    await waitFor(() => {
      expect(connect).toHaveBeenCalledWith('github')
      expect(auth).toHaveBeenCalledWith('google-drive')
    })
  })
})
