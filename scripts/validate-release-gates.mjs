#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'

const branchProtectionPath = 'docs/branch-protection.md'
const releaseChecklistPath = 'docs/release-checklist.md'
const packagingDocsPath = 'docs/packaging-and-releases.md'
const ciWorkflowPath = '.github/workflows/ci.yml'
const releaseWorkflowPath = '.github/workflows/release.yml'
const codeqlWorkflowPath = '.github/workflows/codeql.yml'
const goNoGoTemplatePath = 'deploy/private-beta/go-no-go-report.template.md'
const privateGoNoGoSummaryPath = 'deploy/private-beta/private-beta-go-no-go.public.md'
const launchEvidenceTemplatePath = 'deploy/private-beta/launch-evidence-record.template.json'
const launchEvidenceMatrixPath = 'deploy/load/launch-evidence-matrix.json'
const packagePath = 'package.json'

const recursivePrivateValueScanDirs = [
  'deploy',
  'docs',
  'helm',
  'examples',
]

const privateValueScanRootFilePatterns = [
  /^docker-compose.*\.ya?ml$/,
  /^.+\.example(?:\..+)?$/,
  /^.+\.template(?:\..+)?$/,
]

const privateValueScanExtensions = new Set([
  '.conf',
  '.css',
  '.env',
  '.example',
  '.js',
  '.json',
  '.md',
  '.plist',
  '.service',
  '.template',
  '.toml',
  '.txt',
  '.yaml',
  '.yml',
])

const privateValueScanSkippedPrefixes = [
  'docs/assets/auto/',
  'docs/javascripts/vendor/',
]

const requiredBranchChecks = [
  { check: 'validate', workflow: 'CI' },
  { check: 'cloud-gates', workflow: 'CI' },
  { check: 'macos-build', workflow: 'CI' },
  { check: 'linux-package', workflow: 'CI' },
  { check: 'docs', workflow: 'CI' },
  { check: 'coverage', workflow: 'CI' },
  { check: 'analyze (javascript-typescript)', workflow: 'CodeQL' },
]

const publicSafeFiles = [
  branchProtectionPath,
  releaseChecklistPath,
  packagingDocsPath,
  'docs/deployment-readiness.md',
  'docker-compose.cloud.yml',
  'docker-compose.cloud.split.yml',
  'docker-compose.cloud-gateway.yml',
  'docker-compose.gateway-remote.yml',
  'helm/open-cowork-cloud/values.yaml',
  'helm/open-cowork-gateway/values.yaml',
  'deploy/README.md',
  'deploy/aws/README.md',
  'deploy/azure/README.md',
  'deploy/digitalocean/README.md',
  'deploy/gcp/README.md',
  'deploy/gcp/cloud-run/all-in-one.service.yaml.example',
  'deploy/gcp/gke/external-secret.example.yaml',
  'deploy/gcp/gke/managed-certificate.example.yaml',
  'deploy/gcp/gke/values.gke.yaml.example',
  'deploy/gcp/smoke/README.md',
  'deploy/gcp/smoke/evidence.template.json',
  'deploy/gateway-appliance/README.md',
  'deploy/gateway-appliance/local-all-in-one.env.example',
  'deploy/gateway-appliance/remote-cloud.env.example',
  'deploy/gateway-appliance/reverse-proxy/Caddyfile.example',
  'deploy/kubernetes/README.md',
  'deploy/managed-workers/helm-values.worker-pool.yaml.example',
  'deploy/managed-workers/managed-operator-worker.env.template',
  'deploy/managed-workers/self-host-worker.env.example',
  'deploy/observability/managed-worker-slo-template.json',
  'deploy/private-beta/design-partner-onboarding.template.md',
  'deploy/private-beta/hosted-byok.config.example.json',
  'deploy/private-beta/self-host-oss.config.example.json',
  'deploy/private-beta/private-beta-plans.json',
  'deploy/topologies/README.md',
  'deploy/topologies/topology-profiles.json',
  'examples/downstream/example-org/README.md',
  'examples/downstream/example-org/open-cowork.config.json',
  'examples/downstream/example-org/cloud-values.yaml',
  'examples/downstream/example-org/gateway-values.yaml',
  goNoGoTemplatePath,
  privateGoNoGoSummaryPath,
  launchEvidenceTemplatePath,
  launchEvidenceMatrixPath,
  'deploy/private-beta/README.md',
  'deploy/private-beta/private-beta-launch-profile.template.json',
  'deploy/private-beta/managed-byok-readiness-contract.template.json',
  'deploy/managed-workers/worker-release-evidence.template.md',
  'deploy/managed-workers/worker-restore-drill.template.md',
  'docs/runbooks/launch-readiness-report.md',
  'docs/runbooks/launch-readiness.md',
]

