import {
  CloudExecutionIsolationError,
  type CloudExecutionProvisionInput,
  type CloudSandboxIsolationProviderOptions,
} from './execution-isolation.ts'
import { runSandboxRuntimeCommand } from './runtime-portability.ts'
import { SANDBOX_CONTAINER_WORKSPACE } from './sandbox-execution-environment.ts'

const CONTAINER_NODE = '/usr/local/bin/node'
const KNOWLEDGE_TRANSPORT_PROBE = `
const base = process.env.OPEN_COWORK_KNOWLEDGE_TOOL_URL
const token = process.env.OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN
if (!base || !token) process.exit(2)
const target = base.replace(/\\/+$/, '') + '/propose'
try {
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(5000),
  })
  process.exit(response.status === 400 ? 0 : 1)
} catch {
  process.exit(1)
}
`

function redactedFailure(reasonCode: string) {
  return new CloudExecutionIsolationError(reasonCode)
}

type PermissionEffect = 'allow' | 'ask' | 'deny'

function wildcardMatches(pattern: string, value: string) {
  let patternIndex = 0
  let valueIndex = 0
  let starIndex = -1
  let resumeValueIndex = 0
  while (valueIndex < value.length) {
    if (pattern[patternIndex] === '?' || pattern[patternIndex] === value[valueIndex]) {
      patternIndex += 1
      valueIndex += 1
    } else if (pattern[patternIndex] === '*') {
      starIndex = patternIndex
      patternIndex += 1
      resumeValueIndex = valueIndex
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1
      resumeValueIndex += 1
      valueIndex = resumeValueIndex
    } else {
      return false
    }
  }
  while (pattern[patternIndex] === '*') patternIndex += 1
  return patternIndex === pattern.length
}

