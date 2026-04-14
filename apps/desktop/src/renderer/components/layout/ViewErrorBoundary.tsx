import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ViewErrorBoundaryProps {
  children: ReactNode
  resetKey: string
  onBackHome: () => void
}

interface ViewErrorBoundaryState {
  hasError: boolean
}

export class ViewErrorBoundary extends Component<ViewErrorBoundaryProps, ViewErrorBoundaryState> {
  state: ViewErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ViewErrorBoundary] View render failed:', error, errorInfo)
  }

  componentDidUpdate(prevProps: ViewErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false })
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="flex-1 flex items-center justify-center px-8">
        <div className="max-w-[420px] w-full rounded-2xl border border-border-subtle bg-surface p-6 text-center">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-2">View Error</div>
          <h2 className="text-[18px] font-semibold text-text mb-2">This page failed to render.</h2>
          <p className="text-[13px] text-text-secondary leading-relaxed mb-5">
            Open Cowork recovered the rest of the app. Go back home and try again.
          </p>
          <button
            onClick={this.props.onBackHome}
            className="px-4 py-2 rounded-lg text-[13px] font-medium cursor-pointer transition-colors"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}
          >
            Back to home
          </button>
        </div>
      </div>
    )
  }
}
