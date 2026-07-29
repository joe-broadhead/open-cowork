import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DEFAULT_CONFIG } from '@open-cowork/shared'

export const TEST_COOKIE_KEY = 'not-a-real-cookie-key-for-tests!'
export const STRONG_CLOUD_SECRET = 'Pp4J9_kV2rTq8YzLmN6bHwC3sDxF7uAaG1eOiR5v'
export const STRONG_CLOUD_COOKIE_SECRET = 'Vs7Qm2_ZxHa93LpNuR4TwE8cYbK6jFoDiG1rS5el'

export async function readJson(response: Response) {
  return JSON.parse(await response.text()) as Record<string, unknown>
}

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

export async function waitForResponse(url: string): Promise<Response> {
  const deadline = Date.now() + 1_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await fetch(url)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${url}`)
}

export function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(Boolean(value && typeof value === 'object' && !Array.isArray(value)), true)
  return value as Record<string, unknown>
}

export function asArray(value: unknown): unknown[] {
  assert.equal(Array.isArray(value), true)
  return value as unknown[]
}

export function cloudConfigWithRemoteApprovalResponses() {
  return {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      runtime: {
        ...DEFAULT_CONFIG.cloud.runtime,
        allowRemoteApprovalResponses: true,
      },
      profiles: {
        ...DEFAULT_CONFIG.cloud.profiles,
        full: {
          ...DEFAULT_CONFIG.cloud.profiles.full,
          runtime: {
            ...DEFAULT_CONFIG.cloud.runtime,
            ...(DEFAULT_CONFIG.cloud.profiles.full.runtime || {}),
            allowRemoteApprovalResponses: true,
          },
        },
      },
    },
  }
}
