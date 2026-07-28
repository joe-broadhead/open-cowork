import { setLogStorage } from '@open-cowork/shared/node'
import {
  assertConfigValid,
  getAppConfig,
  getAppDataDir,
  getLogFilePrefix,
} from '@open-cowork/runtime-host/config'
import { startCloudApp } from '../packages/cloud-server/src/app.ts'

const developmentProcessRequested = process.argv.includes('--development-process')
if (developmentProcessRequested) {
  const configuredMode = process.env.OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE?.trim()
  if (configuredMode && configuredMode !== 'development-process') {
    throw new Error(
      '--development-process conflicts with OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE.',
    )
  }
  process.env.OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE = 'development-process'
}

// The cloud has no Electron host wiring; point the shared logger at the cloud data
// directory (resolved by the Electron-free config core from OPEN_COWORK_* env) so
// logs land beside the cloud root instead of the unconfigured temp-dir fallback.
setLogStorage(() => ({ directory: getAppDataDir(), filePrefix: getLogFilePrefix() }))

assertConfigValid()
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
