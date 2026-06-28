import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LoadingScreen } from './LoadingScreen'

describe('LoadingScreen', () => {
  it('renders stage-specific startup copy', () => {
    const { rerender } = render(<LoadingScreen brandName="Open Cowork" stage="boot" />)
    expect(screen.getByText('Open Cowork')).toBeInTheDocument()
    expect(screen.getByText('Starting up...')).toBeInTheDocument()

    rerender(<LoadingScreen brandName="Open Cowork" stage="auth" />)
    expect(screen.getByText('Checking authentication...')).toBeInTheDocument()

    rerender(<LoadingScreen brandName="Open Cowork" stage="config" />)
    expect(screen.getByText('Loading workspace configuration...')).toBeInTheDocument()
  })

  it('progresses runtime loading copy as elapsed time grows', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-09T12:00:00.000Z'))

    render(<LoadingScreen brandName="Open Cowork" stage="runtime" />)
    expect(screen.getByText('Starting runtime...')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    expect(screen.getByText('Connecting to runtime...')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(6_000)
    })
    expect(screen.getByText('Almost there...')).toBeInTheDocument()
  })

  it('surfaces runtime configuration errors with recovery guidance', () => {
    render(
      <LoadingScreen
        brandName="Open Cowork"
        stage="runtime"
        errorMessage="Provider model is missing."
      />,
    )

    expect(screen.getByText('Runtime configuration needs attention.')).toBeInTheDocument()
    expect(screen.getByText('Open Cowork could not start the runtime')).toBeInTheDocument()
    expect(screen.getByText('Provider model is missing.')).toBeInTheDocument()
    expect(screen.getByText('Fix the invalid runtime or config input, then relaunch the app.')).toBeInTheDocument()
  })
})