function read(path) {
  return readFileSync(path, 'utf8')
}

function readJson(path) {
  return JSON.parse(read(path))
}

function assertFile(path) {
  if (!existsSync(path)) throw new Error(`${path} is required`)
}

function assertIncludes(path, text) {
  const contents = read(path)
  if (!contents.includes(text)) throw new Error(`${path} must include ${text}`)
}

function assertNotIncludes(path, text) {
  const contents = read(path)
  if (contents.includes(text)) throw new Error(`${path} must not include ${text}`)
}

function assertMatches(path, pattern, label = String(pattern)) {
  const contents = read(path)
  if (!pattern.test(contents)) throw new Error(`${path} must match ${label}`)
}

function assertOrder(path, labels) {
  const contents = read(path)
  let previousIndex = -1
  for (const label of labels) {
    const index = contents.indexOf(label)
    if (index < 0) throw new Error(`${path} must include ordered marker ${label}`)
    if (index <= previousIndex) {
      throw new Error(`${path} must keep ${label} after ${labels[labels.indexOf(label) - 1]}`)
    }
    previousIndex = index
  }
}

function assertExactArray(label, actual, expected) {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  if (actualText !== expectedText) {
    throw new Error(`${label} mismatch.\nExpected: ${expectedText}\nActual:   ${actualText}`)
  }
}

function extractBranchProtectionRows() {
  return read(branchProtectionPath)
    .split('\n')
    .map((line) => {
      const match = /^\| `([^`]+)` \| ([^|]+) \|/.exec(line)
      if (!match) return null
      return { check: match[1], workflow: match[2].trim() }
    })
    .filter(Boolean)
}

function assertPublicSafe(path) {
  const contents = read(path)
  const forbiddenStrings = ['/Users/joe']
  const forbiddenPatterns = [
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bghp_[A-Za-z0-9_]{20,}\b/,
    /\bsk-[A-Za-z0-9]{20,}\b/,
    /\bxoxb-[A-Za-z0-9-]{20,}\b/,
    /\bAIza[0-9A-Za-z_-]{20,}\b/,
    /\b(?:price|prod|acct|cus|sub)_[0-9A-Za-z]{8,}\b/,
    /\b\d{12}\b/,
    /[?&](?:X-Amz-Signature|X-Amz-Credential|X-Goog-Signature|X-Goog-Credential|AWSAccessKeyId|sig|signature)=/i,
    /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
  ]
  for (const marker of forbiddenStrings) {
    if (contents.includes(marker)) throw new Error(`${path} must not include private marker ${marker}`)
  }
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(contents)) throw new Error(`${path} appears to contain private material matching ${pattern}`)
  }
  assertNoPrivateEnvAssignments(path, contents)
}

function assertNoPrivateEnvAssignments(path, contents) {
  const assignmentPattern = /^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|DATABASE_URL|PRIVATE_KEY|ACCESS_KEY|API_KEY)[A-Z0-9_]*)[ \t]*[:=][ \t]*([^#\n`\\]*)/gm
  for (const match of contents.matchAll(assignmentPattern)) {
    const [, envName, rawValue] = match
    const value = rawValue.trim().replace(/^['"]|['"]$/g, '')
    if (!isPublicPlaceholderValue(value)) {
      throw new Error(`${path} must not assign a private value to ${envName}`)
    }
  }
}

function isPublicPlaceholderValue(value) {
  if (!value || value === '...' || value === 'PROJECT') return true
  if (value.startsWith('${') || value.startsWith('{{') || value.startsWith('<')) return true
  if (value.startsWith('env:') || value.includes('...') || value.includes('PROJECT')) return true
  if (value.toLowerCase().includes('redacted')) return true
  return [
    'DATABASE_HOST',
    'PASSWORD',
    'REGION',
    'REPLACE',
    'USER',
    'change-me',
    'example.',
    'localhost',
    'local_dev',
    'open_cowork',
    'replace-with',
  ].some((placeholder) => value.includes(placeholder))
}

function normalizedRelative(path) {
  return path.split('\\').join('/')
}

function shouldSkipPrivateValueScan(path) {
  const normalized = normalizedRelative(path)
  return privateValueScanSkippedPrefixes.some((prefix) => normalized.startsWith(prefix))
}

function shouldScanPublicFile(path) {
  const normalized = normalizedRelative(path)
  if (shouldSkipPrivateValueScan(normalized)) return false
  const fileName = basename(normalized)
  if (privateValueScanRootFilePatterns.some((pattern) => pattern.test(fileName))) return true
  return privateValueScanExtensions.has(extname(fileName))
}

function collectPrivateValueScanFiles() {
  const files = new Set(publicSafeFiles)
  for (const entry of readdirSync('.')) {
    if (privateValueScanRootFilePatterns.some((pattern) => pattern.test(entry)) && statSync(entry).isFile()) {
      files.add(entry)
    }
  }
  for (const dir of recursivePrivateValueScanDirs) {
    if (!existsSync(dir)) continue
    collectPrivateValueScanFilesFromDir(dir, files)
  }
  return Array.from(files).sort()
}

function collectPrivateValueScanFilesFromDir(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const normalized = normalizedRelative(path)
    if (shouldSkipPrivateValueScan(normalized)) continue
    if (entry.isDirectory()) {
      collectPrivateValueScanFilesFromDir(path, files)
    } else if (entry.isFile() && shouldScanPublicFile(normalized)) {
      files.add(normalized)
    }
  }
}

