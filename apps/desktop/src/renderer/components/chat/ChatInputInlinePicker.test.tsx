import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatInputInlinePicker } from './ChatInputInlinePicker'
import type { InlinePickerState, MentionableAgent } from './chat-input-types'

const picker: InlinePickerState = {
  trigger: '@',
  query: 'ana',
  start: 0,
  end: 4,
  selectedIndex: 1,
}

const suggestions: MentionableAgent[] = [
  {
    id: 'explore',
    label: 'Explore',
    description: 'Reads code and explains structure.',
  },
  {
    id: 'analyst',
    label: 'Analyst',
    description: 'Investigates data and summarizes insights with enough detail to be compacted.',
  },
]

describe('ChatInputInlinePicker', () => {
  it('renders nothing when the picker is inactive', () => {
    const { container } = render(
      <ChatInputInlinePicker
        picker={null}
        suggestions={suggestions}
        pickerRef={createRef<HTMLDivElement>()}
        left={100}
        top={300}
        onSelect={vi.fn()}
      />,
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('renders agent suggestions and reports selection', () => {
    const onSelect = vi.fn()
    render(
      <ChatInputInlinePicker
        picker={picker}
        suggestions={suggestions}
        pickerRef={createRef<HTMLDivElement>()}
        left={100}
        top={300}
        onSelect={onSelect}
      />,
    )

    expect(screen.getByText('Coworkers')).toBeInTheDocument()
    expect(screen.getByText('Explore')).toBeInTheDocument()
    expect(screen.getByText('@analyst')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Analyst/i }))
    expect(onSelect).toHaveBeenCalledWith(suggestions[1])
  })

  it('clamps the menu position inside the viewport and shows empty state', () => {
    const { container } = render(
      <ChatInputInlinePicker
        picker={{ ...picker, query: 'missing' }}
        suggestions={[]}
        pickerRef={createRef<HTMLDivElement>()}
        left={10_000}
        top={80}
        onSelect={vi.fn()}
      />,
    )

    const menu = container.firstElementChild as HTMLElement
    expect(menu.style.left).toBe('752px')
    expect(screen.getByText('No agents match “missing”.')).toBeInTheDocument()
  })
})
