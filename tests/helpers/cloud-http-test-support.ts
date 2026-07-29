import assert from 'node:assert/strict'

import {
  DEFAULT_CONFIG,
  type CloudAbuseConfig,
  type CloudBillingConfig,
  type OpenCoworkConfig,
} from '@open-cowork/shared'
import {
  resolveCloudRuntimePolicy,
  type CloudRuntimePolicy,
} from '@open-cowork/cloud-server/cloud-config'

export const TEST_COOKIE_KEY = 'not-a-real-cookie-key-for-tests!'

export const KNOWLEDGE_CAPABILITY_CONFIG: OpenCoworkConfig = {
  ...DEFAULT_CONFIG,
  tools: [{
    id: 'knowledge',
    name: 'Knowledge',
    description: 'Knowledge tool',
    kind: 'built-in',
    namespace: 'knowledge',
    patterns: ['mcp__knowledge__*'],
    askPatterns: ['mcp__knowledge__propose_knowledge_edit'],
  }],
  mcps: [{
    name: 'knowledge',
    type: 'local',
    description: 'Knowledge MCP',
    authMode: 'none',
  }],
}

export async function readJson(response: Response) {
  const text = await response.text()
  return JSON.parse(text) as Record<string, unknown>
}

export function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(
    Boolean(value && typeof value === 'object' && !Array.isArray(value)),
    true,
  )
  return value as Record<string, unknown>
}

export function asArray(value: unknown): unknown[] {
  assert.equal(Array.isArray(value), true)
  return value as unknown[]
}

export function setCookieHeaders(response: Response) {
  const getSetCookie = (
    response.headers as unknown as { getSetCookie?: () => string[] }
  ).getSetCookie
  if (typeof getSetCookie === 'function') {
    return getSetCookie.call(response.headers)
  }
  const combined = response.headers.get('set-cookie')
  return combined ? combined.split(/,(?=[^ ;]+=)/g) : []
}

export function cookieHeader(headers: string[]) {
  return headers.map((header) => header.split(';')[0]).join('; ')
}

export function cookieValue(headers: string[], name: string) {
  const prefix = `${name}=`
  const value = headers
    .map((header) => header.split(';')[0])
    .find((entry) => entry.startsWith(prefix))
  return value ? decodeURIComponent(value.slice(prefix.length)) : null
}

export function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || ''
}

export function policyWithRemoteApprovalResponses(
  basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG),
): CloudRuntimePolicy {
  return {
    ...basePolicy,
    allowRemoteApprovalResponses: true,
  }
}

export function testAbuseConfig(
  overrides: Partial<CloudAbuseConfig> = {},
): CloudAbuseConfig {
  return {
    ...DEFAULT_CONFIG.cloud.abuse,
    ...overrides,
    enabled: overrides.enabled ?? true,
    httpRateLimit: {
      ...DEFAULT_CONFIG.cloud.abuse.httpRateLimit,
      ...(overrides.httpRateLimit || {}),
    },
    authBackoff: {
      ...DEFAULT_CONFIG.cloud.abuse.authBackoff,
      ...(overrides.authBackoff || {}),
    },
  }
}

export function testBillingConfig(
  overrides: Partial<CloudBillingConfig> = {},
): CloudBillingConfig {
  return {
    ...DEFAULT_CONFIG.cloud.billing,
    ...overrides,
    enabled: overrides.enabled ?? true,
    provider: overrides.provider || 'stub',
    defaultPlanKey: overrides.defaultPlanKey || 'pro',
    plans: {
      pro: {
        label: 'Pro',
        entitlements: {
          allowNewSessions: true,
          allowPrompts: true,
          allowWorkers: true,
        },
      },
      blocked: {
        label: 'Blocked',
        entitlements: {
          allowNewSessions: false,
          allowPrompts: false,
          allowWorkers: false,
        },
      },
      ...(overrides.plans || {}),
    },
  }
}