function assertWorkflowJob(path, jobName) {
  assertMatches(path, new RegExp(`\\n  ${jobName}:\\n`), `job ${jobName}`)
}

function assertPackageScripts() {
  const packageJson = readJson(packagePath)
  if (packageJson.scripts?.['release:gates:validate'] !== 'node scripts/validate-release-gates.mjs') {
    throw new Error('package.json must expose release:gates:validate')
  }
  if (packageJson.scripts?.['ops:validate'] !== 'node scripts/validate-ops-readiness.mjs && node scripts/validate-release-gates.mjs') {
    throw new Error('package.json ops:validate must run operations and release-gate validators')
  }
  if (packageJson.scripts?.['deploy:standalone-gateway:validate'] !== 'node scripts/validate-standalone-gateway.mjs') {
    throw new Error('package.json must expose deploy:standalone-gateway:validate')
  }
  if (packageJson.scripts?.['deploy:launch:evidence:validate'] !== 'node scripts/validate-launch-evidence-manifest.mjs') {
    throw new Error('package.json must expose deploy:launch:evidence:validate')
  }
}

function assertBranchProtectionContract() {
  const rows = extractBranchProtectionRows()
  assertExactArray('branch protection required checks', rows, requiredBranchChecks)
  for (const { check, workflow } of requiredBranchChecks) {
    if (workflow === 'CI') assertWorkflowJob(ciWorkflowPath, check)
    else if (workflow === 'CodeQL') assertWorkflowJob(codeqlWorkflowPath, 'analyze')
  }
  assertIncludes(codeqlWorkflowPath, 'language: [javascript-typescript]')
  assertIncludes(codeqlWorkflowPath, 'wait-for-processing: ${{ github.event.repository.private == false }}')
}

function assertCiContract() {
  for (const job of ['validate', 'cloud-gates', 'macos-build', 'linux-package', 'docs', 'coverage']) {
    assertWorkflowJob(ciWorkflowPath, job)
  }
  for (const command of [
    'pnpm lint',
    'pnpm test',
    'pnpm test:cloud-web',
    'pnpm test:renderer',
    'pnpm typecheck',
    'pnpm perf:check',
    'pnpm build',
    'pnpm proof:cloud:opencode-portability --json',
    'pnpm test:cloud-continuation',
    'node --no-warnings --experimental-strip-types --test tests/cloud-postgres-concurrency.test.ts',
    'docker build -f docker/open-cowork-cloud/Dockerfile',
    'docker build -f docker/open-cowork-gateway/Dockerfile',
    'bash scripts/ci-cloud-compose-smoke.sh docker-compose.cloud.split.yml',
    'pnpm deploy:validate -- --require-tools',
    'pnpm deploy:launch:validate',
    'pnpm deploy:launch:evidence:validate',
    'pnpm deploy:private-beta:validate',
    'pnpm deploy:standalone-gateway:validate',
    'pnpm ops:validate',
    'pnpm docs:build',
    'pnpm --dir apps/desktop test:e2e:packaged',
  ]) {
    assertIncludes(ciWorkflowPath, command)
  }
  assertIncludes(ciWorkflowPath, 'OPEN_COWORK_PACKAGED_EXECUTABLE: ${{ steps.packaged-executable.outputs.path }}')
  assertIncludes(ciWorkflowPath, 'OPEN_COWORK_PACKAGED_EXECUTABLE: ${{ steps.linux-packaged-executable.outputs.path }}')
}

