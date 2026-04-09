import { execFile, execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { log } from './logger'

// All Google scopes we need in one place
const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
]

function getAdcPath(): string {
  const home = process.env.HOME || ''
  return join(home, '.config', 'gcloud', 'application_default_credentials.json')
}

/**
 * Check if Application Default Credentials exist and have a refresh token.
 */
export function hasValidAdc(): boolean {
  const adcPath = getAdcPath()
  if (!existsSync(adcPath)) return false
  try {
    const content = JSON.parse(readFileSync(adcPath, 'utf-8'))
    return !!content.client_id && !!content.refresh_token
  } catch {
    return false
  }
}

/**
 * Get the user's email from gcloud.
 */
export function getAuthEmail(): string | null {
  try {
    const email = execFileSync('gcloud', ['config', 'get-value', 'account'], {
      timeout: 5_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return email && email !== '(unset)' ? email : null
  } catch {
    return null
  }
}

/**
 * Get an access token from ADC for the GWS CLI.
 */
export function getAccessTokenForGws(): string | null {
  try {
    return execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], {
      timeout: 10_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null
  } catch {
    return null
  }
}

/**
 * Trigger Google login with all required scopes.
 * Opens the user's browser. Returns a promise that resolves when auth completes.
 */
export function triggerGoogleLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    log('auth', 'Triggering Google login with scopes: ' + SCOPES.join(', '))

    const child = execFile(
      'gcloud',
      [
        'auth', 'application-default', 'login',
        '--scopes=' + SCOPES.join(','),
        '--quiet',
      ],
      { timeout: 120_000 },
      (err) => {
        if (err) {
          log('auth', `Login failed: ${err.message}`)
          resolve(false)
        } else {
          log('auth', 'Login succeeded')
          resolve(true)
        }
      },
    )

    child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) log('auth', `gcloud: ${msg}`)
    })
  })
}
