import { Component, type ErrorInfo, type ReactNode } from 'react'
import { getBrandName } from '../../helpers/brand'
import { t } from '../../helpers/i18n'
import { Button } from '../ui'

interface ViewErrorBoundaryProps {
  children: ReactNode
  resetKey: string
  onBackHome: () => void
  title?: string
  body?: string
  actionLabel?: string
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
    // Forward to the main process so render panics land in the sanitized
    // diagnostics bundle. Fails silently in tests where coworkApi is
    // unavailable; the console.error above still captures the panic.
    try {
      const api = (window as unknown as { coworkApi?: { diagnostics?: { reportRendererError?: (payload: { message: string; stack?: string; componentStack?: string; view?: string }) => void } } }).coworkApi
      api?.diagnostics?.reportRendererError?.({
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack || undefined,
        view: this.props.resetKey,
      })
    } catch {
      /* diagnostics reporting must never throw */
    }
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
          <div className="text-2xs font-semibold uppercase tracking-[0.08em] text-text-muted mb-2">{t('error.viewError', 'View Error')}</div>
          <h2 className="text-xl font-semibold text-text mb-2">{this.props.title || t('error.viewErrorTitle', 'This page failed to render.')}</h2>
          <p className="text-sm text-text-secondary leading-relaxed mb-5">
            {this.props.body || t('error.viewErrorBody', '{{brandName}} recovered the rest of the app. Go back home and try again.', { brandName: getBrandName() })}
          </p>
          <Button variant="primary" onClick={this.props.onBackHome}>
            {this.props.actionLabel || t('error.backToHome', 'Back to home')}
          </Button>
        </div>
      </div>
    )
  }
}
