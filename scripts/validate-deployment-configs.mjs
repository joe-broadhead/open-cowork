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
const gatewayOnlyComposeFiles = [
  'docker-compose.gateway-remote.yml',
]
const testImageDigest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
const publicHelmImagePrerequisites = [
  '--set',
  `image.digest=${testImageDigest}`,
]
const typedEgressAllowlist = [
  '--set-json',
  'networkPolicy.egress.allow=[{"name":"approved-api","to":[{"ipBlock":{"cidr":"203.0.113.0/24"}}],"ports":[{"protocol":"TCP","port":443}]}]',
]
const typedIngressAllowlist = [
  '--set-json',
  'networkPolicy.ingress.from=[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"ingress-nginx"}},"podSelector":{"matchLabels":{"app.kubernetes.io/name":"ingress-nginx"}}}]',
]
const publicHelmPrerequisites = [
  ...publicHelmImagePrerequisites,
  ...typedIngressAllowlist,
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

function runCapture(command, args, options = {}) {
  log(`${command} ${args.join(' ')}`)
  return execFileSync(command, args, { encoding: 'utf8', ...options })
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

function parseJson(path) {
  return JSON.parse(read(path))
}

function assertIncludes(path, text) {
  const contents = read(path)
  if (!contents.includes(text)) {
    throw new Error(`${path} must include ${text}`)
  }
}

function assertNotIncludes(path, text) {
  const contents = read(path)
  if (contents.includes(text)) {
    throw new Error(`${path} must not include ${text}`)
  }
}

function extractRenderedChecksums(manifest, name) {
  const pattern = new RegExp(`${name}: ([a-f0-9]{64})`, 'g')
  return Array.from(manifest.matchAll(pattern), (match) => match[1])
}

function assertConfigChecksumRollsPods(label, renderBase, renderChanged) {
  const baseConfig = extractRenderedChecksums(renderBase, 'checksum/config')
  const changedConfig = extractRenderedChecksums(renderChanged, 'checksum/config')
  const baseSecret = extractRenderedChecksums(renderBase, 'checksum/secret')
  if (baseConfig.length === 0) {
    throw new Error(`${label} deployment must include checksum/config pod-template annotations.`)
  }
  if (baseSecret.length === 0) {
    throw new Error(`${label} deployment must include checksum/secret pod-template annotations.`)
  }
  if (baseConfig.length !== changedConfig.length) {
    throw new Error(`${label} rendered deployment count changed during checksum comparison.`)
  }
  if (baseConfig.every((checksum, index) => checksum === changedConfig[index])) {
    throw new Error(`${label} checksum/config must change when ConfigMap-backed values change.`)
  }
}

function assertRenderedIncludes(label, manifest, text) {
  if (!manifest.includes(text)) {
    throw new Error(`${label} rendered manifest must include ${text}`)
  }
}

function assertDefaultCloudHelmBrandingUsesRuntimeTheme(renderedManifest) {
  const match = renderedManifest.match(/OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON:\s*(.+)/)
  if (!match) {
    throw new Error('open-cowork-cloud rendered ConfigMap must include OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON.')
  }
  const renderedValue = match[1]
  if (!renderedValue.includes('Open Cowork Cloud')) {
    throw new Error('open-cowork-cloud default public branding must preserve the product name.')
  }
  for (const forbidden of ['\\"theme\\"', '"theme"', '#f5f6f3', '#2d6b56']) {
    if (renderedValue.includes(forbidden)) {
      throw new Error('open-cowork-cloud default public branding must not override the shared Cloud Web theme.')
    }
  }
}

function assertPublicTemplateSafe(path) {
  const contents = read(path)
  const forbiddenPatterns = [
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bghp_[A-Za-z0-9_]{20,}\b/,
    /\bsk-[A-Za-z0-9]{20,}\b/,
    /\bAIza[0-9A-Za-z_-]{20,}\b/,
    /\b(?:price|prod|acct)_[0-9A-Za-z]{8,}\b/,
    /\b\d{12}\b/,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    /gcp-sm:\/\/projects\/(?!PROJECT(?:\/|$))[a-z][a-z0-9-]{4,}[a-z0-9]\//i,
    /[?&](?:X-Amz-Signature|X-Amz-Credential|X-Goog-Signature|X-Goog-Credential|AWSAccessKeyId|sig|signature)=/i,
    /customer\s+(?:name|email|domain)\s*:/i,
    /private\s+domain\s*:/i,
    /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
  ]
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(contents)) {
      throw new Error(`${path} appears to contain private deployment or secret material matching ${pattern}`)
    }
  }
}

function staticComposeChecks() {
  for (const file of composeFiles) {
    assertIncludes(file, 'services:')
    assertIncludes(file, 'postgres:')
    assertIncludes(file, 'Local/demo')
  }
  for (const file of gatewayOnlyComposeFiles) {
    assertIncludes(file, 'services:')
    assertIncludes(file, 'Local/demo')
    assertIncludes(file, 'open-cowork-gateway:')
    assertIncludes(file, 'OPEN_COWORK_GATEWAY_HOST')
    assertIncludes(file, 'OPEN_COWORK_GATEWAY_TELEGRAM_PUBLIC_URL')
    assertIncludes(file, 'OPEN_COWORK_GATEWAY_ADMIN_TOKEN')
    assertIncludes(file, 'OPEN_COWORK_GATEWAY_ADMIN_TOKEN:?')
    assertIncludes(file, 'OPEN_COWORK_GATEWAY_MAX_REQUEST_BODY_BYTES')
    assertIncludes(file, 'OPEN_COWORK_GATEWAY_CLOUD_REQUEST_TIMEOUT_MS')
    assertIncludes(file, 'OPEN_COWORK_GATEWAY_WEBHOOK_DELIVERY_TIMEOUT_MS')
    assertIncludes(file, 'OPEN_COWORK_GATEWAY_SMTP_TIMEOUT_MS')
    assertIncludes(file, 'OPEN_COWORK_GATEWAY_SHUTDOWN_DRAIN_TIMEOUT_MS')
    assertIncludes(file, 'OPEN_COWORK_GATEWAY_EMAIL_MAX_ATTACHMENT_BYTES')
    assertIncludes(file, 'OPEN_COWORK_GATEWAY_WEBHOOK_MAX_ATTACHMENT_BYTES')
  }
  assertIncludes('docker-compose.cloud.yml', 'minio:')
  assertIncludes('docker-compose.cloud.yml', 'OPEN_COWORK_CLOUD_IMAGE')
  assertIncludes('docker-compose.cloud.split.yml', 'open-cowork-cloud-web:')
  assertIncludes('docker-compose.cloud.split.yml', 'open-cowork-cloud-worker:')
  assertIncludes('docker-compose.cloud.split.yml', 'open-cowork-cloud-scheduler:')
  assertIncludes('docker-compose.cloud.split.yml', 'OPEN_COWORK_CLOUD_IMAGE')
  assertIncludes('docker-compose.cloud-gateway.yml', 'open-cowork-gateway:')
  assertIncludes('docker-compose.cloud-gateway.yml', 'OPEN_COWORK_CLOUD_IMAGE')
  assertIncludes('docker-compose.cloud-gateway.yml', 'OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS')
  assertIncludes('docker-compose.cloud-gateway.yml', 'OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS')
  assertIncludes('docker-compose.cloud-gateway.yml', 'OPEN_COWORK_GATEWAY_IMAGE')
  assertIncludes('docker-compose.cloud-gateway.yml', 'OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER')
  assertIncludes('docker-compose.cloud-gateway.yml', 'OPEN_COWORK_GATEWAY_TELEGRAM_PUBLIC_URL')
  assertIncludes('docker-compose.cloud-gateway.yml', 'OPEN_COWORK_GATEWAY_ADMIN_TOKEN')
  assertIncludes('docker-compose.cloud-gateway.yml', 'OPEN_COWORK_GATEWAY_ADMIN_TOKEN:?')
  assertIncludes('docker-compose.cloud-gateway.yml', 'OPEN_COWORK_GATEWAY_MAX_REQUEST_BODY_BYTES')
  assertIncludes('docker-compose.cloud-gateway.yml', 'OPEN_COWORK_GATEWAY_CLOUD_REQUEST_TIMEOUT_MS')
  assertIncludes('docker-compose.cloud-gateway.yml', 'OPEN_COWORK_GATEWAY_WEBHOOK_DELIVERY_TIMEOUT_MS')
  assertIncludes('docker-compose.cloud-gateway.yml', 'OPEN_COWORK_GATEWAY_SMTP_TIMEOUT_MS')
  assertIncludes('docker-compose.cloud-gateway.yml', 'OPEN_COWORK_GATEWAY_SHUTDOWN_DRAIN_TIMEOUT_MS')
  assertIncludes('docker-compose.cloud-gateway.yml', 'OPEN_COWORK_GATEWAY_EMAIL_MAX_ATTACHMENT_BYTES')
  assertIncludes('docker-compose.cloud-gateway.yml', 'OPEN_COWORK_GATEWAY_WEBHOOK_MAX_ATTACHMENT_BYTES')
  assertIncludes('docker-compose.cloud-gateway.yml', '${OPEN_COWORK_GATEWAY_PUBLISHED_ADDR:-127.0.0.1}:8790:8790')
  for (const file of composeFiles) {
    assertIncludes(file, 'OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS')
    assertIncludes(file, 'OPEN_COWORK_CLOUD_DEPLOYMENT_TIER')
    assertIncludes(file, 'OPEN_COWORK_CLOUD_SIGNUP_MODE')
    assertIncludes(file, 'OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET')
    assertIncludes(file, 'OPEN_COWORK_CLOUD_HEADER_AUTH_MAX_SIGNATURE_AGE_MS')
    assertIncludes(file, 'OPEN_COWORK_CLOUD_API_TOKEN_ALLOWED_SCOPES')
    assertIncludes(file, 'OPEN_COWORK_CLOUD_PUBLISHED_ADDR: ${OPEN_COWORK_CLOUD_PUBLISHED_ADDR:-127.0.0.1}')
    assertIncludes(file, '${OPEN_COWORK_CLOUD_PUBLISHED_ADDR:-127.0.0.1}:8787:8787')
    assertIncludes(file, '${OPEN_COWORK_MINIO_PUBLISHED_ADDR:-127.0.0.1}:9000:9000')
    assertIncludes(file, '${OPEN_COWORK_MINIO_CONSOLE_PUBLISHED_ADDR:-127.0.0.1}:9001:9001')
    assertNotIncludes(file, '- "8787:8787"')
    assertNotIncludes(file, '- "9000:9000"')
    assertNotIncludes(file, '- "9001:9001"')
  }
  for (const file of [...composeFiles, ...gatewayOnlyComposeFiles]) {
    assertIncludes(file, 'OPEN_COWORK_CONFIG_PATH')
    assertIncludes(file, 'OPEN_COWORK_CONFIG_DIR')
    assertIncludes(file, 'OPEN_COWORK_DOWNSTREAM_ROOT')
    assertIncludes(file, '${OPEN_COWORK_CONFIG_PATH:-./open-cowork.config.json}:${OPEN_COWORK_CONFIG_PATH:-/etc/open-cowork/open-cowork.config.json}:ro')
    assertIncludes(file, '${OPEN_COWORK_CONFIG_DIR:-.}:${OPEN_COWORK_CONFIG_DIR:-/etc/open-cowork/config}:ro')
    assertIncludes(file, '${OPEN_COWORK_DOWNSTREAM_ROOT:-.}:${OPEN_COWORK_DOWNSTREAM_ROOT:-/etc/open-cowork/downstream}:ro')
  }
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

  const composeEnv = {
    ...process.env,
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: process.env.OPEN_COWORK_GATEWAY_ADMIN_TOKEN || 'validate-gateway-admin-token',
  }
  for (const file of [...composeFiles, ...gatewayOnlyComposeFiles]) {
    run('docker', ['compose', '-f', file, 'config', '--quiet'], { env: composeEnv })
  }
}

