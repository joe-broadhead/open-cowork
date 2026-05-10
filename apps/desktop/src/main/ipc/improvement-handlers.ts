import type { IpcHandlerContext } from './context.ts'
import { buildImprovementDiagnosticsSummary } from '../improvement-store.ts'
import { buildImprovementPolicyDiagnostics } from '../improvement-policy.ts'
import { getEffectiveSettings } from '../settings.ts'

export function registerImprovementHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('improvements:summary', async () => {
    return buildImprovementDiagnosticsSummary(
      buildImprovementPolicyDiagnostics(getEffectiveSettings()),
    )
  })
}
