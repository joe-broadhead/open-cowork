import { constantTimeEquals } from '@open-cowork/shared/node'
import type { IncomingMessage } from 'node:http'

// Pure header / constant-time-token auth helpers for the cloud HTTP server,
// extracted from http-server.ts. No server state — read a request header, compare
// two strings in constant time, and validate the internal service token.

export function readHeader(req: IncomingMessage, name: string) {
  const value = req.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] || null
  return value || null
}

export function internalTokenIsValid(req: IncomingMessage, expected: string | null | undefined) {
  if (!expected) return false
  const provided = readHeader(req, 'x-open-cowork-internal-token')
  return typeof provided === 'string' && constantTimeEquals(provided, expected)
}