function configuredPermissionEffect(
  permission: Record<string, unknown>,
  action: string,
  resource = '*',
) {
  let result: PermissionEffect = 'deny'
  for (const [actionPattern, raw] of Object.entries(permission)) {
    if (!wildcardMatches(actionPattern, action)) continue
    if (raw === 'allow' || raw === 'ask' || raw === 'deny') {
      result = raw
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    for (const [resourcePattern, effect] of Object.entries(raw)) {
      if (
        wildcardMatches(resourcePattern, resource)
        && (effect === 'allow' || effect === 'ask' || effect === 'deny')
      ) {
        result = effect
      }
    }
  }
  return result
}

function nativeAgentPermissionEffect(
  rules: Array<{ action?: unknown, resource?: unknown, effect?: unknown }>,
  action: string,
  resource = '*',
) {
  let result: PermissionEffect = 'deny'
  for (const rule of rules) {
    if (
      typeof rule.action === 'string'
      && typeof rule.resource === 'string'
      && wildcardMatches(rule.action, action)
      && wildcardMatches(rule.resource, resource)
      && (rule.effect === 'allow' || rule.effect === 'ask' || rule.effect === 'deny')
    ) {
      result = rule.effect
    }
  }
  return result
}

export async function waitForSandboxRuntimeReady(input: {
  url: string
  authorizationHeader: string
  timeoutMs: number
}) {
  const deadline = Date.now() + input.timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${input.url}/doc`, {
        headers: { Authorization: input.authorizationHeader },
        signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - Date.now()))),
      })
      if (response.ok) return
    } catch {
      // The detached container may still be loading OpenCode.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw redactedFailure('sandbox_runtime_readiness_timeout')
}

export async function verifySandboxRuntimeV2PolicyReady(input: {
  url: string
  authorizationHeader: string
  runtimeConfig: CloudExecutionProvisionInput['runtimeConfig']
}) {
  const permission = input.runtimeConfig?.permission
  if (
    !permission
    || typeof permission !== 'object'
    || Array.isArray(permission)
    || permission['*'] !== 'deny'
  ) {
    throw redactedFailure('sandbox_runtime_v2_policy_unverified')
  }
  const headers = {
    Authorization: input.authorizationHeader,
    'content-type': 'application/json',
  }
  let sessionId = ''
  let verified: boolean
  let failureStage = 'session'
  try {
    const sessionResponse = await fetch(`${input.url}/api/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agent: 'build',
        location: { directory: SANDBOX_CONTAINER_WORKSPACE },
      }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!sessionResponse.ok) throw new Error('session')
    const session = await sessionResponse.json() as { data?: { id?: unknown } }
    if (typeof session.data?.id !== 'string' || !session.data.id) {
      throw new Error('session')
    }
    sessionId = session.data.id

    failureStage = 'agent'
    let buildAgent: {
      permissions?: Array<{ action?: unknown, resource?: unknown, effect?: unknown }>
    } | null = null
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const agentsResponse = await fetch(`${input.url}/api/agent`, {
        headers: { Authorization: input.authorizationHeader },
        signal: AbortSignal.timeout(2_000),
      })
      if (agentsResponse.ok) {
        const agents = await agentsResponse.json() as {
          data?: Array<{
            id?: unknown
            permissions?: Array<{ action?: unknown, resource?: unknown, effect?: unknown }>
          }>
        }
        const candidate = agents.data?.find((agent) => agent.id === 'build')
        if (candidate) {
          buildAgent = candidate
          break
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
    if (!buildAgent?.permissions) throw new Error('agents')
    for (const [action, resource] of [
      ['bash', 'printf forbidden'],
      ['read', `${SANDBOX_CONTAINER_WORKSPACE}/readiness.txt`],
      ['edit', `${SANDBOX_CONTAINER_WORKSPACE}/readiness.txt`],
      ['mcp__knowledge__readiness_probe', '*'],
      ['open_cowork_unregistered_readiness_probe', '*'],
    ]) {
      if (
        nativeAgentPermissionEffect(buildAgent.permissions, action, resource)
        !== configuredPermissionEffect(permission, action, resource)
      ) {
        throw new Error('agents')
      }
    }

    failureStage = 'permission'
    const permissionResponse = await fetch(
      `${input.url}/api/session/${encodeURIComponent(sessionId)}/permission`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'open_cowork_unregistered_readiness_probe',
          resources: ['*'],
        }),
        signal: AbortSignal.timeout(5_000),
      },
    )
    if (!permissionResponse.ok) throw new Error('permission')
    const verdict = await permissionResponse.json() as {
      data?: { effect?: unknown }
    }
    verified = verdict.data?.effect === 'deny'
  } catch {
    verified = false
  }

  let sessionRemoved = !sessionId
  if (sessionId) {
    try {
      const response = await fetch(
        `${input.url}/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(SANDBOX_CONTAINER_WORKSPACE)}`,
        {
          method: 'DELETE',
          headers: { Authorization: input.authorizationHeader },
          signal: AbortSignal.timeout(5_000),
        },
      )
      sessionRemoved = response.ok
    } catch {
      sessionRemoved = false
    }
  }
  if (!verified || !sessionRemoved) {
    throw redactedFailure(
      sessionRemoved
        ? `sandbox_runtime_v2_${failureStage}_unverified`
        : 'sandbox_runtime_v2_session_cleanup_failed',
    )
  }
}

export async function verifySandboxKnowledgeTransportReady(input: {
  options: CloudSandboxIsolationProviderOptions
  boundaryId: string
  env: CloudExecutionProvisionInput['env']
}) {
  const url = input.env.OPEN_COWORK_KNOWLEDGE_TOOL_URL?.trim()
  const token = input.env.OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN?.trim()
  if (!url && !token) return
  if (!url || !token || input.options.policy.network.kind !== 'restricted') {
    throw redactedFailure('sandbox_knowledge_transport_unavailable')
  }
  const result = await runSandboxRuntimeCommand(
    'docker',
    [
      'exec',
      input.boundaryId,
      CONTAINER_NODE,
      '--input-type=module',
      '--eval',
      KNOWLEDGE_TRANSPORT_PROBE,
    ],
    input.options.runner,
  )
  if (result.exitCode !== 0) {
    throw redactedFailure('sandbox_knowledge_transport_unavailable')
  }
}
