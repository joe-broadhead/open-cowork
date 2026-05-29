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
  assert.match(compose, /OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH: "true"/)
  assert.match(compose, /OPEN_COWORK_CLOUD_COOKIE_SECRET: change-me-for-local-cookie-secret/)
  assert.match(compose, /OPEN_COWORK_CLOUD_INTERNAL_TOKEN: change-me-for-local-internal-token/)
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

test('combined cloud and gateway compose declares self-host gateway wiring', () => {
  const compose = readRepoFile('docker-compose.cloud-gateway.yml')
  assert.match(compose, /open-cowork-cloud:/)
  assert.match(compose, /open-cowork-gateway:/)
  assert.match(compose, /docker\/open-cowork-gateway\/Dockerfile/)
  assert.match(compose, /OPEN_COWORK_CLOUD_BASE_URL: http:\/\/open-cowork-cloud:8787/)
  assert.match(compose, /OPEN_COWORK_GATEWAY_SERVICE_TOKEN/)
  assert.match(compose, /OPEN_COWORK_GATEWAY_ALLOW_INSECURE_HTTP: "true"/)
  assert.match(compose, /OPEN_COWORK_GATEWAY_METRICS_ENABLED: "false"/)
  assert.match(compose, /OPEN_COWORK_GATEWAY_DIAGNOSTICS_ENABLED: "false"/)
  assert.match(compose, /OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER: \$\{OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER:-false\}/)
  assert.match(compose, /OPEN_COWORK_GATEWAY_FAKE_CHANNEL_BINDING_ID/)
  assert.match(compose, /OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN/)
  assert.match(compose, /OPEN_COWORK_GATEWAY_WEBHOOK_DELIVERY_URL/)
  assert.match(compose, /8790:8790/)
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
  assert.match(docs, /OPEN_COWORK_CLOUD_AUTH_MODE/)
  assert.match(docs, /OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH/)
  assert.match(docs, /OPEN_COWORK_CLOUD_INTERNAL_TOKEN/)
  assert.match(docs, /OPEN_COWORK_CLOUD_OIDC_ISSUER_URL/)
  assert.match(docs, /OPEN_COWORK_CLOUD_OIDC_CLIENT_ID/)
  assert.match(docs, /OPEN_COWORK_CLOUD_PUBLIC_URL/)
  assert.match(docs, /OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON/)
  assert.match(docs, /OPEN_COWORK_GATEWAY_PUBLIC_BRANDING_JSON/)
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
  assert.match(docs, /Generic Docker: Cloud \+ Gateway/)
  assert.match(docs, /docker-compose\.cloud-gateway\.yml/)
  assert.match(docs, /GET \/ready/)
  assert.match(docs, /OPEN_COWORK_GATEWAY_SERVICE_TOKEN/)
  assert.match(docs, /OPEN_COWORK_GATEWAY_DIAGNOSTICS_ENABLED/)
  assert.match(docs, /helm\/open-cowork-gateway/)
  assert.match(docs, /cloud-managed-operations\.md/)
})

