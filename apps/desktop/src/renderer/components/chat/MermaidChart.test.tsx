import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MermaidChart } from './MermaidChart'

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}))

vi.mock('mermaid', () => ({
  default: mermaidMock,
}))

describe('MermaidChart', () => {
  beforeEach(() => {
    mermaidMock.render.mockResolvedValue({
      svg: '<svg width="120" height="80"><script>alert(1)</script><foreignObject><div>Unsafe HTML label</div></foreignObject><g onclick="alert(2)"><text>Safe chart</text></g></svg>',
      bindFunctions: vi.fn(),
    })
  })

  it('renders third-party Mermaid SVG through the SVG sanitizer', async () => {
    const { container } = render(<MermaidChart diagram="graph TD; A-->B" title="Flow" />)

    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledWith(expect.stringMatching(/^open-cowork-mermaid-/), 'graph TD; A-->B'))
    await waitFor(() => {
      if (!container.querySelector('svg')) throw new Error('Expected sanitized SVG to render.')
    })

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('foreignObject')).toBeNull()
    expect(container.querySelector('[onclick]')).toBeNull()
    expect(container.textContent).toContain('Flow')
    expect(container.textContent).toContain('Safe chart')
    expect(screen.getByLabelText('Zoom in mermaid diagram')).toBeTruthy()
    expect(mermaidMock.initialize).toHaveBeenCalledWith(expect.objectContaining({
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels'],
      securityLevel: 'strict',
    }))
  })

  it('shows a contained error state when Mermaid rejects a diagram', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mermaidMock.render.mockRejectedValueOnce(new Error('bad diagram'))

    render(<MermaidChart diagram="not mermaid" />)

    await screen.findByText('Mermaid error: bad diagram')
    consoleError.mockRestore()
  })
})
