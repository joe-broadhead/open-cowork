import { useState } from 'react'
import { t } from '../helpers/i18n'
import { BrandMark } from './BrandMark'
import { Button } from './ui'

export function LoginScreen({
  brandName,
  onLoggedIn,
}: {
  brandName: string
  onLoggedIn: (email: string) => void
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleLogin = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.coworkApi.auth.login()
      if (result.authenticated) {
        onLoggedIn(result.email || '')
      } else {
        setError(t('login.failed', 'Login was cancelled or failed. Please try again.'))
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('login.failed', 'Login failed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen w-screen" style={{ background: 'var(--color-base)' }}>
      <div className="flex flex-col items-center gap-8 max-w-sm px-6">
        <div className="flex flex-col items-center gap-3">
          <BrandMark name={brandName} size="md" showName headingName />
          <p className="text-sm text-text-muted text-center">
            {t('login.welcome', 'Sign in to enable the configured authentication provider for this {{brandName}} build.', { brandName })}
          </p>
        </div>

        <Button
          variant="primary"
          fullWidth
          loading={loading}
          onClick={() => void handleLogin()}
        >
          {loading ? t('common.loading', 'Waiting for browser...') : t('common.continue', 'Continue')}
        </Button>

        {error ? <p className="text-xs text-red text-center">{error}</p> : null}
      </div>
    </div>
  )
}
