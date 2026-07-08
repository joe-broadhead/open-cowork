import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatInputModelMenu } from './ChatInputModelMenu'

const anchorRect = {
  top: 500,
  bottom: 540,
  left: 120,
  right: 220,
  width: 100,
  height: 40,
  x: 120,
  y: 500,
  toJSON: () => ({}),
} as DOMRect

describe('ChatInputModelMenu', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 0
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('focuses short model lists so keyboard selection works', async () => {
    const onSelect = vi.fn()
    render(
      <ChatInputModelMenu
        visible
        anchorRect={anchorRect}
        models={[
          { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
          { id: 'openai/gpt-5', label: 'GPT-5' },
        ]}
        currentModel="anthropic/claude-sonnet-4"
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    )

    const menu = screen.getByRole('listbox', { name: 'Select model' })
    await waitFor(() => expect(menu).toHaveFocus())
    expect(menu).toHaveAttribute('aria-activedescendant', 'chat-model-menu-listbox-option-anthropic/claude-sonnet-4')

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(menu).toHaveAttribute('aria-activedescendant', 'chat-model-menu-listbox-option-openai/gpt-5')

    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('openai/gpt-5')
  })
})
