import electron from 'electron'
import type { IpcHandlerContext } from './context.ts'
import { objectArg, registerIpcInvoke } from './schema.ts'
import {
  ensureRuntimeAfterAuthLogin,
  MAX_CLIPBOARD_TEXT_LENGTH,
  MAX_SAVE_TEXT_BYTES,
  MAX_SAVE_TEXT_FILENAME_BYTES,
  normalizeBoundedString,
  normalizeCredentialScopeId,
  resolveSafeSaveTextPath,
} from './app-handler-support.ts'
import { getPublicAppConfigWithRuntimeModels, registerProviderHandlers } from './provider-handlers.ts'
import {
  getEffectiveSettings,
  getIntegrationCredentials,
  getProviderCredentials,
  maskEffectiveSettingsCredentials,
  saveSettings,
  isSetupComplete,
  type CoworkSettings,
} from '../settings.ts'
import { getClient, getModelInfoAsync } from '../runtime.ts'
import { getConfigError } from '../config-loader.ts'
import { buildDiagnosticsBundle } from '../diagnostics-export.ts'
import { getRuntimeStatus } from '../runtime-status.ts'
import { getPerfSnapshot } from '../perf-metrics.ts'
import { log } from '../logger.ts'
import { getRuntimeInputDiagnostics } from '../runtime-input-diagnostics.ts'
import { renderChartSpecToSvg } from '../chart-renderer.ts'
import { saveChartArtifact } from '../chart-artifacts.ts'
import { isKnownChartArtifactToolCall } from '../chart-artifact-access.ts'
import { sessionEngine } from '../session-engine.ts'
import { checkForUpdates } from '../update-check.ts'
import {
  checkInstallableUpdate,
  downloadInstallableUpdate,
  getUpdateInstallCapability,
  quitAndInstallUpdate,
  subscribeUpdateInstallEvents,
} from '../update-service.ts'
import { resetAppData } from '../app-reset.ts'
import { readFileCheckedSync, readTextFileCheckedSync } from '../fs-read.ts'
import { writeFileAtomic } from '../fs-atomic.ts'
import type {
  ChartSaveArtifactRequest,
  DestructiveConfirmationRequest,
} from '@open-cowork/shared'

export {
  ensureRuntimeAfterAuthLogin,
  mergeRuntimeProviderModels,
  resolveSafeSaveTextPath,
} from './app-handler-support.ts'

async function loadAuthModule() {
  return import('../auth.ts')
}

const electronShell = (electron as { shell?: typeof import('electron').shell }).shell
const electronClipboard = (electron as { clipboard?: typeof import('electron').clipboard }).clipboard
const electronApp = (electron as { app?: typeof import('electron').app }).app

export function saveTextExportFile(filePath: string, content: string) {
  writeFileAtomic(filePath, content, { mode: 0o600 })
}