test('cloud Helm chart keeps provider-neutral role wiring explicit', () => {
  const chart = readRepoFile('helm/open-cowork-cloud/Chart.yaml')
  const values = readRepoFile('helm/open-cowork-cloud/values.yaml')
  const deployment = readRepoFile('helm/open-cowork-cloud/templates/deployment.yaml')
  const configMap = readRepoFile('helm/open-cowork-cloud/templates/configmap.yaml')
  const secret = readRepoFile('helm/open-cowork-cloud/templates/secret.yaml')

  assert.match(chart, /name: open-cowork-cloud/)
  assert.match(chart, /open-cowork-gateway/)
  assert.match(values, /web:/)
  assert.match(values, /worker:/)
  assert.match(values, /scheduler:/)
  assert.match(values, /gateway:/)
  assert.equal(values.includes('worker:\n    enabled: false\n    replicas: 1'), true)
  assert.match(values, /checkpoints:/)
  assert.match(values, /secretKeyRef: ""/)
  assert.match(values, /auth:/)
  assert.match(values, /oidcIssuerUrl: ""/)
  assert.match(values, /oidcClientId: ""/)
  assert.match(values, /allowedEmailDomains: \[\]/)
  assert.match(values, /cookieSecure: true/)
  assert.match(values, /publicUrl: ""/)
  assert.match(values, /branding:/)
  assert.match(values, /productName: Open Cowork Cloud/)
  assert.match(values, /oidcClientSecret: ""/)
  assert.match(values, /observability:/)
  assert.match(values, /logFormat: json/)
  assert.match(values, /otlpEndpoint: ""/)
  assert.match(values, /checkpointsEnabled: true/)
  assert.match(values, /podSecurityContext:/)
  assert.match(values, /runAsNonRoot: true/)
  assert.match(values, /containerSecurityContext:/)
  assert.match(values, /allowPrivilegeEscalation: false/)
  assert.match(values, /allowInsecureAuth: false/)
  assert.match(values, /allowInsecurePublicAuth: false/)
  assert.match(values, /internalToken: ""/)
  assert.match(values, /kind: filesystem/)
  assert.match(deployment, /OPEN_COWORK_CLOUD_ROLE/)
  assert.match(deployment, /cloud\.auth\.mode=none requires explicit cloud\.allowInsecureAuth=true/)
  assert.match(deployment, /cloud\.auth\.mode=none with public service or ingress requires explicit cloud\.allowInsecurePublicAuth=true/)
  assert.match(deployment, /worker and scheduler roles require a shared control plane/)
  assert.match(deployment, /OPEN_COWORK_CLOUD_WORKER_ID/)
  assert.match(deployment, /OPEN_COWORK_CLOUD_SCHEDULER_ID/)
  assert.match(deployment, /livenessProbe:/)
  assert.match(deployment, /roles\.worker\.persistence\.enabled cannot be used/)
  assert.match(deployment, /emptyDir: {}/)
  assert.match(deployment, /securityContext:/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_OBJECT_STORE_KIND/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_AUTH_MODE/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_OIDC_ISSUER_URL/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_OIDC_CLIENT_ID/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_ALLOWED_EMAIL_DOMAINS/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_COOKIE_SECURE/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_PUBLIC_URL/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_SERVICE_NAME/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_OTLP_ENDPOINT/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED/)
  assert.match(secret, /OPEN_COWORK_CLOUD_CONTROL_PLANE_URL/)
  assert.match(secret, /OPEN_COWORK_CLOUD_SECRET_KEY/)
  assert.match(secret, /OPEN_COWORK_CLOUD_SECRET_KEY_REF/)
  assert.match(secret, /OPEN_COWORK_CLOUD_COOKIE_SECRET/)
  assert.match(secret, /OPEN_COWORK_CLOUD_COOKIE_SECRET_REF/)
  assert.match(secret, /OPEN_COWORK_CLOUD_INTERNAL_TOKEN/)
  assert.match(secret, /OPEN_COWORK_CLOUD_INTERNAL_TOKEN_REF/)
  assert.match(secret, /OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET/)
  assert.match(secret, /OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET_REF/)
  assert.match(secret, /OPEN_COWORK_CLOUD_OTLP_HEADERS/)
})

test('gateway Helm chart keeps provider-neutral gateway wiring explicit', () => {
  const chart = readRepoFile('helm/open-cowork-gateway/Chart.yaml')
  const values = readRepoFile('helm/open-cowork-gateway/values.yaml')
  const deployment = readRepoFile('helm/open-cowork-gateway/templates/deployment.yaml')
  const configMap = readRepoFile('helm/open-cowork-gateway/templates/configmap.yaml')
  const secret = readRepoFile('helm/open-cowork-gateway/templates/secret.yaml')

  assert.match(chart, /name: open-cowork-gateway/)
  assert.match(values, /repository: ghcr\.io\/joe-broadhead\/open-cowork-gateway/)
  assert.match(values, /mode: self-host/)
  assert.match(values, /cloudBaseUrl: ""/)
  assert.match(values, /serviceToken: ""/)
  assert.match(values, /adminToken: ""/)
  assert.match(values, /branding:/)
  assert.match(values, /productName: Open Cowork Cloud/)
  assert.match(values, /diagnostics:\n {4}enabled: false/)
  assert.match(values, /providersJson: ""/)
  assert.match(values, /telegram:/)
  assert.match(values, /webhook:/)
  assert.match(values, /podSecurityContext:/)
  assert.match(values, /runAsNonRoot: true/)
  assert.match(values, /containerSecurityContext:/)
  assert.match(values, /allowPrivilegeEscalation: false/)
  assert.match(deployment, /gateway\.cloudBaseUrl is required/)
  assert.match(deployment, /gateway\.serviceToken or gateway\.existingSecret is required/)
  assert.match(deployment, /gateway\.providersJson, gateway\.telegram\.botToken, gateway\.webhook\.deliveryUrl, or gateway\.existingSecret is required/)
  assert.match(deployment, /gateway\.adminToken or gateway\.existingSecret is required/)
  assert.match(deployment, /gateway diagnostics are enabled on a public bind/)
  assert.match(deployment, /gateway\.webhook\.sharedSecret or gateway\.existingSecret is required/)
  assert.match(deployment, /\/health/)
  assert.match(deployment, /\/ready/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_BASE_URL/)
  assert.match(configMap, /OPEN_COWORK_GATEWAY_MODE/)
  assert.match(configMap, /OPEN_COWORK_GATEWAY_PUBLIC_BRANDING_JSON/)
  assert.match(configMap, /OPEN_COWORK_GATEWAY_METRICS_ENABLED/)
  assert.match(configMap, /OPEN_COWORK_GATEWAY_DIAGNOSTICS_ENABLED/)
  assert.match(secret, /OPEN_COWORK_GATEWAY_SERVICE_TOKEN/)
  assert.match(secret, /OPEN_COWORK_GATEWAY_ADMIN_TOKEN/)
  assert.match(secret, /OPEN_COWORK_GATEWAY_PROVIDERS/)
  assert.match(secret, /OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN/)
  assert.match(secret, /OPEN_COWORK_GATEWAY_WEBHOOK_SHARED_SECRET/)
})

