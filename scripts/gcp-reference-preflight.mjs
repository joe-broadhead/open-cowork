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
  'deploy/gcp/smoke/evidence.template.json',
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

function listArgOrEnv(argName, envName) {
  return argOrEnv(argName, envName)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function redactGcpEvidence(value, key = '') {
  if (Array.isArray(value)) {
    return value.map((item) => redactGcpEvidence(item, key))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactGcpEvidence(entryValue, entryKey),
      ])
    )
  }
  if (typeof value !== 'string') return value

  const normalizedKey = key.toLowerCase()
  if (normalizedKey.includes('role')) {
    return value
      .replace(/projects\/[^/\s]+\/roles\//g, 'projects/PROJECT/roles/')
      .replace(/organizations\/[^/\s]+\/roles\//g, 'organizations/ORG/roles/')
  }
  if (normalizedKey.includes('project')) return 'PROJECT'
  if (normalizedKey.includes('account')) return 'ACCOUNT'
  if (normalizedKey.includes('member')) return 'MEMBER'
  if (normalizedKey.includes('bucket')) return 'OPEN_COWORK_BUCKET'
  if (normalizedKey.includes('secret')) return 'SECRET_NAME'
  if (normalizedKey.includes('instance')) return 'INSTANCE'
  if (normalizedKey.includes('region')) return 'REGION'
  if (normalizedKey.includes('location')) return 'LOCATION'
  if (normalizedKey.includes('servicename')) return 'SERVICE'
  if (normalizedKey === 'url' || normalizedKey.includes('url')) return 'https://cowork.example.com'
  return value.replace(/\b[a-z][a-z0-9-]{4,}[a-z0-9]:[a-z][a-z0-9-]*[a-z0-9]:[a-z][a-z0-9-]*[a-z0-9]\b/gi, 'PROJECT:REGION:INSTANCE')
}

function redactGcpText(text) {
  return text
    .replace(/--project\s+\S+/g, '--project PROJECT')
    .replace(/\bprojects get-iam-policy\s+\S+/g, 'projects get-iam-policy PROJECT')
    .replace(/projects\/[^/\s]+/g, 'projects/PROJECT')
    .replace(/organizations\/[^/\s]+\/roles\//g, 'organizations/ORG/roles/')
    .replace(/projects\/PROJECT\/secrets\/[^/\s,)]+(?:\/versions\/[^/\s,)]+)?/g, 'projects/PROJECT/secrets/SECRET_NAME')
    .replace(/projects\/PROJECT\/instances\/[^/\s,)]+/g, 'projects/PROJECT/instances/INSTANCE')
    .replace(/projects\/PROJECT\/buckets\/[^/\s,)]+/g, 'projects/PROJECT/buckets/OPEN_COWORK_BUCKET')
    .replace(/\bbuckets\/[^/\s,)]+/g, 'buckets/OPEN_COWORK_BUCKET')
    .replace(/\bproject\s+[^:\s,]+/gi, 'project PROJECT')
    .replace(/--region\s+\S+/g, '--region REGION')
    .replace(/--secret\s+\S+/g, '--secret SECRET_NAME')
    .replace(/gs:\/\/[^/\s]+/g, 'gs://OPEN_COWORK_BUCKET')
    .replace(/Cloud SQL instance\s+\S+/g, 'Cloud SQL instance INSTANCE')
    .replace(/Cloud Storage bucket\s+\S+/g, 'Cloud Storage bucket OPEN_COWORK_BUCKET')
    .replace(/instances describe\s+\S+/g, 'instances describe INSTANCE')
    .replace(/secrets describe\s+\S+/g, 'secrets describe SECRET_NAME')
    .replace(/services describe\s+\S+/g, 'services describe SERVICE')
    .replace(/serviceAccount:[^\s,]+\.svc\.id\.goog\[[^\]]+\]/g, 'serviceAccount:PROJECT.svc.id.goog[NAMESPACE/KSA]')
    .replace(/\bservice\s+\S+\s+did not/gi, 'service SERVICE did not')
    .replace(/https:\/\/[^\s)]+/g, 'https://cowork.example.com')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'ACCOUNT')
}

function formatError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return truthyArgOrEnv('redacted', 'OPEN_COWORK_GCP_REDACT_OUTPUT')
    ? redactGcpText(message)
    : message
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

