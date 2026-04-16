import type { IpcHandlerContext } from './context.ts'
import { getEffectiveSettings, saveSettings, isSetupComplete, type CoworkSettings } from '../settings.ts'
import { getClient, getModelInfo } from '../runtime.ts'
import { normalizeProviderListResponse } from '../provider-utils.ts'
import { getConfigError, getProviderDynamicCatalog, getPublicAppConfig, invalidatePublicConfigCache } from '../config-loader.ts'
import { refreshProviderCatalog } from '../provider-catalog.ts'
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

  context.ipcMain.handle('chart:render-svg', async (_event, spec: Record<string, unknown>) => {
    return renderChartSpecToSvg(spec)
  })
}
