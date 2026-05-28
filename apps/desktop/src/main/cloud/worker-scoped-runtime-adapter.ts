import type { OpenCoworkConfig } from '../config-types.ts'
import type { ByokSecretStore } from './byok-secret-store.ts'
import { buildCloudByokRuntimeConfig, type CloudByokRuntimeProviderPolicy } from './byok-runtime-config.ts'
import type { CloudRuntimePolicy } from './cloud-config.ts'
import type { PathProvider } from './path-provider.ts'
import { createCloudSessionPathProvider } from './path-provider.ts'
import type {
  CloudRuntimeAdapter,
  CloudRuntimeEvent,
  CloudRuntimeEventListener,
  CloudRuntimeExecutionContext,
} from './runtime-adapter.ts'

type Env = Record<string, string | undefined>

export type WorkerScopedRuntimeFactoryInput = {
  paths: PathProvider
  policy: CloudRuntimePolicy
  env: Env
  config: OpenCoworkConfig
  execution: CloudRuntimeExecutionContext
  runtimeConfig: import('@opencode-ai/sdk/v2/server').ServerOptions['config']
}

export type WorkerScopedRuntimeFactory = (
  input: WorkerScopedRuntimeFactoryInput,
) => Promise<CloudRuntimeAdapter> | CloudRuntimeAdapter

export type WorkerScopedRuntimeAdapterOptions = {
  paths: PathProvider
  policy: CloudRuntimePolicy
  env: Env
  config: OpenCoworkConfig
  byokSecrets: ByokSecretStore
  byokPolicy?: CloudByokRuntimeProviderPolicy | null
  runtimeFactory: WorkerScopedRuntimeFactory
}

type RuntimeEntry = {
  adapter: CloudRuntimeAdapter
  unsubscribe: (() => void | Promise<void>) | null
}

function runtimeKey(context: CloudRuntimeExecutionContext) {
  return `${context.tenantId}\0${context.sessionId}`
}

function requireContext(context: CloudRuntimeExecutionContext | null | undefined) {
  if (!context?.tenantId || !context.sessionId) {
    throw new Error('Cloud worker runtime execution requires tenant and session context.')
  }
  return context
}

function mapRuntimeEventToCoworkSession(context: CloudRuntimeExecutionContext, event: CloudRuntimeEvent): CloudRuntimeEvent {
  const runtimeSessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : null
  return {
    ...event,
    payload: {
      ...event.payload,
      ...(runtimeSessionId && runtimeSessionId !== context.sessionId ? { opencodeSessionId: runtimeSessionId } : {}),
      sessionId: context.sessionId,
    },
  }
}

export function createWorkerScopedRuntimeAdapter(options: WorkerScopedRuntimeAdapterOptions): CloudRuntimeAdapter {
  const runtimes = new Map<string, RuntimeEntry>()
  const listeners = new Map<CloudRuntimeEventListener, { onError?: (error: unknown) => void }>()

  async function subscribeRuntimeEvents(context: CloudRuntimeExecutionContext, adapter: CloudRuntimeAdapter) {
    if (!adapter.subscribeEvents || listeners.size === 0) return null
    const unsubscribe = await adapter.subscribeEvents(
      (event) => {
        const mapped = mapRuntimeEventToCoworkSession(context, event)
        for (const listener of listeners.keys()) {
          void listener(mapped)
        }
      },
      {
        onError(error) {
          for (const entry of listeners.values()) entry.onError?.(error)
        },
      },
    )
    return unsubscribe
  }

  async function getRuntime(contextInput: CloudRuntimeExecutionContext | null | undefined) {
    const context = requireContext(contextInput)
    const key = runtimeKey(context)
    const existing = runtimes.get(key)
    if (existing) return existing.adapter

    const scopedPaths = createCloudSessionPathProvider(options.paths, context.tenantId, context.sessionId)
    const runtimeConfig = await buildCloudByokRuntimeConfig({
      appConfig: options.config,
      byokSecrets: options.byokSecrets,
      context,
      allowKmsRef: true,
      byokPolicy: options.byokPolicy,
    })
    const adapter = await options.runtimeFactory({
      paths: scopedPaths,
      policy: options.policy,
      env: options.env,
      config: options.config,
      execution: context,
      runtimeConfig,
    })
    const unsubscribe = await subscribeRuntimeEvents(context, adapter)
    runtimes.set(key, { adapter, unsubscribe })
    return adapter
  }

  return {
    requiresWorkerContext: true,
    async createSession(input) {
      const adapter = await getRuntime(input?.context)
      return adapter.createSession({ profileName: input?.profileName || undefined })
    },
    async promptSession(input) {
      const adapter = await getRuntime(input.context)
      return adapter.promptSession(input)
    },
    async abortSession(input) {
      const adapter = await getRuntime(input.context)
      return adapter.abortSession(input)
    },
    async replyToQuestion(input) {
      const adapter = await getRuntime(input.context)
      if (!adapter.replyToQuestion) throw new Error('OpenCode question replies are not available.')
      return adapter.replyToQuestion(input)
    },
    async rejectQuestion(input) {
      const adapter = await getRuntime(input.context)
      if (!adapter.rejectQuestion) throw new Error('OpenCode question rejection is not available.')
      return adapter.rejectQuestion(input)
    },
    async respondToPermission(input) {
      const adapter = await getRuntime(input.context)
      if (!adapter.respondToPermission) throw new Error('OpenCode permission responses are not available.')
      return adapter.respondToPermission(input)
    },
    async subscribeEvents(listener, subscribeOptions) {
      listeners.set(listener, { onError: subscribeOptions?.onError })
      for (const [key, entry] of runtimes.entries()) {
        if (entry.unsubscribe) continue
        const [tenantId, sessionId] = key.split('\0')
        entry.unsubscribe = await subscribeRuntimeEvents({ tenantId, sessionId }, entry.adapter)
      }
      return () => {
        listeners.delete(listener)
      }
    },
    async close() {
      for (const entry of runtimes.values()) {
        await entry.unsubscribe?.()
        await entry.adapter.close?.()
      }
      runtimes.clear()
      listeners.clear()
    },
  }
}
