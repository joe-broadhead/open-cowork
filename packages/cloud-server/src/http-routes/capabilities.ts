import type { CloudApiRouteInput } from './types.ts'

export async function handleCapabilitiesApiRoute(input: CloudApiRouteInput): Promise<boolean> {
  const { req, res, options, context, itemId: collection, action: itemId, artifactId: itemAction, tools } = input

  if (!options.policy.features.agents && !options.policy.features.customSkills && !options.policy.features.customMcps) {
    tools.writePolicyError(res, 403, 'Capabilities are disabled for this cloud profile.', 'capabilities.disabled', options.corsOrigin)
    return true
  }

  if (!collection && req.method === 'GET') {
    tools.writeJson(res, 200, await options.service.listCapabilityCatalog(context.principal), options.corsOrigin)
    return true
  }

  if (collection === 'tools') {
    if (!itemId && req.method === 'GET') {
      tools.writeJson(res, 200, { tools: await options.service.listCapabilityTools(context.principal) }, options.corsOrigin)
      return true
    }
    if (itemId && !itemAction && req.method === 'GET') {
      const tool = await options.service.getCapabilityTool(context.principal, itemId)
      if (!tool) {
        tools.writeError(res, 404, 'Capability tool was not found.', options.corsOrigin)
        return true
      }
      tools.writeJson(res, 200, { tool }, options.corsOrigin)
      return true
    }
  }

  if (collection === 'skills') {
    if (!itemId && req.method === 'GET') {
      tools.writeJson(res, 200, { skills: await options.service.listCapabilitySkills(context.principal) }, options.corsOrigin)
      return true
    }
    if (itemId && !itemAction && req.method === 'GET') {
      const skill = await options.service.getCapabilitySkill(context.principal, itemId)
      if (!skill) {
        tools.writeError(res, 404, 'Capability skill was not found.', options.corsOrigin)
        return true
      }
      tools.writeJson(res, 200, { skill }, options.corsOrigin)
      return true
    }
    if (itemId && itemAction === 'bundle' && req.method === 'GET') {
      const bundle = await options.service.getCapabilitySkillBundle(context.principal, itemId)
      if (!bundle) {
        tools.writeError(res, 404, 'Capability skill bundle was not found.', options.corsOrigin)
        return true
      }
      tools.writeJson(res, 200, { bundle }, options.corsOrigin)
      return true
    }
  }

  tools.writeError(res, 404, 'Not found.', options.corsOrigin)
  return true
}
