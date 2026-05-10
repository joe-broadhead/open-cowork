import type {
  AutomationDetail,
  AutomationRunKind,
  SopListItem,
  SopRunLink,
  SopTriggerType,
} from '@open-cowork/shared'
import {
  assertSopRunInputSnapshotSize,
  getSopDetail,
  getLatestActiveSopForAutomation,
  getSopRunLinkForAutomationRun,
} from './sop-store.ts'
import { getAutomationDetail } from './automation-store.ts'

export type SopRunStartContext = {
  sopVersionId: string
  triggerType: SopTriggerType
  inputs: Record<string, unknown>
}

export type ResolvedSopRunStartContext = {
  automationId: string
  context: SopRunStartContext
}

function inputValueIsPresent(value: unknown) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

function inputsForSopRun(
  sop: Pick<SopListItem, 'activeVersion'>,
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

export function resolveSopRunContextForSopTrigger(options: {
  sopId: string
  triggerType: SopTriggerType
  inputs?: Record<string, unknown>
}): ResolvedSopRunStartContext {
  const sop = getSopDetail(options.sopId)
  if (!sop?.activeVersion) throw new Error(`SOP ${options.sopId} has no active version.`)
  if (sop.definition.status !== 'active') throw new Error('Only active SOPs can be run.')
  if (!sop.activeVersion.triggerTypes.includes(options.triggerType)) {
    throw new Error(`SOP does not allow ${options.triggerType} runs.`)
  }
  const automationId = sop.activeVersion.sourceAutomationId || sop.definition.sourceAutomationId
  if (!automationId) throw new Error('SOP has no backing automation to execute.')
  const automation = getAutomationDetail(automationId)
  if (!automation) throw new Error(`SOP backing automation ${automationId} does not exist.`)
  const inputs = inputsForSopRun(sop, automation, options.inputs || {})
  return {
    automationId,
    context: {
      sopVersionId: sop.activeVersion.id,
      triggerType: options.triggerType,
      inputs,
    },
  }
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
