import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import type { OpenCoworkConfig } from './config-types.ts'

export function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override || {})) {
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
