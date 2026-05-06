import type { ConfiguredAgent, ConfiguredTool } from './config-types.ts'
import {
  expandMcpToolPermissionPatterns,
  getConfiguredToolAllowPatterns,
  getConfiguredToolAskPatterns,
  getConfiguredToolById,
  getConfiguredToolPatterns,
  getConfiguredToolsFromConfig,
} from './config-loader.ts'
import { configuredToolLabels } from './capability-catalog.ts'
import { getEffectiveSettings } from './settings.ts'

export function unique(values: string[]) {
  return Array.from(new Set(values))
}

function toolPatternMatches(pattern: string, toolId: string) {
  let patternIndex = 0
  let toolIndex = 0
  let starIndex = -1
  let resumeToolIndex = 0

  while (toolIndex < toolId.length) {
    const patternChar = pattern[patternIndex]
    if (patternChar === '?' || patternChar === toolId[toolIndex]) {
      patternIndex += 1
      toolIndex += 1
    } else if (patternChar === '*') {
      starIndex = patternIndex
      resumeToolIndex = toolIndex
      patternIndex += 1
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1
      resumeToolIndex += 1
      toolIndex = resumeToolIndex
    } else {
      return false
    }
  }

  while (pattern[patternIndex] === '*') patternIndex += 1
  return patternIndex === pattern.length
}

export function hasNativeWebToolPattern(patterns: string[]) {
  const nativeWebToolIds = ['webfetch', 'websearch', 'codesearch']
  return patterns.some((pattern) => nativeWebToolIds.some((toolId) => toolPatternMatches(pattern, toolId)))
}

export function hasNativeBashToolPattern(patterns: string[]) {
  return patterns.some((pattern) => toolPatternMatches(pattern, 'bash'))
}

export function hasNativeFileWriteToolPattern(patterns: string[]) {
  const nativeFileWriteToolIds = ['edit', 'write', 'apply_patch']
  return patterns.some((pattern) => nativeFileWriteToolIds.some((toolId) => toolPatternMatches(pattern, toolId)))
}

const WRITE_CAPABLE_TOOL_VERBS = new Set([
  'add',
  'apply',
  'archive',
  'cancel',
  'clear',
  'close',
  'commit',
  'copy',
  'create',
  'delete',
  'deploy',
  'drop',
  'edit',
  'grant',
  'import',
  'insert',
  'merge',
  'modify',
  'move',
  'mutate',
  'patch',
  'post',
  'publish',
  'push',
  'put',
  'remove',
  'reopen',
  'replace',
  'retry',
  'revoke',
  'save',
  'send',
  'set',
  'submit',
  'sync',
  'truncate',
  'update',
  'upload',
  'upsert',
  'write',
])

const AMBIGUOUS_WRITE_TOOL_VERBS = new Set([
  'execute',
  'run',
])

const READ_ONLY_AMBIGUOUS_TOOL_NOUNS = new Set([
  'analyze',
  'analysis',
  'calculate',
  'check',
  'count',
  'counts',
  'describe',
  'explain',
  'fetch',
  'find',
  'get',
  'inspect',
  'list',
  'lookup',
  'lookups',
  'preview',
  'queries',
  'query',
  'read',
  'report',
  'reports',
  'search',
  'select',
  'show',
  'status',
  'summarize',
  'summary',
  'test',
  'validate',
  'view',
  'views',
])

function toolPatternLooksWriteCapable(pattern: string) {
  const lower = pattern.toLowerCase()
  if (hasNativeBashToolPattern([lower]) || hasNativeFileWriteToolPattern([lower])) return true
  if (lower === '*' || /^mcp__[a-z0-9_-]+__\*$/.test(lower) || /^[a-z0-9_-]+_\*$/.test(lower)) return true
  const tokens = lower.split(/[_:/.-]+/g).filter(Boolean)
  if (tokens.some((token) => WRITE_CAPABLE_TOOL_VERBS.has(token))) return true
  if (!tokens.some((token) => AMBIGUOUS_WRITE_TOOL_VERBS.has(token))) return false
  return !tokens.some((token) => READ_ONLY_AMBIGUOUS_TOOL_NOUNS.has(token))
}

function isNamespaceWildcardToolPattern(pattern: string) {
  const lower = pattern.toLowerCase()
  return /^mcp__[a-z0-9_-]+__\*$/.test(lower) || /^[a-z0-9_-]+_\*$/.test(lower)
}

function configuredToolMatchesPattern(tool: ConfiguredTool, pattern: string) {
  const configuredPatterns = getConfiguredToolPatterns(tool)
    .flatMap((entry) => expandMcpToolPermissionPatterns([entry]))
    .map((entry) => entry.toLowerCase())
  return expandMcpToolPermissionPatterns([pattern])
    .map((entry) => entry.toLowerCase())
    .some((entry) => configuredPatterns.some((configured) => (
      configured === entry || toolPatternMatches(configured, entry) || toolPatternMatches(entry, configured)
    )))
}

function configuredAgentPatternLooksWriteCapable(agent: ConfiguredAgent, pattern: string) {
  if (isNamespaceWildcardToolPattern(pattern)) {
    const matchingTools = configuredAgentConfiguredToolIds(agent)
      .map((toolId) => getConfiguredToolById(toolId))
      .filter((tool): tool is ConfiguredTool => Boolean(tool))
      .filter((tool) => configuredToolMatchesPattern(tool, pattern))

    if (matchingTools.length > 0) {
      return matchingTools.some((tool) => configuredToolMayWrite(tool.id))
    }
  }

  return toolPatternLooksWriteCapable(pattern)
}

