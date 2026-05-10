import type {
  AutomationDetail,
  AutomationRunKind,
  SopListItem,
  SopRunLink,
  SopTriggerType,
} from '@open-cowork/shared'
import {
  assertSopRunInputSnapshotSize,
  getLatestActiveSopForAutomation,
  getSopRunLinkForAutomationRun,
} from './sop-store.ts'

export type SopRunStartContext = {
  sopVersionId: string
  triggerType: SopTriggerType
  inputs: Record<string, unknown>
}

function inputValueIsPresent(value: unknown) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

function inputsForSopRun(
  sop: SopListItem,
  automation: AutomationDetail,
  seedInputs: Record<string, unknown>,
) {
  const inputs = { ...seedInputs }
  const missingInputs: string[] = []
  for (const input of sop.activeVersion?.requiredInputs || []) {
    if (input.id === 'project-directory' && !inputValueIsPresent(inputs[input.id]) && automation.projectDirectory) {
      inputs[input.id] = automation.projectDirectory
    }
    if (input.required && !inputValueIsPresent(inputs[input.id])) {
      missingInputs.push(input.label || input.id)
    }
  }
  if (missingInputs.length > 0) {
    throw new Error(`Missing required SOP input${missingInputs.length === 1 ? '' : 's'}: ${missingInputs.join(', ')}`)
  }
  assertSopRunInputSnapshotSize(inputs)
  return inputs
}

function retrySopContext(previousLink: SopRunLink | null): SopRunStartContext | null {
  if (!previousLink) return null
  return {
    sopVersionId: previousLink.sopVersionId,
    triggerType: previousLink.triggerType,
    inputs: previousLink.inputs,
  }
}

export function resolveSopRunContextForAutomationStart(options: {
  automation: AutomationDetail
  kind: AutomationRunKind
  triggerType?: SopTriggerType | null
  retryOfRunId?: string | null
  inputs?: Record<string, unknown>
}): SopRunStartContext | null {
  if (options.kind !== 'execution') return null
  const retryContext = retrySopContext(options.retryOfRunId ? getSopRunLinkForAutomationRun(options.retryOfRunId) : null)
  if (retryContext) return retryContext

  const triggerType = options.triggerType || null
  if (!triggerType) return null
  const sop = getLatestActiveSopForAutomation(options.automation.id)
  if (!sop?.activeVersion) return null
  if (!sop.activeVersion.triggerTypes.includes(triggerType)) return null

  let inputs: Record<string, unknown>
  try {
    inputs = inputsForSopRun(sop, options.automation, options.inputs || {})
  } catch {
    return null
  }

  return {
    sopVersionId: sop.activeVersion.id,
    triggerType,
    inputs,
  }
}
