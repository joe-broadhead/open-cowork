import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'

const MCP_PROTOCOL_VERSION = '2025-06-18'

function isInside(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path))
}

function resolveBarePackageDirectory(packageName, bundle) {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName)) {
    throw new Error(`invalid bare external package name: ${packageName}`)
  }
  let cursor = dirname(resolve(bundle))
  while (true) {
    const candidate = join(cursor, 'node_modules', ...packageName.split('/'))
    if (existsSync(join(candidate, 'package.json'))) {
      return realpathSync(candidate)
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  throw new Error(`package ${packageName} is not installed on the bundle resolution path`)
}

export function assertRuntimeExternalResolutionsContained(input) {
  const runtimeRoot = realpathSync(resolve(input.runtimeRoot))
  const contained = []

  for (const packageName of Array.from(new Set(input.externalPackages)).sort()) {
    let resolvedPackage
    try {
      resolvedPackage = resolveBarePackageDirectory(packageName, input.bundle)
    } catch (error) {
      throw new Error(
        `CLOUD_SMOKE_EXTERNAL_MISSING: ${packageName} (${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      )
    }
    if (!isInside(runtimeRoot, resolvedPackage)) {
      throw new Error(
        `CLOUD_SMOKE_EXTERNAL_ESCAPE: ${packageName} resolved outside isolated runtime root`,
      )
    }
    contained.push(packageName)
  }

  return contained
}

export function buildSmokeProviderOverride(baseURL) {
  const url = new URL(baseURL)
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', '::1', 'localhost'].includes(url.hostname)
  ) {
    throw new Error('Cloud provider smoke base URL must use loopback HTTP.')
  }
  return {
    cloud: {
      defaultProfile: 'cloud-smoke',
      profiles: {
        'cloud-smoke': {
          label: 'Cloud closure smoke',
          description: 'Deterministic provider adapter closure verification.',
          agents: ['build'],
        },
      },
    },
    providers: {
      available: ['openrouter'],
      defaultProvider: 'openrouter',
      defaultModel: 'cloud-smoke-model',
      descriptors: {
        openrouter: {
          options: { baseURL: url.href.replace(/\/$/, '') },
          models: [{
            id: 'cloud-smoke-model',
            name: 'Cloud smoke model',
          }],
        },
      },
    },
  }
}

function mcpChildEnvironment() {
  const env = {}
  for (const name of [
    'PATH',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
  ]) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return env
}

export async function invokeStdioMcpTool(input) {
  const runtimeRoot = realpathSync(resolve(input.runtimeRoot))
  const script = realpathSync(resolve(input.script))
  if (!isInside(runtimeRoot, script)) {
    throw new Error('CLOUD_SMOKE_MCP_ESCAPE: MCP script is outside the isolated runtime root')
  }

  const child = spawn(
    input.nodeExecutable || process.execPath,
    [
      '--permission',
      `--allow-fs-read=${runtimeRoot}`,
      script,
    ],
    {
      cwd: runtimeRoot,
      env: {
        ...mcpChildEnvironment(),
        ...(input.env || {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const timeoutMs = input.timeoutMs || 10_000
  const childExit = new Promise((resolveExit) => {
    child.once('exit', resolveExit)
  })
  let stderr = ''
  let stdout = ''
  let nextId = 1
  const pending = new Map()
  const timer = setTimeout(() => {
    for (const { reject } of pending.values()) {
      reject(new Error(`MCP request timed out after ${timeoutMs}ms`))
    }
    pending.clear()
    child.kill('SIGKILL')
  }, timeoutMs)

  const request = (method, params) => {
    const id = nextId
    nextId += 1
    return new Promise((resolveRequest, rejectRequest) => {
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest })
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      })}\n`)
    })
  }

  const processLine = (line) => {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (!Number.isInteger(message.id)) return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) {
      waiter.reject(new Error(`MCP ${message.error.code || 'error'}: ${message.error.message || 'request failed'}`))
    } else {
      waiter.resolve(message.result)
    }
  }

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
    const lines = stdout.split(/\r?\n/)
    stdout = lines.pop() || ''
    for (const line of lines) processLine(line)
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  const childFailure = new Promise((_, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (pending.size === 0) return
      reject(new Error(
        `MCP exited before responding (code ${code}, signal ${signal}): ${stderr.slice(-500)}`,
      ))
    })
  })

  try {
    await Promise.race([
      request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'open-cowork-cloud-closure-smoke',
          version: '1.0.0',
        },
      }),
      childFailure,
    ])
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })}\n`)
    const result = await Promise.race([
      request('tools/call', {
        name: input.toolName,
        arguments: input.arguments || {},
      }),
      childFailure,
    ])
    if (
      !result
      || result.isError === true
      || !Array.isArray(result.content)
      || result.content.length === 0
    ) {
      throw new Error('CLOUD_SMOKE_MCP_RESULT_INVALID: tools/call did not return content')
    }
    return result
  } finally {
    clearTimeout(timer)
    for (const { reject } of pending.values()) {
      reject(new Error('MCP smoke closed before the request completed'))
    }
    pending.clear()
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([
        childExit,
        new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000)),
      ])
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await childExit
    }
  }
}
