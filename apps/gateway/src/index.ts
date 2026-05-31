import { createGatewayDaemon } from './daemon.js'
import { loadGatewayConfig } from './config.js'

export {
  createCloudGateway,
  type CloudGateway,
} from './cloud-gateway.js'
export {
  loadGatewayConfig,
  resolveGatewayConfig,
  redactGatewayConfig,
  redactGatewayEnv,
  type GatewayConfig,
  type GatewayProviderConfig,
} from './config.js'
export {
  createGatewayDaemon,
  createGatewayHttpServer,
  type GatewayDaemon,
  type GatewayHttpServer,
} from './daemon.js'
export {
  createGatewayRuntime,
  type GatewayRuntime,
} from './gateway-runtime.js'
export {
  createGatewayMetrics,
  renderPrometheusMetrics,
  type GatewayMetrics,
} from './metrics.js'
export {
  GATEWAY_RENDERED_SESSION_EVENT_TYPES,
  renderGatewaySessionEvent,
} from './event-renderer.js'
export {
  executeRenderOperation,
  getGatewayRenderProfile,
  normalizeChannelCapabilities,
  type GatewayRenderOperation,
  type GatewayRenderOperationResult,
  type GatewayRenderProfile,
  type NormalizedChannelCapabilities,
} from './render/operations.js'
export {
  createGatewaySessionRenderState,
  type GatewaySessionRenderState,
} from './render/state.js'
export {
  renderArtifactCreated,
} from './render/artifact-renderer.js'
export {
  mergeStreamingText,
} from './render/text-stream-renderer.js'
export {
  routeGatewayInteraction,
} from './interaction-router.js'
export {
  createGatewayProviderRegistry,
  type GatewayProviderRegistry,
} from './provider-registry.js'
export {
  findGatewayProviderReadiness,
  GATEWAY_PROVIDER_READINESS_MATRIX,
  type GatewayProviderReadinessEntry,
  type GatewayProviderReadinessTier,
} from './provider-readiness.js'
export {
  createGatewaySessionStreamManager,
  type GatewaySessionStreamManager,
} from './session-stream-manager.js'

if (import.meta.url === `file://${process.argv[1]}`) {
  const daemon = createGatewayDaemon(loadGatewayConfig())
  const shutdown = async () => {
    await daemon.stop()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  daemon.start()
    .then((url) => {
      process.stdout.write(`Open Cowork gateway listening on ${url}\n`)
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
      process.exit(1)
    })
}
