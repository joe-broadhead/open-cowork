import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function readRepoFile(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

test('split cloud compose declares web, worker, and scheduler roles', () => {
  const compose = readRepoFile('docker-compose.cloud.split.yml')
  assert.match(compose, /Local\/demo split-role reference only/)
  assert.match(compose, /open-cowork-cloud-web:/)
  assert.match(compose, /image: \$\{OPEN_COWORK_CLOUD_IMAGE:-open-cowork-cloud:local\}/)
  assert.match(compose, /OPEN_COWORK_CLOUD_ROLE: web/)
  assert.match(compose, /OPEN_COWORK_CLOUD_AUTO_PROCESS_COMMANDS: "false"/)
  assert.match(compose, /OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH: "true"/)
  assert.match(compose, /OPEN_COWORK_CLOUD_COOKIE_SECRET: change-me-for-local-cookie-secret/)
  assert.match(compose, /OPEN_COWORK_CLOUD_INTERNAL_TOKEN: change-me-for-local-internal-token/)
  assert.match(compose, /OPEN_COWORK_CONFIG_PATH: \$\{OPEN_COWORK_CONFIG_PATH:-\}/)
  assert.match(compose, /OPEN_COWORK_CONFIG_DIR: \$\{OPEN_COWORK_CONFIG_DIR:-\}/)
  assert.match(compose, /OPEN_COWORK_DOWNSTREAM_ROOT: \$\{OPEN_COWORK_DOWNSTREAM_ROOT:-\}/)
  assert.match(compose, /\$\{OPEN_COWORK_CONFIG_PATH:-\.\/open-cowork\.config\.json\}:\$\{OPEN_COWORK_CONFIG_PATH:-\/etc\/open-cowork\/open-cowork\.config\.json\}:ro/)
  assert.match(compose, /\$\{OPEN_COWORK_CONFIG_DIR:-\.\}:\$\{OPEN_COWORK_CONFIG_DIR:-\/etc\/open-cowork\/config\}:ro/)
  assert.match(compose, /\$\{OPEN_COWORK_DOWNSTREAM_ROOT:-\.\}:\$\{OPEN_COWORK_DOWNSTREAM_ROOT:-\/etc\/open-cowork\/downstream\}:ro/)
  assert.match(compose, /OPEN_COWORK_CLOUD_COOKIE_SECURE: "false"/)
  assert.match(compose, /OPEN_COWORK_CLOUD_PUBLIC_URL: http:\/\/localhost:8787/)
  assert.match(compose, /OPEN_COWORK_CLOUD_SERVICE_NAME: open-cowork-cloud/)
  assert.match(compose, /OPEN_COWORK_CLOUD_LOG_FORMAT: json/)
  assert.match(compose, /OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS: 30000/)
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
  assert.match(compose, /Local\/demo Cloud plus Gateway reference only/)
  assert.match(compose, /open-cowork-cloud:/)
  assert.match(compose, /OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS: 30000/)
  assert.match(compose, /open-cowork-gateway:/)
  assert.match(compose, /image: \$\{OPEN_COWORK_CLOUD_IMAGE:-open-cowork-cloud:local\}/)
  assert.match(compose, /image: \$\{OPEN_COWORK_GATEWAY_IMAGE:-open-cowork-gateway:local\}/)
  assert.match(compose, /docker\/open-cowork-gateway\/Dockerfile/)
  assert.match(compose, /OPEN_COWORK_CONFIG_PATH: \$\{OPEN_COWORK_CONFIG_PATH:-\}/)
  assert.match(compose, /OPEN_COWORK_CONFIG_DIR: \$\{OPEN_COWORK_CONFIG_DIR:-\}/)
  assert.match(compose, /OPEN_COWORK_DOWNSTREAM_ROOT: \$\{OPEN_COWORK_DOWNSTREAM_ROOT:-\}/)
  assert.match(compose, /\$\{OPEN_COWORK_CONFIG_PATH:-\.\/open-cowork\.config\.json\}:\$\{OPEN_COWORK_CONFIG_PATH:-\/etc\/open-cowork\/open-cowork\.config\.json\}:ro/)
  assert.match(compose, /\$\{OPEN_COWORK_CONFIG_DIR:-\.\}:\$\{OPEN_COWORK_CONFIG_DIR:-\/etc\/open-cowork\/config\}:ro/)
  assert.match(compose, /\$\{OPEN_COWORK_DOWNSTREAM_ROOT:-\.\}:\$\{OPEN_COWORK_DOWNSTREAM_ROOT:-\/etc\/open-cowork\/downstream\}:ro/)
  assert.match(compose, /OPEN_COWORK_CLOUD_BASE_URL: http:\/\/open-cowork-cloud:8787/)
  assert.match(compose, /OPEN_COWORK_GATEWAY_SERVICE_TOKEN/)
  assert.match(compose, /OPEN_COWORK_GATEWAY_ADMIN_TOKEN/)
  assert.match(compose, /OPEN_COWORK_GATEWAY_ALLOW_INSECURE_HTTP: "true"/)
  assert.match(compose, /OPEN_COWORK_GATEWAY_METRICS_ENABLED: "false"/)
  assert.match(compose, /OPEN_COWORK_GATEWAY_DIAGNOSTICS_ENABLED: "false"/)
  assert.match(compose, /OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER: \$\{OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER:-false\}/)
  assert.match(compose, /OPEN_COWORK_GATEWAY_ALLOW_PUBLIC_FAKE_PROVIDER: \$\{OPEN_COWORK_GATEWAY_ALLOW_PUBLIC_FAKE_PROVIDER:-false\}/)
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
  assert.match(docs, /OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS/)
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
  assert.match(docs, /GET \/api\/metrics/)
  assert.match(docs, /web app at `\/`/)
  assert.match(docs, /Cloud Web Workbench readiness gates/)
  assert.match(docs, /pnpm test:cloud-web/)
  assert.match(docs, /createHttpSseCloudTransportAdapter/)
  assert.match(docs, /Generic Docker: Cloud \+ Gateway/)
  assert.match(docs, /docker-compose\.cloud-gateway\.yml/)
  assert.match(docs, /GET \/ready/)
  assert.match(docs, /OPEN_COWORK_GATEWAY_SERVICE_TOKEN/)
  assert.match(docs, /OPEN_COWORK_GATEWAY_DIAGNOSTICS_ENABLED/)
  assert.match(docs, /helm\/open-cowork-gateway/)
  assert.match(docs, /cloud-managed-operations\.md/)
  assert.match(docs, /deployment-readiness\.md/)
  assert.match(docs, /runbooks\/managed-byok-saas\.md/)
  assert.match(docs, /deploy\/managed-workers\//)
  assert.match(docs, /pnpm deploy:validate/)
  assert.match(docs, /pnpm deploy:smoke/)
  assert.match(docs, /pnpm deploy:desktop:smoke/)
  assert.match(docs, /pnpm deploy:gateway:smoke/)
  assert.match(docs, /pnpm deploy:continuation:smoke/)
})

test('cloud Helm chart keeps provider-neutral role wiring explicit', () => {
  const chart = readRepoFile('helm/open-cowork-cloud/Chart.yaml')
  const values = readRepoFile('helm/open-cowork-cloud/values.yaml')
  const deployment = readRepoFile('helm/open-cowork-cloud/templates/deployment.yaml')
  const configMap = readRepoFile('helm/open-cowork-cloud/templates/configmap.yaml')
  const secret = readRepoFile('helm/open-cowork-cloud/templates/secret.yaml')
  const serviceAccount = readRepoFile('helm/open-cowork-cloud/templates/serviceaccount.yaml')

  assert.match(chart, /name: open-cowork-cloud/)
  assert.match(chart, /open-cowork-gateway/)
  assert.match(values, /web:/)
  assert.match(values, /tag: "0\.0\.0"/)
  assert.match(values, /digest: ""/)
  assert.doesNotMatch(values, /tag: latest/)
  assert.match(values, /worker:/)
  assert.match(values, /scheduler:/)
  assert.match(values, /gateway:/)
  assert.equal(values.includes('worker:\n    enabled: false\n    replicas: 1'), true)
  assert.match(values, /configPath: ""/)
  assert.match(values, /configDir: ""/)
  assert.match(values, /downstreamRoot: ""/)
  assert.match(values, /checkpoints:/)
  assert.match(values, /shutdownGraceMs: 300000/)
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
  assert.match(values, /terminationGracePeriodSeconds: 300/)
  assert.match(values, /updateStrategy:/)
  assert.match(values, /maxUnavailable: 0/)
  assert.match(values, /topologySpreadConstraints: \[\]/)
  assert.match(values, /podDisruptionBudget:/)
  assert.match(values, /podSecurityContext:/)
  assert.match(values, /runAsNonRoot: true/)
  assert.match(values, /containerSecurityContext:/)
  assert.match(values, /allowPrivilegeEscalation: false/)
  assert.match(values, /serviceAccount:/)
  assert.match(values, /automountServiceAccountToken: true/)
  assert.match(values, /allowInsecureAuth: false/)
  assert.match(values, /allowInsecurePublicAuth: false/)
  assert.match(values, /internalToken: ""/)
  assert.match(values, /kind: filesystem/)
  assert.match(deployment, /OPEN_COWORK_CLOUD_ROLE/)
  assert.match(deployment, /cloud\.auth\.mode=none requires explicit cloud\.allowInsecureAuth=true/)
  assert.match(deployment, /cloud\.auth\.mode=none with public service or ingress requires explicit cloud\.allowInsecurePublicAuth=true/)
  assert.match(deployment, /image\.tag=latest is not allowed/)
  assert.match(deployment, /worker and scheduler roles require a shared control plane/)
  assert.match(deployment, /roles\.worker\.replicas > 1 requires cloud\.checkpoints\.enabled=true/)
  assert.match(deployment, /cloud\.objectStore\.kind=filesystem is local\/demo-only/)
  assert.match(deployment, /roles\.worker\.replicas > 1 requires cloud\.objectStore\.bucket/)
  assert.match(deployment, /roles\.worker\.terminationGracePeriodSeconds must be >= 30/)
  assert.match(deployment, /terminationGracePeriodSeconds:/)
  assert.match(deployment, /strategy:/)
  assert.match(deployment, /OPEN_COWORK_CLOUD_WORKER_ID/)
  assert.match(deployment, /OPEN_COWORK_CLOUD_SCHEDULER_ID/)
  assert.match(deployment, /serviceAccountName:/)
  assert.match(deployment, /livenessProbe:/)
  assert.match(deployment, /roles\.worker\.persistence\.enabled cannot be used/)
  assert.match(deployment, /topologySpreadConstraints:/)
  assert.match(deployment, /emptyDir: {}/)
  assert.match(deployment, /securityContext:/)
  const cloudPdb = readRepoFile('helm/open-cowork-cloud/templates/pdb.yaml')
  assert.match(cloudPdb, /PodDisruptionBudget/)
  assert.match(cloudPdb, /podDisruptionBudget\.enabled/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_OBJECT_STORE_KIND/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS/)
  assert.match(configMap, /OPEN_COWORK_CONFIG_PATH/)
  assert.match(configMap, /OPEN_COWORK_CONFIG_DIR/)
  assert.match(configMap, /OPEN_COWORK_DOWNSTREAM_ROOT/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_AUTH_MODE/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_OIDC_ISSUER_URL/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_OIDC_CLIENT_ID/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_ALLOWED_EMAIL_DOMAINS/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_COOKIE_SECURE/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_PUBLIC_URL/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS/)
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
  assert.match(serviceAccount, /kind: ServiceAccount/)
  assert.match(serviceAccount, /automountServiceAccountToken:/)
})

test('GCP reference deployment defines split roles, Cloud Run demo, and smoke gates', () => {
  const readme = readRepoFile('deploy/gcp/README.md')
  const values = readRepoFile('deploy/gcp/gke/values.gke.yaml.example')
  const externalSecret = readRepoFile('deploy/gcp/gke/external-secret.example.yaml')
  const certificate = readRepoFile('deploy/gcp/gke/managed-certificate.example.yaml')
  const cloudRun = readRepoFile('deploy/gcp/cloud-run/all-in-one.service.yaml.example')
  const smoke = readRepoFile('deploy/gcp/smoke/README.md')
  const preflightScript = readRepoFile('scripts/gcp-reference-preflight.mjs')
  const smokeScript = readRepoFile('scripts/gcp-reference-smoke.mjs')
  const desktopSmokeScript = readRepoFile('scripts/desktop-cloud-sync-smoke.mjs')
  const gatewaySmokeScript = readRepoFile('scripts/gateway-cloud-smoke.mjs')
  const continuationSmokeScript = readRepoFile('scripts/cloud-continuation-smoke.mjs')
  const launchReadinessScript = readRepoFile('scripts/launch-readiness.mjs')
  const launchTargets = readRepoFile('deploy/load/launch-readiness-targets.json')

  assert.match(readme, /GCP Reference Deployment/)
  assert.match(readme, /Cloud SQL for PostgreSQL/)
  assert.match(readme, /Cloud Storage/)
  assert.match(readme, /Secret Manager/)
  assert.match(readme, /^- `iamcredentials\.googleapis\.com`$/m)
  assert.match(readme, /OPEN_COWORK_GCP_REGION/)
  assert.match(readme, /pnpm deploy:gcp:preflight/)
  assert.match(readme, /pnpm deploy:gcp:smoke/)
  assert.match(readme, /pnpm deploy:desktop:smoke/)
  assert.match(readme, /pnpm deploy:gateway:smoke/)
  assert.match(readme, /pnpm deploy:continuation:smoke/)
  assert.match(readme, /pnpm deploy:load/)
  assert.match(readme, /pnpm deploy:soak/)
  assert.match(readme, /OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true/)
  assert.match(readme, /OPEN_COWORK_LOAD_INCLUDE_SSE=true/)
  assert.match(readme, /OPEN_COWORK_LOAD_OPERATOR_CHECKS=true/)
  assert.match(readme, /OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic/)
  assert.match(readme, /Desktop cloud-sync smoke/)
  assert.match(readme, /Gateway cloud smoke/)
  assert.match(readme, /Web\/Desktop\/Gateway continuation smoke/)
  assert.match(readme, /kubectl apply -f deploy\/gcp\/gke\/external-secret\.example\.yaml/)
  assert.match(readme, /kubectl apply -f deploy\/gcp\/gke\/managed-certificate\.example\.yaml/)
  assert.match(readme, /OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS=true/)
  assert.match(readme, /Rollback order/)
  assert.match(readme, /GCP configuration is adapter wiring only/)

  assert.match(values, /REGION-docker\.pkg\.dev\/PROJECT\/open-cowork\/open-cowork-cloud/)
  assert.match(values, /existingSecret: open-cowork-cloud-secrets/)
  assert.match(values, /mode: oidc/)
  assert.match(values, /publicUrl: https:\/\/cowork\.example\.com/)
  assert.match(values, /trustProxyHeaders: true/)
  assert.match(values, /kind: gcs/)
  assert.match(values, /web:\n {4}enabled: true/)
  assert.match(values, /worker:\n {4}enabled: true/)
  assert.match(values, /scheduler:\n {4}enabled: true/)
  assert.match(values, /checkpointsEnabled: true/)
  assert.match(values, /serviceAccount:\n {2}create: true/)
  assert.match(values, /^ {4}iam\.gke\.io\/gcp-service-account: open-cowork-cloud@PROJECT\.iam\.gserviceaccount\.com$/m)
  assert.match(values, /^ {4}cloud\.google\.com\/neg: '\{"ingress": true\}'$/m)
  assert.match(values, /kubernetes\.io\/ingress\.class: gce/)
  assert.match(values, /kubernetes\.io\/ingress\.allow-http: "false"/)

  assert.match(externalSecret, /ClusterSecretStore/)
  assert.match(externalSecret, /gcpsm/)
  assert.match(externalSecret, /workloadIdentity/)
  assert.match(externalSecret, /OPEN_COWORK_CLOUD_CONTROL_PLANE_URL/)
  assert.match(externalSecret, /OPEN_COWORK_CLOUD_SECRET_KEY_REF/)
  assert.match(externalSecret, /OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET/)
  assert.match(certificate, /ManagedCertificate/)
  assert.match(certificate, /^ {4}- cowork\.example\.com$/m)

  assert.match(cloudRun, /Cloud Run all-in-one demo profile/)
  assert.match(cloudRun, /^ {8}run\.googleapis\.com\/cloudsql-instances: PROJECT:REGION:INSTANCE$/m)
  assert.match(cloudRun, /^ {8}run\.googleapis\.com\/secrets: >-$/m)
  assert.match(cloudRun, /open-cowork-cloud-control-plane-url:projects\/PROJECT_NUMBER\/secrets\/open-cowork-cloud-control-plane-url,/)
  assert.match(cloudRun, /OPEN_COWORK_CLOUD_ROLE/)
  assert.match(cloudRun, /all-in-one/)
  assert.match(cloudRun, /OPEN_COWORK_CLOUD_AUTH_MODE/)
  assert.match(cloudRun, /OPEN_COWORK_CLOUD_OBJECT_STORE_KIND/)
  assert.match(cloudRun, /gcs/)
  assert.match(cloudRun, /OPEN_COWORK_CLOUD_SECRET_KEY_REF/)

  assert.match(smoke, /OPEN_COWORK_GCP_BUCKET/)
  assert.match(smoke, /OPEN_COWORK_GCP_SECRET_REF/)
  assert.match(smoke, /OPEN_COWORK_DESKTOP_SMOKE_CLOUD_URL/)
  assert.match(smoke, /pnpm deploy:desktop:smoke/)
  assert.match(smoke, /OPEN_COWORK_GATEWAY_SMOKE_CLOUD_URL/)
  assert.match(smoke, /OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN/)
  assert.match(smoke, /pnpm deploy:gateway:smoke/)
  assert.match(smoke, /Gateway Cloud Smoke/)
  assert.match(smoke, /OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL/)
  assert.match(smoke, /OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN/)
  assert.match(smoke, /OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION/)
  assert.match(smoke, /pnpm deploy:continuation:smoke/)
  assert.match(smoke, /Continuation Parity Smoke/)
  assert.match(smoke, /OPEN_COWORK_LOAD_CLOUD_URL/)
  assert.match(smoke, /OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true/)
  assert.match(smoke, /OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic/)
  assert.match(smoke, /pnpm deploy:load/)
  assert.match(smoke, /pnpm deploy:soak/)
  assert.match(preflightScript, /requiredApis/)
  assert.match(preflightScript, /optionalApis/)
  assert.match(preflightScript, /^ {2}'iamcredentials\.googleapis\.com',$/m)
  assert.match(preflightScript, /OPEN_COWORK_GCP_REQUIRE_CLOUD_RUN/)
  assert.match(preflightScript, /did not return a status URL/)
  assert.match(preflightScript, /'services'/)
  assert.match(preflightScript, /'list'/)
  assert.match(smokeScript, /'storage'/)
  assert.match(smokeScript, /'cp'/)
  assert.match(smokeScript, /'--all-versions'/)
  assert.match(smokeScript, /'secrets'/)
  assert.match(smokeScript, /'versions'/)
  assert.match(smokeScript, /'access'/)
  assert.equal(smokeScript.includes('--cloud-token'), false)
  assert.match(desktopSmokeScript, /CloudWorkspaceAdapter/)
  assert.match(desktopSmokeScript, /OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN/)
  assert.match(desktopSmokeScript, /subscribeWorkspaceEvents/)
  assert.match(desktopSmokeScript, /subscribeSessionEvents/)
  assert.match(desktopSmokeScript, /revokeApiToken/)
  assert.match(desktopSmokeScript, /offlineMutationsBlocked/)
  assert.match(desktopSmokeScript, /LOCAL_WORKSPACE_ID/)
  assert.equal(desktopSmokeScript.includes('--desktop-token'), false)
  assert.match(gatewaySmokeScript, /createGatewayDaemon/)
  assert.match(gatewaySmokeScript, /OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN/)
  assert.match(gatewaySmokeScript, /OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL/)
  assert.match(gatewaySmokeScript, /OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_ADMIN_TOKEN/)
  assert.match(gatewaySmokeScript, /createHeadlessAgent/)
  assert.match(gatewaySmokeScript, /createChannelBinding/)
  assert.match(gatewaySmokeScript, /resolveChannelIdentity/)
  assert.match(gatewaySmokeScript, /revokeApiToken/)
  assert.match(gatewaySmokeScript, /Gateway fake webhook/)
  assert.match(gatewaySmokeScript, /dead-letter/)
  assert.match(gatewaySmokeScript, /leastPrivilegeChecks/)
  assert.equal(gatewaySmokeScript.includes('--service-token'), false)
  assert.match(continuationSmokeScript, /CloudWorkspaceAdapter/)
  assert.match(continuationSmokeScript, /createGatewayDaemon/)
  assert.match(continuationSmokeScript, /OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL/)
  assert.match(continuationSmokeScript, /OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN/)
  assert.match(continuationSmokeScript, /OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION/)
  assert.match(continuationSmokeScript, /readCloudSessionProjection/)
  assert.match(continuationSmokeScript, /bindGatewayToSession/)
  assert.match(continuationSmokeScript, /runConcurrentPromptCheck/)
  assert.match(continuationSmokeScript, /runReplayHydrationCheck/)
  assert.match(continuationSmokeScript, /X-Request-Id/)
  assert.match(continuationSmokeScript, /revokeIssuedTokens/)
  assert.equal(continuationSmokeScript.includes('--admin-token'), false)
  assert.match(launchReadinessScript, /OPEN_COWORK_LOAD_CLOUD_URL/)
  assert.match(launchReadinessScript, /OPEN_COWORK_LOAD_GATEWAY_URL/)
  assert.match(launchReadinessScript, /OPEN_COWORK_LOAD_INCLUDE_MUTATIONS/)
  assert.match(launchReadinessScript, /OPEN_COWORK_LOAD_INCLUDE_SSE/)
  assert.match(launchReadinessScript, /OPEN_COWORK_LOAD_STRICT/)
  assert.match(launchReadinessScript, /OPEN_COWORK_LOAD_BYOK_PROVIDER/)
  assert.match(launchReadinessScript, /\/api\/sessions/)
  assert.match(launchReadinessScript, /\/api\/events/)
  assert.match(launchReadinessScript, /\/api\/channels\/deliveries/)
  assert.match(launchReadinessScript, /\/api\/threads/)
  assert.match(launchReadinessScript, /\/api\/workflows/)
  assert.match(launchReadinessScript, /\/artifacts/)
  assert.match(launchReadinessScript, /open_cowork_gateway_delivery_dead_letters_total/)
  assert.match(launchTargets, /private-beta/)
  assert.match(launchTargets, /public-beta/)
  assert.doesNotMatch(readme, /opencowork/)
})

test('gateway Helm chart keeps provider-neutral gateway wiring explicit', () => {
  const chart = readRepoFile('helm/open-cowork-gateway/Chart.yaml')
  const values = readRepoFile('helm/open-cowork-gateway/values.yaml')
  const deployment = readRepoFile('helm/open-cowork-gateway/templates/deployment.yaml')
  const configMap = readRepoFile('helm/open-cowork-gateway/templates/configmap.yaml')
  const secret = readRepoFile('helm/open-cowork-gateway/templates/secret.yaml')

  assert.match(chart, /name: open-cowork-gateway/)
  assert.match(values, /repository: ghcr\.io\/joe-broadhead\/open-cowork-gateway/)
  assert.match(values, /tag: "0\.0\.0"/)
  assert.match(values, /digest: ""/)
  assert.doesNotMatch(values, /tag: latest/)
  assert.match(values, /mode: self-host/)
  assert.match(values, /configPath: ""/)
  assert.match(values, /configDir: ""/)
  assert.match(values, /downstreamRoot: ""/)
  assert.match(values, /cloudBaseUrl: ""/)
  assert.match(values, /serviceToken: ""/)
  assert.match(values, /adminToken: ""/)
  assert.match(values, /branding:/)
  assert.match(values, /productName: Open Cowork Cloud/)
  assert.match(values, /diagnostics:\n {4}enabled: false/)
  assert.match(values, /providersJson: ""/)
  assert.match(values, /telegram:/)
  assert.match(values, /slack:/)
  assert.match(values, /email:/)
  assert.match(values, /webhook:/)
  assert.match(values, /podSecurityContext:/)
  assert.match(values, /runAsNonRoot: true/)
  assert.match(values, /containerSecurityContext:/)
  assert.match(values, /allowPrivilegeEscalation: false/)
  assert.match(values, /topologySpreadConstraints: \[\]/)
  assert.match(values, /podDisruptionBudget:/)
  assert.match(deployment, /gateway\.cloudBaseUrl is required/)
  assert.match(deployment, /image\.tag=latest is not allowed/)
  assert.match(deployment, /gateway\.serviceToken or gateway\.existingSecret is required/)
  assert.match(deployment, /gateway\.providersJson, gateway\.telegram\.botToken, gateway\.slack\.botToken, gateway\.email\.inboundSecret, gateway\.webhook\.deliveryUrl, or gateway\.existingSecret is required/)
  assert.match(deployment, /gateway\.adminToken or gateway\.existingSecret is required/)
  assert.match(deployment, /\$sharedConfig/)
  assert.match(deployment, /public gateway binds/)
  assert.match(deployment, /gateway\.webhook\.sharedSecret or gateway\.existingSecret is required/)
  assert.match(deployment, /gateway\.slack\.signingSecret or gateway\.existingSecret is required/)
  assert.match(deployment, /gateway\.email\.from and gateway\.email\.smtpHost are required/)
  assert.match(deployment, /\/health/)
  assert.match(deployment, /\/ready/)
  assert.match(deployment, /topologySpreadConstraints:/)
  const gatewayPdb = readRepoFile('helm/open-cowork-gateway/templates/pdb.yaml')
  assert.match(gatewayPdb, /PodDisruptionBudget/)
  assert.match(gatewayPdb, /podDisruptionBudget\.enabled/)
  assert.match(configMap, /OPEN_COWORK_CLOUD_BASE_URL/)
  assert.match(configMap, /OPEN_COWORK_CONFIG_PATH/)
  assert.match(configMap, /OPEN_COWORK_CONFIG_DIR/)
  assert.match(configMap, /OPEN_COWORK_DOWNSTREAM_ROOT/)
  assert.match(configMap, /OPEN_COWORK_GATEWAY_MODE/)
  assert.match(configMap, /OPEN_COWORK_GATEWAY_PUBLIC_BRANDING_JSON/)
  assert.match(configMap, /OPEN_COWORK_GATEWAY_METRICS_ENABLED/)
  assert.match(configMap, /OPEN_COWORK_GATEWAY_DIAGNOSTICS_ENABLED/)
  assert.match(configMap, /OPEN_COWORK_GATEWAY_SLACK_CHANNEL_BINDING_ID/)
  assert.match(configMap, /OPEN_COWORK_GATEWAY_EMAIL_SMTP_HOST/)
  assert.match(secret, /OPEN_COWORK_GATEWAY_SERVICE_TOKEN/)
  assert.match(secret, /OPEN_COWORK_GATEWAY_ADMIN_TOKEN/)
  assert.match(secret, /OPEN_COWORK_GATEWAY_PROVIDERS/)
  assert.match(secret, /OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN/)
  assert.match(secret, /OPEN_COWORK_GATEWAY_SLACK_SIGNING_SECRET/)
  assert.match(secret, /OPEN_COWORK_GATEWAY_EMAIL_INBOUND_SECRET/)
  assert.match(secret, /OPEN_COWORK_GATEWAY_WEBHOOK_SHARED_SECRET/)
})

test('Acme downstream example covers desktop, cloud, and gateway branding parity', () => {
  const readme = readRepoFile('examples/downstream/acme/README.md')
  const desktopConfig = readRepoFile('examples/downstream/acme/open-cowork.config.json')
  const cloudValues = readRepoFile('examples/downstream/acme/cloud-values.yaml')
  const gatewayValues = readRepoFile('examples/downstream/acme/gateway-values.yaml')

  assert.match(readme, /Internal enterprise mode/)
  assert.match(readme, /Managed BYOK SaaS mode/)
  assert.match(readme, /immutable downstream release tag or digest/)
  assert.match(readme, /cloud\.billing\.provider=none/)
  assert.match(readme, /OPEN_COWORK_CONFIG_PATH/)
  assert.match(readme, /cloud\.publicBranding/)
  assert.match(readme, /cloudDesktop/)
  assert.match(readme, /gateway\.providers/)
  assert.match(desktopConfig, /"name": "Acme Cowork"/)
  assert.match(desktopConfig, /"publicBranding"/)
  assert.match(desktopConfig, /"preconfiguredConnections"/)
  assert.match(desktopConfig, /"allowUserAddedConnections": false/)
  assert.match(desktopConfig, /"gateway"/)
  assert.match(desktopConfig, /OPEN_COWORK_GATEWAY_SERVICE_TOKEN/)
  assert.match(desktopConfig, /OPEN_COWORK_GATEWAY_ADMIN_TOKEN/)
  assert.match(desktopConfig, /OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN/)
  assert.match(desktopConfig, /"providers"/)
  assert.match(desktopConfig, /"kind": "telegram"/)
  assert.match(desktopConfig, /"kind": "slack"/)
  assert.match(desktopConfig, /"kind": "email"/)
  assert.match(cloudValues, /productName: Acme Cowork/)
  assert.match(cloudValues, /tag: v2026\.05\.0/)
  assert.match(cloudValues, /topologySpreadConstraints:/)
  assert.match(cloudValues, /podDisruptionBudget:/)
  assert.match(cloudValues, /oidcIssuerUrl: https:\/\/idp\.acme\.example/)
  assert.match(cloudValues, /profile: data-analyst/)
  assert.match(gatewayValues, /cloudBaseUrl: https:\/\/cowork\.acme\.example/)
  assert.match(gatewayValues, /productName: Acme Cowork/)
  assert.match(gatewayValues, /tag: v2026\.05\.0/)
  assert.match(gatewayValues, /topologySpreadConstraints:/)
  assert.match(gatewayValues, /podDisruptionBudget:/)
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
  const browserApp = readRepoFile('apps/desktop/src/main/cloud/browser-app.ts')
  const websitePackage = readRepoFile('apps/website/package.json')

  assert.match(buildScript, /cloudElectronShimPlugin/)
  assert.match(buildScript, /onResolve\(\{ filter: \/\^electron\$\/ \}/)
  assert.match(buildScript, /plugins: \[cloudElectronShimPlugin\]/)
  assert.match(browserApp, /website\/src\/render\.ts/)
  assert.match(websitePackage, /"test:browser"/)
  assert.match(websitePackage, /"test:a11y"/)
  assert.match(websitePackage, /"perf:check"/)

  assert.match(dockerfile, /pnpm install --frozen-lockfile/)
  assert.match(dockerfile, /pnpm install --frozen-lockfile --prod/)
  assert.match(dockerfile, /pnpm --filter @open-cowork\/shared build/)
  assert.match(dockerfile, /pnpm cloud:build/)
  assert.match(dockerfile, /USER node/)
  assert.match(dockerfile, /HEALTHCHECK/)
  assert.match(dockerfile, /CMD \["pnpm", "cloud:start"\]/)

  assert.match(gatewayDockerfile, /pnpm --filter @open-cowork\/gateway build/)
  assert.match(gatewayDockerfile, /pnpm --filter @open-cowork\/shared build/)
  assert.match(gatewayDockerfile, /COPY open-cowork\.config\.json open-cowork\.config\.schema\.json/)
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
  assert.match(index, /cloud\.publicBranding/)
  assert.match(index, /cloudDesktop/)
  assert.match(index, /gateway\.providers/)
  assert.match(index, /OPEN_COWORK_CONFIG_PATH/)
  assert.match(index, /Postgres/)
  assert.match(index, /OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED=true/)
  assert.match(index, /image\.tag=latest/)
  assert.match(index, /OPEN_COWORK_CLOUD_IMAGE/)
  assert.match(index, /HPA or KEDA/)
  assert.match(index, /PodDisruptionBudgets/)
  assert.match(index, /topology spread constraints/)
  assert.match(index, /cloud\.objectStore\.kind/)
  assert.match(index, /no billing/)
  assert.match(index, /stub billing provider/)
  assert.match(index, /pnpm deploy:validate/)
  assert.match(index, /pnpm deploy:smoke/)
  assert.match(index, /Provider recipes/)

  const recipes = {
    gcp: ['Cloud SQL for PostgreSQL', 'Cloud Storage', 'Secret Manager', 'GKE', 'open-cowork-gateway', 'Cloud Logging', 'Cloud SQL PITR'],
    aws: ['RDS for PostgreSQL', 'S3', 'Secrets Manager', 'EKS', 'open-cowork-gateway', 'CloudWatch Logs', 'RDS PITR'],
    azure: ['Azure Database for PostgreSQL', 'Azure Blob Storage', 'Key Vault', 'AKS', 'open-cowork-gateway', 'Azure Monitor', 'Azure PostgreSQL PITR'],
    digitalocean: ['Managed PostgreSQL', 'Spaces', 'DOKS', 'App Platform', 'open-cowork-gateway', 'App Platform logs', 'Managed PostgreSQL backups'],
    kubernetes: ['Generic Kubernetes Recipe', 'provider-neutral Helm charts', 'open-cowork-cloud-secrets', 'open-cowork-gateway-secrets', 'Prometheus/OTLP collector', 'Postgres PITR'],
  }

  for (const [provider, expected] of Object.entries(recipes)) {
    const readme = readRepoFile(`deploy/${provider}/README.md`)
    assert.match(readme, /open-cowork-cloud/)
    assert.match(readme, /open-cowork-gateway/)
    assert.match(readme, /pnpm deploy:validate/)
    assert.match(readme, /pnpm deploy:smoke/)
    assert.match(readme, /pnpm deploy:gateway:smoke/)
    assert.match(readme, /pnpm deploy:continuation:smoke/)
    assert.match(readme, /provider-config only|adapter wiring only/)
    assert.match(readme, /OPEN_COWORK_CLOUD_PUBLIC_URL/)
    assert.match(readme, /OPEN_COWORK_GATEWAY_PUBLIC_URL/)
    assert.match(readme, /provider webhook signing secrets/)
    assert.doesNotMatch(readme, /\b\d{12}\b/)
    assert.doesNotMatch(readme, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    if (provider !== 'kubernetes') {
      assert.match(readme, /cloud.checkpoints.enabled=true/)
      assert.match(readme, /helm upgrade --install open-cowork-cloud/)
      assert.match(readme, /helm upgrade --install open-cowork-gateway/)
      assert.match(readme, /gateway.existingSecret=open-cowork-gateway-secrets/)
      assert.match(readme, /billing disabled\/stubbed/)
    }
    for (const phrase of expected) {
      assert.match(readme, new RegExp(phrase))
    }
  }

  const gatewayAppliance = readRepoFile('deploy/gateway-appliance/README.md')
  assert.match(gatewayAppliance, /VPS\/Local Compose Recipe/)
  assert.match(gatewayAppliance, /provider-config only/)
  assert.match(gatewayAppliance, /docker-compose.gateway-remote.yml/)
  assert.match(gatewayAppliance, /docker-compose.cloud-gateway.yml/)
  assert.match(gatewayAppliance, /pnpm deploy:validate/)
  assert.match(gatewayAppliance, /pnpm deploy:gateway:smoke/)
  assert.match(gatewayAppliance, /OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER=true/)
})

test('deployment readiness checklist and managed BYOK runbook cover production gates', () => {
  const readiness = readRepoFile('docs/deployment-readiness.md')
  for (const phrase of [
    'Required Topology',
    'Auth',
    'cookie secret',
    'Postgres',
    'object store',
    'secret adapter/KMS',
    'public URL/HTTPS',
    'worker/scheduler scaling',
    'gateway service token',
    'provider webhook signing',
    'quotas/rate limits',
    'OTLP/logging',
    'backups/restore',
    'deploy/observability/',
    'docs/runbooks/backup-restore.md',
    'docs/runbooks/restore-drill-report.md',
    'no billing provider or the stub billing provider',
    'cloud.publicBranding',
    'cloudDesktop',
    'gateway.providers',
    'cloud.billing.provider=none',
    'Cloud Web Workbench',
    'browser E2E',
    'accessibility',
    'performance and scale',
    'GET /',
    'Content-Security-Policy',
    'api bootstrap',
    'pnpm deploy:validate',
    'pnpm deploy:smoke',
    'Provider Recipe Contract',
    'HPA or KEDA',
    'PodDisruptionBudgets',
    'topology spread constraints',
    'Helm image pinning',
    'billing-free path',
  ]) {
    assert.match(readiness, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  }

  const byok = readRepoFile('docs/runbooks/managed-byok-saas.md')
  for (const phrase of [
    'org signup mode',
    'token TTL',
    'invite/domain controls',
    'billing setup',
    'BYOK validation',
    'gateway operations',
    'incident response',
    'no billing provider',
    'Launch Gates',
  ]) {
    assert.match(byok, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  }

  const mkdocs = readRepoFile('mkdocs.yml')
  assert.match(mkdocs, /Deployment Readiness: deployment-readiness\.md/)
  assert.match(mkdocs, /Managed BYOK SaaS: runbooks\/managed-byok-saas\.md/)
  assert.match(mkdocs, /Backup and Restore: runbooks\/backup-restore\.md/)
  assert.match(mkdocs, /Restore Drill Report: runbooks\/restore-drill-report\.md/)
})

test('operations observability assets define metrics, dashboards, alerts, and restore drill gates', () => {
  const packageJson = readRepoFile('package.json')
  const validator = readRepoFile('scripts/validate-ops-readiness.mjs')
  const catalog = readRepoFile('deploy/observability/metrics-catalog.json')
  const alerts = readRepoFile('deploy/observability/prometheus-alerts.yaml')
  const dashboard = readRepoFile('deploy/observability/grafana-open-cowork-overview.json')
  const backup = readRepoFile('docs/runbooks/backup-restore.md')
  const drill = readRepoFile('docs/runbooks/restore-drill-report.md')

  assert.match(packageJson, /"ops:validate": "node scripts\/validate-ops-readiness\.mjs"/)
  assert.match(validator, /open_cowork_cloud_http_requests_total/)
  assert.match(validator, /open_cowork_gateway_delivery_dead_letters_total/)

  for (const metric of [
    'open_cowork_cloud_http_requests_total',
    'open_cowork_cloud_http_request_duration_ms',
    'open_cowork_cloud_command_queue_depth_estimate',
    'open_cowork_cloud_command_oldest_age_ms',
    'open_cowork_cloud_worker_lease_claims_total',
    'open_cowork_cloud_worker_lease_renewals_total',
    'open_cowork_cloud_worker_expired_leases_reaped_total',
    'open_cowork_cloud_worker_stale_owner_rejections_total',
    'open_cowork_cloud_scheduler_claims_total',
    'open_cowork_cloud_scheduler_expired_claims_reaped_total',
    'open_cowork_cloud_projection_lag_events',
    'open_cowork_cloud_sse_connections',
    'open_cowork_cloud_quota_rejections_total',
    'open_cowork_cloud_auth_failures_total',
    'open_cowork_cloud_byok_reveal_failures_total',
    'open_cowork_object_store_errors_total',
    'pg_up',
    'pg_stat_activity_count',
    'open_cowork_gateway_deliveries_received_total',
    'open_cowork_gateway_deliveries_sent_total',
    'open_cowork_gateway_delivery_retries_total',
    'open_cowork_gateway_delivery_dead_letters_total',
    'open_cowork_gateway_session_streams',
  ]) {
    assert.match(catalog, new RegExp(metric))
    assert.match(alerts + dashboard, new RegExp(metric))
  }

  for (const alert of [
    'OpenCoworkCloudHighHttpErrorRate',
    'OpenCoworkWorkerBacklogGrowing',
    'OpenCoworkWorkerLeaseRecoverySpike',
    'OpenCoworkSchedulerStalled',
    'OpenCoworkProjectionLag',
    'OpenCoworkAuthFailuresSpike',
    'OpenCoworkQuotaAbuse',
    'OpenCoworkByokRevealFailures',
    'OpenCoworkGatewayDeliveryBacklog',
  ]) {
    assert.match(alerts, new RegExp(alert))
  }

  for (const phrase of [
    'pg_dump',
    'pg_restore',
    'aws s3 sync',
    'gcloud storage rsync',
    'az storage blob sync',
    'Restore Drill Report Requirements',
  ]) {
    assert.match(backup, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }

  for (const phrase of [
    'Postgres restore',
    'Object-store restore',
    'Secret/KMS references',
    'Session projection parity',
    'Worker recovery',
    'Scheduler recovery',
    'Gateway recovery',
    'Redaction',
  ]) {
    assert.match(drill, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('deployment validation and smoke scripts cover compose, helm, cloud, and gateway checks', () => {
  const packageJson = readRepoFile('package.json')
  const scriptsReadme = readRepoFile('scripts/README.md')
  const validate = readRepoFile('scripts/validate-deployment-configs.mjs')
  const smoke = readRepoFile('scripts/smoke-deployment.mjs')

  assert.match(packageJson, /"deploy:validate": "node scripts\/validate-deployment-configs\.mjs"/)
  assert.match(packageJson, /"deploy:smoke": "node scripts\/smoke-deployment\.mjs"/)
  assert.match(packageJson, /"deploy:gateway:smoke": "pnpm build:gateway && node scripts\/gateway-cloud-smoke\.mjs"/)
  assert.match(packageJson, /"deploy:continuation:smoke": "pnpm build:gateway && pnpm build:shared && node --no-warnings --experimental-strip-types scripts\/cloud-continuation-smoke\.mjs"/)
  assert.match(packageJson, /"ops:validate": "node scripts\/validate-ops-readiness\.mjs"/)
  assert.match(scriptsReadme, /pnpm deploy:validate/)
  assert.match(scriptsReadme, /pnpm deploy:smoke/)
  assert.match(scriptsReadme, /pnpm deploy:gateway:smoke/)
  assert.match(scriptsReadme, /pnpm deploy:continuation:smoke/)
  assert.match(scriptsReadme, /pnpm ops:validate/)
  const ciWorkflow = readRepoFile('.github/workflows/ci.yml')
  assert.match(ciWorkflow, /pnpm ops:validate/)
  assert.match(validate, /docker-compose\.cloud\.yml/)
  assert.match(validate, /docker-compose\.cloud\.split\.yml/)
  assert.match(validate, /docker-compose\.cloud-gateway\.yml/)
  assert.match(validate, /helm\/open-cowork-cloud/)
  assert.match(validate, /helm\/open-cowork-gateway/)
  assert.match(validate, /deploy\/observability\/metrics-catalog\.json/)
  assert.match(validate, /docs\/runbooks\/backup-restore\.md/)
  assert.match(validate, /docs\/runbooks\/restore-drill-report\.md/)
  assert.match(validate, /unsafe-public-cloud/)
  assert.match(validate, /latest-cloud-image/)
  assert.match(validate, /unsafe-multi-worker-cloud/)
  assert.match(validate, /image\.tag=latest is not allowed/)
  assert.match(validate, /unsafe-webhook-gateway/)
  assert.match(validate, /latest-gateway-image/)
  assert.match(validate, /unsafe-metrics-gateway/)
  assert.match(smoke, /OPEN_COWORK_SMOKE_CLOUD_URL/)
  assert.match(smoke, /OPEN_COWORK_SMOKE_GATEWAY_URL/)
  assert.match(smoke, /\/healthz/)
  assert.match(smoke, /cloud web workbench/)
  assert.match(smoke, /open-cowork-cloud-bootstrap/)
  assert.match(smoke, /data-route-panel="threads"/)
  assert.match(smoke, /content-security-policy/)
  assert.match(smoke, /\/api\/config/)
  assert.match(smoke, /\/api\/workspace/)
  assert.match(smoke, /\/api\/runtime\/status/)
  assert.match(smoke, /\/api\/workers\/heartbeats/)
  assert.match(smoke, /\/api\/metrics/)
  assert.match(smoke, /checkText/)
  assert.match(smoke, /\/health/)
  assert.match(smoke, /\/ready/)
  const gatewaySmoke = readRepoFile('scripts/gateway-cloud-smoke.mjs')
  assert.match(gatewaySmoke, /OPEN_COWORK_GATEWAY_SMOKE_CLOUD_URL/)
  assert.match(gatewaySmoke, /OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN/)
  assert.match(gatewaySmoke, /createGatewayDaemon/)
  assert.match(gatewaySmoke, /revokeApiToken/)
  const continuationSmoke = readRepoFile('scripts/cloud-continuation-smoke.mjs')
  assert.match(continuationSmoke, /OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL/)
  assert.match(continuationSmoke, /OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN/)
  assert.match(continuationSmoke, /CloudWorkspaceAdapter/)
  assert.match(continuationSmoke, /createGatewayDaemon/)
  assert.match(continuationSmoke, /runConcurrentPromptCheck/)
})

test('managed operations runbook covers readiness, rollback, diagnostics, and gateway backlog', () => {
  const runbook = readRepoFile('docs/runbooks/cloud-managed-operations.md')

  for (const phrase of [
    'GET /healthz',
    'GET /api/workers/heartbeats',
    'GET /ready',
    'Rollback',
    'Worker Drains',
    'Web Unavailable Or Erroring',
    'Worker Backlog',
    'Scheduler Stalled',
    'Postgres Connection Exhaustion',
    'Object-Store Errors',
    'KMS Or Secret Adapter Errors',
    'OIDC Outage',
    'Gateway Backlog',
    'Gateway Provider Outage',
    'Webhook Abuse',
    'BYOK Provider Key Failure',
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
  assert.match(workflow, /OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER=true OPEN_COWORK_GATEWAY_ALLOW_PUBLIC_FAKE_PROVIDER=true OPEN_COWORK_GATEWAY_SMOKE_URL=http:\/\/127\.0\.0\.1:8790\/ready bash scripts\/ci-cloud-compose-smoke\.sh docker-compose\.cloud-gateway\.yml/)
  assert.match(workflow, /helm dependency build helm\/open-cowork-cloud/)
  assert.match(workflow, /helm lint helm\/open-cowork-cloud/)
  assert.match(workflow, /helm template open-cowork-cloud helm\/open-cowork-cloud/)
  assert.match(workflow, /gateway\.enabled=true/)
  assert.match(workflow, /gateway\.gateway\.adminToken=ci-gateway-admin-token/)
  assert.match(workflow, /OPEN_COWORK_GATEWAY_SERVICE_TOKEN/)
  assert.match(workflow, /gateway\.adminToken=ci-gateway-admin-token/)
  assert.match(workflow, /helm lint helm\/open-cowork-gateway/)
  assert.match(workflow, /helm template open-cowork-gateway helm\/open-cowork-gateway/)
  assert.match(workflow, /pnpm deploy:validate -- --require-tools/)
  assert.match(workflow, /pnpm test:cloud-web/)

  const smoke = readRepoFile('scripts/ci-cloud-compose-smoke.sh')
  assert.match(smoke, /docker compose -p "\$\{project_name\}" -f "\$\{compose_file\}" up --build -d/)
  assert.match(smoke, /http:\/\/127\.0\.0\.1:8787\/healthz/)
  assert.match(smoke, /OPEN_COWORK_GATEWAY_SMOKE_URL/)
  assert.match(smoke, /pnpm deploy:smoke/)
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
