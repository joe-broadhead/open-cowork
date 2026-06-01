#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const DEFAULT_TARGETS_PATH = 'deploy/load/launch-readiness-targets.json'
const DEFAULT_OUTPUT_DIR = '.open-cowork-test/launch-readiness'
const DEFAULT_TIMEOUT_MS = 10000

const args = parseArgs(process.argv.slice(2))

function parseArgs(argv) {
  const parsed = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      parsed.set(key, 'true')
    } else {
      parsed.set(key, next)
      index += 1
    }
  }
  return parsed
}

function argOrEnv(argName, envName, fallback = '') {
  return args.get(argName) || process.env[envName] || fallback
}

function boolArg(argName, envName) {
  return args.has(argName) || process.env[envName] === 'true'
}

function intArg(argName, envName, fallback) {
  const raw = argOrEnv(argName, envName)
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${argName} must be a positive integer.`)
  }
  return parsed
}

function floatArg(argName, envName, fallback) {
  const raw = argOrEnv(argName, envName)
  if (!raw) return fallback
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${argName} must be a positive number.`)
  }
  return parsed
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function normalizeUrl(value) {
  return value.replace(/\/+$/, '')
}

function safeUrl(url) {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return url ? '[invalid-url]' : ''
  }
}

function currentCommitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

