import { getAppConfig } from '@open-cowork/runtime-host/config'
import { resolveCloudControlPlaneUrl } from '../packages/cloud-server/src/app.ts'
import {
  createPostgresControlPlaneStore,
  loadPgPool,
} from '../packages/cloud-server/src/postgres-control-plane-store.ts'
import { provisionPostgresRuntimeRole } from '../packages/cloud-server/src/postgres-runtime-role.ts'

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
} finally {
  await store.close()
}

const runtimeRole = process.env.OPEN_COWORK_CLOUD_RUNTIME_DATABASE_ROLE?.trim() || ''
const runtimePrincipal = process.env.OPEN_COWORK_CLOUD_RUNTIME_DATABASE_PRINCIPAL?.trim() || ''
if (Boolean(runtimeRole) !== Boolean(runtimePrincipal)) {
  throw new Error(
    'Set OPEN_COWORK_CLOUD_RUNTIME_DATABASE_ROLE and OPEN_COWORK_CLOUD_RUNTIME_DATABASE_PRINCIPAL together when provisioning least-privilege runtime access.',
  )
}
if (runtimeRole && runtimePrincipal) {
  const pool = loadPgPool(url)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await provisionPostgresRuntimeRole(client, { role: runtimeRole, principal: runtimePrincipal })
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

process.stdout.write(
  runtimeRole
    ? 'open-cowork-cloud migrations and runtime grants applied\n'
    : 'open-cowork-cloud migrations applied\n',
)
