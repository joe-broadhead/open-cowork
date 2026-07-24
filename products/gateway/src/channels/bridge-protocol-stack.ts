/**
 * JOE-994 Phase 3: shared helpers for Durable → monorepo bridge protocol stacks
 * (Discord / WhatsApp monorepo providers are WebhookProvider bridge-mode only).
 */
export type ChannelProtocolStack = 'durable' | 'monorepo'

export function resolveChannelProtocolStack(
  env: NodeJS.ProcessEnv,
  envKeys: readonly string[],
  configStack?: string | undefined,
): ChannelProtocolStack {
  for (const key of envKeys) {
    const rawEnv = (env[key] || '').trim().toLowerCase()
    if (rawEnv === 'monorepo' || rawEnv === 'shared' || rawEnv === 'gateway-provider' || rawEnv === 'provider' || rawEnv === 'bridge') {
      return 'monorepo'
    }
    if (rawEnv === 'durable' || rawEnv === 'legacy' || rawEnv === 'classic' || rawEnv === 'native') {
      return 'durable'
    }
  }
  const fromConfig = (configStack || '').trim().toLowerCase()
  if (fromConfig === 'monorepo' || fromConfig === 'bridge') return 'monorepo'
  return 'durable'
}

