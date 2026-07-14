import { touchSessionRecord } from '@open-cowork/runtime-host/session-registry'
import { getClient } from '@open-cowork/runtime-host/runtime'
import { normalizeRuntimeCommands } from '@open-cowork/runtime-host'
import { shortSessionId } from '@open-cowork/shared'
import type { IpcHandlerContext } from './context.ts'
import { normalizeCommandName, normalizeSessionId } from './session-handler-validation.ts'
import { trackParentSession } from '../event-task-state.ts'
export function registerSessionCommandHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('command:list', async () => {
    const client = getClient()
    if (!client) return []
    try {
      const result = await client.v2.command.list(undefined, { throwOnError: true })
      return normalizeRuntimeCommands(result.data.data)
    } catch (err) {
      context.logHandlerError('command:list', err)
      return []
    }
  })

  context.ipcMain.handle('command:run', async (_event, sessionIdInput: unknown, commandNameInput: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const commandName = normalizeCommandName(commandNameInput)
    const { client } = await context.getSessionClient(sessionId)
    try {
      trackParentSession(sessionId)
      await client.session.command({ sessionID: sessionId, command: commandName })
      touchSessionRecord(sessionId)
      return true
    } catch (err) {
      context.logHandlerError(`command:run ${shortSessionId(sessionId)}:${commandName}`, err)
      return false
    }
  })

  context.ipcMain.handle('session:todo', async (_event, sessionId: string) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      const result = await client.session.todo({ sessionID: sessionId })
      return result.data || []
    } catch (err) {
      context.logHandlerError(`session:todo ${shortSessionId(sessionId)}`, err)
      return []
    }
  })
}