function assertReleaseWorkflowContract() {
  for (const command of [
    'pnpm test:cloud-web',
    'pnpm test:cloud-continuation',
    'pnpm test:renderer',
    'pnpm perf:check',
    'pnpm docs:build',
    'pnpm deploy:validate -- --require-tools',
    'pnpm deploy:launch:validate',
    'pnpm deploy:launch:evidence:validate',
    'pnpm deploy:private-beta:validate',
    'pnpm deploy:standalone-gateway:validate',
    'pnpm ops:validate',
    'pnpm --dir apps/desktop test:e2e:packaged',
    'node scripts/verify-release-tag-signature.mjs',
  ]) {
    assertIncludes(releaseWorkflowPath, command)
  }

  assertOrder(releaseWorkflowPath, [
    'Build and publish cloud OCI staging image',
    'Build and publish gateway OCI staging image',
    'Generate cloud image SBOM',
    'Generate gateway image SBOM',
    'Scan cloud image vulnerabilities',
    'Scan gateway image vulnerabilities',
    'Sign OCI image digests',
    'Attest cloud image provenance',
    'Attest gateway image provenance',
    'Attest cloud image SBOM',
    'Attest gateway image SBOM',
    'Publish final OCI release tags',
    'Verify OCI supply-chain evidence',
    'Upload OCI supply-chain artifacts',
  ])

  for (const evidence of [
    'open-cowork-cloud.image.json',
    'open-cowork-cloud.image.sbom.cdx.json',
    'open-cowork-cloud.image.scan.grype.json',
    'open-cowork-cloud.image.cosign-verify.json',
    'open-cowork-gateway.image.json',
    'open-cowork-gateway.image.sbom.cdx.json',
    'open-cowork-gateway.image.scan.grype.json',
    'open-cowork-gateway.image.cosign-verify.json',
    'release-oci-supply-chain',
    'dist-artifacts/sbom.cdx.json',
    'dist-artifacts/sbom.spdx.json',
    'dist-artifacts/SHA256SUMS.txt',
    'dist-artifacts/SHA256SUMS.txt.asc',
    'actions/attest-build-provenance',
  ]) {
    assertIncludes(releaseWorkflowPath, evidence)
  }

  assertIncludes(releaseWorkflowPath, 'needs.release-policy.result == \'success\'')
  assertIncludes(releaseWorkflowPath, 'publish-oci-images')
  assertIncludes(releaseWorkflowPath, 'OPEN_COWORK_PACKAGED_EXECUTABLE: ${{ steps.packaged-executable.outputs.path }}')
  assertNotIncludes(releaseWorkflowPath, 'test:e2e:packaged:optional')
}

function assertReleaseChecklistContract() {
  for (const phrase of [
    '## Release Claim Levels',
    '`local-self-host-beta`',
    '`private-hosted-beta`',
    '`public-beta`',
    '`enterprise-ready`',
    'Protected CI gates plus supply-chain artifacts',
    'load/soak',
    'restore drill',
    'worker failover',
    'BYOK redaction',
    'Gateway replay/dead-letter recovery',
    'private-value scan',
    '--require-private-pass',
    'Go/No-Go',
  ]) {
    assertIncludes(releaseChecklistPath, phrase)
  }
}

function assertGoNoGoTemplateContract() {
  for (const phrase of [
    'Exact command output artifact',
    'Immutable artifact link',
    'immutable artifact id',
    'SHA256',
    'GitHub Actions run URL',
    'GHCR digest URL',
    'Cosign verification artifact',
    'SLSA provenance attestation',
    'SBOM attestation',
    'public template private-value scan',
  ]) {
    assertIncludes(goNoGoTemplatePath, phrase)
  }
}

for (const path of [
  branchProtectionPath,
  releaseChecklistPath,
  packagingDocsPath,
  ciWorkflowPath,
  releaseWorkflowPath,
  codeqlWorkflowPath,
  goNoGoTemplatePath,
  privateGoNoGoSummaryPath,
  launchEvidenceTemplatePath,
  launchEvidenceMatrixPath,
  packagePath,
]) {
  assertFile(path)
}

assertPackageScripts()
assertBranchProtectionContract()
assertCiContract()
assertReleaseWorkflowContract()
assertReleaseChecklistContract()
assertGoNoGoTemplateContract()
for (const path of collectPrivateValueScanFiles()) {
  if (relative('.', path).startsWith('..')) throw new Error(`private-value scan path escaped repository root: ${path}`)
  assertPublicSafe(path)
}

process.stdout.write('[release-gates-validate] release gate contract validated\n')
