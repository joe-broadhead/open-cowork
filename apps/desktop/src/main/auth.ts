import { OAuth2Client } from 'google-auth-library'
import crypto from 'crypto'
import { createServer } from 'http'
import electron from 'electron'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AuthState } from '@open-cowork/shared'
import { log } from './logger.ts'
import { getUsableAccessToken } from './auth-utils.ts'
import { getAppConfig, getAppDataDir, getBrandName } from './config-loader.ts'
import { writeFileAtomic } from './fs-atomic.ts'

const { shell, safeStorage, BrowserWindow } = electron

type StoredTokens = {
  access_token: string
  refresh_token: string
  expiry_date: number
  email?: string
}

const DEFAULT_GOOGLE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/cloud-platform',
]

let cachedClient: OAuth2Client | null = null

function getTokenPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'google-tokens.json')
}

// Atomic + 0o600. A mid-write crash would otherwise leave tokens.json /
// ADC truncated, which google-auth-library then fails to parse, forcing
// the user to re-authenticate. `writeFileAtomic` opens the temp file
// with the requested mode via `openSync(tempPath, 'w', mode)` and then
// rename(2)s over the target — the file is never visible to readers
// with the wrong mode, so a trailing `chmodSync` would only create a
// micro-window where mode might briefly differ. We rely on the
// openSync-with-mode path and skip the redundant chmod.
function writeSecureFile(path: string, content: string | Uint8Array) {
  const data = typeof content === 'string' ? content : Buffer.from(content)
  writeFileAtomic(path, data, { mode: 0o600 })
}

function getGoogleOAuthConfig() {
  const config = getAppConfig()
  return config.auth.mode === 'google-oauth' ? (config.auth.googleOAuth || null) : null
}

function getOAuth2Client() {
  const oauth = getGoogleOAuthConfig()
  if (!oauth?.clientId) {
    throw new Error('Google OAuth is not configured')
  }
  if (cachedClient) return cachedClient
  cachedClient = new OAuth2Client(oauth.clientId, oauth.clientSecret || '', 'http://127.0.0.1:0')
  return cachedClient
}

function loadTokens(): StoredTokens | null {
  const path = getTokenPath()
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path)
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const decrypted = safeStorage.decryptString(raw)
        return JSON.parse(decrypted)
      } catch {
        // Encryption is available but the on-disk blob can't be decrypted
        // (either corrupted or a legacy plaintext install from before
        // safeStorage wrapping was added). We intentionally do NOT fall
        // back to reading plaintext — keeping refresh tokens readable on
        // disk by any other process with user perms is exactly what the
        // encryption step is protecting against. Instead, wipe the file
        // and force re-auth; the next save will be encrypted.
        log('auth', `Could not decrypt stored tokens at ${path}; deleting and requiring re-authentication.`)
        try { rmSync(path, { force: true }) } catch { /* ignore */ }
        return null
      }
    }
    // safeStorage not available on this platform — plaintext is the only
    // option the OS gives us. File perms are still 0600 via writeSecureFile.
    return JSON.parse(raw.toString('utf-8'))
  } catch {
    return null
  }
}

function saveTokens(tokens: StoredTokens) {
  const json = JSON.stringify(tokens)
  if (safeStorage.isEncryptionAvailable()) {
    writeSecureFile(getTokenPath(), safeStorage.encryptString(json))
  } else {
    writeSecureFile(getTokenPath(), json)
  }
}

export function getAuthState(): AuthState {
  const config = getAppConfig()
  if (config.auth.mode === 'none') {
    return { authenticated: true, email: null }
  }

  const tokens = loadTokens()
  if (!tokens?.refresh_token) {
    return { authenticated: false, email: null }
  }

  return { authenticated: true, email: tokens.email || null }
}

export function getCachedAccessToken(): string | null {
  if (getAppConfig().auth.mode === 'none') return null
  return getUsableAccessToken(loadTokens())
}

export async function refreshAccessToken(): Promise<string | null> {
  if (getAppConfig().auth.mode === 'none') return null

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
      // Write ADC FIRST. If that fails (full disk, permissions
      // clobbered out-of-band), we bail before advancing the tokens
      // file — leaving the pair consistent with each other. The
      // alternative ordering (tokens first, ADC second) could leave
      // consumers that parse ADC directly (Vertex SDK, CLI helpers)
      // stuck on an access_token that google-tokens.json no longer
      // matches, producing hard-to-debug "401 expired credential"
      // errors hours later. Disk errors bubble up with a distinct
      // log prefix so support can tell a filesystem failure from an
      // actual OAuth problem.
      try {
        writeAdcFile(credentials.access_token, tokens.refresh_token)
      } catch (writeErr) {
        const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr)
        log('auth', `ADC write failed during token refresh (filesystem): ${writeMsg}`)
        // Keep the in-memory refresh success but don't advance
        // tokens.json either — next refresh will retry the whole
        // write pair from the same starting state.
        return credentials.access_token
      }
      saveTokens(updated)
      return credentials.access_token
    }
  } catch (err: any) {
    const errStr = String(err)
    log('auth', `Token refresh failed: ${errStr}`)
    if (errStr.includes('invalid_rapt') || errStr.includes('invalid_grant') || errStr.includes('Token has been expired')) {
      try {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('auth:expired')
          }
        }
      } catch {
        // Renderer notification is best-effort only.
      }
      return null
    }
  }

  return getUsableAccessToken(tokens)
}

