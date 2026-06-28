import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ElapsedClock } from './ElapsedClock'

describe('ElapsedClock', () => {
  it('renders nothing without a valid start timestamp', () => {
    const { container } = render(<ElapsedClock startedAt={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders finished durations with the default finished label', () => {
    render(
      <ElapsedClock
        startedAt="2026-05-09T12:00:00.000Z"
        finishedAt="2026-05-09T12:01:05.000Z"
      />,
    )

    expect(screen.getByText('ran 1m 5s')).toHaveAttribute('title', 'Task duration')
  })

  it('ticks while running and respects custom running labels', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-09T12:00:05.000Z'))

    render(
      <ElapsedClock
        startedAt="2026-05-09T12:00:00.000Z"
        labelWhileRunning="working"
      />,
    )

    expect(screen.getByText('working')).toHaveAttribute('title', 'Elapsed since the task started running')

    act(() => {
      vi.advanceTimersByTime(1_000)
      vi.setSystemTime(new Date('2026-05-09T12:00:06.000Z'))
    })

    expect(screen.getByText('working')).toBeInTheDocument()
  })
})
