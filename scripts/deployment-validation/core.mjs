import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseYamlDocuments } from './yaml.mjs'

const requireTools =
  process.argv.includes('--require-tools') || process.env.OPEN_COWORK_DEPLOY_REQUIRE_TOOLS === 'true'
const composeFiles = [
  'docker-compose.cloud.yml',
  'docker-compose.cloud.split.yml',
  'docker-compose.cloud-gateway.yml',
]
const gatewayOnlyComposeFiles = ['docker-compose.gateway-remote.yml']
const testImageDigest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
const publicHelmImagePrerequisites = ['--set', `image.digest=${testImageDigest}`]
const typedEgressAllowlist = [
  '--set-json',
  'networkPolicy.egress.allow=[{"name":"approved-api","to":[{"ipBlock":{"cidr":"203.0.113.0/24"}}],"ports":[{"protocol":"TCP","port":443}]}]',
]
const publicHelmPrerequisites = [
  ...publicHelmImagePrerequisites,
  '--set-json',
  'networkPolicy.ingress.from=[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"ingress-nginx"}},"podSelector":{"matchLabels":{"app.kubernetes.io/name":"ingress-nginx"}}}]',
]

function log(message) {
  process.stdout.write(`[deploy-validate] ${message}\n`)
}

function commandExists(command, args = ['--version']) {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0
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
  if (result.status === 0) throw new Error(`Expected command to fail: ${command} ${args.join(' ')}`)
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (!output.includes(expectedText)) {
    throw new Error(`Expected failure to include "${expectedText}". Output:\n${output}`)
  }
}

function values(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function renderedDeploymentChecksums(label, manifest) {
  return parseYamlDocuments(manifest, label)
    .filter((object) => object?.kind === 'Deployment')
    .map((object) => {
      const metadata = values(object.metadata)
      const annotations = values(values(values(object.spec).template).metadata).annotations
      return {
        identity: `${metadata.namespace ?? 'default'}/${metadata.name ?? ''}`,
        config: annotations?.['checksum/config'],
        secret: annotations?.['checksum/secret'],
      }
    })
    .sort((left, right) => left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0)
}

function assertConfigChecksumRollsPods(label, renderBase, renderChanged) {
  const base = renderedDeploymentChecksums(`${label} base render`, renderBase)
  const changed = renderedDeploymentChecksums(`${label} changed render`, renderChanged)
  const checksumPattern = /^[a-f0-9]{64}$/
  if (base.length === 0 || base.some((entry) => !checksumPattern.test(String(entry.config ?? '')))) {
    throw new Error(`${label} deployment must include checksum/config annotations`)
  }
  if (base.some((entry) => !checksumPattern.test(String(entry.secret ?? '')))) {
    throw new Error(`${label} deployment must include checksum/secret annotations`)
  }
  if (
    base.length !== changed.length
    || base.some((entry, index) => entry.identity !== changed[index]?.identity)
  ) {
    throw new Error(`${label} rendered deployment count changed during checksum comparison`)
  }
  if (base.every((entry, index) => entry.config === changed[index]?.config)) {
    throw new Error(`${label} checksum/config must change when ConfigMap-backed values change`)
  }
}

function assertDefaultCloudHelmBrandingUsesRuntimeTheme(renderedManifest) {
  const configMaps = parseYamlDocuments(
    renderedManifest,
    'open-cowork-cloud default branding render',
  ).filter((object) => object?.kind === 'ConfigMap')
  const rawBranding = configMaps
    .map((object) => values(object.data).OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON)
    .find((value) => typeof value === 'string')
  let branding
  try {
    branding = JSON.parse(rawBranding)
  } catch {
    branding = {}
  }
  if (values(branding).productName !== 'Open Cowork Cloud') {
    throw new Error('open-cowork-cloud default public branding must preserve the product name')
  }
  if (Object.hasOwn(values(branding), 'theme')) {
    throw new Error('open-cowork-cloud default branding must inherit the shared Cloud Web theme')
  }
}

export {
  assertConfigChecksumRollsPods,
  assertDefaultCloudHelmBrandingUsesRuntimeTheme,
  commandExists,
  composeFiles,
  cpSync,
  expectFailure,
  gatewayOnlyComposeFiles,
  join,
  log,
  mkdtempSync,
  publicHelmImagePrerequisites,
  publicHelmPrerequisites,
  requireTools,
  rmSync,
  run,
  runCapture,
  spawnSync,
  tmpdir,
  typedEgressAllowlist,
}
