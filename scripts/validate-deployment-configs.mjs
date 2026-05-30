#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const requireTools =
  process.argv.includes('--require-tools') || process.env.OPEN_COWORK_DEPLOY_REQUIRE_TOOLS === 'true'

const composeFiles = [
  'docker-compose.cloud.yml',
  'docker-compose.cloud.split.yml',
  'docker-compose.cloud-gateway.yml',
]

function log(message) {
  process.stdout.write(`[deploy-validate] ${message}\n`)
}

function commandExists(command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  return result.status === 0
}

function run(command, args, options = {}) {
  log(`${command} ${args.join(' ')}`)
  execFileSync(command, args, { stdio: 'inherit', ...options })
}

function expectFailure(command, args, expectedText, options = {}) {
  log(`expect failure: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status === 0) {
    throw new Error(`Expected command to fail: ${command} ${args.join(' ')}`)
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (!output.includes(expectedText)) {
    throw new Error(`Expected failure to include "${expectedText}". Output:\n${output}`)
  }
}

function read(path) {
  return readFileSync(path, 'utf8')
}

function assertIncludes(path, text) {
  const contents = read(path)
  if (!contents.includes(text)) {
    throw new Error(`${path} must include ${text}`)
  }
}

function staticComposeChecks() {
  for (const file of composeFiles) {
    assertIncludes(file, 'services:')
    assertIncludes(file, 'postgres:')
  }
  assertIncludes('docker-compose.cloud.yml', 'minio:')
  assertIncludes('docker-compose.cloud.split.yml', 'open-cowork-cloud-web:')
  assertIncludes('docker-compose.cloud.split.yml', 'open-cowork-cloud-worker:')
  assertIncludes('docker-compose.cloud.split.yml', 'open-cowork-cloud-scheduler:')
  assertIncludes('docker-compose.cloud-gateway.yml', 'open-cowork-gateway:')
  assertIncludes('docker-compose.cloud-gateway.yml', 'OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER')
}

function validateCompose() {
  staticComposeChecks()
  if (!commandExists('docker')) {
    if (requireTools) {
      throw new Error('docker is required for deployment validation')
    }
    log('docker not found; static Compose checks passed')
    return
  }

  const composeAvailable = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0
  if (!composeAvailable) {
    if (requireTools) {
      throw new Error('docker compose is required for deployment validation')
    }
    log('docker compose not found; static Compose checks passed')
    return
  }

  for (const file of composeFiles) {
    run('docker', ['compose', '-f', file, 'config', '--quiet'])
  }
}

function staticHelmChecks() {
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.auth.mode=none requires explicit cloud.allowInsecureAuth=true')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.auth.mode=none with public service or ingress requires explicit cloud.allowInsecurePublicAuth=true')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'gateway.serviceToken or gateway.existingSecret is required')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'gateway.webhook.sharedSecret or gateway.existingSecret is required')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'gateway.adminToken or gateway.existingSecret is required when gateway metrics are enabled on a public bind')
}

function validateHelm() {
  staticHelmChecks()
  if (!commandExists('helm', ['version', '--short'])) {
    if (requireTools) {
      throw new Error('helm is required for deployment validation')
    }
    log('helm not found; static Helm guard checks passed')
    return
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-deploy-helm-'))
  try {
    cpSync('helm', join(tempRoot, 'helm'), { recursive: true })
    const cloudChart = join(tempRoot, 'helm/open-cowork-cloud')
    const gatewayChart = join(tempRoot, 'helm/open-cowork-gateway')

    run('helm', ['dependency', 'build', cloudChart])
    run('helm', [
      'lint',
      cloudChart,
      '--set',
      'cloud.auth.mode=oidc',
      '--set',
      'cloud.auth.oidcIssuerUrl=https://issuer.example.com',
      '--set',
      'cloud.auth.oidcClientId=open-cowork-cloud-ci',
    ])
    run('helm', [
      'template',
      'open-cowork-cloud',
      cloudChart,
      '--set',
      'image.repository=example.com/open-cowork-cloud',
      '--set',
      'image.tag=ci',
      '--set',
      'cloud.auth.mode=oidc',
      '--set',
      'cloud.auth.oidcIssuerUrl=https://issuer.example.com',
      '--set',
      'cloud.auth.oidcClientId=open-cowork-cloud-ci',
      '--set',
      'cloud.controlPlaneUrl=postgres://postgres:postgres@postgres:5432/open_cowork_cloud',
      '--set',
      'cloud.secretKey=ci-secret-key',
      '--set',
      'cloud.cookieSecret=ci-cookie-secret',
      '--set',
      'cloud.objectStore.kind=s3',
      '--set',
      'cloud.objectStore.bucket=open-cowork-ci',
    ])
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-public-cloud',
        cloudChart,
        '--set',
        'cloud.auth.mode=none',
        '--set',
        'cloud.allowInsecureAuth=true',
        '--set',
        'ingress.enabled=true',
      ],
      'cloud.auth.mode=none with public service or ingress requires explicit cloud.allowInsecurePublicAuth=true'
    )

    run('helm', [
      'lint',
      gatewayChart,
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.serviceToken=ci-gateway-token',
      '--set',
      'gateway.telegram.botToken=ci-telegram-token',
    ])
    run('helm', [
      'template',
      'open-cowork-gateway',
      gatewayChart,
      '--set',
      'image.repository=example.com/open-cowork-gateway',
      '--set',
      'image.tag=ci',
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.serviceToken=ci-gateway-token',
      '--set',
      'gateway.telegram.botToken=ci-telegram-token',
    ])
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-webhook-gateway',
        gatewayChart,
        '--set',
        'gateway.cloudBaseUrl=https://cloud.example.com',
        '--set',
        'gateway.serviceToken=ci-gateway-token',
        '--set',
        'gateway.webhook.deliveryUrl=https://bridge.example.com/inbound',
      ],
      'gateway.webhook.sharedSecret or gateway.existingSecret is required'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-metrics-gateway',
        gatewayChart,
        '--set',
        'gateway.cloudBaseUrl=https://cloud.example.com',
        '--set',
        'gateway.serviceToken=ci-gateway-token',
        '--set',
        'gateway.telegram.botToken=ci-telegram-token',
        '--set',
        'gateway.metrics.enabled=true',
      ],
      'gateway.adminToken or gateway.existingSecret is required when gateway metrics are enabled on a public bind'
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function validateDocs() {
  const requiredDocs = [
    'docs/deployment-readiness.md',
    'docs/runbooks/managed-byok-saas.md',
    'deploy/README.md',
    'deploy/gcp/README.md',
    'deploy/aws/README.md',
    'deploy/azure/README.md',
    'deploy/digitalocean/README.md',
  ]
  for (const path of requiredDocs) {
    if (!existsSync(path)) {
      throw new Error(`${path} is required`)
    }
  }

  const readiness = read('docs/deployment-readiness.md').toLowerCase()
  for (const phrase of [
    'auth',
    'cookie secret',
    'postgres',
    'object store',
    'secret adapter/kms',
    'public url/https',
    'worker/scheduler scaling',
    'gateway service token',
    'provider webhook signing',
    'quotas/rate limits',
    'cloud web workbench',
    'browser e2e',
    'accessibility',
    'performance and scale',
    'api bootstrap',
    'content-security-policy',
    'otlp/logging',
    'backups/restore',
    'no billing provider or the stub billing provider',
  ]) {
    if (!readiness.includes(phrase)) {
      throw new Error(`docs/deployment-readiness.md must include ${phrase}`)
    }
  }

  const byok = read('docs/runbooks/managed-byok-saas.md').toLowerCase()
  for (const phrase of [
    'org signup mode',
    'token ttl',
    'invite/domain controls',
    'billing setup',
    'byok validation',
    'gateway operations',
    'incident response',
  ]) {
    if (!byok.includes(phrase)) {
      throw new Error(`docs/runbooks/managed-byok-saas.md must include ${phrase}`)
    }
  }
}

function validateGcpReference() {
  const requiredGcpFiles = [
    'deploy/gcp/README.md',
    'deploy/gcp/gke/values.gke.yaml.example',
    'deploy/gcp/gke/external-secret.example.yaml',
    'deploy/gcp/gke/managed-certificate.example.yaml',
    'deploy/gcp/cloud-run/all-in-one.service.yaml.example',
    'deploy/gcp/smoke/README.md',
    'scripts/gcp-reference-preflight.mjs',
    'scripts/gcp-reference-smoke.mjs',
    'scripts/desktop-cloud-sync-smoke.mjs',
    'scripts/gateway-cloud-smoke.mjs',
  ]
  for (const path of requiredGcpFiles) {
    if (!existsSync(path)) {
      throw new Error(`${path} is required for the GCP reference deployment`)
    }
  }

  const gcpReadme = read('deploy/gcp/README.md')
  for (const phrase of [
    'GKE split-role',
    'Cloud SQL for PostgreSQL',
    'Cloud Storage',
    'Secret Manager',
    'iamcredentials.googleapis.com',
    'OPEN_COWORK_GCP_REGION',
    'pnpm deploy:gcp:preflight',
    'pnpm deploy:gcp:smoke',
    'pnpm deploy:desktop:smoke',
    'pnpm deploy:gateway:smoke',
    'kubectl apply -f deploy/gcp/gke/external-secret.example.yaml',
    'kubectl apply -f deploy/gcp/gke/managed-certificate.example.yaml',
    'OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS=true',
    'Rollback order',
    'GCP configuration is adapter wiring only',
  ]) {
    if (!gcpReadme.includes(phrase)) {
      throw new Error(`deploy/gcp/README.md must include ${phrase}`)
    }
  }

  const gkeValues = read('deploy/gcp/gke/values.gke.yaml.example')
  for (const phrase of [
    'REGION-docker.pkg.dev/PROJECT/open-cowork/open-cowork-cloud',
    'existingSecret: open-cowork-cloud-secrets',
    'mode: oidc',
    'publicUrl: https://cowork.example.com',
    'trustProxyHeaders: true',
    'kind: gcs',
    'enabled: true',
    'replicas: 2',
    'checkpointsEnabled: true',
    'serviceAccount:',
    'iam.gke.io/gcp-service-account',
    'cloud.google.com/neg',
    'kubernetes.io/ingress.class: gce',
    'kubernetes.io/ingress.allow-http: "false"',
  ]) {
    if (!gkeValues.includes(phrase)) {
      throw new Error(`deploy/gcp/gke/values.gke.yaml.example must include ${phrase}`)
    }
  }

  const externalSecret = read('deploy/gcp/gke/external-secret.example.yaml')
  for (const phrase of [
    'ClusterSecretStore',
    'gcpsm',
    'workloadIdentity',
    'OPEN_COWORK_CLOUD_CONTROL_PLANE_URL',
    'OPEN_COWORK_CLOUD_SECRET_KEY_REF',
    'OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET',
  ]) {
    if (!externalSecret.includes(phrase)) {
      throw new Error(`deploy/gcp/gke/external-secret.example.yaml must include ${phrase}`)
    }
  }

  const cloudRun = read('deploy/gcp/cloud-run/all-in-one.service.yaml.example')
  for (const phrase of [
    'run.googleapis.com/cloudsql-instances',
    'run.googleapis.com/secrets',
    'open-cowork-cloud-control-plane-url:projects/PROJECT_NUMBER/secrets/open-cowork-cloud-control-plane-url,',
    'OPEN_COWORK_CLOUD_ROLE',
    'all-in-one',
    'OPEN_COWORK_CLOUD_AUTH_MODE',
    'oidc',
    'OPEN_COWORK_CLOUD_OBJECT_STORE_KIND',
    'gcs',
    'OPEN_COWORK_CLOUD_SECRET_KEY_REF',
  ]) {
    if (!cloudRun.includes(phrase)) {
      throw new Error(`deploy/gcp/cloud-run/all-in-one.service.yaml.example must include ${phrase}`)
    }
  }

  const desktopSmoke = read('scripts/desktop-cloud-sync-smoke.mjs')
  for (const phrase of [
    'OPEN_COWORK_DESKTOP_SMOKE_CLOUD_URL',
    'OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN',
    'CloudWorkspaceAdapter',
    'subscribeWorkspaceEvents',
    'subscribeSessionEvents',
    'offlineMutationsBlocked',
    'revokeApiToken',
    'LOCAL_WORKSPACE_ID',
  ]) {
    if (!desktopSmoke.includes(phrase)) {
      throw new Error(`scripts/desktop-cloud-sync-smoke.mjs must include ${phrase}`)
    }
  }

  const gatewaySmoke = read('scripts/gateway-cloud-smoke.mjs')
  for (const phrase of [
    'OPEN_COWORK_GATEWAY_SMOKE_CLOUD_URL',
    'OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN',
    'OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL',
    'createGatewayDaemon',
    'createHeadlessAgent',
    'createChannelBinding',
    'resolveChannelIdentity',
    'OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_ADMIN_TOKEN',
    'revokeApiToken',
    'Gateway fake webhook',
    'dead-letter',
    'leastPrivilegeChecks',
  ]) {
    if (!gatewaySmoke.includes(phrase)) {
      throw new Error(`scripts/gateway-cloud-smoke.mjs must include ${phrase}`)
    }
  }
}

validateCompose()
validateHelm()
validateDocs()
validateGcpReference()
log('deployment configuration validation passed')
