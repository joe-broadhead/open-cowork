import type { OpenCoworkConfig } from '@open-cowork/shared'
import type { OpencodeRuntimeConfig } from '@open-cowork/runtime-host/runtime-config-builder'
import {
  resolveBundledOpencodeBinaryPath,
  resolveBundledOpencodeCliEnvironment,
  resolveBundledOpencodeWrapperPath,
} from '@open-cowork/runtime-host/runtime-opencode-cli'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CloudRuntimePolicy } from './cloud-config.ts'
import type { Env } from './cloud-config-parse.ts'
import type { CloudExecutionIsolationPolicy } from './execution-isolation.ts'
import {
  applyKnowledgeAgentRuntimeAugmentation,
  buildKnowledgeAgentRuntimeAugmentation,
} from './knowledge-agent-runtime.ts'
import { createNodeOpencodeCloudRuntimeAdapter } from './opencode-runtime-adapter.ts'
import type { PathProvider } from './path-provider.ts'
import type { CloudRuntimeAdapter } from './runtime-adapter.ts'

export type CloudRoleRuntimeFactoryInput = {
  paths: PathProvider
  policy: CloudRuntimePolicy
  env: Env
  config: OpenCoworkConfig
  execution: {
    tenantId: string
    sessionId: string
    profileName?: string | null
  }
  runtimeConfig: OpencodeRuntimeConfig | undefined
  onUnexpectedExit?: () => void
}

export type CloudRuntimeFactory = (
  input: CloudRoleRuntimeFactoryInput,
) => Promise<CloudRuntimeAdapter> | CloudRuntimeAdapter

export type KnowledgeAgentSpawnOptions = {
  knowledgeEnabled: boolean
  secret: string | null
  publicUrl: string | null
  mcpScriptPath: string | null
}

export function resolveCloudOpencodeCliLaunch(input: {
  binary?: string | null
  currentPath?: string
  wrapper?: string | null
} = {}) {
  const binary = input.binary === undefined
    ? resolveBundledOpencodeBinaryPath()
    : input.binary
  const wrapper = input.wrapper === undefined
    ? resolveBundledOpencodeWrapperPath()
    : input.wrapper
  const launch = resolveBundledOpencodeCliEnvironment({
    binary,
    wrapper,
    currentPath: input.currentPath || '',
    isPackaged: false,
  })
  if (!launch.opencodeBinPath && !launch.path) {
    throw new Error(
      'Pinned OpenCode CLI is unavailable for Cloud execution; refusing ambient PATH fallback.',
    )
  }
  return launch
}

// The cloud bundle places this asset next to its entrypoint. A deployment may
// relocate it explicitly; a missing path leaves Knowledge unregistered.
export function resolveCloudKnowledgeMcpScriptPath(env: Env = process.env): string | null {
  const override = env.OPEN_COWORK_CLOUD_KNOWLEDGE_MCP_PATH?.trim()
  if (override) return override
  try {
    return fileURLToPath(new URL('./mcp-knowledge.mjs', import.meta.url))
  } catch {
    return null
  }
}

export function cloudKnowledgeRuntimeEligible(input: {
  knowledgeEnabled: boolean
  allowedTools: readonly string[] | null
  allowedMcps: readonly string[] | null
  isolationMode: CloudExecutionIsolationPolicy['mode']
  networkPolicy: CloudExecutionIsolationPolicy['network']['kind']
}) {
  return input.knowledgeEnabled
    && (input.allowedTools === null || input.allowedTools.includes('knowledge'))
    && (input.allowedMcps === null || input.allowedMcps.includes('knowledge'))
    && (
      input.isolationMode === 'development-process'
      || input.networkPolicy === 'restricted'
    )
}

export function resolveCloudKnowledgeRuntimeAssets(input: {
  policy: Pick<
    CloudRuntimePolicy,
    'allowedTools' | 'allowedMcps' | 'features'
  >
  isolationPolicy: Pick<
    CloudExecutionIsolationPolicy,
    'mode' | 'network'
  >
  env: Env
}) {
  const knowledgeEnabled = cloudKnowledgeRuntimeEligible({
    knowledgeEnabled: input.policy.features.knowledge,
    allowedTools: input.policy.allowedTools,
    allowedMcps: input.policy.allowedMcps,
    isolationMode: input.isolationPolicy.mode,
    networkPolicy: input.isolationPolicy.network.kind,
  })
  const mcpScriptPath = knowledgeEnabled
    ? resolveCloudKnowledgeMcpScriptPath(input.env)
    : null
  return {
    knowledgeEnabled,
    mcpScriptPath,
    runtimeAssetPaths: mcpScriptPath ? [mcpScriptPath] : [],
  }
}

export function resolveCloudKnowledgeAgentOrigin(input: {
  isolationMode: CloudExecutionIsolationPolicy['mode']
  role: CloudRuntimePolicy['role']
  allInOnePort: number
  publicUrl: string | null | undefined
}) {
  return input.isolationMode === 'development-process' && input.role === 'all-in-one'
    ? `http://127.0.0.1:${input.allInOnePort}`
    : (input.publicUrl?.trim() || null)
}

export function prepareDefaultCloudRuntimeFactoryInput(
  input: CloudRoleRuntimeFactoryInput,
  knowledgeAgent: KnowledgeAgentSpawnOptions,
): CloudRoleRuntimeFactoryInput {
  const augmentation = buildKnowledgeAgentRuntimeAugmentation({
    knowledgeEnabled: knowledgeAgent.knowledgeEnabled,
    policy: input.policy,
    secret: knowledgeAgent.secret,
    publicUrl: knowledgeAgent.publicUrl,
    mcpScriptPath: knowledgeAgent.mcpScriptPath,
    execution: input.execution,
  })
  const { env, runtimeConfig } = applyKnowledgeAgentRuntimeAugmentation({
    env: input.env,
    runtimeConfig: input.runtimeConfig,
    augmentation,
  })
  return {
    ...input,
    env,
    runtimeConfig: runtimeConfig as CloudRoleRuntimeFactoryInput['runtimeConfig'],
  }
}

export function createDefaultCloudRuntimeFactory(
  knowledgeAgent: KnowledgeAgentSpawnOptions,
): CloudRuntimeFactory {
  return (input) => {
    const prepared = prepareDefaultCloudRuntimeFactoryInput(input, knowledgeAgent)
    const opencodeCli = resolveCloudOpencodeCliLaunch({
      currentPath: prepared.env.PATH,
    })
    const workspace = input.paths.resolveWorkspacePath(
      input.execution.tenantId,
      input.execution.sessionId,
    )
    const runtimeConfig = {
      ...(prepared.runtimeConfig || {}),
      // Project executable config is masked in Cloud. Preserve the intended
      // instruction file explicitly without admitting agents or plugins.
      instructions: Array.from(new Set([
        ...(prepared.runtimeConfig?.instructions || []),
        resolve(workspace, 'AGENTS.md'),
      ])),
    }
    return createNodeOpencodeCloudRuntimeAdapter({
      paths: input.paths,
      env: {
        ...prepared.env,
        ...(opencodeCli.path ? { PATH: opencodeCli.path } : {}),
      } as NodeJS.ProcessEnv,
      config: runtimeConfig,
      configDelivery: 'ephemeral-file',
      cwd: workspace,
      opencodeBinPath: opencodeCli.opencodeBinPath,
      onUnexpectedExit: input.onUnexpectedExit,
    })
  }
}