function configuredToolMayWrite(toolId: string) {
  const tool = getConfiguredToolById(toolId)
  if (!tool) return false
  if (tool.writeAccess === true) return true
  if (tool.writeAccess === false) return false
  return [
    ...getConfiguredToolAllowPatterns(tool),
    ...getConfiguredToolAskPatterns(tool),
  ].some((pattern) => toolPatternLooksWriteCapable(pattern))
}

function configuredAgentAskPatternsMayWrite(agent: ConfiguredAgent) {
  const explicitAskPatterns = expandMcpToolPermissionPatterns(agent.askTools || [])
  if (explicitAskPatterns.some((pattern) => configuredAgentPatternLooksWriteCapable(agent, pattern))) return true

  return configuredAgentConfiguredToolIds(agent).some((toolId) => configuredToolMayWrite(toolId))
}

export function configuredAgentMayWrite(agent: ConfiguredAgent) {
  const explicitAllowPatterns = expandMcpToolPermissionPatterns(agent.allowTools || [])
  const explicitAskPatterns = expandMcpToolPermissionPatterns(agent.askTools || [])
  const explicitPatterns = [...explicitAllowPatterns, ...explicitAskPatterns]
  return configuredAgentConfiguredToolIds(agent).some((toolId) => configuredToolMayWrite(toolId))
    || explicitAllowPatterns.some((pattern) => configuredAgentPatternLooksWriteCapable(agent, pattern))
    || configuredAgentAskPatternsMayWrite(agent)
    || hasNativeBashToolPattern(explicitPatterns)
    || hasNativeFileWriteToolPattern(explicitPatterns)
}

const NATIVE_TOOL_IDS = new Set([
  'read',
  'grep',
  'glob',
  'list',
  'websearch',
  'webfetch',
  'bash',
  'edit',
  'write',
  'apply_patch',
  'question',
  'todowrite',
  'codesearch',
])

export function configuredAgentNativeToolIds(agent: ConfiguredAgent) {
  return unique(
    [...(agent.allowTools || []), ...(agent.askTools || [])]
      .filter((toolId) => NATIVE_TOOL_IDS.has(toolId)),
  )
}

export function configuredAgentConfiguredToolIds(agent: ConfiguredAgent) {
  const explicit = agent.toolIds || []
  const byPattern = getConfiguredToolsFromConfig()
    .filter((tool) => {
      const agentPatterns = new Set([
        ...(agent.allowTools || []),
        ...(agent.askTools || []),
      ])
      return getConfiguredToolPatterns(tool).some((pattern) => agentPatterns.has(pattern))
    })
    .map((tool) => tool.id)

  return unique([...explicit, ...byPattern])
}

export function configuredAgentAllowPatterns(agent: ConfiguredAgent) {
  const configured = (agent.toolIds || [])
    .flatMap((toolId) => {
      const tool = getConfiguredToolById(toolId)
      return tool ? getConfiguredToolAllowPatterns(tool) : []
    })
  return Array.from(new Set([
    ...expandMcpToolPermissionPatterns(agent.allowTools || []),
    ...configured,
  ]))
}

export function configuredAgentAskPatterns(agent: ConfiguredAgent) {
  const configured = (agent.toolIds || [])
    .flatMap((toolId) => {
      const tool = getConfiguredToolById(toolId)
      return tool ? getConfiguredToolAskPatterns(tool) : []
    })
  return Array.from(new Set([
    ...expandMcpToolPermissionPatterns(agent.askTools || []),
    ...configured,
  ]))
}

export function configuredToolAccess(agent: ConfiguredAgent) {
  const nativeToolIds = configuredAgentNativeToolIds(agent)
  const configuredToolIds = configuredAgentConfiguredToolIds(agent)
  const labels = [
    ...nativeToolLabels(nativeToolIds),
    ...configuredToolLabels(configuredToolIds),
  ]

  return labels.length > 0 ? unique(labels) : ['No dedicated tools']
}

export function getGlobalToolAccess() {
  const tools = getConfiguredToolsFromConfig()
  const allow = Array.from(new Set(tools.flatMap((tool) => getConfiguredToolAllowPatterns(tool))))
  const ask = Array.from(new Set(tools.flatMap((tool) => getConfiguredToolAskPatterns(tool))))
  const all = Array.from(new Set(tools.flatMap((tool) => getConfiguredToolPatterns(tool))))
  return { allow, ask, all }
}

export function nativeToolLabels(ids: string[]) {
  return ids.map((id) => {
    switch (id) {
      case 'websearch':
        return 'Web Search'
      case 'webfetch':
        return 'Web Fetch'
      case 'todowrite':
        return 'Todo Write'
      case 'apply_patch':
        return 'Apply Patch'
      default:
        return id
          .split(/[_-]/g)
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' ')
    }
  })
}

export function getNativeToolIdsForBuiltInAgent(name: 'build' | 'plan' | 'general' | 'explore') {
  const settings = getEffectiveSettings()
  const canUseBash = settings.enableBash
  const canWriteFiles = settings.enableFileWrite
  const readOnlyCore = ['read', 'grep', 'glob', 'list']
  const webTools = ['websearch', 'webfetch']
  const writeTools = canWriteFiles ? ['edit', 'write', 'apply_patch'] : []
  const bashTools = canUseBash ? ['bash'] : []

  if (name === 'build') {
    return unique([
      ...readOnlyCore,
      ...webTools,
      ...bashTools,
      ...writeTools,
      'todowrite',
      'question',
    ])
  }

  if (name === 'plan') {
    return unique([
      ...readOnlyCore,
      ...webTools,
      'bash',
    ])
  }

  if (name === 'general') {
    return unique([
      ...readOnlyCore,
      ...webTools,
      ...bashTools,
      ...writeTools,
      'question',
    ])
  }

  return readOnlyCore
}
