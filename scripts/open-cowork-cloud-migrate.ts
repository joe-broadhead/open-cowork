import { getAppConfig } from '@open-cowork/runtime-host/config'
import { resolveCloudControlPlaneUrl } from '../packages/cloud-server/src/app.ts'
import { createPostgresControlPlaneStore } from '../packages/cloud-server/src/postgres-control-plane-store.ts'

// Standalone control-plane migration step for change-managed / blue-green rollouts:
// run the schema migrations once up front (with the web/worker instances booted via
// OPEN_COWORK_CLOUD_RUN_MIGRATIONS=false), instead of relying on the embedded
// migrate-on-connect path. Idempotent — the runner takes an advisory lock and skips
// already-applied migrations.
const config = getAppConfig()
const url = resolveCloudControlPlaneUrl(config)
if (!url) {
  throw new Error(
    'cloud:migrate requires a durable Postgres control-plane URL. '
    + 'Set OPEN_COWORK_CLOUD_CONTROL_PLANE_URL (or cloud.storage.controlPlane.urlRef).',
  )
}

const store = await createPostgresControlPlaneStore({ connectionString: url, runMigrations: false })
try {
  await store.runMigrations()
  process.stdout.write('open-cowork-cloud migrations applied\n')
} finally {
  await store.close()
}
