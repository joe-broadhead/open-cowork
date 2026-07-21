import type { RouteHandler } from '../daemon-router.js'
import { z } from 'zod'
import { defineApiRouteContracts, HttpError, json, pathMatch, readJsonBodyAs } from '../daemon-router.js'
import { getConfig } from '../config.js'
import { getWorkerCounts, listWorkers } from '../workers.js'
import { formatOpenCodeSessionLinks, formatOpenCodeUnavailableSessionLinks, gatewayLocalBaseUrl, opencodeSessionLinks, unavailableOpenCodeSessionLinks } from '../opencode-web.js'
import { listPendingPermissions, listPendingQuestions, rejectPermission, rejectQuestion, replyToPermission, replyToQuestion } from '../opencode-requests.js'
import { deleteOpenCodeAgent, deleteOpenCodeMcp, deleteOpenCodeSkill, deleteOpenCodeTool, listOpenCodeAgents, listOpenCodeMcp, listOpenCodeSkills, listOpenCodeTools, upsertOpenCodeAgent, upsertOpenCodeMcp, upsertOpenCodeSkill, upsertOpenCodeTool } from '../opencode-assets.js'
import { redactSensitiveObject } from '../security.js'
import { guardUnredactedExport } from '../unredacted-export-guard.js'

const zOpenCodeConfigDir = z.string().min(1).max(4096).optional()
const zOpenCodeToolBody = z.object({
  content: z.string().min(1, 'content is required'),
  extension: z.enum(['ts', 'js']).optional(),
  configDir: zOpenCodeConfigDir,
})
const zOpenCodeSkillBody = z.object({
  content: z.string().min(1, 'content is required'),
  configDir: zOpenCodeConfigDir,
})
const zOpenCodeMcpBody = z.object({
  server: z.record(z.string(), z.unknown()).optional(),
  configDir: zOpenCodeConfigDir,
}).passthrough()
const zOpenCodeAgentBody = z.object({
  model: z.string().min(1).max(512).optional(),
  variant: z.string().min(1).max(128).optional(),
  prompt: z.string().max(100_000).optional(),
  description: z.string().max(10_000).optional(),
  mode: z.enum(['subagent', 'primary', 'all']).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxSteps: z.number().int().min(1).max(10_000).optional(),
  hidden: z.boolean().optional(),
  disable: z.boolean().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  permission: z.record(z.string(), z.unknown()).optional(),
  configDir: zOpenCodeConfigDir,
})
const zQuestionReplyBody = z.object({
  answers: z.array(z.array(z.string())),
})
const zPermissionReplyBody = z.object({
  reply: z.enum(['once', 'always', 'reject']),
  message: z.string().optional(),
})
const zPermissionRejectBody = z.object({
  message: z.string().optional(),
})

