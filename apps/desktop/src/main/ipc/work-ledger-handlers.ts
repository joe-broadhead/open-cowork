import type { IpcHandlerContext } from './context.ts'
import { getWorkLedgerService } from '../work-ledger-service.ts'

export function registerWorkLedgerHandlers(context: IpcHandlerContext) {
  const ledger = () => getWorkLedgerService()

  context.ipcMain.handle('work-ledger:search', async (_event, query?: unknown) => (
    ledger().search(query as never)
  ))

  context.ipcMain.handle('work-ledger:facets', async (_event, query?: unknown) => (
    ledger().facets(query as never)
  ))

  context.ipcMain.handle('work-ledger:reindex', async () => (
    ledger().reindex()
  ))
}
