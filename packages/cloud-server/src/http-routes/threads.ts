import type { CloudApiRouteInput } from './types.ts'

export async function handleThreadsApiRoute(input: CloudApiRouteInput): Promise<boolean> {
  const { req, res, options, context, itemId: collection, action: itemId, artifactId: itemAction, tools } = input

  if (!options.policy.features.threadIndex) {
    tools.writePolicyError(res, 403, 'Thread index is disabled for this cloud profile.', 'thread_index.disabled', options.corsOrigin)
    return true
  }

  if (!collection && req.method === 'GET') {
    tools.writeJson(res, 200, {
      threads: await options.service.domains.threads.listThreadMetadata(context.principal, {
        tagIds: tools.parseTagIds(context.url),
        limit: tools.parseLimit(context.url),
      }),
    }, options.corsOrigin)
    return true
  }

  if (collection === 'tags') {
    if (!itemId && req.method === 'GET') {
      tools.writeJson(res, 200, { tags: await options.service.domains.threads.listThreadTags(context.principal) }, options.corsOrigin)
      return true
    }
    if (!itemId && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const name = tools.readString(body.name)
      if (!name) {
        tools.writeError(res, 400, 'Tag name is required.', options.corsOrigin)
        return true
      }
      const tag = await options.service.domains.threads.createThreadTag(context.principal, {
        name,
        color: tools.readString(body.color),
      })
      tools.writeJson(res, 201, { tag }, options.corsOrigin)
      return true
    }
    if (itemId && !itemAction && req.method === 'PATCH') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const tag = await options.service.domains.threads.updateThreadTag(context.principal, itemId, {
        name: body.name === undefined ? undefined : tools.readString(body.name) || '',
        color: body.color === undefined ? undefined : tools.readString(body.color),
      })
      if (!tag) {
        tools.writeError(res, 404, 'Thread tag was not found.', options.corsOrigin)
        return true
      }
      tools.writeJson(res, 200, { tag }, options.corsOrigin)
      return true
    }
    if (itemId && !itemAction && req.method === 'DELETE') {
      tools.writeJson(res, 200, {
        deleted: await options.service.domains.threads.deleteThreadTag(context.principal, itemId),
      }, options.corsOrigin)
      return true
    }
    if (itemId && (itemAction === 'apply' || itemAction === 'remove') && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const sessionIds = tools.readStringArray(body.sessionIds)
      if (!sessionIds) {
        tools.writeError(res, 400, 'sessionIds must be an array of strings.', options.corsOrigin)
        return true
      }
      if (itemAction === 'apply') {
        await options.service.domains.threads.applyThreadTag(context.principal, itemId, sessionIds)
      } else {
        await options.service.domains.threads.removeThreadTag(context.principal, itemId, sessionIds)
      }
      tools.writeJson(res, 200, { ok: true }, options.corsOrigin)
      return true
    }
  }

  if (collection === 'smart-filters') {
    if (!itemId && req.method === 'GET') {
      tools.writeJson(res, 200, {
        filters: await options.service.domains.threads.listThreadSmartFilters(context.principal),
      }, options.corsOrigin)
      return true
    }
    if (!itemId && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const name = tools.readString(body.name)
      const query = tools.readRecord(body.query)
      if (!name || !query) {
        tools.writeError(res, 400, 'Smart filter name and query are required.', options.corsOrigin)
        return true
      }
      const filter = await options.service.domains.threads.createThreadSmartFilter(context.principal, { name, query })
      tools.writeJson(res, 201, { filter }, options.corsOrigin)
      return true
    }
    if (itemId && !itemAction && req.method === 'PATCH') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const filter = await options.service.domains.threads.updateThreadSmartFilter(context.principal, itemId, {
        name: body.name === undefined ? undefined : tools.readString(body.name) || '',
        query: body.query === undefined ? undefined : tools.readRecord(body.query) || {},
      })
      if (!filter) {
        tools.writeError(res, 404, 'Smart filter was not found.', options.corsOrigin)
        return true
      }
      tools.writeJson(res, 200, { filter }, options.corsOrigin)
      return true
    }
    if (itemId && !itemAction && req.method === 'DELETE') {
      tools.writeJson(res, 200, {
        deleted: await options.service.domains.threads.deleteThreadSmartFilter(context.principal, itemId),
      }, options.corsOrigin)
      return true
    }
  }

  tools.writeError(res, 404, 'Not found.', options.corsOrigin)
  return true
}