const PRIVATE_EVIDENCE_PATTERNS = [
  /(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /ya29\.[A-Za-z0-9_-]{8,}/i,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /(?:postgres(?:ql)?|mysql|mongodb):\/\//i,
  /bearer\s+[A-Za-z0-9._-]{8,}/i,
  /(?:token|secret|password|api[_-]?key)=/i,
]

function safeEvidenceText(value, fallback = 'not-provided') {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return fallback
  if (PRIVATE_EVIDENCE_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'redacted-private-value'
  }
  return text.replace(/\s+/g, ' ').slice(0, 512)
}

function commandNameFor(options) {
  if (options.mode === 'plan') return 'pnpm deploy:load:plan'
  if (options.mode === 'soak') return options.strict ? 'pnpm deploy:soak:strict' : 'pnpm deploy:soak'
  return options.strict ? 'pnpm deploy:load:strict' : 'pnpm deploy:load'
}

function createEvidenceMetadata(options, status = 'plan') {
  return {
    command: commandNameFor(options),
    commitSha: safeEvidenceText(options.commitSha, 'unknown'),
    imageDigests: {
      cloud: safeEvidenceText(options.cloudImageDigest),
      gateway: safeEvidenceText(options.gatewayImageDigest),
    },
    environmentProfile: {
      profileName: options.profileName,
      mode: options.mode,
      strict: options.strict,
      cloudUrl: options.skipCloud ? 'skipped' : safeUrl(options.cloudUrl),
      gatewayUrl: options.skipGateway ? 'skipped' : safeUrl(options.gatewayUrl),
      cloudTokenProvided: Boolean(options.cloudToken),
      gatewayAdminTokenProvided: Boolean(options.gatewayAdminToken),
      includeMutations: options.includeMutations,
      includeSse: options.includeSse,
      includeOperator: options.includeOperator,
      byokProvider: safeEvidenceText(options.byokProvider),
    },
    status,
  }
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function round(value, places = 2) {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}`, Connection: 'close' } : { Connection: 'close' }
}

function jsonHeaders(token) {
  return {
    ...authHeaders(token),
    'content-type': 'application/json',
  }
}

async function requestJson(baseUrl, operation, token, body) {
  const response = await timedFetch(`${baseUrl}${operation.path}`, {
    method: operation.method || 'GET',
    headers: body === undefined ? authHeaders(token) : jsonHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.response.text()
  if (!operation.acceptedStatus.includes(response.response.status)) {
    throw new Error(`${operation.name} returned ${response.response.status}: ${text.slice(0, 240)}`)
  }
  const parsed = parseResponseBody(text)
  return {
    status: response.response.status,
    latencyMs: response.latencyMs,
    body: parsed,
  }
}

function parseResponseBody(text) {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return text
  }
}

async function requestText(baseUrl, operation, token) {
  const response = await timedFetch(`${baseUrl}${operation.path}`, {
    method: operation.method || 'GET',
    headers: authHeaders(token),
  })
  const text = await response.response.text()
  if (!operation.acceptedStatus.includes(response.response.status)) {
    throw new Error(`${operation.name} returned ${response.response.status}: ${text.slice(0, 240)}`)
  }
  return {
    status: response.response.status,
    latencyMs: response.latencyMs,
    body: text,
  }
}

async function timedFetch(url, init) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  const started = performance.now()
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    })
    return {
      response,
      latencyMs: performance.now() - started,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function requestSseProbe(baseUrl, operation, token, durationMs) {
  const controller = new AbortController()
  const started = performance.now()
  let chunks = 0
  const timeout = setTimeout(() => controller.abort(), durationMs)
  try {
    const response = await fetch(`${baseUrl}${operation.path}`, {
      headers: authHeaders(token),
      signal: controller.signal,
    })
    if (!operation.acceptedStatus.includes(response.status)) {
      const text = await response.text()
      throw new Error(`${operation.name} returned ${response.status}: ${text.slice(0, 240)}`)
    }
    const reader = response.body?.getReader()
    while (reader) {
      const read = await reader.read()
      if (read.done) break
      chunks += 1
      if (performance.now() - started >= durationMs) {
        controller.abort()
        break
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    clearTimeout(timeout)
  }
  return {
    status: 200,
    latencyMs: performance.now() - started,
    body: { chunks },
  }
}

function extractSessionId(body) {
  const session = body?.session || body
  const sessionId = session?.sessionId || session?.id
  return typeof sessionId === 'string' && sessionId ? sessionId : null
}

function extractArtifactId(body) {
  const artifact = body?.artifact || body
  const artifactId = artifact?.id || artifact?.artifactId
  return typeof artifactId === 'string' && artifactId ? artifactId : null
}

function extractWorkflowId(body) {
  const workflow = body?.workflow || body
  const workflowId = workflow?.id || workflow?.workflowId
  return typeof workflowId === 'string' && workflowId ? workflowId : null
}

function createOperationPlan(options) {
  const operations = []
  const acceptedUnauthed = options.cloudToken ? [200] : [200, 401, 403]
  const acceptedAuthenticatedRead = options.strict ? [200] : [200, 403]

  if (!options.skipCloud) {
    operations.push({
      name: 'cloud-health',
      category: 'read',
      target: 'cloud',
      path: '/healthz',
      acceptedStatus: [200],
      run: () => requestJson(options.cloudUrl, operationsByName.get('cloud-health'), ''),
    })
    operations.push({
      name: 'cloud-liveness',
      category: 'read',
      target: 'cloud',
      path: '/livez',
      acceptedStatus: [200],
      run: () => requestJson(options.cloudUrl, operationsByName.get('cloud-liveness'), ''),
    })
    operations.push({
      name: 'cloud-web-workbench',
      category: 'read',
      target: 'cloud',
      path: '/',
      acceptedStatus: [200],
      run: () => requestText(options.cloudUrl, operationsByName.get('cloud-web-workbench'), ''),
    })
    operations.push({
      name: 'cloud-config-bootstrap',
      category: 'read',
      target: 'cloud',
      path: '/api/config',
      acceptedStatus: acceptedUnauthed,
      run: () => requestJson(options.cloudUrl, operationsByName.get('cloud-config-bootstrap'), options.cloudToken),
    })
    operations.push({
      name: 'cloud-workspace-bootstrap',
      category: 'read',
      target: 'cloud',
      path: '/api/workspace',
      acceptedStatus: acceptedUnauthed,
      run: () => requestJson(options.cloudUrl, operationsByName.get('cloud-workspace-bootstrap'), options.cloudToken),
    })

    if (options.cloudToken) {
      for (const operation of [
        ['cloud-session-list', 'read', '/api/sessions'],
        ['cloud-thread-list', 'read', '/api/threads?limit=50'],
        ['cloud-thread-tags', 'read', '/api/threads/tags'],
        ['cloud-thread-smart-filters', 'read', '/api/threads/smart-filters'],
        ['cloud-workflow-list', 'read', '/api/workflows'],
        ['cloud-byok-status', 'read', '/api/byok'],
        ['cloud-usage-summary', 'operator', '/api/usage/summary?limit=25'],
        ['cloud-channel-deliveries', 'gateway', '/api/channels/deliveries?limit=25'],
      ]) {
        operations.push({
          name: operation[0],
          category: operation[1],
          target: 'cloud',
          path: operation[2],
          acceptedStatus: acceptedAuthenticatedRead,
          run: () => requestJson(options.cloudUrl, operationsByName.get(operation[0]), options.cloudToken),
        })
      }
    }

    if (options.includeOperator && options.cloudToken) {
      for (const operation of [
        ['cloud-admin-policy', 'operator', '/api/admin/policy'],
        ['cloud-worker-heartbeats', 'operator', '/api/workers/heartbeats'],
        ['cloud-runtime-status', 'operator', '/api/runtime/status'],
      ]) {
        operations.push({
          name: operation[0],
          category: operation[1],
          target: 'cloud',
          path: operation[2],
          acceptedStatus: acceptedAuthenticatedRead,
          run: () => requestJson(options.cloudUrl, operationsByName.get(operation[0]), options.cloudToken),
        })
      }
      operations.push({
        name: 'cloud-prometheus-metrics',
        category: 'operator',
        target: 'cloud',
        path: '/api/metrics',
        acceptedStatus: acceptedAuthenticatedRead,
        run: () => requestText(options.cloudUrl, operationsByName.get('cloud-prometheus-metrics'), options.cloudToken),
      })
    }

    if (options.byokProvider && options.cloudToken) {
      operations.push({
        name: 'cloud-byok-provider-validate',
        category: 'mutation',
        target: 'cloud',
        path: `/api/byok/${encodeURIComponent(options.byokProvider)}/validate`,
        method: 'POST',
        acceptedStatus: options.strict ? [200] : [200, 403, 404],
        run: () => requestJson(
          options.cloudUrl,
          operationsByName.get('cloud-byok-provider-validate'),
          options.cloudToken,
          {},
        ),
      })
    }

    if (options.includeSse && options.cloudToken) {
      operations.push({
        name: 'cloud-workspace-sse',
        category: 'sse',
        target: 'cloud',
        path: '/api/events',
        acceptedStatus: [200],
        run: () => requestSseProbe(
          options.cloudUrl,
          operationsByName.get('cloud-workspace-sse'),
          options.cloudToken,
          Math.min(2000, Math.max(250, Math.floor(options.durationMs / 4))),
        ),
      })
    }

    if (options.includeMutations && options.cloudToken) {
      operations.push({
        name: 'cloud-session-create',
        category: 'mutation',
        target: 'cloud',
        path: '/api/sessions',
        method: 'POST',
        acceptedStatus: [201, 202],
        run: async () => {
          if (options.createdSessions.length >= options.maxMutatingSessions) {
            return requestJson(options.cloudUrl, operationsByName.get('cloud-session-list'), options.cloudToken)
          }
          const result = await requestJson(
            options.cloudUrl,
            operationsByName.get('cloud-session-create'),
            options.cloudToken,
            {},
          )
          const sessionId = extractSessionId(result.body)
          if (sessionId) options.createdSessions.push(sessionId)
          return result
        },
      })
      operations.push({
        name: 'cloud-prompt-enqueue',
        category: 'mutation',
        target: 'cloud',
        path: '/api/sessions/:id/prompt',
        method: 'POST',
        acceptedStatus: [202],
        run: async () => {
          const sessionId = options.createdSessions[options.promptIndex % Math.max(1, options.createdSessions.length)]
            || await createSetupSession(options)
          options.promptIndex += 1
          const operation = {
            ...operationsByName.get('cloud-prompt-enqueue'),
            path: `/api/sessions/${encodeURIComponent(sessionId)}/prompt`,
          }
          return requestJson(options.cloudUrl, operation, options.cloudToken, {
            text: `Open Cowork launch readiness probe ${new Date().toISOString()}`,
            agent: options.agent,
          })
        },
      })
      operations.push({
        name: 'cloud-artifact-upload',
        category: 'mutation',
        target: 'cloud',
        path: '/api/sessions/:id/artifacts',
        method: 'POST',
        acceptedStatus: [201],
        run: async () => uploadSetupArtifact(options),
      })
      operations.push({
        name: 'cloud-artifact-download',
        category: 'read',
        target: 'cloud',
        path: '/api/sessions/:sessionId/artifacts/:artifactId',
        acceptedStatus: [200],
        run: async () => {
          const artifact = options.createdArtifacts[options.artifactIndex % Math.max(1, options.createdArtifacts.length)]
            || await ensureSetupArtifact(options)
          options.artifactIndex += 1
          return requestJson(options.cloudUrl, {
            ...operationsByName.get('cloud-artifact-download'),
            path: `/api/sessions/${encodeURIComponent(artifact.sessionId)}/artifacts/${encodeURIComponent(artifact.artifactId)}`,
          }, options.cloudToken)
        },
      })
      operations.push({
        name: 'cloud-workflow-create',
        category: 'mutation',
        target: 'cloud',
        path: '/api/workflows',
        method: 'POST',
        acceptedStatus: [201],
        run: async () => {
          if (options.createdWorkflows.length >= options.maxMutatingWorkflows) {
            return requestJson(options.cloudUrl, operationsByName.get('cloud-workflow-list'), options.cloudToken)
          }
          return createSetupWorkflow(options)
        },
      })
      operations.push({
        name: 'cloud-workflow-run',
        category: 'mutation',
        target: 'cloud',
        path: '/api/workflows/:id/run',
        method: 'POST',
        acceptedStatus: [202],
        run: async () => {
          const workflowId = options.createdWorkflows[options.workflowIndex % Math.max(1, options.createdWorkflows.length)]
            || await createSetupWorkflow(options).then((result) => extractWorkflowId(result.body))
          options.workflowIndex += 1
          if (!workflowId) throw new Error('Workflow create did not return workflow.id.')
          return requestJson(options.cloudUrl, {
            ...operationsByName.get('cloud-workflow-run'),
            path: `/api/workflows/${encodeURIComponent(workflowId)}/run`,
          }, options.cloudToken, {
            triggerType: 'manual',
            triggerPayload: { source: 'launch-readiness' },
          })
        },
      })
    }
  }

  if (!options.skipGateway) {
    operations.push({
      name: 'gateway-health',
      category: 'gateway',
      target: 'gateway',
      path: '/health',
      acceptedStatus: [200],
      run: () => requestJson(options.gatewayUrl, operationsByName.get('gateway-health'), ''),
    })
    operations.push({
      name: 'gateway-readiness',
      category: 'gateway',
      target: 'gateway',
      path: '/ready',
      acceptedStatus: [200],
      run: () => requestJson(options.gatewayUrl, operationsByName.get('gateway-readiness'), ''),
    })
    if (options.includeOperator && options.gatewayAdminToken) {
      operations.push({
        name: 'gateway-prometheus-metrics',
        category: 'gateway',
        target: 'gateway',
        path: '/metrics',
        acceptedStatus: [200],
        run: () => requestText(options.gatewayUrl, operationsByName.get('gateway-prometheus-metrics'), options.gatewayAdminToken),
      })
    }
  }

  operationsByName = new Map(operations.map((operation) => [operation.name, operation]))
  return operations
}

let operationsByName = new Map()

async function createSetupSession(options) {
  const result = await requestJson(options.cloudUrl, {
    name: 'cloud-session-create-setup',
    path: '/api/sessions',
    method: 'POST',
    acceptedStatus: [201, 202],
  }, options.cloudToken, {})
  const sessionId = extractSessionId(result.body)
  if (!sessionId) {
    throw new Error('Cloud session create did not return session.sessionId.')
  }
  if (options.createdSessions.length < options.maxMutatingSessions) {
    options.createdSessions.push(sessionId)
  }
  return sessionId
}

async function uploadArtifact(options) {
  const sessionId = options.createdSessions[options.artifactIndex % Math.max(1, options.createdSessions.length)]
    || await createSetupSession(options)
  const result = await requestJson(options.cloudUrl, {
    name: 'cloud-artifact-upload',
    path: `/api/sessions/${encodeURIComponent(sessionId)}/artifacts`,
    method: 'POST',
    acceptedStatus: [201],
  }, options.cloudToken, {
    filename: `launch-readiness-${Date.now()}.txt`,
    contentType: 'text/plain',
    dataBase64: Buffer.from('open-cowork launch readiness artifact\n', 'utf8').toString('base64'),
  })
  const artifactId = extractArtifactId(result.body)
  if (!artifactId) {
    throw new Error('Artifact upload did not return artifact.id.')
  }
  const artifact = { sessionId, artifactId }
  if (options.createdArtifacts.length < options.maxMutatingArtifacts) {
    options.createdArtifacts.push(artifact)
  }
  return { artifact, result }
}

async function uploadSetupArtifact(options) {
  const uploaded = await uploadArtifact(options)
  return uploaded.result
}

async function ensureSetupArtifact(options) {
  const uploaded = await uploadArtifact(options)
  return uploaded.artifact
}

async function createSetupWorkflow(options) {
  const result = await requestJson(options.cloudUrl, {
    name: 'cloud-workflow-create',
    path: '/api/workflows',
    method: 'POST',
    acceptedStatus: [201],
  }, options.cloudToken, {
    title: `Launch readiness workflow ${new Date().toISOString()}`,
    instructions: 'Return a short launch readiness acknowledgement.',
    agentName: options.agent,
    skillNames: [],
    toolIds: [],
    triggers: [],
  })
  const workflowId = extractWorkflowId(result.body)
  if (!workflowId) {
    throw new Error('Workflow create did not return workflow.id.')
  }
  if (options.createdWorkflows.length < options.maxMutatingWorkflows) {
    options.createdWorkflows.push(workflowId)
  }
  return result
}

async function runOperation(operation, samples) {
  const started = performance.now()
  try {
    const result = await operation.run()
    samples.push({
      name: operation.name,
      category: operation.category,
      target: operation.target,
      status: result.status,
      ok: true,
      latencyMs: result.latencyMs,
    })
  } catch (error) {
    samples.push({
      name: operation.name,
      category: operation.category,
      target: operation.target,
      status: 0,
      ok: false,
      latencyMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function runLoad(options, operations) {
  const samples = []
  const startedAt = new Date()
  const deadline = performance.now() + options.durationMs
  const pauseMs = Math.max(0, Math.floor((1000 * options.concurrency) / options.requestRatePerSecond))
  let nextOperation = 0

  async function worker() {
    while (performance.now() < deadline) {
      const operation = operations[nextOperation % operations.length]
      nextOperation += 1
      await runOperation(operation, samples)
      if (pauseMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, pauseMs))
      }
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()))
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    samples,
  }
}

async function collectMetrics(options) {
  const metrics = {}
  if (!options.skipCloud && options.cloudToken) {
    const response = await fetch(`${options.cloudUrl}/api/metrics`, {
      headers: authHeaders(options.cloudToken),
    }).catch(() => null)
    if (response?.ok) {
      const text = await response.text()
      for (const name of [
        'open_cowork_cloud_command_queue_depth_estimate',
        'open_cowork_cloud_command_oldest_age_ms',
        'open_cowork_cloud_projection_lag_events',
        'open_cowork_cloud_sse_connections',
        'open_cowork_cloud_quota_rejections_total',
        'open_cowork_cloud_worker_stale_owner_rejections_total',
      ]) {
        metrics[name] = readPrometheusMetric(text, name)
      }
    }
  }
  if (!options.skipGateway && options.gatewayAdminToken) {
    const response = await fetch(`${options.gatewayUrl}/metrics`, {
      headers: authHeaders(options.gatewayAdminToken),
    }).catch(() => null)
    if (response?.ok) {
      const text = await response.text()
      for (const name of [
        'open_cowork_gateway_delivery_retries_total',
        'open_cowork_gateway_delivery_dead_letters_total',
        'open_cowork_gateway_stream_reconnects_total',
        'open_cowork_gateway_session_streams',
      ]) {
        metrics[name] = readPrometheusMetric(text, name)
      }
    }
  }
  return metrics
}

function diffMetrics(before, after) {
  const diff = {}
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const beforeValue = before[name]
    const afterValue = after[name]
    diff[name] = typeof beforeValue === 'number' && typeof afterValue === 'number'
      ? Math.max(0, afterValue - beforeValue)
      : typeof afterValue === 'number'
        ? afterValue
        : null
  }
  return diff
}

function readPrometheusMetric(text, name) {
  let total = 0
  let found = false
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) continue
    if (line === '' || !(line.startsWith(`${name} `) || line.startsWith(`${name}{`))) continue
    const value = Number.parseFloat(line.slice(line.lastIndexOf(' ') + 1))
    if (Number.isFinite(value)) {
      total += value
      found = true
    }
  }
  return found ? total : null
}

function summarizeSamples(samples) {
  const byOperation = new Map()
  const byCategory = new Map()
  for (const sample of samples) {
    for (const map of [byOperation, byCategory]) {
      const key = map === byOperation ? sample.name : sample.category
      const summary = map.get(key) || { count: 0, failures: 0, latencies: [], statuses: new Map(), errors: [] }
      summary.count += 1
      if (!sample.ok) summary.failures += 1
      summary.latencies.push(sample.latencyMs)
      summary.statuses.set(sample.status, (summary.statuses.get(sample.status) || 0) + 1)
      if (sample.error && summary.errors.length < 5) summary.errors.push(sample.error)
      map.set(key, summary)
    }
  }
  return {
    operations: Object.fromEntries([...byOperation.entries()].map(([name, value]) => [name, summarizeBucket(value)])),
    categories: Object.fromEntries([...byCategory.entries()].map(([name, value]) => [name, summarizeBucket(value)])),
  }
}

function summarizeBucket(bucket) {
  return {
    count: bucket.count,
    failures: bucket.failures,
    errorRate: bucket.count === 0 ? 0 : round(bucket.failures / bucket.count, 4),
    p50LatencyMs: round(percentile(bucket.latencies, 50)),
    p95LatencyMs: round(percentile(bucket.latencies, 95)),
    p99LatencyMs: round(percentile(bucket.latencies, 99)),
    statuses: Object.fromEntries([...bucket.statuses.entries()].map(([status, count]) => [String(status), count])),
    sampleErrors: bucket.errors,
  }
}

function evaluateGates(options, summary, metrics, operations) {
  const thresholds = options.profile.thresholds
  const all = summarizeBucket({
    count: Object.values(summary.operations).reduce((sum, item) => sum + item.count, 0),
    failures: Object.values(summary.operations).reduce((sum, item) => sum + item.failures, 0),
    latencies: [],
    statuses: new Map(),
    errors: [],
  })
  const allLatencies = Object.values(summary.operations).flatMap((operation) => {
    const approx = []
    for (let index = 0; index < operation.count; index += 1) approx.push(operation.p50LatencyMs)
    return approx
  })
  all.p95LatencyMs = round(percentile(allLatencies, 95))
  all.errorRate = all.count === 0 ? 1 : round(all.failures / all.count, 4)

  const checks = []
  for (const operation of operations) {
    checks.push(check(
      `${operation.name}-sampled`,
      Boolean(summary.operations[operation.name]?.count),
      `${operation.name} collected at least one sample`,
    ))
  }
  checks.push(check(
    'overall-error-rate',
    all.errorRate <= thresholds.maxOverallErrorRate,
    `overall error rate ${all.errorRate} <= ${thresholds.maxOverallErrorRate}`,
  ))

  for (const [name, operation] of Object.entries(summary.operations)) {
    checks.push(check(
      `${name}-operation-error-rate`,
      operation.errorRate <= thresholds.maxOperationErrorRate,
      `${name} error rate ${operation.errorRate} <= ${thresholds.maxOperationErrorRate}`,
    ))
  }

  const readP95 = summary.categories.read?.p95LatencyMs || 0
  const mutationP95 = summary.categories.mutation?.p95LatencyMs || 0
  const gatewayP95 = summary.categories.gateway?.p95LatencyMs || 0
  checks.push(check('read-p95', readP95 <= thresholds.p95ReadLatencyMs, `read p95 ${readP95}ms <= ${thresholds.p95ReadLatencyMs}ms`))
  if (summary.categories.mutation) {
    checks.push(check('mutation-p95', mutationP95 <= thresholds.p95MutationLatencyMs, `mutation p95 ${mutationP95}ms <= ${thresholds.p95MutationLatencyMs}ms`))
  }
  if (summary.categories.gateway) {
    checks.push(check('gateway-p95', gatewayP95 <= thresholds.p95GatewayLatencyMs, `gateway p95 ${gatewayP95}ms <= ${thresholds.p95GatewayLatencyMs}ms`))
  }

  const metricAfter = metrics.after || metrics
  const metricDelta = metrics.delta || metrics
  const projectionLag = metricAfter.open_cowork_cloud_projection_lag_events
  if (projectionLag !== null && projectionLag !== undefined) {
    checks.push(check(
      'projection-lag',
      projectionLag <= thresholds.maxProjectionLagEvents,
      `projection lag ${projectionLag} <= ${thresholds.maxProjectionLagEvents}`,
    ))
  }
  const commandAge = metricAfter.open_cowork_cloud_command_oldest_age_ms
  if (commandAge !== null && commandAge !== undefined) {
    checks.push(check(
      'command-oldest-age',
      commandAge <= thresholds.maxCommandOldestAgeMs,
      `oldest command age ${commandAge}ms <= ${thresholds.maxCommandOldestAgeMs}ms`,
    ))
  }
  const quotaRejections = metricDelta.open_cowork_cloud_quota_rejections_total
  if (quotaRejections !== null && quotaRejections !== undefined) {
    checks.push(check(
      'quota-rejections',
      options.expectQuotaRejections
        ? quotaRejections > 0
        : quotaRejections <= thresholds.maxUnexpectedQuotaRejections,
      options.expectQuotaRejections
        ? `quota pressure produced ${quotaRejections} rejection(s)`
        : `unexpected quota rejections ${quotaRejections} <= ${thresholds.maxUnexpectedQuotaRejections}`,
    ))
  }
  const gatewayDeadLetters = metricDelta.open_cowork_gateway_delivery_dead_letters_total
  if (gatewayDeadLetters !== null && gatewayDeadLetters !== undefined) {
    checks.push(check(
      'gateway-dead-letters',
      gatewayDeadLetters <= thresholds.maxGatewayDeadLetters,
      `gateway dead letters ${gatewayDeadLetters} <= ${thresholds.maxGatewayDeadLetters}`,
    ))
  }
  const durationMinutes = Math.max(1 / 60, options.durationMs / 60000)
  const gatewayRetryRate = metricDelta.open_cowork_gateway_delivery_retries_total === null || metricDelta.open_cowork_gateway_delivery_retries_total === undefined
    ? null
    : metricDelta.open_cowork_gateway_delivery_retries_total / durationMinutes
  if (gatewayRetryRate !== null) {
    checks.push(check(
      'gateway-retry-rate',
      gatewayRetryRate <= thresholds.maxGatewayRetryRatePerMinute,
      `gateway retry rate ${round(gatewayRetryRate)} per minute <= ${thresholds.maxGatewayRetryRatePerMinute}`,
    ))
  }
  const sseReconnectRate = metricDelta.open_cowork_gateway_stream_reconnects_total === null || metricDelta.open_cowork_gateway_stream_reconnects_total === undefined
    ? null
    : metricDelta.open_cowork_gateway_stream_reconnects_total / durationMinutes
  if (sseReconnectRate !== null) {
    checks.push(check(
      'sse-reconnect-rate',
      sseReconnectRate <= thresholds.maxSseReconnectsPerMinute,
      `SSE reconnect rate ${round(sseReconnectRate)} per minute <= ${thresholds.maxSseReconnectsPerMinute}`,
    ))
  }

  const warnings = []
  if (!options.cloudToken) warnings.push('Cloud bearer token was not provided; authenticated reads, mutations, SSE, BYOK, usage, and admin checks were skipped.')
  if (!options.includeMutations) warnings.push('Mutating session/prompt checks were disabled. Set OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true for launch qualification.')
  if (!options.includeSse) warnings.push('SSE fanout probe was disabled. Set OPEN_COWORK_LOAD_INCLUDE_SSE=true for launch qualification.')
  if (!options.includeOperator) warnings.push('Operator metrics/admin checks were disabled. Set OPEN_COWORK_LOAD_OPERATOR_CHECKS=true for launch qualification.')
  if (options.includeOperator && !options.gatewayAdminToken && !options.skipGateway) warnings.push('Gateway admin token was not provided; gateway metric thresholds could not be evaluated.')
  if (!options.byokProvider) warnings.push('BYOK provider validation was skipped. Set OPEN_COWORK_LOAD_BYOK_PROVIDER for managed BYOK launch qualification.')
  if (options.skipGateway) warnings.push('Gateway checks were skipped.')
  if (!operations.some((operation) => operation.category === 'mutation') && options.includeMutations) {
    warnings.push('Mutating checks were requested but no mutating operation was planned; verify cloud token configuration.')
  }

  const failed = checks.filter((item) => item.status === 'fail')
  const warningFailed = options.strict ? warnings.map((message) => ({
    name: `strict-warning-${message.slice(0, 32).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
    status: 'fail',
    message,
  })) : []

  return {
    overall: failed.length === 0 && warningFailed.length === 0 ? warnings.length > 0 ? 'conditional-go' : 'go' : 'no-go',
    checks: [...checks, ...warningFailed],
    warnings,
  }
}