export async function loginWithGoogle(): Promise<AuthState> {
  const config = getAppConfig()
  if (config.auth.mode === 'none') {
    return getAuthState()
  }

  const oauth = getGoogleOAuthConfig()
  if (!oauth?.clientId) {
    return { authenticated: false, email: null }
  }

  return new Promise((resolve) => {
    const client = new OAuth2Client(oauth.clientId, oauth.clientSecret || '', '')
    const oauthState = crypto.randomUUID()
    const scopes = oauth.scopes?.length ? oauth.scopes : DEFAULT_GOOGLE_SCOPES

    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '', 'http://127.0.0.1')
        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')

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

        const redirectUri = `http://127.0.0.1:${(server.address() as any).port}`
        ;(client as any)._redirectUri = redirectUri
        const { tokens } = await client.getToken({ code, redirect_uri: redirectUri })

        if (!tokens.access_token || !tokens.refresh_token) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<html><body><h2>Login failed</h2><p>Could not obtain tokens.</p></body></html>')
          server.close()
          resolve({ authenticated: false, email: null })
          return
        }

        client.setCredentials(tokens)
        let email: string | null = null
        try {
          const userInfo = await client.request({ url: 'https://www.googleapis.com/oauth2/v2/userinfo' })
          email = (userInfo.data as any)?.email || null
        } catch {
          // Email lookup is optional for local auth state.
        }

        // Write ADC before the tokens file for the same reason
        // `refreshAccessToken` does: if the ADC write fails (disk
        // full, permissions clobbered), we bail before the tokens
        // file claims we're authenticated. An ADC-less "logged in"
        // state makes every downstream Google SDK look broken
        // without any clear signal why.
        writeAdcFile(tokens.access_token, tokens.refresh_token)
        saveTokens({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expiry_date: tokens.expiry_date || Date.now() + 3600_000,
          email: email || undefined,
        })

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0"><div style="text-align:center"><h2>Signed in as ${email || 'user'}</h2><p>You can close this tab and return to ${getBrandName()}.</p></div></body></html>`)
        server.close()
        resolve({ authenticated: true, email })
      } catch (err: any) {
        log('auth', `Login error: ${err?.message}`)
        res.writeHead(500, { 'Content-Type': 'text/html' })
        res.end(`<html><body><h2>Login error</h2><p>${err?.message}</p></body></html>`)
        server.close()
        resolve({ authenticated: false, email: null })
      }
    })

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port
      const redirectUri = `http://127.0.0.1:${port}`
      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        redirect_uri: redirectUri,
        prompt: 'consent',
        state: oauthState,
      })
      shell.openExternal(authUrl)
    })

    setTimeout(() => {
      server.close()
      resolve({ authenticated: false, email: null })
    }, 120_000)
  })
}

function getAdcPath() {
  return join(getAppDataDir(), 'application_default_credentials.json')
}

// Returns the filesystem path to the Application Default Credentials file
// IF the user is authenticated via Google OAuth and a token has been
// written. Returns null otherwise. Used by the MCP spawn layer to inject
// `GOOGLE_APPLICATION_CREDENTIALS` into subprocesses that have opted into
// Google auth reuse.
export function getAdcPathIfAvailable(): string | null {
  if (getAppConfig().auth.mode !== 'google-oauth') return null
  const path = getAdcPath()
  if (!existsSync(path)) return null
  return path
}

// Wipe every on-disk artifact that identifies the signed-in user and
// reset the cached OAuth2 client. Callers should reboot the runtime
// after this so any spawned MCPs lose the stale `GOOGLE_APPLICATION_
// CREDENTIALS` and `GOOGLE_WORKSPACE_CLI_TOKEN` env vars they captured
// at spawn time.
export async function logoutFromGoogle() {
  cachedClient = null
  for (const path of [getTokenPath(), getAdcPath()]) {
    try { rmSync(path, { force: true }) } catch { /* best-effort */ }
  }
  // Silence the 30-min refresh timer directly. `rebootRuntime` would
  // also clear it, but the caller may skip reboot (no active runtime)
  // or the reboot may fail partway — either way we don't want a dead
  // timer firing against a deleted tokens file.
  try {
    const { stopTokenRefreshTimer } = await import('./runtime.ts')
    stopTokenRefreshTimer()
  } catch {
    // runtime module may not be loaded in some test contexts.
  }
  log('auth', 'Google OAuth session cleared')
}

function writeAdcFile(accessToken: string, refreshToken: string) {
  mkdirSync(getAppDataDir(), { recursive: true })
  const adcPath = getAdcPath()
  const oauth = getGoogleOAuthConfig()
  if (!oauth?.clientId) return

  // This is Google's canonical "authorized_user" ADC format — the same
  // shape gcloud auth writes. client_id + client_secret + refresh_token
  // are ALL required for GCP SDKs (python, node, etc.) to pick the file
  // up. In the OAuth 2.0 desktop-app flow Google explicitly acknowledges
  // the client_secret is not confidential (it can't be, in a public
  // binary). The file is written with 0600 perms via `writeSecureFile`
  // so other OS users can't read it; that's the only confidentiality
  // boundary available here.
  writeSecureFile(adcPath, JSON.stringify({
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret || '',
    refresh_token: refreshToken,
    type: 'authorized_user',
    access_token: accessToken,
  }, null, 2))
}