function staticHelmChecks() {
  assertNotIncludes('helm/open-cowork-cloud/values.yaml', 'tag: latest')
  assertNotIncludes('helm/open-cowork-gateway/values.yaml', 'tag: latest')
  assertNotIncludes('helm/open-cowork-cloud/values.yaml', 'background: "#f5f6f3"')
  assertNotIncludes('helm/open-cowork-cloud/values.yaml', 'accent: "#2d6b56"')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'digest: ""')
  assertIncludes('helm/open-cowork-gateway/values.yaml', 'digest: ""')
  assertIncludes('deploy/README.md', 'immutable OCI digest')
  assertIncludes('deploy/README.md', 'Public-production Cloud and public Gateway renders require')
  assertIncludes('docs/deployment-readiness.md', 'overlays must pin OCI images by immutable digest')
  assertIncludes('docs/deployment-readiness.md', 'image repository plus immutable digest')
  assertIncludes('deploy/managed-workers/README.md', 'Pinned OCI digest for production')
  for (const file of [
    'deploy/aws/README.md',
    'deploy/azure/README.md',
    'deploy/digitalocean/README.md',
  ]) {
    assertIncludes(file, '--set image.digest=sha256:REPLACE_WITH_CLOUD_DIGEST')
    assertIncludes(file, '--set image.digest=sha256:REPLACE_WITH_GATEWAY_DIGEST')
  }
  assertIncludes('deploy/gcp/gke/values.gke.yaml.example', 'digest: sha256:REPLACE_WITH_CLOUD_DIGEST')
  assertIncludes('deploy/gcp/gke/values.gke.yaml.example', 'digest: sha256:REPLACE_WITH_CLOUD_SQL_PROXY_DIGEST')
  assertIncludes('docs/open-cowork-cloud.md', '--set image.digest=sha256:REPLACE_WITH_CLOUD_DIGEST')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.auth.mode=none requires explicit cloud.allowInsecureAuth=true')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.auth.mode=none with public service or ingress requires explicit cloud.allowInsecurePublicAuth=true')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'image.tag=latest is not allowed')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'image.digest must be a sha256:<64 lowercase hex> OCI digest')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloudSqlProxy.image.tag=latest is not allowed')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloudSqlProxy.image.digest must be a sha256:<64 lowercase hex> OCI digest')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloudSqlProxy.enabled=true requires cloudSqlProxy.instanceConnectionName')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloudSqlProxy.address must be 127.0.0.1')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloudSqlProxy.healthCheck.port must be distinct from cloudSqlProxy.port')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', '--max-sigterm-delay=')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', '--health-check')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', '/cloud-sql-proxy')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', '- wait')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'restartPolicy: Always')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'name: cloud-sql-proxy')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', '--run-connection-test')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'cloudSqlProxy:')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'gcr.io/cloud-sql-connectors/cloud-sql-proxy')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'tag: "2.23.0"')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'maxSigtermDelay: ""')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.deploymentTier=public_production rejects cloud.allowInsecureAuth=true')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.deploymentTier=public_production rejects cloud.allowInsecurePublicAuth=true')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.deploymentTier=public_production requires cloud.cookieSecure=true')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.deploymentTier=public_production requires roles.web.enabled=true')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.deploymentTier=public_production requires image.digest')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.deploymentTier=public_production with cloudSqlProxy.enabled=true requires cloudSqlProxy.image.digest')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.deploymentTier=public_production requires networkPolicy.enabled=true')
  assertIncludes('helm/open-cowork-cloud/templates/networkpolicy.yaml', '$egressEnabled := or $egress.enabled $publicProduction')
  assertIncludes('helm/open-cowork-cloud/templates/networkpolicy.yaml', 'cloud.deploymentTier=public_production requires networkPolicy.ingress.from[]')
  assertIncludes('helm/open-cowork-cloud/templates/networkpolicy.yaml', 'networkPolicy.ingress.from[%d] must select explicit sources')
  assertIncludes('helm/open-cowork-cloud/templates/networkpolicy.yaml', 'empty namespaceSelector allows all namespaces')
  assertIncludes('helm/open-cowork-cloud/templates/networkpolicy.yaml', 'allowAllSourcesForLocalOnly=false')
  assertIncludes('helm/open-cowork-cloud/templates/networkpolicy.yaml', 'networkPolicy.egress.allow[%d].to is required')
  assertIncludes('helm/open-cowork-cloud/templates/networkpolicy.yaml', 'networkPolicy.egress.allow[%d].ports is required')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'allowAllSourcesForLocalOnly: true')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'allow: []')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.deploymentTier=public_production requires roles.worker.enabled=true')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.deploymentTier=public_production requires roles.scheduler.enabled=true')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'web role requires cloud.publicUrl')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'web role must set roles.web.autoProcessCommands=false')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.deploymentTier=public_production requires provider-backed object storage')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.deploymentTier=public_production requires cloud.auth.signupMode')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.deploymentTier=public_production header auth requires cloud.auth.headerSecretRef')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.deploymentTier=public_production rejects inline secret-bearing Helm values')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.deploymentTier=public_production requires durable Postgres control plane credentials via cloud.existingSecret')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.deploymentTier=public_production requires cloud.secretKeyRef or cloud.existingSecret')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.deploymentTier=public_production web role requires cloud.cookieSecretRef or cloud.existingSecret')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'path: /livez')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'path: /readyz')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'roles.worker.replicas > 1 requires cloud.checkpoints.enabled=true')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'cloud.objectStore.kind=filesystem is local/demo-only')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'roles.worker.replicas > 1 requires cloud.objectStore.bucket')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'topologySpreadConstraints')
  assertIncludes('helm/open-cowork-cloud/templates/pdb.yaml', 'PodDisruptionBudget')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'readOnlyRootFilesystem: true')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'seccompProfile:')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'type: RuntimeDefault')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'networkPolicy:')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'automountServiceAccountToken: false')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'automountServiceAccountToken: {{ $.Values.serviceAccount.automountServiceAccountToken }}')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'checksum/config')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'checksum/secret')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'mountPath: /tmp')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'mountPath: {{ $.Values.cloud.root }}')
  assertIncludes('helm/open-cowork-cloud/templates/networkpolicy.yaml', 'kind: NetworkPolicy')
  assertIncludes('helm/open-cowork-cloud/templates/networkpolicy.yaml', 'default-deny')
  assertIncludes('helm/open-cowork-cloud/templates/networkpolicy.yaml', 'web-ingress')
  assertIncludes('helm/open-cowork-cloud/templates/NOTES.txt', 'cloud.deploymentTier is "local"')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'gateway.serviceToken or gateway.existingSecret is required')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'public Gateway deployments reject inline secret-bearing Helm values')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'gateway.webhook.sharedSecret or gateway.existingSecret is required')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'gateway.telegram.publicUrl or gateway.publicUrl is required when Telegram webhook mode is enabled')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'gateway.adminToken or gateway.existingSecret is required for gateway operator endpoints')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'gateway.publicUrl must use HTTPS')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'gateway.allowLoopbackOperatorBypass=true is not allowed with ingress')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'gateway.adminToken is a placeholder')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'gateway.serviceToken is a placeholder')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'gateway replicaCount > 1 is unsafe while stream/replay state is process-local')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'gateway.allowLoopbackOperatorBypass=true requires gateway.host=127.0.0.1 or localhost')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'OPEN_COWORK_GATEWAY_INSTANCE_ID')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'image.tag=latest is not allowed')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'image.digest must be a sha256:<64 lowercase hex> OCI digest')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'public Gateway deployments require image.digest')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'public Gateway deployments require networkPolicy.enabled=true')
  assertIncludes('helm/open-cowork-gateway/templates/networkpolicy.yaml', '$egressEnabled := or $egress.enabled $publicGateway')
  assertIncludes('helm/open-cowork-gateway/templates/networkpolicy.yaml', 'public Gateway deployments require networkPolicy.ingress.from[]')
  assertIncludes('helm/open-cowork-gateway/templates/networkpolicy.yaml', 'networkPolicy.ingress.from[%d] must select explicit sources')
  assertIncludes('helm/open-cowork-gateway/templates/networkpolicy.yaml', 'empty namespaceSelector allows all namespaces')
  assertIncludes('helm/open-cowork-gateway/templates/networkpolicy.yaml', 'allowAllSourcesForLocalOnly=false')
  assertIncludes('helm/open-cowork-gateway/templates/networkpolicy.yaml', 'networkPolicy.egress.allow[%d].to is required')
  assertIncludes('helm/open-cowork-gateway/templates/networkpolicy.yaml', 'networkPolicy.egress.allow[%d].ports is required')
  assertIncludes('helm/open-cowork-gateway/values.yaml', 'allowAllSourcesForLocalOnly: true')
  assertIncludes('helm/open-cowork-gateway/values.yaml', 'allow: []')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'topologySpreadConstraints')
  assertIncludes('helm/open-cowork-gateway/templates/pdb.yaml', 'PodDisruptionBudget')
  assertIncludes('helm/open-cowork-gateway/values.yaml', 'readOnlyRootFilesystem: true')
  assertIncludes('helm/open-cowork-gateway/values.yaml', 'seccompProfile:')
  assertIncludes('helm/open-cowork-gateway/values.yaml', 'type: RuntimeDefault')
  assertIncludes('helm/open-cowork-gateway/values.yaml', 'networkPolicy:')
  assertIncludes('helm/open-cowork-gateway/values.yaml', 'serviceAccount:')
  assertIncludes('helm/open-cowork-gateway/values.yaml', 'automountServiceAccountToken: false')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'serviceAccountName: {{ include "open-cowork-gateway.serviceAccountName" . }}')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'automountServiceAccountToken: {{ .Values.serviceAccount.automountServiceAccountToken }}')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'checksum/config')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'checksum/secret')
  assertIncludes('helm/open-cowork-gateway/templates/serviceaccount.yaml', 'kind: ServiceAccount')
  assertIncludes('helm/open-cowork-gateway/templates/serviceaccount.yaml', 'automountServiceAccountToken: {{ .Values.serviceAccount.automountServiceAccountToken }}')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', 'mountPath: /tmp')
  assertIncludes('helm/open-cowork-gateway/templates/networkpolicy.yaml', 'kind: NetworkPolicy')
  assertIncludes('helm/open-cowork-gateway/templates/networkpolicy.yaml', 'default-deny')
  assertIncludes('helm/open-cowork-gateway/templates/deployment.yaml', '$sharedConfig')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'configPath: ""')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'deploymentTier: local')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'shutdownGraceMs: 300000')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'terminationGracePeriodSeconds: 300')
  assertIncludes('helm/open-cowork-cloud/values.yaml', 'maxUnavailable: 0')
  assertIncludes('helm/open-cowork-cloud/templates/configmap.yaml', 'OPEN_COWORK_CONFIG_PATH')
  assertIncludes('helm/open-cowork-cloud/templates/configmap.yaml', 'OPEN_COWORK_CONFIG_DIR')
  assertIncludes('helm/open-cowork-cloud/templates/configmap.yaml', 'OPEN_COWORK_DOWNSTREAM_ROOT')
  assertIncludes('helm/open-cowork-cloud/templates/configmap.yaml', 'OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS')
  assertIncludes('helm/open-cowork-cloud/templates/configmap.yaml', 'OPEN_COWORK_CLOUD_DEPLOYMENT_TIER')
  assertIncludes('helm/open-cowork-cloud/templates/configmap.yaml', 'OPEN_COWORK_CLOUD_SIGNUP_MODE')
  assertIncludes('helm/open-cowork-cloud/templates/configmap.yaml', 'OPEN_COWORK_CLOUD_HEADER_AUTH_ALLOW_UNSIGNED')
  assertIncludes('helm/open-cowork-cloud/templates/configmap.yaml', 'OPEN_COWORK_CLOUD_API_TOKEN_ALLOWED_SCOPES')
  assertIncludes('helm/open-cowork-cloud/templates/configmap.yaml', 'OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS')
  assertIncludes('helm/open-cowork-cloud/templates/secret.yaml', 'OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET')
  assertIncludes('helm/open-cowork-cloud/templates/secret.yaml', 'OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET_REF')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'terminationGracePeriodSeconds')
  assertIncludes('helm/open-cowork-cloud/templates/deployment.yaml', 'roles.worker.terminationGracePeriodSeconds must be >= 30')
  assertIncludes('helm/open-cowork-gateway/values.yaml', 'configPath: ""')
  assertIncludes('helm/open-cowork-gateway/values.yaml', 'publicUrl: ""')
  assertIncludes('helm/open-cowork-gateway/values.yaml', 'allowLoopbackOperatorBypass: false')
  assertIncludes('helm/open-cowork-gateway/values.yaml', 'maxRequestBodyBytes: 1048576')
  assertIncludes('helm/open-cowork-gateway/values.yaml', 'trustProxyHeaders: false')
  assertIncludes('helm/open-cowork-gateway/values.yaml', 'trustedProxyCidrs: []')
  assertIncludes('helm/open-cowork-gateway/values.yaml', 'experimentalDistributedOwnership: false')
  assertIncludes('helm/open-cowork-gateway/templates/configmap.yaml', 'OPEN_COWORK_CONFIG_PATH')
  assertIncludes('helm/open-cowork-gateway/templates/configmap.yaml', 'OPEN_COWORK_CONFIG_DIR')
  assertIncludes('helm/open-cowork-gateway/templates/configmap.yaml', 'OPEN_COWORK_DOWNSTREAM_ROOT')
  assertIncludes('helm/open-cowork-gateway/templates/configmap.yaml', 'OPEN_COWORK_GATEWAY_TELEGRAM_PUBLIC_URL')
  assertIncludes('helm/open-cowork-gateway/templates/configmap.yaml', 'OPEN_COWORK_GATEWAY_ALLOW_LOOPBACK_OPERATOR_BYPASS')
  assertIncludes('helm/open-cowork-gateway/templates/configmap.yaml', 'OPEN_COWORK_GATEWAY_MAX_REQUEST_BODY_BYTES')
  assertIncludes('helm/open-cowork-gateway/templates/configmap.yaml', 'OPEN_COWORK_GATEWAY_TRUST_PROXY_HEADERS')
  assertIncludes('helm/open-cowork-gateway/templates/configmap.yaml', 'OPEN_COWORK_GATEWAY_TRUSTED_PROXY_CIDRS')
  assertIncludes('helm/open-cowork-gateway/templates/configmap.yaml', 'OPEN_COWORK_GATEWAY_CLOUD_REQUEST_TIMEOUT_MS')
  assertIncludes('helm/open-cowork-gateway/templates/configmap.yaml', 'OPEN_COWORK_GATEWAY_WEBHOOK_DELIVERY_TIMEOUT_MS')
  assertIncludes('helm/open-cowork-gateway/templates/configmap.yaml', 'OPEN_COWORK_GATEWAY_SMTP_TIMEOUT_MS')
  assertIncludes('helm/open-cowork-gateway/templates/configmap.yaml', 'OPEN_COWORK_GATEWAY_SHUTDOWN_DRAIN_TIMEOUT_MS')
  assertIncludes('helm/open-cowork-gateway/templates/configmap.yaml', 'OPEN_COWORK_GATEWAY_EMAIL_MAX_ATTACHMENT_BYTES')
  assertIncludes('helm/open-cowork-gateway/templates/configmap.yaml', 'OPEN_COWORK_GATEWAY_WEBHOOK_MAX_ATTACHMENT_BYTES')
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
      'image.tag=ci',
      '--set',
      'cloud.auth.oidcIssuerUrl=https://issuer.example.com',
      '--set',
      'cloud.auth.oidcClientId=open-cowork-cloud-ci',
    ])
    const defaultCloudRender = runCapture('helm', [
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
    assertDefaultCloudHelmBrandingUsesRuntimeTheme(defaultCloudRender)
    assertConfigChecksumRollsPods(
      'open-cowork-cloud',
      runCapture('helm', [
        'template',
        'open-cowork-cloud-checksum',
        cloudChart,
        '--set',
        'image.repository=example.com/open-cowork-cloud',
        '--set',
        'image.tag=ci',
        '--set',
        'cloud.profile=checksum-a',
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
      ]),
      runCapture('helm', [
        'template',
        'open-cowork-cloud-checksum',
        cloudChart,
        '--set',
        'image.repository=example.com/open-cowork-cloud',
        '--set',
        'image.tag=ci',
        '--set',
        'cloud.profile=checksum-b',
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
      ]),
    )
    run('helm', [
      'template',
      'open-cowork-cloud-gcp-proxy',
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
      'cloud.controlPlaneUrl=postgres://postgres:postgres@127.0.0.1:5432/open_cowork_cloud',
      '--set',
      'cloud.secretKey=ci-secret-key',
      '--set',
      'cloud.cookieSecret=ci-cookie-secret',
      '--set',
      'cloud.objectStore.kind=s3',
      '--set',
      'cloud.objectStore.bucket=open-cowork-ci',
      '--set',
      'cloudSqlProxy.enabled=true',
      '--set',
      'cloudSqlProxy.instanceConnectionName=PROJECT:REGION:INSTANCE',
      '--set',
      'cloudSqlProxy.runConnectionTest=true',
    ])
    expectFailure(
      'helm',
      [
        'template',
        'public-cloud-empty-ingress-allowlist',
        cloudChart,
        ...publicHelmImagePrerequisites,
        '--set',
        'cloud.deploymentTier=public_production',
        '--set',
        'cloud.auth.mode=header',
        '--set',
        'cloud.auth.signupMode=invite',
        '--set',
        'cloud.publicUrl=https://cloud.example.com',
        '--set',
        'roles.worker.enabled=true',
        '--set',
        'roles.scheduler.enabled=true',
        '--set',
        'cloud.existingSecret=open-cowork-cloud-secrets',
        '--set',
        'cloud.objectStore.kind=s3',
        '--set',
        'cloud.objectStore.bucket=open-cowork-ci',
        '--set',
        'cloud.checkpoints.enabled=true',
      ],
      'cloud.deploymentTier=public_production requires networkPolicy.ingress.from[]'
    )
    expectFailure(
      'helm',
      [
        'template',
        'strict-local-cloud-empty-ingress-allowlist',
        cloudChart,
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
        'networkPolicy.ingress.allowAllSourcesForLocalOnly=false',
      ],
      'networkPolicy.ingress.from[] is required when networkPolicy.ingress.allowAllSourcesForLocalOnly=false'
    )
    const publicCloudDenyEgressRender = runCapture('helm', [
      'template',
      'public-cloud-deny-egress',
      cloudChart,
      ...publicHelmPrerequisites,
      '--set',
      'cloud.deploymentTier=public_production',
      '--set',
      'cloud.auth.mode=header',
      '--set',
      'cloud.auth.signupMode=invite',
      '--set',
      'cloud.publicUrl=https://cloud.example.com',
      '--set',
      'roles.worker.enabled=true',
      '--set',
      'roles.scheduler.enabled=true',
      '--set',
      'cloud.existingSecret=open-cowork-cloud-secrets',
      '--set',
      'cloud.objectStore.kind=s3',
      '--set',
      'cloud.objectStore.bucket=open-cowork-ci',
      '--set',
      'cloud.checkpoints.enabled=true',
    ])
    assertRenderedIncludes('public Cloud default egress policy', publicCloudDenyEgressRender, 'policyTypes:\n    - Ingress\n    - Egress')
    assertRenderedIncludes('public Cloud default egress policy', publicCloudDenyEgressRender, 'egress: []')
    assertRenderedIncludes('public Cloud ingress allowlist', publicCloudDenyEgressRender, 'kubernetes.io/metadata.name: ingress-nginx')
    assertRenderedIncludes('public Cloud ingress allowlist', publicCloudDenyEgressRender, 'app.kubernetes.io/name: ingress-nginx')
    const publicCloudAllowedEgressRender = runCapture('helm', [
      'template',
      'public-cloud-allowed-egress',
      cloudChart,
      ...publicHelmPrerequisites,
      ...typedEgressAllowlist,
      '--set',
      'cloud.deploymentTier=public_production',
      '--set',
      'cloud.auth.mode=header',
      '--set',
      'cloud.auth.signupMode=invite',
      '--set',
      'cloud.publicUrl=https://cloud.example.com',
      '--set',
      'roles.worker.enabled=true',
      '--set',
      'roles.scheduler.enabled=true',
      '--set',
      'cloud.existingSecret=open-cowork-cloud-secrets',
      '--set',
      'cloud.objectStore.kind=s3',
      '--set',
      'cloud.objectStore.bucket=open-cowork-ci',
      '--set',
      'cloud.checkpoints.enabled=true',
    ])
    assertRenderedIncludes('public Cloud allowed egress policy', publicCloudAllowedEgressRender, 'cidr: 203.0.113.0/24')
    assertRenderedIncludes('public Cloud allowed egress policy', publicCloudAllowedEgressRender, 'port: 443')
    expectFailure(
      'helm',
      [
        'template',
        'latest-cloud-image',
        cloudChart,
        '--set',
        'image.tag=latest',
        '--set',
        'cloud.auth.mode=oidc',
        '--set',
        'cloud.auth.oidcIssuerUrl=https://issuer.example.com',
        '--set',
        'cloud.auth.oidcClientId=open-cowork-cloud-ci',
      ],
      'image.tag=latest is not allowed'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-cloud-sql-proxy-missing-instance',
        cloudChart,
        '--set',
        'image.tag=ci',
        '--set',
        'cloudSqlProxy.enabled=true',
      ],
      'cloudSqlProxy.enabled=true requires cloudSqlProxy.instanceConnectionName'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-cloud-sql-proxy-latest',
        cloudChart,
        '--set',
        'image.tag=ci',
        '--set',
        'cloudSqlProxy.enabled=true',
        '--set',
        'cloudSqlProxy.image.tag=latest',
        '--set',
        'cloudSqlProxy.instanceConnectionName=PROJECT:REGION:INSTANCE',
      ],
      'cloudSqlProxy.image.tag=latest is not allowed'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-cloud-sql-proxy-address',
        cloudChart,
        '--set',
        'image.tag=ci',
        '--set',
        'cloudSqlProxy.enabled=true',
        '--set',
        'cloudSqlProxy.instanceConnectionName=PROJECT:REGION:INSTANCE',
        '--set',
        'cloudSqlProxy.address=0.0.0.0',
      ],
      'cloudSqlProxy.address must be 127.0.0.1'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-cloud-sql-proxy-localhost',
        cloudChart,
        '--set',
        'image.tag=ci',
        '--set',
        'cloudSqlProxy.enabled=true',
        '--set',
        'cloudSqlProxy.instanceConnectionName=PROJECT:REGION:INSTANCE',
        '--set',
        'cloudSqlProxy.address=localhost',
      ],
      'cloudSqlProxy.address must be 127.0.0.1'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-cloud-sql-proxy-health-port',
        cloudChart,
        '--set',
        'image.tag=ci',
        '--set',
        'cloudSqlProxy.enabled=true',
        '--set',
        'cloudSqlProxy.instanceConnectionName=PROJECT:REGION:INSTANCE',
        '--set',
        'cloudSqlProxy.healthCheck.port=5432',
      ],
      'cloudSqlProxy.healthCheck.port must be distinct from cloudSqlProxy.port'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-multi-worker-cloud',
        cloudChart,
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
        'roles.worker.enabled=true',
        '--set',
        'roles.worker.replicas=2',
      ],
      'roles.worker.replicas > 1 requires cloud.checkpoints.enabled=true'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-public-cloud',
        cloudChart,
        '--set',
        'image.tag=ci',
        '--set',
        'cloud.auth.mode=none',
        '--set',
        'cloud.allowInsecureAuth=true',
        '--set',
        'ingress.enabled=true',
      ],
      'cloud.auth.mode=none with public service or ingress requires explicit cloud.allowInsecurePublicAuth=true'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-public-cloud-no-worker',
        cloudChart,
        '--set',
        'image.tag=ci',
        ...publicHelmPrerequisites,
        '--set',
        'cloud.deploymentTier=public_production',
        '--set',
        'cloud.auth.mode=header',
        '--set',
        'cloud.auth.signupMode=invite',
        '--set',
        'cloud.auth.headerSecret=ci-header-secret-with-enough-entropy-123456789',
        '--set',
        'cloud.publicUrl=https://cloud.example.com',
        '--set',
        'cloud.controlPlaneUrl=postgres://postgres:postgres@postgres:5432/open_cowork_cloud',
        '--set',
        'cloud.secretKeyRef=env:OPEN_COWORK_CLOUD_SECRET_KEY',
        '--set',
        'cloud.cookieSecret=ci-cookie-secret-with-enough-entropy-123456789',
        '--set',
        'cloud.objectStore.kind=s3',
        '--set',
        'cloud.objectStore.bucket=open-cowork-ci',
        '--set',
        'cloud.checkpoints.enabled=true',
      ],
      'cloud.deploymentTier=public_production requires roles.worker.enabled=true'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-public-cloud-no-public-url',
        cloudChart,
        '--set',
        'image.tag=ci',
        ...publicHelmPrerequisites,
        '--set',
        'cloud.deploymentTier=public_production',
        '--set',
        'cloud.auth.mode=header',
        '--set',
        'cloud.auth.signupMode=invite',
        '--set',
        'cloud.auth.headerSecret=ci-header-secret-with-enough-entropy-123456789',
        '--set',
        'roles.worker.enabled=true',
        '--set',
        'roles.scheduler.enabled=true',
        '--set',
        'cloud.controlPlaneUrl=postgres://postgres:postgres@postgres:5432/open_cowork_cloud',
        '--set',
        'cloud.secretKeyRef=env:OPEN_COWORK_CLOUD_SECRET_KEY',
        '--set',
        'cloud.cookieSecret=ci-cookie-secret-with-enough-entropy-123456789',
        '--set',
        'cloud.objectStore.kind=s3',
        '--set',
        'cloud.objectStore.bucket=open-cowork-ci',
        '--set',
        'cloud.checkpoints.enabled=true',
      ],
      'cloud.deploymentTier=public_production web role requires cloud.publicUrl'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-public-cloud-inline-secrets',
        cloudChart,
        '--set',
        'image.tag=ci',
        ...publicHelmPrerequisites,
        '--set',
        'cloud.deploymentTier=public_production',
        '--set',
        'cloud.auth.mode=header',
        '--set',
        'cloud.auth.signupMode=invite',
        '--set',
        'cloud.auth.headerSecret=ci-header-secret-with-enough-entropy-123456789',
        '--set',
        'cloud.publicUrl=https://cloud.example.com',
        '--set',
        'roles.worker.enabled=true',
        '--set',
        'roles.scheduler.enabled=true',
        '--set',
        'cloud.controlPlaneUrl=postgres://postgres:postgres@postgres:5432/open_cowork_cloud',
        '--set',
        'cloud.objectStore.kind=s3',
        '--set',
        'cloud.objectStore.bucket=open-cowork-ci',
        '--set',
        'cloud.checkpoints.enabled=true',
      ],
      'cloud.deploymentTier=public_production rejects inline secret-bearing Helm values'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-public-cloud-inline-web-worker',
        cloudChart,
        '--set',
        'image.tag=ci',
        ...publicHelmPrerequisites,
        '--set',
        'cloud.deploymentTier=public_production',
        '--set',
        'cloud.auth.mode=header',
        '--set',
        'cloud.auth.signupMode=invite',
        '--set',
        'cloud.publicUrl=https://cloud.example.com',
        '--set',
        'roles.worker.enabled=true',
        '--set',
        'roles.scheduler.enabled=true',
        '--set',
        'roles.web.autoProcessCommands=true',
        '--set',
        'cloud.existingSecret=open-cowork-cloud-secrets',
        '--set',
        'cloud.objectStore.kind=s3',
        '--set',
        'cloud.objectStore.bucket=open-cowork-ci',
        '--set',
        'cloud.checkpoints.enabled=true',
      ],
      'cloud.deploymentTier=public_production web role must set roles.web.autoProcessCommands=false'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-public-cloud-insecure-auth-override',
        cloudChart,
        '--set',
        'image.tag=ci',
        ...publicHelmPrerequisites,
        '--set',
        'cloud.deploymentTier=public_production',
        '--set',
        'cloud.allowInsecureAuth=true',
        '--set',
        'cloud.auth.mode=header',
        '--set',
        'cloud.auth.signupMode=invite',
        '--set',
        'cloud.publicUrl=https://cloud.example.com',
        '--set',
        'roles.worker.enabled=true',
        '--set',
        'roles.scheduler.enabled=true',
        '--set',
        'cloud.existingSecret=open-cowork-cloud-secrets',
        '--set',
        'cloud.objectStore.kind=s3',
        '--set',
        'cloud.objectStore.bucket=open-cowork-ci',
        '--set',
        'cloud.checkpoints.enabled=true',
      ],
      'cloud.deploymentTier=public_production rejects cloud.allowInsecureAuth=true'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-public-cloud-insecure-cookie',
        cloudChart,
        '--set',
        'image.tag=ci',
        ...publicHelmPrerequisites,
        '--set',
        'cloud.deploymentTier=public_production',
        '--set',
        'cloud.cookieSecure=false',
        '--set',
        'cloud.auth.mode=header',
        '--set',
        'cloud.auth.signupMode=invite',
        '--set',
        'cloud.publicUrl=https://cloud.example.com',
        '--set',
        'roles.worker.enabled=true',
        '--set',
        'roles.scheduler.enabled=true',
        '--set',
        'cloud.existingSecret=open-cowork-cloud-secrets',
        '--set',
        'cloud.objectStore.kind=s3',
        '--set',
        'cloud.objectStore.bucket=open-cowork-ci',
        '--set',
        'cloud.checkpoints.enabled=true',
      ],
      'cloud.deploymentTier=public_production requires cloud.cookieSecure=true'
    )

    run('helm', [
      'lint',
      gatewayChart,
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'image.tag=ci',
      '--set',
      'gateway.serviceToken=ci-gateway-token',
      '--set',
      'gateway.adminToken=ci-gateway-admin-token',
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
      'gateway.adminToken=ci-gateway-admin-token',
      '--set',
      'gateway.telegram.botToken=ci-telegram-token',
    ])
    assertConfigChecksumRollsPods(
      'open-cowork-gateway',
      runCapture('helm', [
        'template',
        'open-cowork-gateway-checksum',
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
        'gateway.adminToken=ci-gateway-admin-token',
        '--set',
        'gateway.telegram.botToken=ci-telegram-token',
        '--set',
        'gateway.logLevel=info',
      ]),
      runCapture('helm', [
        'template',
        'open-cowork-gateway-checksum',
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
        'gateway.adminToken=ci-gateway-admin-token',
        '--set',
        'gateway.telegram.botToken=ci-telegram-token',
        '--set',
        'gateway.logLevel=warn',
      ]),
    )
    run('helm', [
      'template',
      'open-cowork-gateway-shared-config',
      gatewayChart,
      '--set',
      'image.repository=example.com/open-cowork-gateway',
      '--set',
      'image.tag=ci',
      '--set',
      'gateway.configPath=/etc/open-cowork/open-cowork.config.json',
    ])
    expectFailure(
      'helm',
      [
        'template',
        'public-gateway-empty-ingress-allowlist',
        gatewayChart,
        ...publicHelmImagePrerequisites,
        '--set',
        'gateway.cloudBaseUrl=https://cloud.example.com',
        '--set',
        'gateway.publicUrl=https://gateway.example.com',
        '--set',
        'gateway.existingSecret=open-cowork-gateway-secrets',
      ],
      'public Gateway deployments require networkPolicy.ingress.from[]'
    )
    expectFailure(
      'helm',
      [
        'template',
        'strict-local-gateway-empty-ingress-allowlist',
        gatewayChart,
        '--set',
        'image.tag=ci',
        '--set',
        'gateway.cloudBaseUrl=https://cloud.example.com',
        '--set',
        'gateway.serviceToken=ci-gateway-token',
        '--set',
        'gateway.adminToken=ci-gateway-admin-token',
        '--set',
        'networkPolicy.ingress.allowAllSourcesForLocalOnly=false',
      ],
      'networkPolicy.ingress.from[] is required when networkPolicy.ingress.allowAllSourcesForLocalOnly=false'
    )
    const publicGatewayDenyEgressRender = runCapture('helm', [
      'template',
      'public-gateway-deny-egress',
      gatewayChart,
      ...publicHelmPrerequisites,
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.publicUrl=https://gateway.example.com',
      '--set',
      'gateway.existingSecret=open-cowork-gateway-secrets',
    ])
    assertRenderedIncludes('public Gateway default egress policy', publicGatewayDenyEgressRender, 'policyTypes:\n    - Ingress\n    - Egress')
    assertRenderedIncludes('public Gateway default egress policy', publicGatewayDenyEgressRender, 'egress: []')
    assertRenderedIncludes('public Gateway ingress allowlist', publicGatewayDenyEgressRender, 'kubernetes.io/metadata.name: ingress-nginx')
    assertRenderedIncludes('public Gateway ingress allowlist', publicGatewayDenyEgressRender, 'app.kubernetes.io/name: ingress-nginx')
    const publicGatewayAllowedEgressRender = runCapture('helm', [
      'template',
      'public-gateway-allowed-egress',
      gatewayChart,
      ...publicHelmPrerequisites,
      ...typedEgressAllowlist,
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.publicUrl=https://gateway.example.com',
      '--set',
      'gateway.existingSecret=open-cowork-gateway-secrets',
    ])
    assertRenderedIncludes('public Gateway allowed egress policy', publicGatewayAllowedEgressRender, 'cidr: 203.0.113.0/24')
    assertRenderedIncludes('public Gateway allowed egress policy', publicGatewayAllowedEgressRender, 'port: 443')
    expectFailure(
      'helm',
      [
        'template',
        'latest-gateway-image',
        gatewayChart,
        '--set',
        'image.tag=latest',
        '--set',
        'gateway.cloudBaseUrl=https://cloud.example.com',
        '--set',
        'gateway.serviceToken=ci-gateway-token',
        '--set',
        'gateway.adminToken=ci-gateway-admin-token',
        '--set',
        'gateway.telegram.botToken=ci-telegram-token',
      ],
      'image.tag=latest is not allowed'
    )
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
        'gateway.adminToken=ci-gateway-admin-token',
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
      'gateway.adminToken or gateway.existingSecret is required for gateway operator endpoints'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-multi-gateway',
        gatewayChart,
        '--set',
        'gateway.cloudBaseUrl=https://cloud.example.com',
        '--set',
        'gateway.serviceToken=ci-gateway-token',
        '--set',
        'gateway.adminToken=ci-gateway-admin-token',
        '--set',
        'gateway.telegram.botToken=ci-telegram-token',
        '--set',
        'replicaCount=2',
      ],
      'gateway replicaCount > 1 is unsafe while stream/replay state is process-local'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-telegram-webhook-gateway',
        gatewayChart,
        '--set',
        'gateway.cloudBaseUrl=https://cloud.example.com',
        '--set',
        'gateway.serviceToken=ci-gateway-token',
        '--set',
        'gateway.adminToken=ci-gateway-admin-token',
        '--set',
        'gateway.telegram.botToken=ci-telegram-token',
        '--set',
        'gateway.telegram.mode=webhook',
        '--set',
        'gateway.telegram.webhookSecret=ci-telegram-secret',
      ],
      'gateway.telegram.publicUrl or gateway.publicUrl is required when Telegram webhook mode is enabled'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-public-gateway-inline-secrets',
        gatewayChart,
        ...publicHelmPrerequisites,
        '--set',
        'gateway.cloudBaseUrl=https://cloud.example.com',
        '--set',
        'gateway.publicUrl=https://gateway.example.com',
        '--set',
        'gateway.serviceToken=ci-gateway-token',
        '--set',
        'gateway.adminToken=ci-gateway-admin-token',
        '--set',
        'gateway.telegram.botToken=ci-telegram-token',
      ],
      'public Gateway deployments reject inline secret-bearing Helm values'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-gateway-http-public-url',
        gatewayChart,
        ...publicHelmPrerequisites,
        '--set',
        'gateway.cloudBaseUrl=https://cloud.example.com',
        '--set',
        'gateway.existingSecret=open-cowork-gateway-secrets',
        '--set',
        'gateway.publicUrl=http://gateway.example.com',
      ],
      'gateway.publicUrl must use HTTPS'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-gateway-ingress-loopback-bypass',
        gatewayChart,
        ...publicHelmPrerequisites,
        '--set',
        'gateway.cloudBaseUrl=https://cloud.example.com',
        '--set',
        'gateway.existingSecret=open-cowork-gateway-secrets',
        '--set',
        'gateway.allowLoopbackOperatorBypass=true',
        '--set',
        'ingress.enabled=true',
        '--set',
        'gateway.publicUrl=https://gateway.example.com',
      ],
      'gateway.allowLoopbackOperatorBypass=true is not allowed with ingress'
    )
    expectFailure(
      'helm',
      [
        'template',
        'unsafe-gateway-placeholder-admin',
        gatewayChart,
        '--set',
        'gateway.cloudBaseUrl=https://cloud.example.com',
        '--set',
        'gateway.serviceToken=ci-gateway-token',
        '--set',
        'gateway.adminToken=replace-with-operator-token',
        '--set',
        'gateway.telegram.botToken=ci-telegram-token',
      ],
      'gateway.adminToken is a placeholder'
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function validateTopologyProfiles() {
  const topologyPath = 'deploy/topologies/topology-profiles.json'
  const topologyReadmePath = 'deploy/topologies/README.md'
  const topologyDocsPath = 'docs/deployment-topologies.md'
  const profilesDocument = parseJson(topologyPath)
  const packageScripts = parseJson('package.json').scripts ?? {}
  const requiredProfileIds = [
    'desktop-only',
    'gateway-only',
    'cloud-only',
    'cloud-channel-gateway',
    'desktop-gateway',
    'cloud-gateway-edge',
    'full-hybrid',
  ]

  if (profilesDocument.schemaVersion !== 1) {
    throw new Error(`${topologyPath} must declare schemaVersion 1`)
  }
  if (profilesDocument.purpose !== 'open-cowork-deployment-topology-profiles') {
    throw new Error(`${topologyPath} must declare open-cowork-deployment-topology-profiles purpose`)
  }
  if (!Array.isArray(profilesDocument.profiles)) {
    throw new Error(`${topologyPath} must contain a profiles array`)
  }

  const profiles = new Map(profilesDocument.profiles.map((profile) => [profile.id, profile]))
  for (const id of requiredProfileIds) {
    const profile = profiles.get(id)
    if (!profile) throw new Error(`${topologyPath} is missing profile ${id}`)
    for (const field of [
      'label',
      'status',
      'soloPath',
      'productionPath',
      'securityBoundary',
    ]) {
      if (!profile[field] || typeof profile[field] !== 'string') {
        throw new Error(`${topologyPath} profile ${id} must include string field ${field}`)
      }
    }
    for (const field of [
      'intendedOperators',
      'surfaces',
      'executionAuthorities',
      'controlPlanes',
      'referenceAssets',
      'requiredDurability',
      'failClosedChecks',
      'validationCommands',
      'smokeCommands',
      'notes',
    ]) {
      if (!Array.isArray(profile[field]) || profile[field].length === 0) {
        throw new Error(`${topologyPath} profile ${id} must include non-empty array field ${field}`)
      }
    }
  }

  const expectedCommands = {
    'desktop-only': ['pnpm test:e2e'],
    'gateway-only': ['pnpm deploy:standalone-gateway:validate', 'pnpm deploy:standalone-gateway:smoke'],
    'cloud-only': ['pnpm deploy:validate', 'pnpm ops:validate'],
    'cloud-channel-gateway': ['pnpm deploy:validate', 'pnpm deploy:gateway:smoke', 'pnpm deploy:continuation:smoke'],
    'desktop-gateway': ['pnpm test:e2e'],
    'cloud-gateway-edge': ['pnpm deploy:validate', 'pnpm deploy:gateway:smoke'],
    'full-hybrid': ['pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm test:e2e', 'pnpm deploy:validate', 'pnpm test:cloud-continuation'],
  }

  for (const [id, commands] of Object.entries(expectedCommands)) {
    const profile = profiles.get(id)
    const commandText = [...profile.validationCommands, ...profile.smokeCommands].join('\n')
    for (const command of commands) {
      if (!commandText.includes(command)) {
        throw new Error(`${topologyPath} profile ${id} must include ${command}`)
      }
    }
  }
  for (const profile of profilesDocument.profiles) {
    for (const command of [...profile.validationCommands, ...profile.smokeCommands]) {
      const match = /^pnpm\s+([^\s]+)/.exec(command)
      if (!match) throw new Error(`${topologyPath} profile ${profile.id} command must start with pnpm: ${command}`)
      const scriptName = match[1]
      if (scriptName.startsWith('--')) continue
      if (!packageScripts[scriptName]) {
        throw new Error(`${topologyPath} profile ${profile.id} references missing package script: ${scriptName}`)
      }
    }
  }

  const boundaryText = profilesDocument.profiles
    .map((profile) => `${profile.id}\n${profile.securityBoundary}\n${profile.failClosedChecks.join('\n')}`)
    .join('\n')
  for (const phrase of [
    'No public OpenCode port',
    'OpenCode stays loopback/private',
    'Gateway is a Cloud client',
    'no Desktop or OpenCode port is public',
    'one execution authority',
    'non-loopback broker URLs require HTTPS',
    'provider-backed object storage',
    'admin token required',
  ]) {
    if (!boundaryText.toLowerCase().includes(phrase.toLowerCase())) {
      throw new Error(`${topologyPath} must include topology boundary phrase: ${phrase}`)
    }
  }

  for (const id of requiredProfileIds) {
    assertIncludes(topologyReadmePath, `\`${id}\``)
    assertIncludes(topologyDocsPath, `\`${id}\``)
  }
  for (const phrase of [
    'Telegram-to-VPS OpenCode team',
    'provider recipes',
    'systemd',
    'launchd',
    'docker-compose.gateway-remote.yml',
    'docker-compose.cloud-gateway.yml',
    'helm/open-cowork-cloud/',
    'helm/open-cowork-gateway/',
    'one execution authority',
    'fail closed',
    'pnpm deploy:validate',
  ]) {
    assertIncludes(topologyReadmePath, phrase)
  }
  for (const phrase of [
    'Profile Matrix',
    'Choosing A Path',
    'Production Boundaries',
    'Required Validation',
    'deploy/topologies/topology-profiles.json',
    'deploy/topologies/README.md',
  ]) {
    assertIncludes(topologyDocsPath, phrase)
  }
}

function validateHybridSecurityGates() {
  const gatesPath = 'deploy/security/hybrid-security-gates.json'
  const gatesDocsPath = 'docs/hybrid-security-gates.md'
  const readinessPath = 'docs/deployment-readiness.md'
  const gatesDocument = parseJson(gatesPath)
  const topologyProfiles = new Set(parseJson('deploy/topologies/topology-profiles.json').profiles.map((profile) => profile.id))
  const packageScripts = parseJson('package.json').scripts ?? {}
  const requiredGateIds = [
    'desktop-local',
    'desktop-pairing',
    'standalone-gateway',
    'cloud-worker',
    'cloud-channel-gateway',
    'cloud-gateway-edge',
    'full-hybrid',
  ]

  if (gatesDocument.schemaVersion !== 1) {
    throw new Error(`${gatesPath} must declare schemaVersion 1`)
  }
  if (gatesDocument.purpose !== 'open-cowork-hybrid-security-gates') {
    throw new Error(`${gatesPath} must declare open-cowork-hybrid-security-gates purpose`)
  }
  if (!Array.isArray(gatesDocument.gates)) {
    throw new Error(`${gatesPath} must contain a gates array`)
  }

  const gates = new Map(gatesDocument.gates.map((gate) => [gate.id, gate]))
  for (const id of requiredGateIds) {
    const gate = gates.get(id)
    if (!gate) throw new Error(`${gatesPath} is missing gate ${id}`)
    for (const field of ['label', 'authority', 'scope']) {
      if (!gate[field] || typeof gate[field] !== 'string') {
        throw new Error(`${gatesPath} gate ${id} must include string field ${field}`)
      }
    }
    for (const field of [
      'topologyProfiles',
      'auth',
      'revocation',
      'approvalPolicy',
      'questionPolicy',
      'auditEvents',
      'rateLimits',
      'durability',
      'backupRestore',
      'redaction',
      'failClosedChecks',
      'validationEvidence',
    ]) {
      if (!Array.isArray(gate[field]) || gate[field].length === 0) {
        throw new Error(`${gatesPath} gate ${id} must include non-empty array field ${field}`)
      }
    }
    for (const profileId of gate.topologyProfiles) {
      if (!topologyProfiles.has(profileId)) {
        throw new Error(`${gatesPath} gate ${id} references unknown topology profile ${profileId}`)
      }
    }
    for (const command of gate.validationEvidence) {
      const match = /^pnpm\s+([^\s]+)/.exec(command)
      if (!match) throw new Error(`${gatesPath} gate ${id} command must start with pnpm: ${command}`)
      const scriptName = match[1]
      if (scriptName.startsWith('--')) continue
      if (!packageScripts[scriptName]) {
        throw new Error(`${gatesPath} gate ${id} references missing package script: ${scriptName}`)
      }
    }
    assertIncludes(gatesDocsPath, `\`${id}\``)
    assertIncludes(readinessPath, `\`${id}\``)
  }

  const combinedGateText = `${JSON.stringify(gatesDocument)}\n${read(gatesDocsPath)}\n${read(readinessPath)}`
  for (const phrase of [
    'local_confirmation',
    'remote_allowed',
    'requires_local_confirmation',
    'blocked_by_policy',
    'Retry-After',
    'admin token',
    'provider signing',
    'HMAC',
    'audit',
    'backup',
    'restore',
    'redact',
    'customer_hosted_managed_saas_deferred',
    'one execution authority',
  ]) {
    if (!combinedGateText.includes(phrase)) {
      throw new Error(`${gatesPath} and ${gatesDocsPath} must include hybrid security phrase: ${phrase}`)
    }
  }

  const desktopPairing = read('packages/shared/src/desktop-pairing.ts')
  for (const phrase of [
    "remoteApprovals: 'local_confirmation'",
    "remoteQuestions: 'local_confirmation'",
    'requires_local_confirmation',
    'blocked_by_policy',
    'remote_allowed',
    'pairing.revoked',
    'command.blocked',
  ]) {
    if (!desktopPairing.includes(phrase)) {
      throw new Error(`packages/shared/src/desktop-pairing.ts must include ${phrase}`)
    }
  }

  const gatewayConfig = read('apps/channel-gateway/src/config.ts')
  for (const phrase of [
    'authenticated webhook ingress',
    'signingSecret',
    'webhookSecret',
  ]) {
    if (!gatewayConfig.includes(phrase)) {
      throw new Error(`apps/channel-gateway/src/config.ts must include ${phrase}`)
    }
  }
  const gatewayConfigSafety = read('apps/channel-gateway/src/config-safety.ts')
  if (!gatewayConfigSafety.includes('Gateway operator endpoints require OPEN_COWORK_GATEWAY_ADMIN_TOKEN')) {
    throw new Error('apps/channel-gateway/src/config-safety.ts must include Gateway operator endpoints require OPEN_COWORK_GATEWAY_ADMIN_TOKEN')
  }

  const standaloneNetworkPolicy = read('apps/standalone-gateway/src/network-policy.ts')
  if (!standaloneNetworkPolicy.includes('public OpenCode endpoint')) {
    throw new Error('apps/standalone-gateway/src/network-policy.ts must reject public OpenCode endpoint')
  }

  // Rate-limit handling is split after the cloud-server extraction: the HTTP server
  // emits the quota_rejections metric + the 429 path, while the shared response writer
  // sets the Retry-After header. Assert each phrase in its owning module.
  const cloudHttpServer = read('packages/cloud-server/src/http-server.ts')
  if (!cloudHttpServer.includes('quota_rejections')) {
    throw new Error('packages/cloud-server/src/http-server.ts must include quota_rejections')
  }
  const cloudHttpResponseWriters = read('packages/cloud-server/src/http-response-writers.ts')
  if (!cloudHttpResponseWriters.includes('Retry-After')) {
    throw new Error('packages/cloud-server/src/http-response-writers.ts must include Retry-After')
  }

  const workspace = read('packages/shared/src/workspace.ts')
  for (const phrase of ['OPENCODE_RUNTIME_AUTHORITIES', 'workspace.remote_approval_required']) {
    if (!workspace.includes(phrase)) {
      throw new Error(`packages/shared/src/workspace.ts must include ${phrase}`)
    }
  }
}

function validateSetupHealthCenter() {
  const setupContractPath = 'packages/shared/src/setup-health.ts'
  const setupDocsPath = 'docs/setup-and-health-center.md'
  const setupScreenPath = 'packages/app/src/components/SetupScreen.tsx'
  const healthCenterPath = 'packages/app/src/components/health/HealthCenterPage.tsx'
  const sidebarPath = 'packages/app/src/components/layout/Sidebar.tsx'
  const appTypesPath = 'packages/app/src/app-types.ts'
  const standaloneSetupPath = 'scripts/standalone-gateway-setup.mjs'
  const setupContract = read(setupContractPath)
  const setupDocs = read(setupDocsPath)
  const packageScripts = parseJson('package.json').scripts ?? {}

  for (const id of [
    'desktop-local',
    'gateway-only',
    'cloud-connect',
    'desktop-pairing',
    'full-hybrid',
  ]) {
    if (!setupContract.includes(`'${id}'`)) {
      throw new Error(`${setupContractPath} must include setup intent ${id}`)
    }
    assertIncludes(setupDocsPath, `\`${id}\``)
  }

  for (const checkId of [
    'desktop.runtime.ready',
    'desktop.credentials.configured',
    'workspace.authority.declared',
    'workspace.cloud.authenticated',
    'workspace.cloud.sync.reachable',
    'gateway.private_opencode.reachable',
    'gateway.provider.healthy',
    'gateway.operator_auth.configured',
    'cloud.database.migrated',
    'cloud.object_store.configured',
    'cloud.backup_posture.configured',
    'pairing.connection.active',
    'pairing.remote_policy.scoped',
  ]) {
    if (!setupContract.includes(`'${checkId}'`)) {
      throw new Error(`${setupContractPath} must include health check ${checkId}`)
    }
  }

  for (const phrase of [
    'Health Center',
    'authority-aware',
    'doctor',
    'smoke',
    '0600',
    'raw credentials',
    'pnpm standalone-gateway:setup',
    'pnpm gateway:setup',
    'pnpm deploy:standalone-gateway:smoke',
    'pnpm deploy:gateway:smoke',
    'pnpm deploy:validate',
    'pnpm ops:validate',
  ]) {
    if (!setupDocs.includes(phrase)) {
      throw new Error(`${setupDocsPath} must include setup health phrase: ${phrase}`)
    }
  }

  for (const scriptName of [
    'standalone-gateway:setup',
    'gateway:setup',
    'deploy:standalone-gateway:smoke',
    'deploy:gateway:smoke',
    'deploy:smoke:strict',
    'deploy:validate',
    'ops:validate',
  ]) {
    if (!packageScripts[scriptName]) {
      throw new Error(`package.json scripts must include ${scriptName}`)
    }
  }

  const setupScreen = read(setupScreenPath)
  for (const phrase of [
    'SETUP_INTENTS',
    'advancedIntents.map',
    'Set up a team or server deployment',
    'selectedIntent.primaryCommand',
    'selectedIntent.primaryDocs',
  ]) {
    if (!setupScreen.includes(phrase)) {
      throw new Error(`${setupScreenPath} must render shared setup intents behind advanced setup disclosure`)
    }
  }

  const healthCenter = read(healthCenterPath)
  for (const phrase of [
    'SETUP_INTENTS',
    'SETUP_HEALTH_CHECKS',
    'workspace.support',
    'runtime.status',
    'runtimeInputs',
    'desktopPairing.list',
    'workspaceAuthorityContract',
    'No raw credential values are shown',
  ]) {
    if (!healthCenter.includes(phrase)) {
      throw new Error(`${healthCenterPath} must include ${phrase}`)
    }
  }

  // Product purity: nav label is Health Center (not Diagnostics).
  assertIncludes(sidebarPath, 'healthCenter')
  assertIncludes(sidebarPath, 'Health Center')
  assertIncludes(appTypesPath, "'health'")

  const standaloneSetup = read(standaloneSetupPath)
  for (const phrase of [
    'mode: 0o600',
    'Refusing to print secret arguments',
    'must point at loopback or private network OpenCode',
    'OPEN_COWORK_STANDALONE_GATEWAY_TRUST_PROXY_HEADERS=false',
    'OPEN_COWORK_STANDALONE_GATEWAY_TRUSTED_PROXY_CIDRS=',
    'OPEN_COWORK_STANDALONE_GATEWAY_RUNTIME_ROOT=',
    'OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_EXECUTION_TIMEOUT_MS=',
    'pnpm --filter @open-cowork/standalone-gateway doctor',
    'pnpm deploy:standalone-gateway:smoke',
  ]) {
    if (!standaloneSetup.includes(phrase)) {
      throw new Error(`${standaloneSetupPath} must include ${phrase}`)
    }
  }
}

function validateDocs() {
  const requiredDocs = [
    'docs/deployment-readiness.md',
    'docs/deployment-topologies.md',
    'docs/hybrid-security-gates.md',
    'docs/setup-and-health-center.md',
    'docs/downstream-contract.md',
    'docs/runbooks/cloud-managed-operations.md',
    'docs/runbooks/backup-restore.md',
    'docs/runbooks/restore-drill-report.md',
    'docs/runbooks/managed-byok-saas.md',
    'docs/gateway-appliance.md',
    'docs/gateway-provider-readiness.md',
    'docs/runbooks/private-beta-launch.md',
    'docs/runbooks/private-beta-support.md',
    'deploy/gateway-appliance/README.md',
    'deploy/gateway-appliance/remote-cloud.env.example',
    'deploy/gateway-appliance/local-all-in-one.env.example',
    'deploy/gateway-appliance/systemd/open-cowork-gateway.service',
    'deploy/gateway-appliance/launchd/com.open-cowork.gateway.plist',
    'deploy/gateway-appliance/reverse-proxy/Caddyfile.example',
    'deploy/private-beta/README.md',
    'deploy/private-beta/private-beta-plans.json',
    'deploy/private-beta/hosted-byok.config.example.json',
    'deploy/private-beta/self-host-oss.config.example.json',
    'deploy/managed-workers/README.md',
    'deploy/managed-workers/self-host-worker.env.example',
    'deploy/managed-workers/managed-operator-worker.env.template',
    'deploy/managed-workers/helm-values.worker-pool.yaml.example',
    'deploy/managed-workers/worker-release-evidence.template.md',
    'deploy/managed-workers/worker-restore-drill.template.md',
    'deploy/README.md',
    'deploy/topologies/README.md',
    'deploy/topologies/topology-profiles.json',
    'deploy/security/hybrid-security-gates.json',
    'deploy/observability/metrics-catalog.json',
    'deploy/observability/prometheus-alerts.yaml',
    'deploy/observability/grafana-open-cowork-overview.json',
    'deploy/observability/managed-worker-slo-template.json',
    'deploy/gcp/README.md',
    'deploy/gcp/smoke/evidence.template.json',
    'deploy/aws/README.md',
    'deploy/azure/README.md',
    'deploy/digitalocean/README.md',
    'deploy/kubernetes/README.md',
  ]
  for (const path of requiredDocs) {
    if (!existsSync(path)) {
      throw new Error(`${path} is required`)
    }
  }
  for (const path of [
    'docs/managed-workers.md',
    'docs/deployment-topologies.md',
    'docs/runbooks/cloud-managed-operations.md',
    'deploy/managed-workers/README.md',
    'deploy/managed-workers/self-host-worker.env.example',
    'deploy/managed-workers/managed-operator-worker.env.template',
    'deploy/managed-workers/helm-values.worker-pool.yaml.example',
    'deploy/managed-workers/worker-release-evidence.template.md',
    'deploy/managed-workers/worker-restore-drill.template.md',
    'deploy/gcp/README.md',
    'deploy/gcp/gke/values.gke.yaml.example',
    'deploy/gcp/gke/external-secret.example.yaml',
    'deploy/gcp/gke/managed-certificate.example.yaml',
    'deploy/gcp/cloud-run/all-in-one.service.yaml.example',
    'deploy/gcp/smoke/README.md',
    'deploy/gcp/smoke/evidence.template.json',
    'deploy/topologies/README.md',
    'deploy/topologies/topology-profiles.json',
    'deploy/security/hybrid-security-gates.json',
    'docs/hybrid-security-gates.md',
    'docs/setup-and-health-center.md',
    'deploy/observability/managed-worker-slo-template.json',
    'deploy/private-beta/hosted-byok.config.example.json',
    'deploy/private-beta/self-host-oss.config.example.json',
    'deploy/private-beta/private-beta-plans.json',
    'deploy/private-beta/design-partner-onboarding.template.md',
    'deploy/private-beta/go-no-go-report.template.md',
    'deploy/private-beta/private-beta-launch-profile.template.json',
    'examples/downstream/example-org/README.md',
    'examples/downstream/example-org/open-cowork.config.json',
    'examples/downstream/example-org/cloud-values.yaml',
    'examples/downstream/example-org/gateway-values.yaml',
  ]) {
    assertPublicTemplateSafe(path)
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
    'deploy/managed-workers/',
    'open_cowork_cloud_shutdown_grace_ms',
    'hpa or keda',
    'poddisruptionbudgets',
    'topology spread constraints',
    'helm image pinning',
    'gateway service token',
    'provider webhook signing',
    'quotas/rate limits',
    'cloud web workbench',
    'browser e2e',
    'accessibility',
    'performance and scale',
    'api bootstrap',
    'content-security-policy',
    'cloud.publicbranding',
    'clouddesktop',
    'gateway.providers',
    'open_cowork_config_path',
    'cloud.billing.provider=none',
    'otlp/logging',
    'backups/restore',
    'deploy/observability/',
    'docs/runbooks/backup-restore.md',
    'docs/runbooks/restore-drill-report.md',
    'no billing provider or the stub billing provider',
    'billing-free path',
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

  const privateBeta = read('docs/runbooks/private-beta-launch.md')
  for (const phrase of [
    'Managed BYOK Onboarding Checklist',
    'Hosted BYOK Setup Flow',
    'OSS Self-Host Equivalent',
    'Managed Vs Self-Host Responsibilities',
    'Security Posture',
    'Known Private Beta Constraints',
    'Open Cowork does not resell model tokens',
  ]) {
    if (!privateBeta.includes(phrase)) {
      throw new Error(`docs/runbooks/private-beta-launch.md must include ${phrase}`)
    }
  }

  const privateBetaSupport = read('docs/runbooks/private-beta-support.md')
  for (const phrase of [
    'Support Intake',
    'Triage Matrix',
    'Diagnostics Workflow',
    'BYOK Issue Handling',
    'Gateway Issue Handling',
    'Desktop Sync Issue Handling',
    'Never attach raw secrets',
  ]) {
    if (!privateBetaSupport.includes(phrase)) {
      throw new Error(`docs/runbooks/private-beta-support.md must include ${phrase}`)
    }
  }

  const operations = read('docs/runbooks/cloud-managed-operations.md')
  for (const phrase of [
    'Web Unavailable Or Erroring',
    'Worker Backlog',
    'Scheduler Stalled',
    'Postgres Connection Exhaustion',
    'Object-Store Errors',
    'KMS Or Secret Adapter Errors',
    'OIDC Outage',
    'Gateway Provider Outage',
    'Worker Registration',
    'Worker Credential Rotation',
    'Pause, Drain, Resume, And Retire',
    'Rolling Worker Update',
    'Emergency Revoke',
    'Stuck Queue',
    'Stale Lease Spike',
    'Worker Crash Loop',
    'Tenant Offboarding',
    'Suspected Key Exposure',
    'Webhook Abuse',
    'BYOK Provider Key Failure',
  ]) {
    if (!operations.includes(phrase)) {
      throw new Error(`docs/runbooks/cloud-managed-operations.md must include ${phrase}`)
    }
  }

  const metricsCatalog = read('deploy/observability/metrics-catalog.json')
  for (const metric of [
    'open_cowork_cloud_http_requests_total',
    'open_cowork_cloud_command_queue_depth_estimate',
    'open_cowork_cloud_worker_lease_claims_total',
    'open_cowork_cloud_scheduler_claims_total',
    'open_cowork_cloud_projection_lag_events',
    'open_cowork_cloud_byok_reveal_failures_total',
    'open_cowork_cloud_object_store_operations_total',
    'pg_up',
    'pg_stat_activity_count',
    'open_cowork_gateway_delivery_retries_total',
    'open_cowork_gateway_delivery_dead_letters_total',
    'open_cowork_gateway_session_streams',
  ]) {
    if (!metricsCatalog.includes(metric)) {
      throw new Error(`deploy/observability/metrics-catalog.json must include ${metric}`)
    }
  }

  for (const path of ['deploy/observability/prometheus-alerts.yaml', 'deploy/observability/grafana-open-cowork-overview.json']) {
    const artifact = read(path)
    for (const phrase of ['Worker', 'Gateway', 'BYOK', 'projection']) {
      if (!artifact.toLowerCase().includes(phrase.toLowerCase())) {
        throw new Error(`${path} must include ${phrase}`)
      }
    }
  }
  const workerSlo = parseJson('deploy/observability/managed-worker-slo-template.json')
  const workerSloIds = new Set((workerSlo.slos || []).map((slo) => slo.id))
  for (const id of [
    'worker-heartbeat-freshness',
    'command-queue-age',
    'claim-latency',
    'command-latency',
    'workflow-latency',
    'projection-lag',
    'checkpoint-failures',
    'byok-reveal-failures',
    'stale-lease-reclaims',
    'gateway-worker-lag',
  ]) {
    if (!workerSloIds.has(id)) {
      throw new Error(`deploy/observability/managed-worker-slo-template.json is missing ${id}`)
    }
  }

  const backupRestore = read('docs/runbooks/backup-restore.md')
  for (const phrase of ['pg_dump', 'pg_restore', 'aws s3 sync', 'gcloud storage rsync', 'az storage blob sync']) {
    if (!backupRestore.includes(phrase)) {
      throw new Error(`docs/runbooks/backup-restore.md must include ${phrase}`)
    }
  }

  const restoreDrill = read('docs/runbooks/restore-drill-report.md')
  for (const phrase of ['Postgres restore', 'Object-store restore', 'Session projection parity', 'Gateway recovery', 'Redaction']) {
    if (!restoreDrill.includes(phrase)) {
      throw new Error(`docs/runbooks/restore-drill-report.md must include ${phrase}`)
    }
  }

  const deployReadme = read('deploy/README.md')
  for (const phrase of [
    'Provider Recipes',
    'Topology Profiles',
    'deploy/topologies/topology-profiles.json',
    'docs/deployment-topologies.md',
    'gateway-only',
    'cloud-channel-gateway',
    'full-hybrid',
    'Deployment Repository Strategy',
    'tmp/local deployment repo',
    'Private/downstream deployment repo',
    'redacted evidence',
    'deploy/kubernetes/',
    'VPS/local Compose',
    'cloud.publicBranding',
    'cloudDesktop',
    'gateway.providers',
    'docs/gateway-appliance.md',
    'docker-compose.gateway-remote.yml',
    'OPEN_COWORK_GATEWAY_PRODUCT_MODE=cloud_channel',
    'OPEN_COWORK_CONFIG_PATH',
    'cloud.billing.provider',
    'OPEN_COWORK_CLOUD_IMAGE',
    'OPEN_COWORK_GCP_REDACT_OUTPUT=true',
    'OPEN_COWORK_GCP_SQL_INSTANCE',
    'OPEN_COWORK_GCP_SKIP_RESTORE_SMOKE',
    'image.tag=latest',
    'HPA or KEDA',
    'PodDisruptionBudgets',
    'topology spread',
    'cloud.objectStore.kind',
    'deploy/managed-workers/',
  ]) {
    if (!deployReadme.includes(phrase)) {
      throw new Error(`deploy/README.md must include ${phrase}`)
    }
  }

  const managedWorkers = read('deploy/managed-workers/README.md')
  for (const phrase of [
    'Supported Modes',
    '`self_hosted`',
    '`saas_operated`',
    '`customer_hosted`',
    'Bootstrap Sequence',
    'Update And Rollback Policy',
    'Emergency revoke',
    'Sizing Guidance',
    'OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS',
    'pnpm ops:validate',
  ]) {
    if (!managedWorkers.includes(phrase)) {
      throw new Error(`deploy/managed-workers/README.md must include ${phrase}`)
    }
  }

  for (const path of [
    'deploy/managed-workers/self-host-worker.env.example',
    'deploy/managed-workers/managed-operator-worker.env.template',
  ]) {
    const template = read(path)
    for (const phrase of [
      'OPEN_COWORK_CLOUD_ROLE=worker',
      'OPEN_COWORK_CLOUD_WORKER_ID',
      'OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS',
      'OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED',
    ]) {
      if (!template.includes(phrase)) {
        throw new Error(`${path} must include ${phrase}`)
      }
    }
  }
  const workerHelm = read('deploy/managed-workers/helm-values.worker-pool.yaml.example')
  for (const phrase of [
    'worker:',
    'enabled: true',
    'replicas: 2',
    'shutdownGraceMs: 300000',
    'terminationGracePeriodSeconds: 300',
    'checkpointsEnabled: true',
    'maxUnavailable: 0',
    'maxSurge: 1',
    'podDisruptionBudget:',
    'topologySpreadConstraints:',
  ]) {
    if (!workerHelm.includes(phrase)) {
      throw new Error(`deploy/managed-workers/helm-values.worker-pool.yaml.example must include ${phrase}`)
    }
  }

  for (const path of [
    'deploy/managed-workers/worker-release-evidence.template.md',
    'deploy/managed-workers/worker-restore-drill.template.md',
  ]) {
    const template = read(path).toLowerCase()
    for (const phrase of [
      'do not',
      'worker',
      'checkpoint',
      'byok',
      'redact',
    ]) {
      if (!template.includes(phrase)) {
        throw new Error(`${path} must include ${phrase}`)
      }
    }
  }

  const recipeChecks = {
    'deploy/aws/README.md': [
      'RDS for PostgreSQL',
      'S3',
      'Secrets Manager',
      'EKS',
      'ECS/Fargate',
      'ACCOUNT.dkr.ecr.REGION.amazonaws.com/open-cowork-cloud',
      'aws-sm://open-cowork/cloud-secret-key?region=REGION',
      'OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS',
    ],
    'deploy/azure/README.md': [
      'Azure Database for PostgreSQL',
      'Azure Blob Storage',
      'Key Vault',
      'AKS',
      'Azure Container Apps',
      'REGISTRY.azurecr.io/open-cowork-cloud',
      'azure-kv://VAULT_NAME/secrets/open-cowork-cloud-key/VERSION',
      'OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS',
    ],
    'deploy/digitalocean/README.md': [
      'Managed PostgreSQL',
      'Spaces',
      'DOKS',
      'App Platform',
      'registry.digitalocean.com/REGISTRY/open-cowork-cloud',
      'cloud.objectStore.kind=digitalocean-spaces',
      'OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS',
    ],
    'deploy/kubernetes/README.md': [
      'Generic Kubernetes Recipe',
      'provider-neutral Helm charts',
      'registry.example.com/open-cowork/open-cowork-cloud',
      'open-cowork-cloud-secrets',
      'open-cowork-gateway-secrets',
      'OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS=true',
      'OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS',
    ],
    'deploy/gateway-appliance/README.md': [
      'VPS/Local Compose Recipe',
      'docker-compose.gateway-remote.yml',
      'docker-compose.cloud-gateway.yml',
      'OPEN_COWORK_GATEWAY_PRODUCT_MODE=cloud_channel',
      'OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER=true',
    ],
  }

  for (const [path, providerPhrases] of Object.entries(recipeChecks)) {
    const recipe = read(path)
    for (const phrase of [
      'open-cowork-cloud',
      'open-cowork-gateway',
      'provider-config only',
      'pnpm deploy:validate',
      'pnpm deploy:smoke',
      'pnpm deploy:smoke:strict',
      'pnpm deploy:gateway:smoke',
      'pnpm deploy:continuation:smoke',
      ...providerPhrases,
    ]) {
      if (!recipe.includes(phrase)) {
        throw new Error(`${path} must include ${phrase}`)
      }
    }
    for (const forbidden of [
      /\b\d{12}\b/,
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    ]) {
      if (forbidden.test(recipe)) {
        throw new Error(`${path} appears to include a real provider identifier`)
      }
    }
    assertNoProviderHostedUrls(path, recipe)
  }

  for (const phrase of [
    'health_port   = 8787',
    'health_path   = "/readyz"',
    'health_port   = 8788',
    'health_path   = "/livez"',
    'OPEN_COWORK_CLOUD_LIVENESS_PORT',
    'containerPort = each.value.health_port',
    'healthCheck = {',
    'each.value.health_path',
    'for_each = var.deploy_runtime_services ? local.roles : {}',
    'resource "aws_ecs_task_definition" "migrator"',
    'apps/desktop/dist/cloud/open-cowork-cloud-migrate.mjs',
    'migrator_secret_env',
  ]) {
    assertIncludes('deploy/aws/terraform/main.tf', phrase)
  }
  assertIncludes('deploy/aws/terraform/README.md', 'OPEN_COWORK_CLOUD_LIVENESS_PORT=8788')
  assertIncludes('deploy/aws/terraform/README.md', 'deploy_runtime_services=false')

  const gatewayAppliance = read('docs/gateway-appliance.md')
  for (const phrase of [
    'Remote Cloud',
    'Local All-In-One',
    'VPS',
    'Mac mini',
    'Raspberry Pi',
    'systemd',
    'launchd',
    'Telegram',
    'OPEN_COWORK_GATEWAY_TELEGRAM_PUBLIC_URL',
    'OPEN_COWORK_GATEWAY_ADMIN_TOKEN',
    'docker-compose.gateway-remote.yml',
    'docker-compose.cloud-gateway.yml',
    'OPEN_COWORK_GATEWAY_PRODUCT_MODE=cloud_channel',
    'not an OpenCode runtime',
    'Standalone Team Gateway',
    'Gateway Provider Readiness',
    'Delivery Drain And Local State',
    'Upgrade And Rollback',
  ]) {
    if (!gatewayAppliance.includes(phrase)) {
      throw new Error(`docs/gateway-appliance.md must include ${phrase}`)
    }
  }

  const gatewayProviderReadiness = read('docs/gateway-provider-readiness.md')
  for (const phrase of [
    'Provider Readiness Matrix',
    '`telegram` | Tier 1',
    '`slack` | Tier 1',
    '`email` | Tier 1',
    '`webhook` | Tier 2',
    '`cli` | Tier 2',
    '`discord` | Tier 3',
    '`whatsapp` | Tier 3',
    '`signal` | Tier 3',
    '`fake` | Tier demo',
    'apps/channel-gateway/src/provider-readiness.ts',
    'Public webhook providers must fail closed',
    'pnpm deploy:gateway:smoke',
  ]) {
    if (!gatewayProviderReadiness.includes(phrase)) {
      throw new Error(`docs/gateway-provider-readiness.md must include ${phrase}`)
    }
  }

  const gatewaySetup = read('scripts/gateway-appliance-setup.mjs')
  for (const phrase of [
    '--mode remote',
    '--mode local',
    '--telegram-mode polling|webhook',
    'OPEN_COWORK_GATEWAY_TELEGRAM_PUBLIC_URL',
    'OPEN_COWORK_GATEWAY_TRUST_PROXY_HEADERS=false',
    'OPEN_COWORK_GATEWAY_TRUSTED_PROXY_CIDRS=',
  ]) {
    if (!gatewaySetup.includes(phrase)) {
      throw new Error(`scripts/gateway-appliance-setup.mjs must include ${phrase}`)
    }
  }

  const downstream = read('docs/downstream.md')
  for (const phrase of [
    'contractVersion: 1',
    'Downstream Contract',
    'cloud.publicBranding',
    'cloudDesktop',
    'gateway.providers',
    'OPEN_COWORK_CONFIG_PATH',
    'cloud.billing.provider=none',
    'immutable release tag or digest',
    'multi-worker Cloud requires checkpointing',
    'HPA/KEDA policy',
    'PodDisruptionBudgets',
    'topology spread constraints',
    'billing-free path',
    'Runtime profiles and policy packs',
    'Cloud Web feature modules and admin panels',
    'BYOK validation and injection hooks',
  ]) {
    if (!downstream.includes(phrase)) {
      throw new Error(`docs/downstream.md must include ${phrase}`)
    }
  }

  const downstreamContract = read('docs/downstream-contract.md')
  for (const phrase of [
    'contractVersion',
    'Version `1`',
    'Runtime config',
    'Packaging-time config',
    'Infrastructure config',
    'Private downstream config',
    'Desktop shell',
    'Cloud Web branding',
    'Gateway channels',
    'Runtime profiles and policy packs',
    'Cloud Web modules and admin panels',
    'BYOK provider validation/injection',
    'Unsupported source-patch paths',
    'Template Hygiene',
    'latest',
    'signed URL query strings',
  ]) {
    if (!downstreamContract.includes(phrase)) {
      throw new Error(`docs/downstream-contract.md must include ${phrase}`)
    }
  }

  const exampleReadme = read('examples/downstream/example-org/README.md')
  for (const phrase of ['OPEN_COWORK_CONFIG_PATH', 'contractVersion: 1', 'docs/downstream-contract.md', 'cloud.publicBranding', 'cloudDesktop', 'gateway.providers', 'immutable downstream release tag or digest', 'cloud.billing.provider=none', 'OPEN_COWORK_CLOUD_BASE_URL', 'OPEN_COWORK_GATEWAY_SERVICE_TOKEN', 'OPEN_COWORK_GATEWAY_CLOUD_REQUEST_TIMEOUT_MS']) {
    if (!exampleReadme.includes(phrase)) {
      throw new Error(`examples/downstream/example-org/README.md must include ${phrase}`)
    }
  }

  const exampleConfig = read('examples/downstream/example-org/open-cowork.config.json')
  for (const phrase of [
    '"contractVersion": 1',
    '"gateway"',
    '"productMode": "cloud_channel"',
    '"providers"',
    'OPEN_COWORK_GATEWAY_ADMIN_TOKEN',
    'OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN',
  ]) {
    if (!exampleConfig.includes(phrase)) {
      throw new Error(`examples/downstream/example-org/open-cowork.config.json must include ${phrase}`)
    }
  }
}

function validateGcpReference() {
  const requiredGcpFiles = [
    'deploy/gcp/README.md',
    'deploy/gcp/gke/values.gke.yaml.example',
    'deploy/gcp/gke/external-secret.example.yaml',
    'deploy/gcp/gke/migrate-job.example.yaml',
    'deploy/gcp/gke/managed-certificate.example.yaml',
    'deploy/gcp/cloud-run/all-in-one.service.yaml.example',
    'deploy/gcp/smoke/README.md',
    'deploy/gcp/smoke/evidence.template.json',
    'scripts/gcp-reference-preflight.mjs',
    'scripts/gcp-reference-smoke.mjs',
    'scripts/desktop-cloud-sync-smoke.mjs',
    'scripts/gateway-cloud-smoke.mjs',
    'scripts/cloud-continuation-smoke.mjs',
    'scripts/strict-deployment-smoke.mjs',
  ]
  for (const path of requiredGcpFiles) {
    if (!existsSync(path)) {
      throw new Error(`${path} is required for the GCP reference deployment`)
    }
    assertPublicTemplateSafe(path)
  }

  const gcpReadme = read('deploy/gcp/README.md')
  for (const phrase of [
    'GKE split-role',
    'Cloud SQL for PostgreSQL',
    'Cloud Storage',
    'Secret Manager',
    'iamcredentials.googleapis.com',
    'OPEN_COWORK_GCP_REGION',
    'Deployment Repository Strategy',
    'tmp/local deployment repo',
    'Private/downstream repo',
    'redacted evidence',
    'OPEN_COWORK_GCP_REDACT_OUTPUT=true',
    'OPEN_COWORK_GCP_SQL_INSTANCE',
    'OPEN_COWORK_GCP_SKIP_RESTORE_SMOKE',
    'OPEN_COWORK_GCP_ALLOW_NO_PITR',
    'pnpm deploy:gcp:preflight',
    'pnpm deploy:gcp:smoke',
    'pnpm deploy:desktop:smoke',
    'pnpm deploy:gateway:smoke',
    'pnpm deploy:continuation:smoke',
    'kubectl apply -f deploy/gcp/gke/external-secret.example.yaml',
    'kubectl apply -f deploy/gcp/gke/managed-certificate.example.yaml',
    'gke/migrate-job.example.yaml',
    '--database-roles=cloudsqlsuperuser',
    'open-cowork-cloud migrations and runtime grants applied',
    'OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS=true',
    'OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS',
    'Rollback order',
    'GCP configuration is adapter wiring only',
  ]) {
    if (!gcpReadme.includes(phrase)) {
      throw new Error(`deploy/gcp/README.md must include ${phrase}`)
    }
  }

  const migrationGateIndex = gcpReadme.indexOf('kubectl apply -f PRIVATE_DEPLOYMENT_REPO/migrate-job.yaml')
  const runtimeInstallIndex = gcpReadme.indexOf('helm upgrade --install open-cowork-cloud', migrationGateIndex)
  if (migrationGateIndex < 0 || runtimeInstallIndex <= migrationGateIndex) {
    throw new Error('deploy/gcp/README.md must run and verify the one-shot migration Job before installing long-running Helm roles')
  }

  const gkeValues = read('deploy/gcp/gke/values.gke.yaml.example')
  for (const phrase of [
    'REGION-docker.pkg.dev/PROJECT/open-cowork/open-cowork-cloud',
    'existingSecret: open-cowork-cloud-secrets',
    'deploymentTier: public_production',
    'mode: oidc',
    'publicUrl: https://cowork.example.com',
    'trustProxyHeaders: true',
    'trustedProxyCidrs:',
    '130.211.0.0/22',
    '35.191.0.0/16',
    'kind: gcs',
    'enabled: true',
    'replicas: 2',
    'checkpointsEnabled: true',
    'topologySpreadConstraints:',
    'topology.kubernetes.io/zone',
    'whenUnsatisfiable: DoNotSchedule',
    'app.kubernetes.io/name: open-cowork-cloud',
    'podDisruptionBudget:',
    'serviceAccount:',
    'iam.gke.io/gcp-service-account',
    'cloud.google.com/neg',
    'kubernetes.io/ingress.class: gce',
    'kubernetes.io/ingress.allow-http: "false"',
    'privateIp: true',
    'autoIamAuthn: true',
  ]) {
    if (!gkeValues.includes(phrase)) {
      throw new Error(`deploy/gcp/gke/values.gke.yaml.example must include ${phrase}`)
    }
  }


  const migrationJob = read('deploy/gcp/gke/migrate-job.example.yaml')
  for (const phrase of [
    'kind: ServiceAccount',
    'name: open-cowork-cloud-migrator',
    'iam.gke.io/gcp-service-account: open-cowork-cloud-migrator@PROJECT.iam.gserviceaccount.com',
    'kind: Job',
    'name: open-cowork-cloud-migrate',
    'restartPolicy: Always',
    'gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.23.0@sha256:54e23cad9aeeedbf88ab75f993146631b878035f702b31c51885a932e0c7286c',
    'REGION-docker.pkg.dev/PROJECT/open-cowork/open-cowork-cloud@sha256:REPLACE_WITH_CLOUD_DIGEST',
    '--private-ip',
    '--auto-iam-authn',
    '--run-connection-test',
    'apps/desktop/dist/cloud/open-cowork-cloud-migrate.mjs',
    'OPEN_COWORK_CLOUD_RUNTIME_DATABASE_ROLE',
    'open_cowork_runtime',
    'OPEN_COWORK_CLOUD_RUNTIME_DATABASE_PRINCIPAL',
    'open-cowork-cloud@PROJECT.iam',
  ]) {
    if (!migrationJob.includes(phrase)) {
      throw new Error(`deploy/gcp/gke/migrate-job.example.yaml must include ${phrase}`)
    }
  }
  if (/^kind: Secret$/m.test(migrationJob) || /:latest\b/.test(migrationJob)) {
    throw new Error('deploy/gcp/gke/migrate-job.example.yaml must not carry Kubernetes Secrets or mutable latest image tags')
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

  const gcpSmokeDocs = read('deploy/gcp/smoke/README.md')
  for (const phrase of [
    'evidence.template.json',
    'OPEN_COWORK_GCP_REDACT_OUTPUT=true',
    'OPEN_COWORK_GCP_SQL_INSTANCE',
    'OPEN_COWORK_GCP_SKIP_RESTORE_SMOKE',
    'point-in-time recovery',
    'OPEN_COWORK_SMOKE_ADMIN_TOKEN',
    'OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN',
    'pnpm deploy:smoke:strict',
    'worker heartbeat visibility',
    'token revocation rejection',
  ]) {
    if (!gcpSmokeDocs.includes(phrase)) {
      throw new Error(`deploy/gcp/smoke/README.md must include ${phrase}`)
    }
  }

  const gcpEvidence = read('deploy/gcp/smoke/evidence.template.json')
  for (const phrase of [
    '"redacted": true',
    '"project": "PROJECT"',
    '"region": "REGION"',
    '"activeAccount": "ACCOUNT"',
    '"bucket": "OPEN_COWORK_BUCKET"',
    '"sqlInstance": "INSTANCE"',
    '"pointInTimeRecoveryEnabled": true',
    'PRIVATE_DEPLOYMENT_REPO',
  ]) {
    if (!gcpEvidence.includes(phrase)) {
      throw new Error(`deploy/gcp/smoke/evidence.template.json must include ${phrase}`)
    }
  }

  const preflight = read('scripts/gcp-reference-preflight.mjs')
  for (const phrase of [
    'OPEN_COWORK_GCP_REDACT_OUTPUT',
    'redactGcpEvidence',
    'redactGcpText',
  ]) {
    if (!preflight.includes(phrase)) {
      throw new Error(`scripts/gcp-reference-preflight.mjs must include ${phrase}`)
    }
  }

  const gcpSmoke = read('scripts/gcp-reference-smoke.mjs')
  for (const phrase of [
    'OPEN_COWORK_GCP_REDACT_OUTPUT',
    'redactGcpEvidence',
    'redactGcpText',
    'OPEN_COWORK_GCP_SQL_INSTANCE',
    'OPEN_COWORK_GCP_SKIP_RESTORE_SMOKE',
    'OPEN_COWORK_GCP_ALLOW_NO_PITR',
    'pointInTimeRecoveryEnabled',
  ]) {
    if (!gcpSmoke.includes(phrase)) {
      throw new Error(`scripts/gcp-reference-smoke.mjs must include ${phrase}`)
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

  const continuationSmoke = read('scripts/cloud-continuation-smoke.mjs')
  for (const phrase of [
    'OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL',
    'OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN',
    'OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION',
    'CloudWorkspaceAdapter',
    'createGatewayDaemon',
    'createHeadlessAgent',
    'createChannelBinding',
    'resolveChannelIdentity',
    'bindGatewayToSession',
    'runConcurrentPromptCheck',
    'runReplayHydrationCheck',
    'readCloudSessionProjection',
    'X-Request-Id',
    'revokeIssuedTokens',
  ]) {
    if (!continuationSmoke.includes(phrase)) {
      throw new Error(`scripts/cloud-continuation-smoke.mjs must include ${phrase}`)
    }
  }

  const strictSmoke = read('scripts/strict-deployment-smoke.mjs')
  for (const phrase of [
    'OPEN_COWORK_SMOKE_ADMIN_TOKEN',
    'OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN',
    'OPEN_COWORK_DESKTOP_SMOKE_REQUIRE_REVOCATION',
    'OPEN_COWORK_GATEWAY_SMOKE_REQUIRE_MANAGED',
    'OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION',
    'cloud worker heartbeats',
    'results.tokenRevocation.rejected',
    'tokens?.revoked',
  ]) {
    if (!strictSmoke.includes(phrase)) {
      throw new Error(`scripts/strict-deployment-smoke.mjs must include ${phrase}`)
    }
  }
}

function assertNoProviderHostedUrls(path, contents) {
  const providerHostPatterns = [
    /^[a-z0-9-]+\.amazonaws\.com$/i,
    /^[a-z0-9-]+\.azurewebsites\.net$/i,
    /^[a-z0-9-]+\.ondigitalocean\.app$/i,
  ]

  for (const token of contents.split(/\s+/)) {
    const cleaned = token.replace(/^[("'`<]+|[)"'`>,.;]+$/g, '')
    if (!cleaned.startsWith('https://')) continue

    let hostname = ''
    try {
      hostname = new URL(cleaned).hostname
    } catch {
      continue
    }

    if (providerHostPatterns.some((pattern) => pattern.test(hostname))) {
      throw new Error(`${path} appears to include a real provider-hosted URL`)
    }
  }
}

function validateReleaseSupplyChain() {
  const releaseWorkflow = read('.github/workflows/release.yml')

  for (const phrase of [
    '| `cloud-gates` | CI |',
    'OpenCode portability proof',
    'Docker/Compose smoke',
    'Helm validation',
  ]) {
    assertIncludes('docs/branch-protection.md', phrase)
  }

  for (const phrase of [
    'pnpm test:cloud-continuation',
    'pnpm deploy:validate -- --require-tools',
    'pnpm deploy:launch:validate',
    'pnpm deploy:private-beta:validate',
    'pnpm ops:validate',
    'sigstore/cosign-installer',
    'anchore/sbom-action',
    'anchore/scan-action',
    'release-candidate-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${short_sha}',
    'docker buildx imagetools create',
    '--prefer-index=false',
    'Publish final OCI release tags',
    'severity-cutoff: high',
    'cosign sign --yes',
    'cosign verify',
    'actions/attest-build-provenance',
    'subject-name:',
    'subject-digest:',
    'push-to-registry: true',
    'actions/attest@',
    'sbom-path:',
    'release-oci-supply-chain',
    'dist-artifacts/release-oci-supply-chain/*',
    'open-cowork-cloud.image.sbom.cdx.json',
    'open-cowork-gateway.image.scan.grype.json',
    "jq -er '.versionTag'",
    'version_tag_digest',
  ]) {
    assertIncludes('.github/workflows/release.yml', phrase)
  }

  const scanIndex = releaseWorkflow.indexOf('name: Scan cloud image vulnerabilities')
  const attestIndex = releaseWorkflow.indexOf('name: Attest cloud image provenance')
  const finalTagIndex = releaseWorkflow.indexOf('name: Publish final OCI release tags')
  const publishJobIndex = releaseWorkflow.indexOf('\n  publish:')
  const verifyReleaseArtifactsIndex = releaseWorkflow.indexOf('name: Verify OCI supply-chain release artifacts')
  if (scanIndex < 0 || attestIndex < 0 || finalTagIndex < 0 || finalTagIndex < attestIndex || finalTagIndex < scanIndex) {
    throw new Error('release workflow must publish final OCI tags only after image scan and attestation steps')
  }
  if (publishJobIndex < 0 || verifyReleaseArtifactsIndex < 0 || finalTagIndex < publishJobIndex || finalTagIndex < verifyReleaseArtifactsIndex) {
    throw new Error('release workflow must publish final OCI tags from the final publish job after release artifact validation')
  }
  if (releaseWorkflow.includes('docker push "${image}:${GITHUB_REF_NAME}"')) {
    throw new Error('release workflow must not push final OCI release tags before supply-chain evidence succeeds')
  }
  const publishIndex = releaseWorkflow.indexOf('name: Publish GitHub Release')
  if (publishIndex < 0 || !releaseWorkflow.slice(publishIndex).includes('dist-artifacts/release-oci-supply-chain/*')) {
    throw new Error('release workflow must upload OCI supply-chain evidence files to the GitHub Release')
  }

  for (const phrase of [
    'Desktop Web Gateway continuation gates',
    'Deployment and launch readiness gates',
    'Generate cloud image SBOM',
    'Scan cloud image vulnerabilities',
    'Sign OCI image digests',
    'Attest cloud image provenance',
    'Attest cloud image SBOM',
    'Verify OCI supply-chain release artifacts',
  ]) {
    assertIncludes('.github/workflows/release.yml', phrase)
  }

  const packageJson = parseJson('package.json')
  if (!packageJson.scripts?.['deploy:load:strict']?.includes('--strict')) {
    throw new Error('package.json deploy:load:strict must run with --strict')
  }
  if (!packageJson.scripts?.['deploy:soak:strict']?.includes('--strict')) {
    throw new Error('package.json deploy:soak:strict must run with --strict')
  }
  if (packageJson.scripts?.['deploy:smoke:strict'] !== 'node scripts/strict-deployment-smoke.mjs') {
    throw new Error('package.json deploy:smoke:strict must run the strict deployment smoke wrapper')
  }

  for (const phrase of [
    'pnpm test:cloud-continuation',
    'pnpm deploy:validate -- --require-tools',
    'pnpm deploy:smoke:strict',
    'pnpm deploy:load:strict',
    'pnpm deploy:soak:strict',
    'GHCR Cloud and Gateway images have immutable digest metadata',
    'Cosign',
    'image SBOMs',
    'image vulnerability scan JSON',
    'open-cowork-cloud.image.json',
    'open-cowork-gateway.image.scan.grype.json',
    'final tags',
  ]) {
    assertIncludes('docs/release-checklist.md', phrase)
  }

  for (const phrase of [
    'Verify Cloud and Gateway images',
    'digestRef',
    'cosign verify',
    'gh attestation verify "oci://${digest_ref}"',
    '--predicate-type https://cyclonedx.org/bom',
    'open-cowork-cloud.image.sbom.cdx.json',
    'open-cowork-gateway.image.scan.grype.json',
    'final `vX.Y.Z` image tags are published only after',
    'workflow threshold',
  ]) {
    assertIncludes('docs/packaging-and-releases.md', phrase)
  }
}

validateCompose()
validateHelm()
validateTopologyProfiles()
validateHybridSecurityGates()
validateSetupHealthCenter()
validateDocs()
validateGcpReference()
validateReleaseSupplyChain()
log('deployment configuration validation passed')
