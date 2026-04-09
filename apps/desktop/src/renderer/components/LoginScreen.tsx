import { useState } from 'react'

export function LoginScreen({ onLoggedIn }: { onLoggedIn: (email: string) => void }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleLogin = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.cowork.auth.login()
      if (result.authenticated && result.email) {
        onLoggedIn(result.email)
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
        {/* Logo / title */}
        <div className="flex flex-col items-center gap-3">
          <div className="w-16 h-16 rounded-2xl bg-surface border border-border flex items-center justify-center">
            <span className="text-2xl font-bold text-accent">C</span>
          </div>
          <h1 className="text-xl font-semibold text-text">Cowork</h1>
          <p className="text-[13px] text-text-muted text-center">
            Sign in with your Google account to get started
          </p>
        </div>

        {/* Login button */}
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
          {!loading && (
            <svg width="18" height="18" viewBox="0 0 18 18">
              <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
              <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
              <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
              <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
            </svg>
          )}
          {loading ? 'Waiting for browser...' : 'Sign in with Google'}
        </button>

        {error && (
          <p className="text-[12px] text-red text-center">{error}</p>
        )}

        <p className="text-[11px] text-text-muted text-center">
          This will open your browser to authenticate with Google. All Google services (Vertex AI, Gmail, Sheets, Drive, Calendar) will use this login.
        </p>
      </div>
    </div>
  )
}
