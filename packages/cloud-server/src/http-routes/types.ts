import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CloudProjectSourceInput } from '@open-cowork/shared'
import type { ApiTokenScope } from '../control-plane-store.ts'
import type { CloudHttpServerOptions } from '../http-server.ts'
import type { CloudCookieSession } from '../session-cookie-auth.ts'
import type { CloudPrincipal } from '../session-service.ts'

export type CloudApiRouteContext = {
  principal: CloudPrincipal
  authSource: 'cookie' | 'resolver'
  cookieSession: CloudCookieSession | null
  url: URL
  segments: string[]
}

export type CloudApiRouteTools = {
  readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown>>
  readString(value: unknown): string | null
  readRecord(value: unknown): Record<string, unknown> | null
  readStringArray(value: unknown): string[] | null
  readOptionalDate(value: unknown): Date | null
  readApiTokenScopes(value: unknown): ApiTokenScope[] | null
  readOptionalCloudProjectSource(body: Record<string, unknown>): CloudProjectSourceInput | null | undefined
  parseLimit(url: URL): number | undefined
  parseTagIds(url: URL): string[]
  writeJson(res: ServerResponse, status: number, body: unknown, origin?: string | null): void
  writeError(res: ServerResponse, status: number, message: string, origin?: string | null): void
  writePolicyError(res: ServerResponse, status: number, message: string, policyCode: string, origin?: string | null): void
  handleWorkspaceSse(
    req: IncomingMessage,
    res: ServerResponse,
    options: CloudHttpServerOptions,
    context: CloudApiRouteContext,
  ): Promise<void>
}

export type CloudApiRouteInput = {
  req: IncomingMessage
  res: ServerResponse
  options: CloudHttpServerOptions
  context: CloudApiRouteContext
  resource: string | undefined
  itemId: string | undefined
  action: string | undefined
  artifactId?: string | undefined
  tools: CloudApiRouteTools
}
