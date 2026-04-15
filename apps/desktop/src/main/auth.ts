import { OAuth2Client } from 'google-auth-library'
import crypto from 'crypto'
import { createServer } from 'http'
import electron from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AuthState } from '@open-cowork/shared'
import { log } from './logger.ts'
import { getUsableAccessToken } from './auth-utils.ts'
import { getAppConfig, getAppDataDir, resolveConfigEnvPlaceholders } from './config-loader.ts'

const { shell, app, safeStorage, BrowserWindow } = electron

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

function getGoogleOAuthConfig() {
  const config = getAppConfig()
  return config.auth.mode === 'google-oauth'
    ? resolveConfigEnvPlaceholders(config.auth.googleOAuth || null)
    : null
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
      saveTokens(updated)
      return credentials.access_token
    }
  } catch (err: any) {
    const errStr = String(err)
    log('auth', `Token refresh failed: ${errStr}`)
    if (errStr.includes('invalid_rapt') || errStr.includes('invalid_grant') || errStr.includes('Token has been expired')) {
      try {
        const win = BrowserWindow.getAllWindows()[0]
        if (win && !win.isDestroyed()) win.webContents.send('auth:expired')
      } catch {}
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
        } catch {}

        saveTokens({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expiry_date: tokens.expiry_date || Date.now() + 3600_000,
          email: email || undefined,
        })

        writeAdcFile(tokens.access_token, tokens.refresh_token)

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0"><div style="text-align:center"><h2>Signed in as ${email || 'user'}</h2><p>You can close this tab and return to Open Cowork.</p></div></body></html>`)
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

function writeAdcFile(accessToken: string, refreshToken: string) {
  const adcDir = getAppDataDir()
  mkdirSync(adcDir, { recursive: true })
  const adcPath = join(adcDir, 'application_default_credentials.json')
  const oauth = getGoogleOAuthConfig()
  if (!oauth?.clientId) return

  writeFileSync(adcPath, JSON.stringify({
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret || '',
    refresh_token: refreshToken,
    type: 'authorized_user',
    access_token: accessToken,
  }, null, 2))

  process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath
}
