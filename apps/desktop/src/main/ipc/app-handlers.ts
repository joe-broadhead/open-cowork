import type { IpcHandlerContext } from './context.ts'
import { getEffectiveSettings, maskEffectiveSettingsCredentials, saveSettings, isSetupComplete, type CoworkSettings } from '../settings.ts'
import { getClient, getModelInfo } from '../runtime.ts'
import { normalizeProviderListResponse } from '../provider-utils.ts'
import { getConfigError, getProviderDynamicCatalog, getPublicAppConfig, invalidatePublicConfigCache } from '../config-loader.ts'
import { refreshProviderCatalog } from '../provider-catalog.ts'
import { buildDiagnosticsBundle } from '../diagnostics-export.ts'
import { getRuntimeStatus } from '../runtime-status.ts'
import { getPerfSnapshot } from '../perf-metrics.ts'
import { log } from '../logger.ts'
import { getDashboardSummary } from '../dashboard-summary.ts'
import { getRuntimeInputDiagnostics } from '../runtime-input-diagnostics.ts'
import { renderChartSpecToSvg } from '../chart-renderer.ts'

async function loadAuthModule() {
  return import('../auth.ts')
}

export function registerAppHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('auth:status', async () => {
    const { getAuthState } = await loadAuthModule()
    return getAuthState()
  })

  context.ipcMain.handle('auth:login', async () => {
    const { loginWithGoogle } = await loadAuthModule()
    const { bootRuntime } = await import('../index.ts')

    log('auth', 'User initiated login')
    const state = await loginWithGoogle()
    if (state.authenticated && isSetupComplete()) {
      log('auth', 'Login completed')
      await bootRuntime()
    }
    return state
  })

  context.ipcMain.handle('app:config', async () => {
    return getPublicAppConfig()
  })

  context.ipcMain.handle('app:dashboard-summary', async (_event, range) => {
    return getDashboardSummary(range)
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

  context.ipcMain.handle('app:refresh-provider-catalog', async (_event, providerId: string) => {
    const catalog = getProviderDynamicCatalog(providerId)
    if (!catalog) return []
    try {
      const models = await refreshProviderCatalog(providerId, catalog)
      invalidatePublicConfigCache()
      return models
    } catch (err) {
      context.logHandlerError(`app:refresh-provider-catalog ${providerId}`, err)
      return []
    }
  })

  context.ipcMain.handle('settings:get', async () => {
    // Default surface returns credentials masked so the raw API keys
    // don't live in the renderer heap / DevTools for every consumer that
    // only needs provider ids + model ids + feature flags.
    return maskEffectiveSettingsCredentials(getEffectiveSettings())
  })

  context.ipcMain.handle('settings:get-with-credentials', async () => {
    // Explicit opt-in for the credential editor surfaces (SetupScreen,
    // SettingsPanel → Models tab) that need the real values to prefill
    // their forms. Any other caller should use `settings:get`.
    return getEffectiveSettings()
  })

  context.ipcMain.handle('settings:set', async (_event, updates: Partial<CoworkSettings>) => {
    const result = saveSettings(updates)
    const runtimeSensitiveUpdate = Boolean(
      updates.selectedProviderId !== undefined
      || updates.selectedModelId !== undefined
      || updates.providerCredentials !== undefined
      || updates.integrationCredentials !== undefined
      || updates.enableBash !== undefined
      || updates.enableFileWrite !== undefined,
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

    return result
  })

  context.ipcMain.handle('model:info', async () => {
    return getModelInfo()
  })

  context.ipcMain.handle('provider:list', async () => {
    const client = getClient()
    if (!client) return []
    try {
      const result = await client.provider.list()
      const data = normalizeProviderListResponse(result.data)
      log('provider', `Listed ${data.length} providers: ${data.map((provider) => `${provider.id || provider.name}(${Object.keys(provider.models || {}).length} models)`).join(', ')}`)
      return data
    } catch (err) {
      context.logHandlerError('provider:list', err)
      return []
    }
  })

  context.ipcMain.handle('runtime:status', async () => {
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
    return result.canceled ? null : result.filePaths[0]
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
      const fs = await import('fs')
      const stats = fs.statSync(path)
      const MAX_BYTES = 8 * 1024 * 1024
      if (stats.size > MAX_BYTES) {
        log('error', `dialog:select-image rejected ${stats.size}B — over ${MAX_BYTES}B cap`)
        return null
      }
      const buffer = fs.readFileSync(path)
      const ext = path.toLowerCase().split('.').pop() || ''
      const mime = ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'gif'
            ? 'image/gif'
            : 'image/png'
      return { mime, base64: buffer.toString('base64') }
    } catch (err) {
      log('error', `dialog:select-image read failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  })

  context.ipcMain.handle('chart:render-svg', async (_event, spec: Record<string, unknown>) => {
    return renderChartSpecToSvg(spec)
  })
}