function gcloudJson(args) {
  const output = runGcloud([...args, '--format=json'])
  return output ? JSON.parse(output) : {}
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

function maybeCheckCloudSql(project) {
  const sqlInstance = argOrEnv('sql-instance', 'OPEN_COWORK_GCP_SQL_INSTANCE')
  if (!sqlInstance) return null
  const instance = gcloudJson([
    'sql',
    'instances',
    'describe',
    sqlInstance,
    '--project',
    project,
  ])
  const backupConfiguration = instance?.settings?.backupConfiguration || {}
  const connectionName = instance?.connectionName || ''
  if (!connectionName) {
    throw new Error(`Cloud SQL instance ${sqlInstance} did not return a connectionName.`)
  }
  if (backupConfiguration.enabled !== true) {
    throw new Error(`Cloud SQL instance ${sqlInstance} must have automated backups enabled before production preflight passes.`)
  }
  const pointInTimeRecoveryEnabled = backupConfiguration.pointInTimeRecoveryEnabled === true
  if (!pointInTimeRecoveryEnabled && !truthyArgOrEnv('allow-no-pitr', 'OPEN_COWORK_GCP_ALLOW_NO_PITR')) {
    throw new Error(`Cloud SQL instance ${sqlInstance} must have point-in-time recovery enabled, or set OPEN_COWORK_GCP_ALLOW_NO_PITR=true for a documented non-production exception.`)
  }
  return {
    sqlInstance,
    connectionName,
    backupsEnabled: true,
    pointInTimeRecoveryEnabled,
  }
}

function maybeCheckBucket(project) {
  const bucket = argOrEnv('bucket', 'OPEN_COWORK_GCP_BUCKET')
  if (!bucket) return null
  const parsed = gcloudJson([
    'storage',
    'buckets',
    'describe',
    `gs://${bucket}`,
    '--project',
    project,
  ])
  const versioningEnabled = parsed?.versioning?.enabled === true || parsed?.versioning_enabled === true
  if (!versioningEnabled && !truthyArgOrEnv('allow-unversioned-bucket', 'OPEN_COWORK_GCP_ALLOW_UNVERSIONED_BUCKET')) {
    throw new Error(`Cloud Storage bucket ${bucket} must have object versioning enabled, or set OPEN_COWORK_GCP_ALLOW_UNVERSIONED_BUCKET=true for a documented non-production exception.`)
  }
  return {
    bucket,
    location: parsed?.location || '',
    versioningEnabled,
  }
}

function maybeCheckSecrets(project) {
  const secrets = listArgOrEnv('secrets', 'OPEN_COWORK_GCP_SECRETS')
  if (secrets.length === 0) return []
  return secrets.map((secret) => {
    const parsed = gcloudJson([
      'secrets',
      'describe',
      secret,
      '--project',
      project,
    ])
    return {
      secret,
      replication: parsed?.replication ? 'configured' : 'unknown',
    }
  })
}

function normalizeServiceAccountEmail(project, value) {
  if (!value) return ''
  return value.includes('@') ? value : `${value}@${project}.iam.gserviceaccount.com`
}

function policyHasBinding(policy, role, member) {
  const bindings = Array.isArray(policy?.bindings) ? policy.bindings : []
  return bindings.some((binding) => {
    if (binding.role !== role) return false
    return Array.isArray(binding.members) && binding.members.includes(member)
  })
}

function maybeCheckGkeIam(project) {
  const requireGkeIam = truthyArgOrEnv('require-gke-iam', 'OPEN_COWORK_GCP_REQUIRE_GKE_IAM')
  const serviceAccountEmail = normalizeServiceAccountEmail(
    project,
    argOrEnv('gcp-service-account', 'OPEN_COWORK_GCP_GSA_EMAIL'),
  )
  if (!serviceAccountEmail) {
    if (requireGkeIam) {
      throw new Error('Set OPEN_COWORK_GCP_GSA_EMAIL or pass --gcp-service-account when OPEN_COWORK_GCP_REQUIRE_GKE_IAM=true.')
    }
    return null
  }

  runGcloud([
    'iam',
    'service-accounts',
    'describe',
    serviceAccountEmail,
    '--project',
    project,
    '--format=value(email)',
  ])

  const namespace = argOrEnv('ksa-namespace', 'OPEN_COWORK_GCP_KSA_NAMESPACE') || 'open-cowork'
  const ksaName = argOrEnv('ksa-name', 'OPEN_COWORK_GCP_KSA_NAME') || 'open-cowork-cloud'
  const workloadIdentityMember = `serviceAccount:${project}.svc.id.goog[${namespace}/${ksaName}]`
  const serviceAccountPolicy = gcloudJson([
    'iam',
    'service-accounts',
    'get-iam-policy',
    serviceAccountEmail,
    '--project',
    project,
  ])
  const workloadIdentityBound = policyHasBinding(
    serviceAccountPolicy,
    'roles/iam.workloadIdentityUser',
    workloadIdentityMember,
  )
  if (!workloadIdentityBound && requireGkeIam) {
    throw new Error(`GCP service account ${serviceAccountEmail} must grant roles/iam.workloadIdentityUser to ${workloadIdentityMember}.`)
  }

  const projectPolicy = gcloudJson([
    'projects',
    'get-iam-policy',
    project,
  ])
  const projectMember = `serviceAccount:${serviceAccountEmail}`
  const overlayProjectRoles = listArgOrEnv('required-project-roles', 'OPEN_COWORK_GCP_REQUIRED_PROJECT_ROLES')
  const rolesToCheck = Array.from(new Set(['roles/cloudsql.client', ...overlayProjectRoles]))
  const missingProjectRoles = rolesToCheck.filter((role) => !policyHasBinding(projectPolicy, role, projectMember))
  if (missingProjectRoles.length > 0 && requireGkeIam) {
    throw new Error(`GCP service account ${serviceAccountEmail} is missing project IAM roles: ${missingProjectRoles.join(', ')}`)
  }

  return {
    serviceAccountEmail,
    namespace,
    ksaName,
    workloadIdentityMember,
    workloadIdentityBound,
    checkedProjectRoles: rolesToCheck,
    missingProjectRoles,
  }
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
  const cloudSql = maybeCheckCloudSql(project)
  const bucket = maybeCheckBucket(project)
  const secrets = maybeCheckSecrets(project)
  const gkeIam = maybeCheckGkeIam(project)

  const report = {
    ok: true,
    project,
    region,
    activeAccount: account.split(/\r?\n/)[0],
    requiredApis,
    optionalApis,
    referenceFiles: files,
    cloudRun,
    cloudSql,
    bucket,
    secrets,
    gkeIam,
  }
  const output = truthyArgOrEnv('redacted', 'OPEN_COWORK_GCP_REDACT_OUTPUT')
    ? { redacted: true, ...redactGcpEvidence(report) }
    : { redacted: false, ...report }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`[gcp-preflight] ${formatError(error)}\n`)
  process.exit(1)
}
