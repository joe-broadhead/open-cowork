import { OAuth2Client } from 'google-auth-library'
import crypto from 'crypto'
import { createServer } from 'http'
import { shell, app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { log } from './logger'

// OAuth2 client config — using Google's "TV and Limited Input" device flow
// For a proper production app, register your own OAuth client in GCP console.
// For now, we use the same client ID that gcloud uses (well-known, works for desktop apps).
const CLIENT_ID = '1083931578587-r5bvv97a5rqj2mknmo8egrr6p474u9n7.apps.googleusercontent.com'
const CLIENT_SECRET = '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'

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/cloud-platform',
  // Google Workspace scopes — one per MCP
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/chat.spaces',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly',
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments',
]

function getTokenPath(): string {
  const dir = join(app.getPath('userData'), 'cowork')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'google-tokens.json')
}

interface StoredTokens {
  access_token: string
  refresh_token: string
  expiry_date: number
  email?: string
}

function loadTokens(): StoredTokens | null {
  const path = getTokenPath()
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path)
    // Try encrypted first, fall back to plaintext for migration
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const decrypted = safeStorage.decryptString(raw)
        return JSON.parse(decrypted)
      } catch {
        // Fallback: might be old plaintext format
        return JSON.parse(raw.toString('utf-8'))
      }
    }
    return JSON.parse(raw.toString('utf-8'))
  } catch {
    return null
  }
}

function saveTokens(tokens: StoredTokens) {
  const json = JSON.stringify(tokens)
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(getTokenPath(), safeStorage.encryptString(json))
  } else {
    writeFileSync(getTokenPath(), json)
  }
}

let cachedClient: OAuth2Client | null = null

function getOAuth2Client(): OAuth2Client {
  if (cachedClient) return cachedClient
  cachedClient = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, 'http://127.0.0.1:0')
  return cachedClient
}

// --- Auth state ---

export interface AuthState {
  authenticated: boolean
  email: string | null
}

export function getAuthState(): AuthState {
  const tokens = loadTokens()
  if (!tokens?.refresh_token) {
    return { authenticated: false, email: null }
  }
  return { authenticated: true, email: tokens.email || null }
}

// --- Get a fresh access token (for GWS CLI and ADC) ---

export function getCachedAccessToken(): string | null {
  const tokens = loadTokens()
  if (!tokens?.access_token) return null

  // If not expired, return cached
  if (tokens.expiry_date && Date.now() < tokens.expiry_date - 60_000) {
    return tokens.access_token
  }

  // Refresh
  if (tokens.refresh_token) {
    try {
      const client = getOAuth2Client()
      client.setCredentials({ refresh_token: tokens.refresh_token })
      // Synchronous isn't ideal but keeps it simple for env var setting
      return tokens.access_token // Return stale token, async refresh happens separately
    } catch {
      return tokens.access_token
    }
  }

  return tokens.access_token
}

/** Async token refresh — call periodically */
export async function refreshAccessToken(): Promise<string | null> {
  const tokens = loadTokens()
  if (!tokens?.refresh_token) return null

  try {
    const client = getOAuth2Client()
    client.setCredentials({ refresh_token: tokens.refresh_token })
    const { credentials } = await client.refreshAccessToken()

    if (credentials.access_token) {
      const updated: StoredTokens = {
        ...tokens,
        access_token: credentials.access_token,
        expiry_date: credentials.expiry_date || Date.now() + 3600_000,
      }
      saveTokens(updated)
      return credentials.access_token
    }
  } catch (err: any) {
    const errStr = String(err)
    log('auth', `Token refresh failed: ${errStr}`)

    // If RAPT/reauth error, the refresh token is permanently invalid
    // Need to trigger full re-login
    if (errStr.includes('invalid_rapt') || errStr.includes('invalid_grant') || errStr.includes('Token has been expired')) {
      log('auth', 'Refresh token expired — need re-login')
      // Notify via BrowserWindow if available
      try {
        const { BrowserWindow } = require('electron')
        const win = BrowserWindow.getAllWindows()[0]
        if (win && !win.isDestroyed()) {
          win.webContents.send('auth:expired')
        }
      } catch {}
      return null
    }
  }
  return tokens.access_token
}

// --- OAuth login flow ---

/**
 * Opens browser for Google OAuth consent, gets tokens via loopback redirect.
 * No gcloud or CLI tools required.
 */
export function loginWithGoogle(): Promise<AuthState> {
  return new Promise((resolve) => {
    const client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, '')
    const oauthState = crypto.randomUUID() // CSRF protection

    // Start a loopback HTTP server to receive the callback
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '', `http://127.0.0.1`)
        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')

        // Verify state to prevent CSRF
        if (returnedState !== oauthState) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<html><body><h2>Login failed</h2><p>Invalid state parameter.</p></body></html>')
          server.close()
          resolve({ authenticated: false, email: null })
          return
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<html><body><h2>Login failed</h2><p>No authorization code received.</p></body></html>')
          server.close()
          resolve({ authenticated: false, email: null })
          return
        }

        // Exchange code for tokens
        const redirectUri = `http://127.0.0.1:${(server.address() as any).port}`;
        (client as any)._redirectUri = redirectUri
        const { tokens } = await client.getToken({ code, redirect_uri: redirectUri })

        if (!tokens.access_token || !tokens.refresh_token) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<html><body><h2>Login failed</h2><p>Could not obtain tokens.</p></body></html>')
          server.close()
          resolve({ authenticated: false, email: null })
          return
        }

        // Get user email
        client.setCredentials(tokens)
        let email: string | null = null
        try {
          const res2 = await client.request({ url: 'https://www.googleapis.com/oauth2/v2/userinfo' })
          email = (res2.data as any)?.email || null
        } catch {}

        // Save tokens
        const stored: StoredTokens = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expiry_date: tokens.expiry_date || Date.now() + 3600_000,
          email: email || undefined,
        }
        saveTokens(stored)

        // Also write as ADC format for google-vertex provider
        writeAdcFile(tokens.access_token, tokens.refresh_token)

        log('auth', `Login succeeded as ${email}`)

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0"><div style="text-align:center"><h2>Signed in as ${email || 'user'}</h2><p>You can close this tab and return to Cowork.</p></div></body></html>`)
        server.close()
        resolve({ authenticated: true, email })
      } catch (err: any) {
        log('auth', `Login error: ${err.message}`)
        res.writeHead(500, { 'Content-Type': 'text/html' })
        res.end(`<html><body><h2>Login error</h2><p>${err.message}</p></body></html>`)
        server.close()
        resolve({ authenticated: false, email: null })
      }
    })

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port
      const redirectUri = `http://127.0.0.1:${port}`

      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        redirect_uri: redirectUri,
        prompt: 'consent',
        state: oauthState,
      })

      log('auth', `Opening browser for login (redirect: ${redirectUri})`)
      shell.openExternal(authUrl)
    })

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close()
      resolve({ authenticated: false, email: null })
    }, 120_000)
  })
}

/**
 * Write tokens in ADC format so google-vertex provider can use them.
 */
function writeAdcFile(accessToken: string, refreshToken: string) {
  // Write to Cowork-specific path, NOT the global gcloud ADC
  const adcDir = join(app.getPath('userData'), 'cowork')
  mkdirSync(adcDir, { recursive: true })
  const adcPath = join(adcDir, 'adc.json')
  // Set GOOGLE_APPLICATION_CREDENTIALS so google-vertex provider finds it
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath
  const adc = {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
    type: 'authorized_user',
  }
  writeFileSync(adcPath, JSON.stringify(adc, null, 2))
  log('auth', 'Wrote ADC file for google-vertex provider')
}
