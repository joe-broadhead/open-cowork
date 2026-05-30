#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const baseRequiredApis = [
  'artifactregistry.googleapis.com',
  'compute.googleapis.com',
  'container.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'logging.googleapis.com',
  'monitoring.googleapis.com',
  'secretmanager.googleapis.com',
  'sqladmin.googleapis.com',
  'storage.googleapis.com',
]

const optionalApis = [
  {
    api: 'cloudkms.googleapis.com',
    enabledBy: 'OPEN_COWORK_GCP_REQUIRE_KMS',
  },
  {
    api: 'run.googleapis.com',
    enabledBy: 'OPEN_COWORK_GCP_REQUIRE_CLOUD_RUN or OPEN_COWORK_GCP_CLOUD_RUN_SERVICE',
  },
]

const requiredFiles = [
  'deploy/gcp/README.md',
  'deploy/gcp/gke/values.gke.yaml.example',
  'deploy/gcp/gke/external-secret.example.yaml',
  'deploy/gcp/gke/managed-certificate.example.yaml',
  'deploy/gcp/cloud-run/all-in-one.service.yaml.example',
  'deploy/gcp/smoke/README.md',
]

const args = parseArgs(process.argv.slice(2))

function parseArgs(argv) {
  const parsed = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      parsed.set(key, 'true')
    } else {
      parsed.set(key, next)
      index += 1
    }
  }
  return parsed
}

function argOrEnv(argName, envName) {
  return args.get(argName) || process.env[envName] || ''
}

function truthyArgOrEnv(argName, envName) {
  const value = argOrEnv(argName, envName).trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

function runGcloud(args, options = {}) {
  const result = spawnSync('gcloud', args, {
    encoding: 'utf8',
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`gcloud ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
  return (result.stdout || '').trim()
}

function gcloudValue(args) {
  try {
    return runGcloud(args).replace(/\r?\n/g, '').trim()
  } catch {
    return ''
  }
}

function requireGcloud() {
  const result = spawnSync('gcloud', ['--version'], { stdio: 'ignore' })
  if (result.status !== 0) {
    throw new Error('gcloud is required for GCP deployment preflight.')
  }
}

function ensureFiles() {
  const missing = requiredFiles.filter((file) => !existsSync(file))
  if (missing.length > 0) {
    throw new Error(`Missing GCP reference files: ${missing.join(', ')}`)
  }
  return requiredFiles
}

function enabledApis(project) {
  const output = runGcloud([
    'services',
    'list',
    '--enabled',
    '--project',
    project,
    '--format=value(config.name)',
  ])
  return new Set(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
}

function maybeCheckCloudRunService(project, region, serviceName) {
  if (!serviceName) return null
  const url = runGcloud([
    'run',
    'services',
    'describe',
    serviceName,
    '--project',
    project,
    '--region',
    region,
    '--format=value(status.url)',
  ])
  if (!url) {
    throw new Error(`Cloud Run service ${serviceName} did not return a status URL in project ${project}, region ${region}.`)
  }
  return { serviceName, url: url || null }
}

function main() {
  requireGcloud()
  const account = runGcloud(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'])
  if (!account) throw new Error('No active gcloud account is configured.')

  const project = argOrEnv('project', 'OPEN_COWORK_GCP_PROJECT')
    || gcloudValue(['config', 'get-value', 'project'])
  if (!project || project === '(unset)') {
    throw new Error('Set OPEN_COWORK_GCP_PROJECT or configure gcloud project.')
  }

  const region = argOrEnv('region', 'OPEN_COWORK_GCP_REGION')
    || gcloudValue(['config', 'get-value', 'run/region'])
    || gcloudValue(['config', 'get-value', 'compute/region'])
  if (!region || region === '(unset)') {
    throw new Error('Set OPEN_COWORK_GCP_REGION or configure gcloud run/region.')
  }

  const files = ensureFiles()
  const cloudRunServiceName = argOrEnv('cloud-run-service', 'OPEN_COWORK_GCP_CLOUD_RUN_SERVICE')
  const requiredApis = [
    ...baseRequiredApis,
    ...(truthyArgOrEnv('require-kms', 'OPEN_COWORK_GCP_REQUIRE_KMS') ? ['cloudkms.googleapis.com'] : []),
    ...(truthyArgOrEnv('require-cloud-run', 'OPEN_COWORK_GCP_REQUIRE_CLOUD_RUN') || cloudRunServiceName
      ? ['run.googleapis.com']
      : []),
  ]
  const enabled = enabledApis(project)
  const missingApis = requiredApis.filter((api) => !enabled.has(api))
  if (missingApis.length > 0) {
    throw new Error([
      `Missing required GCP APIs for project ${project}: ${missingApis.join(', ')}`,
      `Enable them with: gcloud services enable ${missingApis.join(' ')} --project ${project}`,
    ].join('\n'))
  }

  const cloudRun = maybeCheckCloudRunService(
    project,
    region,
    cloudRunServiceName,
  )

  process.stdout.write(`${JSON.stringify({
    ok: true,
    project,
    region,
    activeAccount: account.split(/\r?\n/)[0],
    requiredApis,
    optionalApis,
    referenceFiles: files,
    cloudRun,
  }, null, 2)}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`[gcp-preflight] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
