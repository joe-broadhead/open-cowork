import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { InstructionsTab } from './InstructionsTab'

describe('InstructionsTab', () => {
  it('edits instructions and reports character count', () => {
    const onChange = vi.fn()
    render(<InstructionsTab value="Existing guidance" onChange={onChange} />)

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Updated guidance' },
    })

    expect(onChange).toHaveBeenCalledWith('Updated guidance')
    expect(screen.getByText('17 chars')).toBeInTheDocument()
  })

  it('prepends selected starter snippets', () => {
    const onChange = vi.fn()
    render(<InstructionsTab value="Existing guidance" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: '+ Snippet' }))
    fireEvent.click(screen.getByRole('button', { name: /Be concise/i }))

    expect(onChange).toHaveBeenCalledWith(expect.stringContaining('Existing guidance'))
    expect(onChange.mock.calls[0][0]).toMatch(/^Answer in 3/)
  })

  it('switches between edit and markdown preview states', () => {
    render(<InstructionsTab value="# Analyst\n\n- Check sources" onChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByText(/Analyst/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('Analyst')
  })

  it('hides snippets in read-only mode and warns on long prompts', () => {
    render(<InstructionsTab value={'x'.repeat(2001)} onChange={vi.fn()} readOnly />)

    expect(screen.queryByRole('button', { name: '+ Snippet' })).not.toBeInTheDocument()
    expect(screen.getByText('Long prompts burn tokens — consider trimming')).toBeInTheDocument()
  })
})
