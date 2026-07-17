import type { IncomingMessage, ServerResponse } from 'node:http'
import { writeCorsHeaders } from '../http-response-writers.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import type { CloudSessionService } from '../session-service.ts'
import {
  parseScimGroup,
  parseScimPatch,
  parseScimUser,
  scimErrorResponse,
  scimListResponse,
  scimUserResource,
  ScimParseError,
} from '../scim-schema.ts'

// SCIM 2.0 provisioning endpoints (issue #895): /scim/v2/Users + /scim/v2/Groups,
// authenticated by the per-org SCIM bearer token. A thin protocol adapter — it parses
// SCIM JSON, calls the SCIM service (which owns the membership/queue/reconcile logic),
// and renders SCIM resources/errors. Mounted top-level (pre-user-auth) like the webhook
// routes, because the IdP presents the org's SCIM token, not a user session.

export type ScimRouteTools = {
  readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown>>
}

export type ScimRouteInput = {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  service: CloudSessionService
  corsOrigin?: string | null
  maxBodyBytes: number
  tools: ScimRouteTools
}

function readBearerToken(req: IncomingMessage): string | null {
  const raw = req.headers.authorization
  const value = Array.isArray(raw) ? raw[0] || '' : raw || ''
  return value.trim().toLowerCase().startsWith('bearer ') ? value.trim().slice(7).trim() : null
}

function writeScim(res: ServerResponse, status: number, body: unknown, origin?: string | null) {
  writeCorsHeaders(res, origin)
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/scim+json', 'cache-control': 'no-store' })
  res.end(payload)
}

function scimBaseUrl(req: IncomingMessage): string {
  const hostHeader = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
  const host = String(hostHeader || 'localhost').split(',')[0]!.trim()
  const scheme = (req.headers['x-forwarded-proto'] === 'https' || (req.socket as { encrypted?: boolean }).encrypted) ? 'https' : 'http'
  return `${scheme}://${host}/scim/v2`
}

// `userName eq "value"` → the email filter the IdP uses to look a user up before create.
function parseUserNameFilter(url: URL): string | null {
  const filter = url.searchParams.get('filter')
  if (!filter) return null
  const match = /userName\s+eq\s+"([^"]+)"/i.exec(filter)
  return match ? match[1]!.trim() : null
}

function serviceProviderConfig(): Record<string, unknown> {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 500 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: 'Per-org SCIM bearer token.' }],
  }
}

export async function handleScimApiRoute(input: ScimRouteInput): Promise<boolean> {
  const { req, res, url, service, corsOrigin, maxBodyBytes, tools } = input
  const segments = url.pathname.split('/').filter(Boolean) // ['scim','v2',resource,id?]
  const resource = segments[2]
  const resourceId = segments[3] ? decodeURIComponent(segments[3]) : null
  const method = req.method || 'GET'

  try {
    if (resource === 'ServiceProviderConfig' && method === 'GET') {
      await service.domains.scim.authenticate(readBearerToken(req))
      writeScim(res, 200, serviceProviderConfig(), corsOrigin)
      return true
    }
    const { orgId } = await service.domains.scim.authenticate(readBearerToken(req))
    const baseUrl = scimBaseUrl(req)

    if (resource === 'Users') {
      if (!resourceId && method === 'GET') {
        const members = await service.domains.scim.listMembers(orgId, { email: parseUserNameFilter(url) })
        writeScim(res, 200, scimListResponse(members.map((member) => scimUserResource(member, baseUrl)), members.length), corsOrigin)
        return true
      }
      if (!resourceId && method === 'POST') {
        const parsed = parseScimUser(await tools.readJsonBody(req, maxBodyBytes))
        const member = await service.domains.scim.createUser(orgId, parsed)
        writeScim(res, 201, scimUserResource(member, baseUrl), corsOrigin)
        return true
      }
      if (resourceId && method === 'GET') {
        const member = await service.domains.scim.getMember(orgId, resourceId)
        if (!member) return notFound(res, 'SCIM user was not found.', corsOrigin)
        writeScim(res, 200, scimUserResource(member, baseUrl), corsOrigin)
        return true
      }
      if (resourceId && method === 'PUT') {
        const parsed = parseScimUser(await tools.readJsonBody(req, maxBodyBytes))
        const member = await service.domains.scim.replaceUser(orgId, resourceId, parsed)
        writeScim(res, 200, scimUserResource(member, baseUrl), corsOrigin)
        return true
      }
      if (resourceId && method === 'PATCH') {
        const patch = parseScimPatch(await tools.readJsonBody(req, maxBodyBytes))
        const member = await service.domains.scim.patchUser(orgId, resourceId, patch)
        writeScim(res, 200, scimUserResource(member, baseUrl), corsOrigin)
        return true
      }
      if (resourceId && method === 'DELETE') {
        await service.domains.scim.deprovisionUser(orgId, resourceId)
        writeCorsHeaders(res, corsOrigin)
        res.writeHead(204).end()
        return true
      }
    }

    if (resource === 'Groups' && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      const group = await service.domains.scim.syncGroup(orgId, parseScimGroup(await tools.readJsonBody(req, maxBodyBytes)))
      writeScim(res, method === 'POST' ? 201 : 200, {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        id: group.id,
        displayName: group.displayName,
        meta: { resourceType: 'Group', location: `${baseUrl}/Groups/${encodeURIComponent(group.id)}` },
      }, corsOrigin)
      return true
    }

    return notFound(res, 'SCIM resource was not found.', corsOrigin)
  } catch (error) {
    if (error instanceof ScimParseError) {
      writeScim(res, error.status, scimErrorResponse(error.status, error.message, error.scimType), corsOrigin)
      return true
    }
    if (error instanceof CloudServiceError) {
      writeScim(res, error.status, scimErrorResponse(error.status, error.publicMessage), corsOrigin)
      return true
    }
    writeScim(res, 500, scimErrorResponse(500, 'Internal SCIM error.'), corsOrigin)
    return true
  }
}

function notFound(res: ServerResponse, detail: string, origin?: string | null): boolean {
  writeScim(res, 404, scimErrorResponse(404, detail), origin)
  return true
}