export function registerAppHandlers(context: IpcHandlerContext) {
  subscribeUpdateInstallEvents((event) => {
    const win = context.getMainWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send('updates:install-event', event)
  })

  context.ipcMain.handle('app:metadata', async () => {
    const version = electronApp?.getVersion?.() || '0.0.0'
    return {
      version,
      preview: version.startsWith('0.'),
    }
  })

  context.ipcMain.handle('auth:status', async () => {
    const { getAuthState } = await loadAuthModule()
    return getAuthState()
  })

  context.ipcMain.handle('auth:login', async () => {
    const { loginWithGoogle } = await loadAuthModule()
    const { bootRuntime, rebootRuntime } = await import('../index.ts')

    log('auth', 'User initiated login')
    const state = await loginWithGoogle()
    if (state.authenticated && isSetupComplete()) {
      log('auth', 'Login completed')
      await ensureRuntimeAfterAuthLogin({
        authenticated: state.authenticated,
        setupComplete: isSetupComplete(),
        hasActiveRuntime: Boolean(getClient()),
        bootRuntime,
        rebootRuntime,
      })
    }
    return state
  })

  context.ipcMain.handle('auth:logout', async () => {
    const { logoutFromGoogle, getAuthState } = await loadAuthModule()
    log('auth', 'User initiated logout')
    await logoutFromGoogle()
    // Reboot so any spawned MCPs drop their captured ADC path +
    // GOOGLE_WORKSPACE_CLI_TOKEN env and come back up authenticated-as-
    // nothing. Without a reboot, a live Sheets MCP subprocess would keep
    // operating with the previous user's credentials until the next
    // restart — a real privacy surprise if two people share a laptop.
    const activeClient = getClient()
    if (activeClient) {
      const { rebootRuntime } = await import('../index.ts')
      await rebootRuntime()
    }
    const state = getAuthState()
    // Broadcast so every renderer window (not just the one that invoked
    // logout) can drop session-specific UI. Without this, a second
    // window would still show "Signed in as X" until its next
    // `auth:status` poll.
    const { BrowserWindow } = await import('electron')
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('auth:logout', state)
      }
    }
    return state
  })

  context.ipcMain.handle('clipboard:write-text', async (_event, textInput: unknown) => {
    if (typeof textInput !== 'string') return false
    if (!textInput || textInput.length > MAX_CLIPBOARD_TEXT_LENGTH) return false
    if (!electronClipboard) return false
    try {
      electronClipboard.writeText(textInput)
      return true
    } catch (err) {
      log('clipboard', `Failed to write clipboard text: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  })

  context.ipcMain.handle('app:config', async () => {
    return getPublicAppConfigWithRuntimeModels()
  })

  context.ipcMain.handle('app:runtime-inputs', async () => {
    return getRuntimeInputDiagnostics()
  })

  context.ipcMain.handle('app:export-diagnostics', async () => {
    try {
      return buildDiagnosticsBundle()
    } catch (err) {
      context.logHandlerError('app:export-diagnostics', err)
      return null
    }
  })

  registerProviderHandlers(context, electronShell)

  context.ipcMain.handle('settings:get', async () => {
    // Default surface returns credentials masked so the raw API keys
    // don't live in the renderer heap / DevTools for every consumer that
    // only needs provider ids + model ids + feature flags.
    return maskEffectiveSettingsCredentials(getEffectiveSettings())
  })

  context.ipcMain.handle('settings:get-provider-credentials', async (_event, providerId: unknown) => {
    // Scoped opt-in for provider credential editor surfaces. Avoid
    // returning every stored provider and integration secret to any
    // renderer code that only needs one credential bag.
    return getProviderCredentials(normalizeCredentialScopeId(providerId, 'Provider'))
  })

  context.ipcMain.handle('settings:get-integration-credentials', async (_event, integrationId: unknown) => {
    // Same scoped read for integration/MCP credential editors.
    return getIntegrationCredentials(normalizeCredentialScopeId(integrationId, 'Integration'))
  })

  registerIpcInvoke(context, 'settings:set', objectArg<Partial<CoworkSettings>>('settings update'), async (_event, updates) => {
    const result = saveSettings(updates)
    const runtimeSensitiveUpdate = Boolean(
      updates.selectedProviderId !== undefined
      || updates.selectedModelId !== undefined
      || updates.providerCredentials !== undefined
      || updates.integrationCredentials !== undefined
      || updates.integrationEnabled !== undefined
      || updates.enableBash !== undefined
      || updates.enableFileWrite !== undefined
      || updates.runtimeConfigSource !== undefined
      || updates.runtimeToolingBridgeEnabled !== undefined
    )

    if (isSetupComplete(result)) {
      const activeClient = getClient()
      if (activeClient && runtimeSensitiveUpdate) {
        const { rebootRuntime } = await import('../index.ts')
        await rebootRuntime()
      } else if (!activeClient) {
        const { bootRuntime } = await import('../index.ts')
        await bootRuntime()
      }
    }

    return maskEffectiveSettingsCredentials(result)
  })

  context.ipcMain.handle('model:info', async () => {
    return getModelInfoAsync()
  })

  context.ipcMain.handle('runtime:status', async () => {
    const status = getRuntimeStatus()
    return {
      ...status,
      error: status.error || getConfigError(),
    }
  })

  // User-initiated runtime restart, reachable from the offline
  // banner's "Try again" button. rebootRuntime is already a singleton,
  // so concurrent clicks coalesce. Returns the post-reboot status so
  // the renderer can hide the banner without a second round-trip.
  context.ipcMain.handle('runtime:restart', async () => {
    const { rebootRuntime } = await import('../index.ts')
    try {
      await rebootRuntime()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('error', `runtime:restart failed: ${message}`)
    }
    const status = getRuntimeStatus()
    return {
      ...status,
      error: status.error || getConfigError(),
    }
  })

  context.ipcMain.handle('diagnostics:perf', async () => {
    return getPerfSnapshot()
  })

  context.ipcMain.handle('dialog:select-directory', async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Project Directory',
    })
    if (result.canceled || !result.filePaths[0]) return null
    return context.grantProjectDirectory(result.filePaths[0])
  })

  // Image picker for custom agent avatars. Returns raw bytes so the
  // renderer can downsample + re-encode before persisting. Capped at
  // 8 MB to keep the IPC buffer sane — the renderer further caps the
  // final data URI to ~80 KB after downsampling. MIME is inferred from
  // the filter that matched; gif frames will render statically (first
  // frame) once the renderer draws them to a canvas.
  context.ipcMain.handle('dialog:select-image', async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: 'Choose agent avatar',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]!
    try {
      const MAX_BYTES = 8 * 1024 * 1024
      const { bytes } = readFileCheckedSync(path, { maxBytes: MAX_BYTES })
      const ext = path.toLowerCase().split('.').pop() || ''
      const mime = ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'gif'
            ? 'image/gif'
            : 'image/png'
      return { mime, base64: bytes.toString('base64') }
    } catch (err) {
      log('error', `dialog:select-image read failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  })

  // Open a JSON file and return its parsed contents. Used by "Import
  // agent" so the renderer can preview + validate before committing. 2 MB
  // cap is orders of magnitude more than any real agent bundle and keeps
  // pathological JSON out of the renderer heap.
  context.ipcMain.handle('dialog:open-json', async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: 'Open file',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]!
    try {
      const MAX_BYTES = 2 * 1024 * 1024
      const { content: raw } = readTextFileCheckedSync(path, { maxBytes: MAX_BYTES })
      const content = JSON.parse(raw)
      const filename = path.split(/[\\/]/).pop() || 'file.json'
      return { content, filename }
    } catch (err) {
      log('error', `dialog:open-json failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  })

  // Save text to disk via the system save dialog. Used by "Export
  // agent" to emit a portable `.cowork-agent.json` bundle. The renderer
  // owns the content; we just handle the OS-level write.
  context.ipcMain.handle('dialog:save-text', async (_event, defaultFilename: unknown, content: unknown) => {
    const safeDefaultFilename = normalizeBoundedString(defaultFilename, 'Default filename', MAX_SAVE_TEXT_FILENAME_BYTES).trim()
    if (!safeDefaultFilename) throw new Error('Default filename is required.')
    const safeContent = normalizeBoundedString(content, 'Save content', MAX_SAVE_TEXT_BYTES)
    const { dialog } = await import('electron')
    const result = await dialog.showSaveDialog({
      title: 'Save file',
      defaultPath: safeDefaultFilename,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return null
    const safeFilePath = resolveSafeSaveTextPath(result.filePath)
    try {
      saveTextExportFile(safeFilePath, safeContent)
      return safeFilePath
    } catch (err) {
      log('error', `dialog:save-text write failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  })

  registerIpcInvoke(context, 'chart:render-svg', objectArg<Record<string, unknown>>('chart specification'), async (_event, spec) => {
    return renderChartSpecToSvg(spec)
  })

  registerIpcInvoke(context, 'chart:save-artifact', objectArg<ChartSaveArtifactRequest>('chart artifact request'), async (_event, request) => {
    const sessionRecord = context.ensureSessionRecord(request.sessionId)
    if (!sessionRecord) {
      throw new Error('Chart artifact save requires an existing session.')
    }
    const sessionView = sessionEngine.getSessionView(request.sessionId)
    if (!isKnownChartArtifactToolCall(sessionView, request)) {
      throw new Error('Chart artifact save requires a known chart tool call for this session.')
    }
    return saveChartArtifact(request)
  })

  // In-app update discovery. Downstream forks with non-GitHub release
  // hosts will get `{ status: 'disabled' }` and the renderer just
  // doesn't surface a "new version" hint — no false positives.
  context.ipcMain.handle('app:check-updates', async () => {
    return checkForUpdates()
  })

  context.ipcMain.handle('updates:install-capability', async () => {
    return getUpdateInstallCapability()
  })

  context.ipcMain.handle('updates:check-installable', async () => {
    return checkInstallableUpdate()
  })

  context.ipcMain.handle('updates:download', async () => {
    return downloadInstallableUpdate()
  })

  context.ipcMain.handle('updates:quit-and-install', async () => {
    return quitAndInstallUpdate()
  })

  // App-wide reset. Behind a destructive confirmation so a compromised
  // renderer can't wipe the user's data without an explicit two-step
  // confirmation flow. Relaunch-on-complete lives inside resetAppData.
  context.ipcMain.handle('app:reset', async (_event, confirmationToken?: string | null) => {
    const request: DestructiveConfirmationRequest = { action: 'app.reset' }
    if (!context.consumeDestructiveConfirmation(request, confirmationToken)) {
      throw new Error('Confirmation required before resetting app data.')
    }
    log('audit', 'app.reset confirmed — wiping user-data and sandbox workspaces')
    return resetAppData()
  })

  // Renderer-side panic reports. One-way (ipcMain.on, not .handle) so
  // the renderer doesn't block waiting for a reply from inside its
  // error boundary. The logger sanitizer runs on every log line, so
  // this feeds the existing diagnostics bundle without a separate path.
  //
  // Two defenses against a compromised renderer using this channel as
  // a DoS vector:
  //   1. Per-field length caps so a megabyte stack trace can't inflate
  //      the log by itself.
  //   2. A simple per-minute rate limit. Ten panics per minute is
  //      already a bug; a hundred is someone gaming the channel.
  const FIELD_CAP = 8 * 1024     // 8 KB each — plenty for a real stack
  const WINDOW_MS = 60 * 1000
  const RATE_LIMIT_PER_WINDOW = 30
  let windowStart = 0
  let windowCount = 0
  const truncate = (value: string | undefined, cap: number) => {
    if (typeof value !== 'string') return ''
    if (value.length <= cap) return value
    return value.slice(0, cap) + `…[truncated ${value.length - cap} bytes]`
  }
  context.ipcMain.on('diagnostics:renderer-error', (_event, payload: { message?: string; stack?: string; componentStack?: string; view?: string }) => {
    try {
      const now = Date.now()
      if (now - windowStart > WINDOW_MS) {
        windowStart = now
        windowCount = 0
      }
      windowCount += 1
      if (windowCount > RATE_LIMIT_PER_WINDOW) {
        // Log once per window when the cap is hit so operators can
        // see the rate-limiting happened without being deluged.
        if (windowCount === RATE_LIMIT_PER_WINDOW + 1) {
          log('error', `Renderer error flood: suppressing further reports for this window`)
        }
        return
      }

      const message = truncate(payload?.message, 512) || 'renderer render failure'
      const view = payload?.view ? ` view=${truncate(payload.view, 64)}` : ''
      const stackLine = payload?.stack ? `\nstack: ${truncate(payload.stack, FIELD_CAP)}` : ''
      const componentLine = payload?.componentStack ? `\ncomponent: ${truncate(payload.componentStack, FIELD_CAP)}` : ''
      log('error', `Renderer error${view}: ${message}${stackLine}${componentLine}`)
    } catch (err) {
      log('error', `Renderer error report failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}
