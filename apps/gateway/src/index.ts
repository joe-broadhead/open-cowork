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
  createGatewayProviderRegistry,
  type GatewayProviderRegistry,
} from './provider-registry.js'

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