test('Acme downstream example covers desktop, cloud, and gateway branding parity', () => {
  const readme = readRepoFile('examples/downstream/acme/README.md')
  const desktopConfig = readRepoFile('examples/downstream/acme/open-cowork.config.json')
  const cloudValues = readRepoFile('examples/downstream/acme/cloud-values.yaml')
  const gatewayValues = readRepoFile('examples/downstream/acme/gateway-values.yaml')

  assert.match(readme, /Internal enterprise mode/)
  assert.match(readme, /Managed BYOK SaaS mode/)
  assert.match(desktopConfig, /"name": "Acme Cowork"/)
  assert.match(desktopConfig, /"publicBranding"/)
  assert.match(desktopConfig, /"preconfiguredConnections"/)
  assert.match(desktopConfig, /"allowUserAddedConnections": false/)
  assert.match(cloudValues, /productName: Acme Cowork/)
  assert.match(cloudValues, /oidcIssuerUrl: https:\/\/idp\.acme\.example/)
  assert.match(cloudValues, /profile: data-analyst/)
  assert.match(gatewayValues, /cloudBaseUrl: https:\/\/cowork\.acme\.example/)
  assert.match(gatewayValues, /productName: Acme Cowork/)
  assert.match(gatewayValues, /channelBindingId: acme-telegram/)
})

test('cloud CLI entrypoint uses the shared config loader and cloud app bootstrap', () => {
  const script = readRepoFile('scripts/open-cowork-cloud.ts')
  assert.match(script, /getAppConfig/)
  assert.match(script, /startCloudApp/)
  assert.doesNotMatch(script, /loadConfig/)
})