function check(name, passed, message) {
  return {
    name,
    status: passed ? 'pass' : 'fail',
    message,
  }
}

function createPlanMarkdown(options, operations) {
  const targets = Object.entries(options.profile.capacityTargets)
    .map(([name, value]) => `- ${name}: ${value}`)
    .join('\n')
  const thresholds = Object.entries(options.profile.thresholds)
    .map(([name, value]) => `- ${name}: ${value}`)
    .join('\n')
  const operationRows = operations
    .map((operation) => `| ${operation.name} | ${operation.target} | ${operation.category} | \`${operation.method || 'GET'} ${operation.path}\` |`)
    .join('\n')
  return `# Open Cowork Launch Readiness Plan

Profile: \`${options.profileName}\`
Command: \`${commandNameFor(options)}\`
Commit SHA: \`${safeEvidenceText(options.commitSha, 'unknown')}\`

${options.profile.description}

## Evidence Metadata

\`\`\`json
${JSON.stringify(createEvidenceMetadata(options), null, 2)}
\`\`\`

## Capacity Targets

${targets}

## Thresholds

${thresholds}

## Planned Operations

| Operation | Target | Category | Route |
| --- | --- | --- | --- |
${operationRows}

## Required Qualification Mode

Launch qualification should run with:

- \`OPEN_COWORK_LOAD_CLOUD_TOKEN\`
- \`OPEN_COWORK_LOAD_GATEWAY_ADMIN_TOKEN\` when gateway metrics are enabled
- \`OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true\`
- \`OPEN_COWORK_LOAD_INCLUDE_SSE=true\`
- \`OPEN_COWORK_LOAD_OPERATOR_CHECKS=true\`
- \`--strict\` so skipped capacity areas fail the gate
`
}

