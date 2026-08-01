import { adoptionTelemetry } from '@open-cowork/runtime-host/adoption-telemetry'
import { isFeatureValueEventInput } from '@open-cowork/shared'
import { log } from '@open-cowork/shared/node'

import type { IpcHandlerContext } from './context.ts'

export function registerAdoptionHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('adoption:feature-value', async (_event, input: unknown) => {
    if (!isFeatureValueEventInput(input)) {
      // Do not serialize hostile input: it may contain the content this channel
      // is deliberately unable to accept.
      log('security', 'Rejected invalid adoption:feature-value payload.')
      return false
    }
    return adoptionTelemetry.featureValueDelivered(input)
  })
}