/** @public Loaded from the built module by the API reference generator. */
export const OPENCODE_API_ROUTE_CONTRACTS = defineApiRouteContracts([
  { method: 'POST', path: '/questions/{id}/reply', bodySchema: zQuestionReplyBody, responses: [200, 400] },
  { method: 'POST', path: '/questions/{id}/reject', requestBody: false, responses: [200] },
  { method: 'POST', path: '/permissions/{id}/reply', bodySchema: zPermissionReplyBody, responses: [200, 400] },
  { method: 'POST', path: '/permissions/{id}/reject', bodySchema: zPermissionRejectBody, responses: [200, 400] },
  { method: 'GET', path: '/opencode/sessions', querySchemas: { limit: z.number().int().min(1).max(500), gatewayOnly: z.boolean() }, responses: [200, 400] },
  { method: 'GET', path: '/opencode/sessions/{id}', responses: [200, 404] },
  { method: 'GET', path: '/opencode/sessions/{id}/messages', querySchemas: { limit: z.number().int().min(1).max(200) }, responses: [200, 400, 404] },
  { method: 'POST', path: '/opencode/sessions/{id}/abort', requestBody: false, responses: [200, 404] },
  { method: 'PUT', path: '/opencode/mcp/{name}', bodySchema: zOpenCodeMcpBody, responses: [200, 400] },
  { method: 'POST', path: '/opencode/mcp/{name}', bodySchema: zOpenCodeMcpBody, responses: [200, 400] },
  { method: 'DELETE', path: '/opencode/mcp/{name}', requestBody: false, querySchemas: { configDir: zOpenCodeConfigDir }, responses: [200] },
  { method: 'PUT', path: '/opencode/tools/{name}', bodySchema: zOpenCodeToolBody, responses: [200, 400] },
  { method: 'POST', path: '/opencode/tools/{name}', bodySchema: zOpenCodeToolBody, responses: [200, 400] },
  { method: 'DELETE', path: '/opencode/tools/{name}', requestBody: false, querySchemas: { configDir: zOpenCodeConfigDir }, responses: [200] },
  { method: 'PUT', path: '/opencode/agents/{name}', bodySchema: zOpenCodeAgentBody, responses: [200, 400] },
  { method: 'POST', path: '/opencode/agents/{name}', bodySchema: zOpenCodeAgentBody, responses: [200, 400] },
  { method: 'DELETE', path: '/opencode/agents/{name}', requestBody: false, querySchemas: { configDir: zOpenCodeConfigDir }, responses: [200] },
  { method: 'PUT', path: '/opencode/skills/{name}', bodySchema: zOpenCodeSkillBody, responses: [200, 400] },
  { method: 'POST', path: '/opencode/skills/{name}', bodySchema: zOpenCodeSkillBody, responses: [200, 400] },
  { method: 'DELETE', path: '/opencode/skills/{name}', requestBody: false, querySchemas: { configDir: zOpenCodeConfigDir }, responses: [200] },
] as const)