function createMarkdownReport(report) {
  const operationRows = Object.entries(report.summary.operations)
    .map(([name, item]) => `| ${name} | ${item.count} | ${item.errorRate} | ${item.p50LatencyMs} | ${item.p95LatencyMs} | ${item.p99LatencyMs} | ${Object.entries(item.statuses).map(([status, count]) => `${status}:${count}`).join(', ')} |`)
    .join('\n')
  const categoryRows = Object.entries(report.summary.categories)
    .map(([name, item]) => `| ${name} | ${item.count} | ${item.errorRate} | ${item.p95LatencyMs} |`)
    .join('\n')
  const checks = report.gates.checks
    .map((item) => `- ${item.status === 'pass' ? '[x]' : '[ ]'} ${item.name}: ${item.message}`)
    .join('\n')
  const warnings = report.gates.warnings.length > 0
    ? report.gates.warnings.map((item) => `- ${item}`).join('\n')
    : '- none'

  return `# Open Cowork Launch Readiness Report

Generated at: ${report.generatedAt}

Mode: \`${report.mode}\`
Profile: \`${report.profileName}\`
Result: **${report.gates.overall}**

## Evidence Metadata

- Command: \`${report.evidence.command}\`
- Commit SHA: \`${report.evidence.commitSha}\`
- Cloud image digest: \`${report.evidence.imageDigests.cloud}\`
- Gateway image digest: \`${report.evidence.imageDigests.gateway}\`
- Started at: \`${report.evidence.startedAt}\`
- Finished at: \`${report.evidence.finishedAt}\`
- Duration: \`${report.evidence.durationMs}ms\`
- Status: \`${report.evidence.status}\`

Sanitized environment profile:

\`\`\`json
${JSON.stringify(report.evidence.environmentProfile, null, 2)}
\`\`\`

## Targets

- Cloud URL: ${report.targets.cloudUrl || 'skipped'}
- Gateway URL: ${report.targets.gatewayUrl || 'skipped'}
- Duration: ${report.run.durationMs}ms
- Concurrency: ${report.run.concurrency}
- Request rate: ${report.run.requestRatePerSecond}/s

## Gate Checks

${checks}

## Warnings

${warnings}

## Operation Summary

| Operation | Count | Error rate | p50 ms | p95 ms | p99 ms | Statuses |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
${operationRows}

## Category Summary

| Category | Count | Error rate | p95 ms |
| --- | ---: | ---: | ---: |
${categoryRows}

## Metrics Snapshot

\`\`\`json
${JSON.stringify(report.metrics, null, 2)}
\`\`\`

## Next Actions

${report.gates.overall === 'go'
    ? '- Keep this report with the release evidence and proceed to final smoke checks.'
    : '- Address failed checks or warnings, rerun in strict launch mode, and attach the new report to the release evidence.'}
`
}

