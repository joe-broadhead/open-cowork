import { useState } from 'react'

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
      const result = await window.openCowork.auth.login()
      if (result.authenticated) {
        onLoggedIn(result.email || '')
      } else {
        setError('Login was cancelled or failed. Please try again.')
      }
    } catch (err: any) {
      setError(err?.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen w-screen" style={{ background: 'var(--color-base)' }}>
      <div className="flex flex-col items-center gap-8 max-w-sm px-6">
        <div className="flex flex-col items-center gap-3">
          <div className="w-16 h-16 rounded-2xl bg-surface border border-border flex items-center justify-center">
            <span className="text-2xl font-bold text-accent">O</span>
          </div>
          <h1 className="text-xl font-semibold text-text">{brandName}</h1>
          <p className="text-[13px] text-text-muted text-center">
            Sign in to enable the configured authentication provider for this Open Cowork build.
          </p>
        </div>

        <button
          onClick={handleLogin}
          disabled={loading}
          className="w-full flex items-center justify-center gap-3 px-5 py-3 rounded-xl text-[14px] font-medium transition-colors cursor-pointer"
          style={{
            background: loading ? 'var(--color-surface-hover)' : '#fff',
            color: loading ? 'var(--color-text-muted)' : '#333',
            border: '1px solid var(--color-border)',
          }}
        >
          {loading ? 'Waiting for browser...' : 'Continue'}
        </button>

        {error ? <p className="text-[12px] text-red text-center">{error}</p> : null}
      </div>
    </div>
  )
}