export function opencodeRoutes(): RouteHandler[] {
  return [async ({ req, url, client }) => {
    if (req.method === 'GET' && url.pathname === '/questions') {
      return json({ questions: await listPendingQuestions() })
    }

    const questionReplyMatch = pathMatch(url.pathname, /^\/questions\/([^/]+)\/reply$/)
    if (req.method === 'POST' && questionReplyMatch) {
      const body = await readJsonBodyAs(req, zQuestionReplyBody)
      return json({ ok: await replyToQuestion(questionReplyMatch[0], body.answers) })
    }

    const questionRejectMatch = pathMatch(url.pathname, /^\/questions\/([^/]+)\/reject$/)
    if (req.method === 'POST' && questionRejectMatch) {
      return json({ ok: await rejectQuestion(questionRejectMatch[0]) })
    }

    if (req.method === 'GET' && url.pathname === '/permissions') {
      return json({ permissions: await listPendingPermissions() })
    }

    const permissionReplyMatch = pathMatch(url.pathname, /^\/permissions\/([^/]+)\/reply$/)
    if (req.method === 'POST' && permissionReplyMatch) {
      const body = await readJsonBodyAs(req, zPermissionReplyBody)
      return json({ ok: await replyToPermission(permissionReplyMatch[0], body.reply, body.message) })
    }

    const permissionRejectMatch = pathMatch(url.pathname, /^\/permissions\/([^/]+)\/reject$/)
    if (req.method === 'POST' && permissionRejectMatch) {
      const body = await readJsonBodyAs(req, zPermissionRejectBody)
      return json({ ok: await rejectPermission(permissionRejectMatch[0], body.message) })
    }

    if (req.method === 'GET' && url.pathname === '/opencode/sessions') {
      const limit = boundedIntegerQuery(url, 'limit', 100, 500)
      const gatewayOnly = !(url.searchParams.get('all') === 'true' || url.searchParams.get('gatewayOnly') === 'false')
      const raw = url.searchParams.get('raw') === 'true' || url.searchParams.get('unredacted') === 'true'
      const limited = guardUnredactedExport(req, {
        operation: 'opencode.sessions.unredacted',
        target: 'opencode/sessions',
        unredacted: raw,
      })
      if (limited) return limited
      const config = getConfig()
      const sessions = ((await client.session.list()).data as any[] || [])
        .filter(session => !gatewayOnly || String(session.title || '').startsWith('GW:'))
        .slice(0, limit)
      return json({ sessions: raw ? sessions : redactSensitiveObject(sessions, config), gatewayOnly })
    }

    const opencodeSessionMessagesMatch = pathMatch(url.pathname, /^\/opencode\/sessions\/([^/]+)\/messages$/)
    if (req.method === 'GET' && opencodeSessionMessagesMatch) {
      const limit = boundedIntegerQuery(url, 'limit', 20, 200)
      const messages = (((await client.session.messages({
        path: { id: opencodeSessionMessagesMatch[0] },
        query: { limit },
      })).data || []) as any[]).slice(-limit)
      return json({ messages })
    }

    const opencodeSessionChildrenMatch = pathMatch(url.pathname, /^\/opencode\/sessions\/([^/]+)\/children$/)
    if (req.method === 'GET' && opencodeSessionChildrenMatch) {
      const childrenFn = (client.session as any).children
      const children = typeof childrenFn === 'function'
        ? await childrenFn.call(client.session, { path: { id: opencodeSessionChildrenMatch[0] } }).catch(() => ({ data: [] }))
        : { data: [] }
      return json({ children: children?.data || [] })
    }

    const opencodeSessionAbortMatch = pathMatch(url.pathname, /^\/opencode\/sessions\/([^/]+)\/abort$/)
    if (req.method === 'POST' && opencodeSessionAbortMatch) {
      await client.session.abort({ path: { id: opencodeSessionAbortMatch[0] } })
      return json({ aborted: true })
    }

    const opencodeSessionMatch = pathMatch(url.pathname, /^\/opencode\/sessions\/([^/]+)$/)
    if (req.method === 'GET' && opencodeSessionMatch) {
      const sessionId = opencodeSessionMatch[0]
      const config = getConfig()
      const gatewayBaseUrl = gatewayLocalBaseUrl(config.httpPort, config.security.httpHost)
      const raw = url.searchParams.get('raw') === 'true' || url.searchParams.get('unredacted') === 'true' || url.searchParams.get('redact') === 'false'
      const limited = guardUnredactedExport(req, {
        operation: 'opencode.session.unredacted',
        target: sessionId,
        unredacted: raw,
      })
      if (limited) return limited
      let session: any
      try {
        session = (await client.session.get({ path: { id: sessionId } })).data
      } catch {
        const links = unavailableOpenCodeSessionLinks(sessionId, {
          gatewayBaseUrl,
          reason: 'session not found in OpenCode API',
          actionHint: 'Use /new [title], /switch <sessionId>, or /project bind <alias> <roadmapId> --rebind to recover a fresh session.',
        })
        return json({
          session: null,
          links,
          webUrl: null,
          tuiCommand: links.tuiCommand,
          linksText: formatOpenCodeUnavailableSessionLinks(sessionId, {
            gatewayBaseUrl,
            reason: links.webStatusReason,
            actionHint: links.webRecoveryHint,
          }),
          recovery: {
            state: 'stale_or_missing',
            reason: links.webStatusReason,
            nextAction: links.webRecoveryHint,
            missionControlUrl: links.missionControlUrl,
            sessionEvidenceUrl: links.sessionEvidenceUrl,
          },
        }, 404)
      }
      const linkSession = raw ? session as any : { id: sessionId }
      const links = session ? opencodeSessionLinks(config.opencodeUrl, linkSession, { gatewayBaseUrl }) : null
      return json({
        session: raw ? session : redactedOpenCodeSession(session, config),
        links,
        webUrl: links?.webUrl || null,
        tuiCommand: links?.tuiCommand || null,
        linksText: session ? formatOpenCodeSessionLinks(config.opencodeUrl, linkSession, { gatewayBaseUrl }) : null,
      })
    }

    if (req.method === 'GET' && url.pathname === '/opencode/mcp') {
      const raw = url.searchParams.get('redact') === 'false' || url.searchParams.get('raw') === 'true' || url.searchParams.get('unredacted') === 'true'
      const limited = guardUnredactedExport(req, {
        operation: 'opencode.mcp.unredacted',
        target: 'opencode/mcp',
        unredacted: raw,
      })
      if (limited) return limited
      const mcp = listOpenCodeMcp(url.searchParams.get('configDir') || undefined)
      return json({ mcp: raw ? mcp : redactSensitiveObject(mcp, getConfig()) })
    }

    const mcpMatch = pathMatch(url.pathname, /^\/opencode\/mcp\/([^/]+)$/)
    if ((req.method === 'PUT' || req.method === 'POST') && mcpMatch) {
      const body = await readJsonBodyAs(req, zOpenCodeMcpBody)
      const server = body.server && typeof body.server === 'object' ? body.server : Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'configDir'))
      return json({ mcp: upsertOpenCodeMcp({ name: mcpMatch[0], server: server as Record<string, unknown>, configDir: body.configDir }) })
    }
    if (req.method === 'DELETE' && mcpMatch) {
      return json({ deleted: deleteOpenCodeMcp(mcpMatch[0], url.searchParams.get('configDir') || undefined) })
    }

    if (req.method === 'GET' && url.pathname === '/opencode/tools') {
      return json({ tools: listOpenCodeTools(url.searchParams.get('configDir') || undefined) })
    }

    const toolMatch = pathMatch(url.pathname, /^\/opencode\/tools\/([^/]+)$/)
    if ((req.method === 'PUT' || req.method === 'POST') && toolMatch) {
      const body = await readJsonBodyAs(req, zOpenCodeToolBody)
      return json({ tool: upsertOpenCodeTool({ name: toolMatch[0], content: body.content, extension: body.extension, configDir: body.configDir }) })
    }
    if (req.method === 'DELETE' && toolMatch) {
      return json({ deleted: deleteOpenCodeTool(toolMatch[0], url.searchParams.get('configDir') || undefined) })
    }

    if (req.method === 'GET' && url.pathname === '/opencode/agents') {
      return json({ agents: listOpenCodeAgents(url.searchParams.get('configDir') || undefined) })
    }

    const agentMatch = pathMatch(url.pathname, /^\/opencode\/agents\/([^/]+)$/)
    if ((req.method === 'PUT' || req.method === 'POST') && agentMatch) {
      const body = await readJsonBodyAs(req, zOpenCodeAgentBody)
      return json({ agent: upsertOpenCodeAgent({ ...body, name: agentMatch[0] }) })
    }
    if (req.method === 'DELETE' && agentMatch) {
      return json({ deleted: deleteOpenCodeAgent(agentMatch[0], url.searchParams.get('configDir') || undefined) })
    }

    if (req.method === 'GET' && url.pathname === '/opencode/skills') {
      return json({ skills: listOpenCodeSkills(url.searchParams.get('configDir') || undefined) })
    }

    const skillMatch = pathMatch(url.pathname, /^\/opencode\/skills\/([^/]+)$/)
    if ((req.method === 'PUT' || req.method === 'POST') && skillMatch) {
      const body = await readJsonBodyAs(req, zOpenCodeSkillBody)
      return json({ skill: upsertOpenCodeSkill({ ...body, name: skillMatch[0] }) })
    }
    if (req.method === 'DELETE' && skillMatch) {
      return json({ deleted: deleteOpenCodeSkill(skillMatch[0], url.searchParams.get('configDir') || undefined) })
    }

    if (req.method === 'GET' && url.pathname === '/session-state') {
      return json({ sessions: listWorkers(), counts: getWorkerCounts() })
    }

    return undefined
  }]
}

export function boundedIntegerQuery(url: URL, name: string, defaultValue: number, max: number): number {
  const raw = url.searchParams.get(name)
  if (raw === null) return defaultValue
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `${name} must be an integer between 1 and ${max}`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new HttpError(400, `${name} must be an integer between 1 and ${max}`)
  }
  return value
}

function redactedOpenCodeSession(session: any, config = getConfig()): Record<string, unknown> | null {
  if (!session || typeof session !== 'object') return null
  const output: Record<string, unknown> = {
    id: session.id,
    title: session.title,
    time: session.time,
    cost: session.cost,
    tokens: session.tokens,
  }
  return redactSensitiveObject(output, config)
}
