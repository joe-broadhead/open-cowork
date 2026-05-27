import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function readRepoFile(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

test('split cloud compose declares web, worker, and scheduler roles', () => {
  const compose = readRepoFile('docker-compose.cloud.split.yml')
  assert.match(compose, /open-cowork-cloud-web:/)
  assert.match(compose, /OPEN_COWORK_CLOUD_ROLE: web/)
  assert.match(compose, /OPEN_COWORK_CLOUD_AUTO_PROCESS_COMMANDS: "false"/)
  assert.match(compose, /OPEN_COWORK_CLOUD_COOKIE_SECRET: change-me-for-local-cookie-secret/)
  assert.match(compose, /OPEN_COWORK_CLOUD_COOKIE_SECURE: "false"/)
  assert.match(compose, /OPEN_COWORK_CLOUD_PUBLIC_URL: http:\/\/localhost:8787/)
  assert.match(compose, /OPEN_COWORK_CLOUD_SERVICE_NAME: open-cowork-cloud/)
  assert.match(compose, /OPEN_COWORK_CLOUD_LOG_FORMAT: json/)
  assert.match(compose, /open-cowork-cloud-worker:/)
  assert.match(compose, /OPEN_COWORK_CLOUD_ROLE: worker/)
  assert.match(compose, /OPEN_COWORK_CLOUD_WORKER_ID: compose-worker-1/)
  assert.match(compose, /OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED: "true"/)
  assert.match(compose, /open-cowork-cloud-scheduler:/)
  assert.match(compose, /OPEN_COWORK_CLOUD_ROLE: scheduler/)
  assert.match(compose, /OPEN_COWORK_CLOUD_SCHEDULER_ID: compose-scheduler-1/)
  assert.match(compose, /OPEN_COWORK_CLOUD_SCHEDULER_POLL_MS: 1000/)
  assert.match(compose, /postgres:/)
  assert.match(compose, /minio:/)
})

test('cloud deployment docs cover provider-neutral split deployment', () => {
  const docs = readRepoFile('docs/open-cowork-cloud.md')
  for (const provider of ['GCP', 'AWS', 'Azure', 'DigitalOcean', 'Kubernetes']) {
    assert.match(docs, new RegExp(provider))
  }
  for (const role of ['all-in-one', 'web', 'worker', 'scheduler']) {
    assert.match(docs, new RegExp(`\\\`${role}\\\``))
  }
  assert.match(docs, /focused-agent/)
  assert.match(docs, /OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED/)
  assert.match(docs, /OPEN_COWORK_CLOUD_SECRET_KEY_REF/)
  assert.match(docs, /gcp-sm:\/\/projects\/\{project\}\/secrets/)
  assert.match(docs, /aws-sm:\/\/\{secret-id\}\?region=\{region\}/)
  assert.match(docs, /azure-kv:\/\/\{vault\}\/secrets/)
  assert.match(docs, /OPEN_COWORK_CLOUD_COOKIE_SECRET/)
  assert.match(docs, /OPEN_COWORK_CLOUD_PUBLIC_URL/)
  assert.match(docs, /OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET/)
  assert.match(docs, /OPEN_COWORK_CLOUD_OTLP_ENDPOINT/)
  assert.match(docs, /structured request logs/)
  assert.match(docs, /OPEN_COWORK_TEST_POSTGRES_URL/)
  assert.match(docs, /cloud-postgres-concurrency\.test\.ts/)
  assert.match(docs, /session command idempotency\/reclaim/)
  assert.match(docs, /X-CSRF-Token/)
  assert.match(docs, /\/auth\/login/)
  assert.match(docs, /Cloud Run all-in-one demo only/)
  assert.match(docs, /GET \/healthz/)
  assert.match(docs, /GET \/api\/runtime\/status/)
  assert.match(docs, /GET \/api\/workers\/heartbeats/)
  assert.match(docs, /web app at `\/`/)
  assert.match(docs, /createHttpSseCloudTransportAdapter/)
})

test('cloud Helm chart keeps provider-neutral role wiring explicit', () => {
  const chart = readRepoFile('helm/open-cowork-cloud/Chart.yaml')
  const values = readRepoFile('helm/open-cowork-cloud/values.yaml')
  const deployment = readRepoFile('helm/open-cowork-cloud/templates/deployment.yaml')
  const configMap = readRepoFile('helm/open-cowork-cloud/templates/configmap.yaml')
  const secret = readRepoFile('helm/open-cowork-cloud/templates/secret.yaml')

  assert.match(chart, /name: open-cowork-cloud/)
  assert.match(values, /web:/)
  assert.match(values, /worker:/)
  assert.match(values, /scheduler:/)
  assert.equal(values.includes('worker:\n    enabled: true\n    replicas: 1'), true)
  assert.match(values, /checkpoints:/)
  assert.match(values, /secretKeyRef: ""/)
  assert.match(values, /cookieSecure: true/)
  assert.match(values, /publicUrl: ""/)
  assert.match(values, /oidcClientSecret: ""/)
  assert.match(values, /observability:/)
  assert.match(values, /logFormat: json/)
  assert.match(values, /otlpEndpoint: ""/)
  assert.match(values, /checkpointsEnabled: true/)
  assert.match(values, /kind: s3/)
  assert.match(deployment, /OPEN_COWORK_CLOUD_ROLE/)
  assert.match(deployment, /OPEN_COWORK_CLOUD_WORKER_ID/)
  assert.match(deployment, /OPEN_COWORK_CLOUD_SCHEDULER_ID/)
  assert.match(deployment, /livenessProbe:/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_OBJECT_STORE_KIND/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_COOKIE_SECURE/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_PUBLIC_URL/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_SERVICE_NAME/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_OTLP_ENDPOINT/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED/)
  assert.match(secret, /OPEN_COWORK_CLOUD_CONTROL_PLANE_URL/)
  assert.match(secret, /OPEN_COWORK_CLOUD_SECRET_KEY/)
  assert.match(secret, /OPEN_COWORK_CLOUD_SECRET_KEY_REF/)
  assert.match(secret, /OPEN_COWORK_CLOUD_COOKIE_SECRET/)
  assert.match(secret, /OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET/)
  assert.match(secret, /OPEN_COWORK_CLOUD_OTLP_HEADERS/)
})

test('cloud CLI entrypoint uses the shared config loader and cloud app bootstrap', () => {
  const script = readRepoFile('scripts/open-cowork-cloud.ts')
  assert.match(script, /getAppConfig/)
  assert.match(script, /startCloudApp/)
  assert.doesNotMatch(script, /loadConfig/)
})

test('cloud image builds workspace packages required by package entrypoints', () => {
  const dockerfile = readRepoFile('docker/open-cowork-cloud/Dockerfile')
  assert.match(dockerfile, /pnpm install --frozen-lockfile/)
  assert.match(dockerfile, /pnpm --filter @open-cowork\/shared build/)
  assert.match(dockerfile, /CMD \["pnpm", "cloud:dev"\]/)
})

test('cloud provider recipes stay thin compositions of the shared image and adapters', () => {
  const index = readRepoFile('deploy/README.md')
  assert.match(index, /same\n`open-cowork-cloud` image/)
  assert.match(index, /Postgres/)
  assert.match(index, /OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED=true/)

  const recipes = {
    gcp: ['Cloud SQL for PostgreSQL', 'Cloud Storage', 'Secret Manager', 'GKE'],
    aws: ['RDS for PostgreSQL', 'S3', 'Secrets Manager', 'EKS'],
    azure: ['Azure Database for PostgreSQL', 'Azure Blob Storage', 'Key Vault', 'AKS'],
    digitalocean: ['Managed PostgreSQL', 'Spaces', 'DOKS', 'App Platform'],
  }

  for (const [provider, expected] of Object.entries(recipes)) {
    const readme = readRepoFile(`deploy/${provider}/README.md`)
    assert.match(readme, /open-cowork-cloud/)
    assert.match(readme, /cloud.checkpoints.enabled=true/)
    assert.match(readme, /helm upgrade --install open-cowork-cloud/)
    for (const phrase of expected) {
      assert.match(readme, new RegExp(phrase))
    }
  }
})

test('CI enforces cloud portability, concurrency, and deployment gates', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml')

  assert.match(workflow, /cloud-gates:/)
  assert.match(workflow, /postgres:17-alpine/)
  assert.match(workflow, /proof:phase0:opencode-portability --json/)
  assert.match(workflow, /OPEN_COWORK_TEST_POSTGRES_URL/)
  assert.match(workflow, /cloud-postgres-concurrency\.test\.ts/)
  assert.match(workflow, /docker compose -f docker-compose\.cloud\.yml config --quiet/)
  assert.match(workflow, /docker compose -f docker-compose\.cloud\.split\.yml config --quiet/)
  assert.match(workflow, /docker build -f docker\/open-cowork-cloud\/Dockerfile/)
  assert.match(workflow, /bash scripts\/ci-cloud-compose-smoke\.sh docker-compose\.cloud\.split\.yml/)
  assert.match(workflow, /helm lint helm\/open-cowork-cloud/)
  assert.match(workflow, /helm template open-cowork-cloud helm\/open-cowork-cloud/)

  const smoke = readRepoFile('scripts/ci-cloud-compose-smoke.sh')
  assert.match(smoke, /docker compose -p "\$\{project_name\}" -f "\$\{compose_file\}" up --build -d/)
  assert.match(smoke, /http:\/\/127\.0\.0\.1:8787\/healthz/)
  assert.match(smoke, /docker compose -p "\$\{project_name\}" -f "\$\{compose_file\}" logs --no-color --tail=200/)
})
