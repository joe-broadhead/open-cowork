import { getAppConfig } from '../apps/desktop/src/main/config-loader.ts'
import { startCloudApp } from '../apps/desktop/src/main/cloud/app.ts'

const app = await startCloudApp({ config: getAppConfig() })

const address = app.url || '(no web listener for this role)'
process.stdout.write(`open-cowork-cloud role=${app.policy.role} profile=${app.policy.profileName} ${address}\n`)

async function shutdown(signal: string) {
  process.stdout.write(`open-cowork-cloud received ${signal}; shutting down\n`)
  await app.close()
  process.exit(0)
}

process.on('SIGINT', () => {
  void shutdown('SIGINT')
})
process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
