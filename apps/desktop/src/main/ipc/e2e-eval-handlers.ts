import type { BrowserWindow, IpcMain } from 'electron'
import type { PermissionRequest } from '@open-cowork/shared'

// E2E-only IPC for desktop UI evals (OPEN_COWORK_E2E=1).
//
// ContextBridge freezes `window.coworkApi`, so eval harnesses cannot wrap
// `on.permissionRequest` or replace `admin.access` from the renderer. Instead
// smoke/eval runs expose a main-process broadcast for synthetic permission
// requests; the preload builds admin overrides into the API *before* expose.
//
// These handlers must never register outside OPEN_COWORK_E2E=1.

function isE2EEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPEN_COWORK_E2E === '1'
}

function isPermissionRequest(value: unknown): value is PermissionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.tool === 'string'
    && typeof record.description === 'string'
    && record.input !== null
    && typeof record.input === 'object'
    && !Array.isArray(record.input)
}

export function registerE2EEvalHandlers(
  ipcMain: IpcMain,
  getWindows: () => BrowserWindow[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  // Always register so preload channel allowlists stay in sync with main. The
  // handler is fail-closed unless OPEN_COWORK_E2E=1 (smoke/eval only).
  const e2eEnabled = isE2EEnabled(env)

  ipcMain.handle('eval:emit-permission-request', (_event, request: unknown) => {
    if (!e2eEnabled) {
      throw new Error('eval:emit-permission-request is only available when OPEN_COWORK_E2E=1')
    }
    if (!isPermissionRequest(request)) {
      throw new Error('eval:emit-permission-request requires a PermissionRequest payload')
    }

    let delivered = 0
    for (const win of getWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      win.webContents.send('permission:request', request)
      delivered += 1
    }
    return delivered
  })
}
