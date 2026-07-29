import type {
  WorkflowDraft,
  WorkflowTrigger,
  WorkflowWebhookSecretReveal,
} from '@open-cowork/shared'

export interface InternalWorkflowTrigger extends WorkflowTrigger {
  webhookSecret?: string | null
}

export interface InternalWorkflowDraft extends Omit<WorkflowDraft, 'triggers'> {
  triggers: InternalWorkflowTrigger[]
}

function toPublicWorkflowTrigger(trigger: InternalWorkflowTrigger): WorkflowTrigger {
  const {
    webhookSecret: _webhookSecret,
    ...publicTrigger
  } = trigger
  return publicTrigger
}

export function toPublicWorkflowTriggers(
  triggers: readonly InternalWorkflowTrigger[],
): WorkflowTrigger[] {
  return triggers.map(toPublicWorkflowTrigger)
}

export function activeWebhookSecret(
  triggers: readonly InternalWorkflowTrigger[],
): { triggerId: string; secret: string } | null {
  const trigger = triggers.find((entry) => (
    entry.type === 'webhook'
    && entry.enabled
    && typeof entry.webhookSecret === 'string'
    && entry.webhookSecret.length > 0
  ))
  if (!trigger || typeof trigger.webhookSecret !== 'string') return null
  return { triggerId: trigger.id, secret: trigger.webhookSecret }
}

export function webhookSecretReveal(
  workflowId: string,
  trigger: { triggerId: string; secret: string } | null,
): WorkflowWebhookSecretReveal | null {
  return trigger
    ? {
        workflowId,
        triggerId: trigger.triggerId,
        secret: trigger.secret,
      }
    : null
}