test('cloud image builds workspace packages required by package entrypoints', () => {
  const dockerfile = readRepoFile('docker/open-cowork-cloud/Dockerfile')
  const gatewayDockerfile = readRepoFile('docker/open-cowork-gateway/Dockerfile')
  const buildScript = readRepoFile('scripts/build-cloud.mjs')

  assert.match(buildScript, /cloudElectronShimPlugin/)
  assert.match(buildScript, /onResolve\(\{ filter: \/\^electron\$\/ \}/)
  assert.match(buildScript, /plugins: \[cloudElectronShimPlugin\]/)

  assert.match(dockerfile, /pnpm install --frozen-lockfile/)
  assert.match(dockerfile, /pnpm install --frozen-lockfile --prod/)
  assert.match(dockerfile, /pnpm --filter @open-cowork\/shared build/)
  assert.match(dockerfile, /pnpm cloud:build/)
  assert.match(dockerfile, /USER node/)
  assert.match(dockerfile, /HEALTHCHECK/)
  assert.match(dockerfile, /CMD \["pnpm", "cloud:start"\]/)

  assert.match(gatewayDockerfile, /pnpm --filter @open-cowork\/gateway build/)
  assert.match(gatewayDockerfile, /pnpm --filter @open-cowork\/shared build/)
  assert.match(gatewayDockerfile, /COPY scripts \.\/scripts/)
  assert.match(gatewayDockerfile, /pnpm install --frozen-lockfile --prod/)
  assert.match(gatewayDockerfile, /OPEN_COWORK_GATEWAY_PORT=8790/)
  assert.match(gatewayDockerfile, /USER node/)
  assert.match(gatewayDockerfile, /\/ready/)
  assert.match(gatewayDockerfile, /CMD \["pnpm", "--dir", "apps\/gateway", "start"\]/)
})

test('cloud provider recipes stay thin compositions of the shared image and adapters', () => {
  const index = readRepoFile('deploy/README.md')
  assert.match(index, /`open-cowork-cloud` and `open-cowork-gateway` images/)
  assert.match(index, /open-cowork-gateway/)
  assert.match(index, /Postgres/)
  assert.match(index, /OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED=true/)

  const recipes = {
    gcp: ['Cloud SQL for PostgreSQL', 'Cloud Storage', 'Secret Manager', 'GKE', 'open-cowork-gateway'],
    aws: ['RDS for PostgreSQL', 'S3', 'Secrets Manager', 'EKS', 'open-cowork-gateway'],
    azure: ['Azure Database for PostgreSQL', 'Azure Blob Storage', 'Key Vault', 'AKS', 'open-cowork-gateway'],
    digitalocean: ['Managed PostgreSQL', 'Spaces', 'DOKS', 'App Platform', 'open-cowork-gateway'],
  }

  for (const [provider, expected] of Object.entries(recipes)) {
    const readme = readRepoFile(`deploy/${provider}/README.md`)
    assert.match(readme, /open-cowork-cloud/)
    assert.match(readme, /cloud.checkpoints.enabled=true/)
    assert.match(readme, /helm upgrade --install open-cowork-cloud/)
    assert.match(readme, /helm upgrade --install open-cowork-gateway/)
    assert.match(readme, /gateway.existingSecret=open-cowork-gateway-secrets/)
    for (const phrase of expected) {
      assert.match(readme, new RegExp(phrase))
    }
  }
})

test('managed operations runbook covers readiness, rollback, diagnostics, and gateway backlog', () => {
  const runbook = readRepoFile('docs/runbooks/cloud-managed-operations.md')

  for (const phrase of [
    'GET /healthz',
    'GET /api/workers/heartbeats',
    'GET /ready',
    'Rollback',
    'Worker Drains',
    'Gateway Backlog',
    'Secret Rotation',
    'Diagnostics',
    'API tokens',
    'BYOK keys',
    'object-store signed URLs',
    'local host paths',
    'Restore Check',
  ]) {
    assert.match(runbook, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('CI enforces cloud portability, concurrency, and deployment gates', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml')

  assert.match(workflow, /cloud-gates:/)
  assert.match(workflow, /postgres:17-alpine/)
  assert.match(workflow, /proof:cloud:opencode-portability --json/)
  assert.match(workflow, /OPEN_COWORK_TEST_POSTGRES_URL/)
  assert.match(workflow, /cloud-postgres-concurrency\.test\.ts/)
  assert.match(workflow, /docker compose -f docker-compose\.cloud\.yml config --quiet/)
  assert.match(workflow, /docker compose -f docker-compose\.cloud\.split\.yml config --quiet/)
  assert.match(workflow, /docker compose -f docker-compose\.cloud-gateway\.yml config --quiet/)
  assert.match(workflow, /docker build -f docker\/open-cowork-cloud\/Dockerfile/)
  assert.match(workflow, /docker build -f docker\/open-cowork-gateway\/Dockerfile/)
  assert.match(workflow, /bash scripts\/ci-cloud-compose-smoke\.sh docker-compose\.cloud\.split\.yml/)
  assert.match(workflow, /OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER=true OPEN_COWORK_GATEWAY_SMOKE_URL=http:\/\/127\.0\.0\.1:8790\/ready bash scripts\/ci-cloud-compose-smoke\.sh docker-compose\.cloud-gateway\.yml/)
  assert.match(workflow, /helm dependency build helm\/open-cowork-cloud/)
  assert.match(workflow, /helm lint helm\/open-cowork-cloud/)
  assert.match(workflow, /helm template open-cowork-cloud helm\/open-cowork-cloud/)
  assert.match(workflow, /gateway\.enabled=true/)
  assert.match(workflow, /OPEN_COWORK_GATEWAY_SERVICE_TOKEN/)
  assert.match(workflow, /helm lint helm\/open-cowork-gateway/)
  assert.match(workflow, /helm template open-cowork-gateway helm\/open-cowork-gateway/)

  const smoke = readRepoFile('scripts/ci-cloud-compose-smoke.sh')
  assert.match(smoke, /docker compose -p "\$\{project_name\}" -f "\$\{compose_file\}" up --build -d/)
  assert.match(smoke, /http:\/\/127\.0\.0\.1:8787\/healthz/)
  assert.match(smoke, /OPEN_COWORK_GATEWAY_SMOKE_URL/)
  assert.match(smoke, /docker compose -p "\$\{project_name\}" -f "\$\{compose_file\}" logs --no-color --tail=200/)
})

test('release workflow publishes versioned cloud and gateway OCI images', () => {
  const workflow = readRepoFile('.github/workflows/release.yml')

  assert.match(workflow, /publish-oci-images:/)
  assert.match(workflow, /packages: write/)
  assert.match(workflow, /docker login ghcr\.io/)
  assert.match(workflow, /docker\/open-cowork-cloud\/Dockerfile/)
  assert.match(workflow, /docker\/open-cowork-gateway\/Dockerfile/)
  assert.match(workflow, /image="ghcr\.io\/\$\{owner\}\/open-cowork-cloud"/)
  assert.match(workflow, /image="ghcr\.io\/\$\{owner\}\/open-cowork-gateway"/)
  assert.match(workflow, /-t "\$\{image\}:\$\{GITHUB_REF_NAME\}"/)
  assert.match(workflow, /docker push "\$\{image\}:\$\{version\}"/)
})
