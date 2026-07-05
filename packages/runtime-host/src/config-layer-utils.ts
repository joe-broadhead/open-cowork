import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { OpenCoworkConfig } from '@open-cowork/shared'

export function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override || {})) {
    // Cheap prototype-pollution insurance (audit P3-6): never let an override key reach the prototype
    // chain. Operator-config-only today and the own-slot assignment can't pollute Object.prototype,
    // but skipping these keys keeps it true regardless of how deepMerge gets reused.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (Array.isArray(value)) {
      next[key] = value
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const current = next[key]
      next[key] = deepMerge(
        current && typeof current === 'object' && !Array.isArray(current)
          ? current as Record<string, unknown>
          : {},
        value as Record<string, unknown>,
      )
      continue
    }
    if (value !== undefined) next[key] = value
  }
  return next as T
}

export function formatConfigError(source: string, path: string, message: string) {
  return `Invalid app config in ${source}${path ? ` at ${path}` : ''}: ${message}`
}

export function validateConfigSemantics(raw: unknown, source: string, options?: { requireProviderDefinitions?: boolean }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const config = raw as Partial<OpenCoworkConfig>
  const providerIds = new Set([
    ...((config.providers?.available || []).filter(Boolean)),
  ])

  if (options?.requireProviderDefinitions !== false) {
    for (const providerId of providerIds) {
      const hasDescriptor = Boolean(config.providers?.descriptors?.[providerId])
      const hasRuntime = Boolean(config.providers?.custom?.[providerId])
      if (!hasDescriptor && !hasRuntime) {
        throw new Error(formatConfigError(source, `providers.available`, `references unknown provider "${providerId}"`))
      }
    }

    if (config.providers?.defaultProvider && !providerIds.has(config.providers.defaultProvider)) {
      throw new Error(formatConfigError(source, 'providers.defaultProvider', 'must exist in providers.available'))
    }
  }

  for (const [index, mcp] of (config.mcps || []).entries()) {
    if (mcp.type === 'local' && !(Array.isArray(mcp.command) || typeof mcp.packageName === 'string')) {
      throw new Error(formatConfigError(source, `mcps[${index}]`, 'local MCPs require either packageName or command'))
    }
    if (mcp.type === 'remote' && typeof mcp.url !== 'string') {
      throw new Error(formatConfigError(source, `mcps[${index}]`, 'remote MCPs require a url'))
    }
  }

  validateGatewaySemantics(config, source)
}

function validateGatewaySemantics(config: Partial<OpenCoworkConfig>, source: string) {
  const gateway = config.gateway
  if (!gateway || typeof gateway !== 'object') return
  const publicBind = isPublicBindHost(gateway.server?.host || '127.0.0.1')
  const adminToken = typeof gateway.server?.adminToken === 'string' && gateway.server.adminToken.trim()
  const mode = gateway.mode === 'managed' ? 'managed' : 'self-host'
  const metricsEnabled = gateway.metrics?.enabled ?? true
  const diagnosticsEnabled = gateway.diagnostics?.enabled ?? mode === 'self-host'
  if (publicBind && (metricsEnabled || diagnosticsEnabled) && !adminToken) {
    throw new Error(formatConfigError(source, 'gateway.server.adminToken', 'is required when public gateway metrics or diagnostics are enabled'))
  }

  const cloudBaseUrl = typeof gateway.cloud?.baseUrl === 'string' ? gateway.cloud.baseUrl.trim() : ''
  if (cloudBaseUrl) {
    const url = new URL(cloudBaseUrl)
    if (url.protocol === 'http:' && gateway.cloud?.allowInsecureHttp !== true && !isLoopbackHost(url.hostname)) {
      throw new Error(formatConfigError(source, 'gateway.cloud.baseUrl', 'must use HTTPS unless gateway.cloud.allowInsecureHttp is true'))
    }
  }

  for (const [index, provider] of (gateway.providers || []).entries()) {
    if (provider.enabled === false) continue
    const kind = provider.kind
    if (publicBind && kind === 'fake') {
      throw new Error(formatConfigError(source, `gateway.providers[${index}]`, 'fake provider cannot be exposed on a public bind'))
    }
    if (kind === 'webhook' && !provider.credentials?.sharedSecret) {
      throw new Error(formatConfigError(source, `gateway.providers[${index}].credentials.sharedSecret`, 'is required for webhook ingress'))
    }
  }
}

function isLoopbackHost(hostname: string) {
  const host = hostname.trim().toLowerCase()
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

function isPublicBindHost(hostname: string) {
  const host = hostname.trim().toLowerCase()
  return host === '0.0.0.0' || host === '::' || host === '[::]' || !isLoopbackHost(host)
}

function resolvePlaceholderFilePath(rawPath: string, baseDir: string) {
  if (rawPath.startsWith('~/')) {
    return join(homedir(), rawPath.slice(2))
  }
  if (rawPath.startsWith('/')) {
    return rawPath
  }
  return resolve(baseDir, rawPath)
}

export function resolveConfigEnvPlaceholders<T>(
  value: T,
  baseDir = process.cwd(),
  allowedEnvPlaceholders: ReadonlySet<string> = new Set(),
): T {
  if (typeof value === 'string') {
    const withEnv = value.replace(/\{env:([A-Z0-9_]+)\}/g, (_match, envName) => {
      if (!allowedEnvPlaceholders.has(envName)) {
        throw new Error(`Environment placeholder ${envName} is not allowlisted. Add it to allowedEnvPlaceholders in open-cowork.config.json or remove the placeholder.`)
      }
      return process.env[envName] || ''
    })
    return withEnv.replace(/\{file:([^}]+)\}/g, (_match, rawPath) => {
      const path = resolvePlaceholderFilePath(rawPath.trim(), baseDir)
      return existsSync(path) ? readFileSync(path, 'utf-8') : ''
    }) as T
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveConfigEnvPlaceholders(entry, baseDir, allowedEnvPlaceholders)) as T
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, resolveConfigEnvPlaceholders(entry, baseDir, allowedEnvPlaceholders)]),
    ) as T
  }

  return value
}
