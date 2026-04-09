import { execFileSync } from 'child_process'

let cachedToken: string | null = null
let tokenExpiresAt = 0

/**
 * Get a Google Cloud access token using Application Default Credentials.
 * Uses `gcloud auth print-access-token` which works when the user is
 * already logged in via `gcloud auth login`.
 *
 * Tokens are cached and refreshed ~5 minutes before expiry.
 */
export function getAccessToken(): string | null {
  const now = Date.now()

  // Return cached token if still valid (with 5 min buffer)
  if (cachedToken && now < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken
  }

  try {
    const token = execFileSync('gcloud', ['auth', 'print-access-token'], {
      timeout: 10_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()

    if (token) {
      cachedToken = token
      // Google access tokens are valid for 1 hour
      tokenExpiresAt = now + 55 * 60 * 1000
      return token
    }
  } catch (err) {
    console.error('[vertex-auth] Failed to get access token:', err)
  }

  return cachedToken // Return stale token as last resort
}

/**
 * Start a background timer to keep the token fresh.
 * Refreshes every 50 minutes.
 */
export function startTokenRefresh(): NodeJS.Timeout {
  // Get initial token
  getAccessToken()

  return setInterval(() => {
    const t = getAccessToken()
    if (t) process.env.GOOGLE_ACCESS_TOKEN = `Bearer ${t}`
  }, 50 * 60 * 1000)
}
