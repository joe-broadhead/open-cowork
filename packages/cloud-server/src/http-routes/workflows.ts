import type {
  WorkflowDraft,
  WorkflowStatus,
  WorkflowTriggerType,
} from '@open-cowork/shared'
import { internalTokenIsValid } from '../http-auth-helpers.ts'
import type { CloudHttpServerOptions } from '../http-contracts.ts'
import type {
  CloudApiRouteInput,
  CloudApiRouteTools,
} from './types.ts'

type WorkflowRouteTools = CloudApiRouteTools & {
  processSessionCommandIfConfigured(
    options: CloudHttpServerOptions,
    tenantId: string,
    sessionId: string,
  ): Promise<number>
}

type WorkflowRouteInput = Omit<CloudApiRouteInput, 'tools'> & {
  tools: WorkflowRouteTools
}

export async function handleWorkflowsApiRoute(
  input: WorkflowRouteInput,
): Promise<boolean> {
  const {
    req,
    res,
    options,
    context,
    resource,
    itemId: sessionId,
    action,
    tools,
  } = input
  if (resource !== 'workflows') return false

  const workflowId = sessionId
  const workflowAction = action

  if (!workflowId && req.method === 'GET') {
    tools.writeJson(res, 200, await options.service.domains.workflows.listWorkflows(context.principal, {
      limit: tools.parseLimit(context.url),
      cursor: context.url.searchParams.get('cursor'),
    }), options.corsOrigin)
    return true
  }

  if (!workflowId && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const draft = body as Partial<WorkflowDraft>
    const created = await options.service.domains.workflows.createWorkflow(context.principal, {
      title: tools.readString(draft.title) || '',
      instructions: tools.readString(draft.instructions) || '',
      agentName: tools.readString(draft.agentName) || 'build',
      skillNames: tools.readStringArray(draft.skillNames) || [],
      toolIds: tools.readStringArray(draft.toolIds) || [],
      steps: Array.isArray(draft.steps) ? draft.steps : undefined,
      projectDirectory: tools.readString(draft.projectDirectory),
      draftSessionId: tools.readString(draft.draftSessionId),
      triggers: Array.isArray(draft.triggers) ? draft.triggers : [],
    })
    tools.writeJson(res, 201, created, options.corsOrigin)
    return true
  }

  if (workflowId === 'scheduler' && workflowAction === 'tick' && req.method === 'POST') {
    if (!options.internalToken) {
      tools.writeError(res, 404, 'Not found.', options.corsOrigin)
      return true
    }
    if (!internalTokenIsValid(req, options.internalToken)) {
      tools.writeError(res, 403, 'Internal scheduler token is missing or invalid.', options.corsOrigin)
      return true
    }
    const started = await options.service.domains.workflows.claimAndStartDueWorkflow()
    const processed = started
      ? await tools.processSessionCommandIfConfigured(options, started.tenantId, started.sessionId)
      : 0
    tools.writeJson(res, 200, {
      claimed: started
        ? {
            tenantId: started.tenantId,
            workflowId: started.workflow.id,
            runId: started.run.id,
            sessionId: started.sessionId,
          }
        : null,
      processed,
    }, options.corsOrigin)
    return true
  }

  if (!workflowId) {
    tools.writeError(res, 405, 'Method not allowed.', options.corsOrigin)
    return true
  }

  if (!workflowAction && req.method === 'GET') {
    const workflow = await options.service.domains.workflows.getWorkflow(context.principal, workflowId)
    if (!workflow) {
      tools.writeError(res, 404, 'Workflow was not found.', options.corsOrigin)
      return true
    }
    tools.writeJson(res, 200, { workflow }, options.corsOrigin)
    return true
  }

  if (workflowAction === 'run' && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const triggerType = tools.readString(body.triggerType) as WorkflowTriggerType | null
    const started = await options.service.domains.workflows.runWorkflow(context.principal, workflowId, {
      triggerType: triggerType || 'manual',
      triggerPayload: tools.readRecord(body.triggerPayload),
    })
    const processed = await tools.processSessionCommandIfConfigured(options, started.tenantId, started.sessionId)
    const workflow = await options.service.domains.workflows.getWorkflow(context.principal, workflowId)
    tools.writeJson(res, 202, {
      ...started,
      workflow: workflow || started.workflow,
      run: workflow?.runs.find((run) => run.id === started.run.id) || started.run,
      processed,
    }, options.corsOrigin)
    return true
  }

  if (workflowAction === 'rotate-webhook-secret' && req.method === 'POST') {
    const result = await options.service.domains.workflows.rotateWorkflowWebhookSecret(context.principal, workflowId)
    if (!result) {
      tools.writeError(res, 404, 'Workflow webhook was not found.', options.corsOrigin)
      return true
    }
    tools.writeJson(res, 200, result, options.corsOrigin)
    return true
  }

  if ((workflowAction === 'pause' || workflowAction === 'resume' || workflowAction === 'archive') && req.method === 'POST') {
    const status: WorkflowStatus = workflowAction === 'resume'
      ? 'active'
      : workflowAction === 'pause'
        ? 'paused'
        : 'archived'
    const workflow = await options.service.domains.workflows.updateWorkflowStatus(context.principal, workflowId, status)
    if (!workflow) {
      tools.writeError(res, 404, 'Workflow was not found.', options.corsOrigin)
      return true
    }
    tools.writeJson(res, 200, { workflow }, options.corsOrigin)
    return true
  }

  tools.writeError(res, 404, 'Not found.', options.corsOrigin)
  return true
}