async function main() {
  const targetsPath = argOrEnv('targets', 'OPEN_COWORK_LOAD_TARGETS', DEFAULT_TARGETS_PATH)
  const targets = readJson(targetsPath)
  const profileName = argOrEnv('profile', 'OPEN_COWORK_LOAD_PROFILE', 'local-self-host-beta')
  const profile = targets.profiles?.[profileName]
  if (!profile) {
    throw new Error(`Unknown launch-readiness profile ${profileName}.`)
  }
  const mode = argOrEnv('mode', 'OPEN_COWORK_LOAD_MODE', args.has('plan') ? 'plan' : 'load')
  if (!['plan', 'load', 'soak'].includes(mode)) {
    throw new Error('mode must be one of plan, load, or soak.')
  }
  const options = {
    mode,
    profileName,
    profile,
    strict: boolArg('strict', 'OPEN_COWORK_LOAD_STRICT'),
    cloudUrl: normalizeUrl(argOrEnv('cloud-url', 'OPEN_COWORK_LOAD_CLOUD_URL', process.env.OPEN_COWORK_SMOKE_CLOUD_URL || 'http://127.0.0.1:8787')),
    gatewayUrl: normalizeUrl(argOrEnv('gateway-url', 'OPEN_COWORK_LOAD_GATEWAY_URL', process.env.OPEN_COWORK_SMOKE_GATEWAY_URL || 'http://127.0.0.1:8790')),
    cloudToken: argOrEnv('cloud-token', 'OPEN_COWORK_LOAD_CLOUD_TOKEN', process.env.OPEN_COWORK_SMOKE_CLOUD_TOKEN || ''),
    gatewayAdminToken: argOrEnv('gateway-admin-token', 'OPEN_COWORK_LOAD_GATEWAY_ADMIN_TOKEN', process.env.OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN || ''),
    commitSha: argOrEnv('commit-sha', 'OPEN_COWORK_EVIDENCE_COMMIT_SHA', currentCommitSha()),
    cloudImageDigest: argOrEnv('cloud-image-digest', 'OPEN_COWORK_EVIDENCE_CLOUD_IMAGE_DIGEST', ''),
    gatewayImageDigest: argOrEnv('gateway-image-digest', 'OPEN_COWORK_EVIDENCE_GATEWAY_IMAGE_DIGEST', ''),
    durationMs: intArg('duration-ms', 'OPEN_COWORK_LOAD_DURATION_MS', mode === 'soak' ? profile.soakDurationMs : profile.durationMs),
    concurrency: intArg('concurrency', 'OPEN_COWORK_LOAD_CONCURRENCY', profile.concurrency),
    requestRatePerSecond: floatArg('request-rate', 'OPEN_COWORK_LOAD_REQUEST_RATE', profile.requestRatePerSecond),
    outputDir: argOrEnv('output-dir', 'OPEN_COWORK_LOAD_OUTPUT_DIR', DEFAULT_OUTPUT_DIR),
    skipCloud: boolArg('skip-cloud', 'OPEN_COWORK_LOAD_SKIP_CLOUD'),
    skipGateway: boolArg('skip-gateway', 'OPEN_COWORK_LOAD_SKIP_GATEWAY'),
    includeMutations: boolArg('include-mutations', 'OPEN_COWORK_LOAD_INCLUDE_MUTATIONS'),
    includeSse: boolArg('include-sse', 'OPEN_COWORK_LOAD_INCLUDE_SSE'),
    includeOperator: boolArg('operator', 'OPEN_COWORK_LOAD_OPERATOR_CHECKS'),
    expectQuotaRejections: boolArg('expect-quota-rejections', 'OPEN_COWORK_LOAD_EXPECT_QUOTA_REJECTIONS'),
    maxMutatingSessions: intArg('max-mutating-sessions', 'OPEN_COWORK_LOAD_MAX_MUTATING_SESSIONS', 25),
    maxMutatingArtifacts: intArg('max-mutating-artifacts', 'OPEN_COWORK_LOAD_MAX_MUTATING_ARTIFACTS', 25),
    maxMutatingWorkflows: intArg('max-mutating-workflows', 'OPEN_COWORK_LOAD_MAX_MUTATING_WORKFLOWS', 10),
    byokProvider: argOrEnv('byok-provider', 'OPEN_COWORK_LOAD_BYOK_PROVIDER', ''),
    agent: argOrEnv('agent', 'OPEN_COWORK_LOAD_AGENT', 'build'),
    createdSessions: [],
    createdArtifacts: [],
    createdWorkflows: [],
    promptIndex: 0,
    artifactIndex: 0,
    workflowIndex: 0,
  }

  const operations = createOperationPlan(options)
  if (operations.length === 0) {
    throw new Error('No launch-readiness operations were planned. Check skip flags and URLs.')
  }

  mkdirSync(options.outputDir, { recursive: true })
  if (mode === 'plan') {
    const plan = createPlanMarkdown(options, operations)
    const planPath = join(options.outputDir, `${profileName}-launch-readiness-plan.md`)
    writeFileSync(planPath, plan)
    process.stdout.write(`${JSON.stringify({ ok: true, mode, profileName, planPath, operations: operations.map((operation) => operation.name) }, null, 2)}\n`)
    return
  }

  const metricsBefore = await collectMetrics(options)
  const run = await runLoad(options, operations)
  const summary = summarizeSamples(run.samples)
  const metricsAfter = await collectMetrics(options)
  const metrics = {
    before: metricsBefore,
    after: metricsAfter,
    delta: diffMetrics(metricsBefore, metricsAfter),
  }
  const gates = evaluateGates(options, summary, metrics, operations)
  const generatedAt = new Date().toISOString()
  const stamp = generatedAt.replace(/[:.]/g, '-')
  const report = {
    ok: gates.overall !== 'no-go',
    generatedAt,
    mode,
    profileName,
    evidence: {
      ...createEvidenceMetadata(options, gates.overall),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
    },
    targets: {
      cloudUrl: options.skipCloud ? null : safeUrl(options.cloudUrl),
      gatewayUrl: options.skipGateway ? null : safeUrl(options.gatewayUrl),
      capacityTargets: profile.capacityTargets,
      thresholds: profile.thresholds,
    },
    run: {
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      concurrency: options.concurrency,
      requestRatePerSecond: options.requestRatePerSecond,
      operationCount: run.samples.length,
      createdSessionCount: options.createdSessions.length,
    },
    summary,
    metrics,
    gates,
  }
  const jsonPath = join(options.outputDir, `${stamp}-${profileName}-${mode}-report.json`)
  const markdownPath = join(options.outputDir, `${stamp}-${profileName}-${mode}-report.md`)
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(markdownPath, createMarkdownReport(report))
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    mode,
    profileName,
    result: gates.overall,
    jsonPath,
    markdownPath,
    warnings: gates.warnings,
    failedChecks: gates.checks.filter((item) => item.status === 'fail'),
  }, null, 2)}\n`)
  if (!report.ok) process.exit(1)
}

main().catch((error) => {
  process.stderr.write(`[launch-readiness] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
