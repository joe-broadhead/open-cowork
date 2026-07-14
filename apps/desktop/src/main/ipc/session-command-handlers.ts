import { touchSessionRecord } from '@open-cowork/runtime-host/session-registry'
import { getClientForDirectory, getRuntimeHomeDir } from '@open-cowork/runtime-host/runtime'
import { normalizeRuntimeCommands } from '@open-cowork/runtime-host'
import { shortSessionId, type RuntimeContextOptions } from '@open-cowork/shared'
import type { IpcHandlerContext } from './context.ts'
import { normalizeCommandName, normalizeSessionId } from './session-handler-validation.ts'
import { trackParentSession } from '../event-task-state.ts'
import { validateRuntimeContextOptions } from './object-validators.ts'
import { optionalObjectArg, registerIpcInvoke } from './schema.ts'
export function registerSessionCommandHandlers(context: IpcHandlerContext) {
  registerIpcInvoke(context, 'command:list', optionalObjectArg<RuntimeContextOptions>('runtime context options', validateRuntimeContextOptions), async (_event, options) => {
    const directory = context.resolveContextDirectory(options) || getRuntimeHomeDir()
    const client = getClientForDirectory(directory)
    if (!client) return []
    try {
      const result = await client.v2.command.list({ location: { directory } }, { throwOnError: true })
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
      await client.session.command(
        { sessionID: sessionId, command: commandName },
        { throwOnError: true },
      )
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
      const result = await client.session.todo({ sessionID: sessionId }, { throwOnError: true })
      return result.data || []
    } catch (err) {
      context.logHandlerError(`session:todo ${shortSessionId(sessionId)}`, err)
      return []
    }
  })
}
