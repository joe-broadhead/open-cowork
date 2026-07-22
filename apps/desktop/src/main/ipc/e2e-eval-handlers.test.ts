import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserWindow, IpcMain } from 'electron'
import { registerE2EEvalHandlers } from './e2e-eval-handlers.ts'

function createFakeIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMain = {
    handle(channel: string, listener: (...args: unknown[]) => unknown) {
      handlers.set(channel, listener)
    },
  } as unknown as IpcMain
  return {
    ipcMain,
    async invoke(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`no handler for ${channel}`)
      return handler({}, ...args)
    },
    has(channel: string) {
      return handlers.has(channel)
    },
  }
}

void test('eval:emit-permission-request is fail-closed without OPEN_COWORK_E2E', async () => {
  const fake = createFakeIpcMain()
  registerE2EEvalHandlers(fake.ipcMain, () => [], { OPEN_COWORK_E2E: undefined } as NodeJS.ProcessEnv)
  assert.equal(fake.has('eval:emit-permission-request'), true)
  await assert.rejects(
    () => fake.invoke('eval:emit-permission-request', {
      id: 'p1',
      sessionId: 's1',
      tool: 'bash',
      input: {},
      description: 'x',
    }),
    /OPEN_COWORK_E2E=1/,
  )
})

void test('eval:emit-permission-request broadcasts to live windows under E2E', async () => {
  const fake = createFakeIpcMain()
  const sent: unknown[] = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send(channel: string, payload: unknown) {
        sent.push({ channel, payload })
      },
    },
  } as unknown as BrowserWindow

  registerE2EEvalHandlers(fake.ipcMain, () => [win], { OPEN_COWORK_E2E: '1' } as NodeJS.ProcessEnv)

  const request = {
    id: 'p1',
    sessionId: 's1',
    tool: 'bash',
    input: { command: 'echo hi' },
    description: 'Run a shell command',
  }
  const delivered = await fake.invoke('eval:emit-permission-request', request)
  assert.equal(delivered, 1)
  assert.deepEqual(sent, [{ channel: 'permission:request', payload: request }])
})

void test('eval:emit-permission-request rejects malformed payloads', async () => {
  const fake = createFakeIpcMain()
  registerE2EEvalHandlers(fake.ipcMain, () => [], { OPEN_COWORK_E2E: '1' } as NodeJS.ProcessEnv)
  await assert.rejects(
    () => fake.invoke('eval:emit-permission-request', { id: 1 }),
    /PermissionRequest/,
  )
})
