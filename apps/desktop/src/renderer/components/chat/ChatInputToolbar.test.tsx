import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatInputToolbar } from './ChatInputToolbar'

function renderToolbar(overrides: Partial<Parameters<typeof ChatInputToolbar>[0]> = {}) {
  const fileInputRef = createRef<HTMLInputElement>()
  const modelButtonRef = createRef<HTMLButtonElement>()
  const props: Parameters<typeof ChatInputToolbar>[0] = {
    fileInputRef,
    modelButtonRef,
    modelLabel: 'Claude Sonnet',
    currentDirectory: '/Users/joe/project',
    agentMode: 'build',
    currentSessionId: 'ses_123',
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
    canSend: true,
    onAddFiles: vi.fn(),
    onToggleModelMenu: vi.fn(),
    onToggleAgentMode: vi.fn(),
    onFork: vi.fn(),
    onStop: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  }

  return {
    ...render(<ChatInputToolbar {...props} />),
    props,
  }
}

describe('ChatInputToolbar', () => {
  it('opens the hidden file input and forwards selected files', () => {
    const { container, props } = renderToolbar()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const clickSpy = vi.spyOn(input, 'click')
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })

    fireEvent.click(screen.getByTitle('Attach file'))
    expect(clickSpy).toHaveBeenCalledTimes(1)

    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    })
    fireEvent.change(input)
    expect(props.onAddFiles).toHaveBeenCalledWith([file])
  })

  it('handles model, agent mode, fork, and submit controls', () => {
    const { props } = renderToolbar()

    fireEvent.click(screen.getByRole('button', { name: /Claude Sonnet/i }))
    fireEvent.click(screen.getByRole('button', { name: /Build/i }))
    fireEvent.click(screen.getByTitle('Fork thread'))
    fireEvent.click(screen.getAllByRole('button').at(-1)!)

    expect(props.onToggleModelMenu).toHaveBeenCalledTimes(1)
    expect(props.onToggleAgentMode).toHaveBeenCalledTimes(1)
    expect(props.onFork).toHaveBeenCalledTimes(1)
    expect(props.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('opens the reasoning selector when a model exposes variants', () => {
    const reasoningButtonRef = createRef<HTMLButtonElement>()
    const onToggleReasoningMenu = vi.fn()

    renderToolbar({
      reasoningButtonRef,
      reasoningLabel: 'XHigh',
      showReasoningControl: true,
      onToggleReasoningMenu,
    })

    fireEvent.click(screen.getByRole('button', { name: /Think XHigh/i }))

    expect(onToggleReasoningMenu).toHaveBeenCalledTimes(1)
  })

  it('routes stop actions while generating', () => {
    const { props } = renderToolbar({ isGenerating: true })

    fireEvent.click(screen.getByTitle('Stop generating (Esc)'))
    fireEvent.click(screen.getAllByRole('button').at(-1)!)

    expect(props.onStop).toHaveBeenCalledTimes(2)
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('shows waiting states and disables submit when it cannot send', () => {
    renderToolbar({
      canSend: false,
      isAwaitingPermission: true,
      isAwaitingQuestion: true,
    })

    expect(screen.getByText('Awaiting approval')).toBeInTheDocument()
    expect(screen.getByText('Awaiting answer')).toBeInTheDocument()
    expect(screen.getAllByRole('button').at(-1)).toBeDisabled()
  })
})
