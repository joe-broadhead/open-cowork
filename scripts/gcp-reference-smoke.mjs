#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

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

function boolArg(argName, envName) {
  if (args.has(argName)) return true
  const value = (process.env[envName] || '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    encoding: 'utf8',
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${argv.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
  return (result.stdout || '').trim()
}

function requireGcloud() {
  const result = spawnSync('gcloud', ['--version'], { stdio: 'ignore' })
  if (result.status !== 0) {
    throw new Error('gcloud is required for GCP deployment smoke.')
  }
}

function projectArgs(project) {
  return project ? ['--project', project] : []
}

function gcsRemoveArgs(uri, project) {
  return ['storage', 'rm', uri, '--all-versions', ...projectArgs(project)]
}

function parseGcpSecretRef(ref) {
  const match = ref.match(/^gcp-sm:\/\/projects\/([^/]+)\/secrets\/([^/]+)\/versions\/([^/]+)$/)
  if (!match) {
    throw new Error('OPEN_COWORK_GCP_SECRET_REF must use gcp-sm://projects/{project}/secrets/{secret}/versions/{version}.')
  }
  return {
    project: match[1],
    secret: match[2],
    version: match[3],
  }
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
  if (normalizedKey.includes('project')) return 'PROJECT'
  if (normalizedKey.includes('bucket')) return 'OPEN_COWORK_BUCKET'
  if (normalizedKey.includes('secret')) return 'SECRET_NAME'
  if (normalizedKey.includes('version')) return 'VERSION'
  if (normalizedKey.includes('sqlinstance')) return 'INSTANCE'
  if (normalizedKey === 'key') return 'open-cowork-smoke/smoke-PLACEHOLDER.txt'
  if (normalizedKey === 'cloudurl' || normalizedKey.includes('url')) return 'https://cowork.example.com'
  return value
}

function redactGcpText(text) {
  return text
    .replace(/--project\s+\S+/g, '--project PROJECT')
    .replace(/projects\/[^/\s]+/g, 'projects/PROJECT')
    .replace(/\bproject\s+[^:\s,]+/gi, 'project PROJECT')
    .replace(/gs:\/\/[^/\s]+/g, 'gs://OPEN_COWORK_BUCKET')
    .replace(/\bbucket\s+[^:\s,]+/gi, 'bucket OPEN_COWORK_BUCKET')
    .replace(/instances describe\s+\S+/g, 'instances describe INSTANCE')
    .replace(/\bCloud SQL instance\s+\S+/g, 'Cloud SQL instance INSTANCE')
    .replace(/--secret\s+\S+/g, '--secret SECRET_NAME')
    .replace(/https:\/\/[^\s)]+/g, 'https://cowork.example.com')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'ACCOUNT')
}

function formatError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return boolArg('redacted', 'OPEN_COWORK_GCP_REDACT_OUTPUT')
    ? redactGcpText(message)
    : message
}

function runCloudSmoke() {
  if (boolArg('skip-cloud-smoke', 'OPEN_COWORK_GCP_SKIP_CLOUD_SMOKE')) return null
  const cloudUrl = argOrEnv('cloud-url', 'OPEN_COWORK_SMOKE_CLOUD_URL')
  if (!cloudUrl) {
    throw new Error('Set OPEN_COWORK_SMOKE_CLOUD_URL or pass --cloud-url for GCP smoke.')
  }
  const smokeArgs = ['scripts/smoke-deployment.mjs', '--cloud-url', cloudUrl, '--skip-gateway']
  run(process.execPath, smokeArgs, { stdio: 'inherit' })
  return { cloudUrl }
}

function runGcsSmoke(project) {
  if (boolArg('skip-object-smoke', 'OPEN_COWORK_GCP_SKIP_OBJECT_SMOKE')) return null
  const bucket = argOrEnv('bucket', 'OPEN_COWORK_GCP_BUCKET')
  if (!bucket) {
    throw new Error('Set OPEN_COWORK_GCP_BUCKET or pass --bucket for object-store smoke.')
  }
  const prefix = (argOrEnv('prefix', 'OPEN_COWORK_GCP_SMOKE_PREFIX') || 'open-cowork-smoke')
    .replace(/^\/+|\/+$/g, '')
  const key = `${prefix}/smoke-${Date.now()}-${randomBytes(8).toString('hex')}.txt`
  const uri = `gs://${bucket}/${key}`
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-gcp-smoke-'))
  const input = join(tempRoot, 'input.txt')
  const output = join(tempRoot, 'output.txt')
  const body = `open-cowork gcp smoke ${new Date().toISOString()}\n`
  let uploaded = false
  try {
    writeFileSync(input, body)
    run('gcloud', ['storage', 'cp', input, uri, ...projectArgs(project)])
    uploaded = true
    run('gcloud', ['storage', 'cp', uri, output, ...projectArgs(project)])
    const roundTrip = readFileSync(output, 'utf8')
    if (roundTrip !== body) {
      throw new Error('GCS object-store smoke round trip did not match.')
    }
    run('gcloud', gcsRemoveArgs(uri, project))
    uploaded = false
    return { bucket, key }
  } finally {
    if (uploaded) {
      spawnSync('gcloud', gcsRemoveArgs(uri, project), { stdio: 'ignore' })
    }
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function runSecretSmoke(project) {
  if (boolArg('skip-secret-smoke', 'OPEN_COWORK_GCP_SKIP_SECRET_SMOKE')) return null
  const ref = argOrEnv('secret-ref', 'OPEN_COWORK_GCP_SECRET_REF')
  if (!ref) {
    throw new Error('Set OPEN_COWORK_GCP_SECRET_REF or pass --secret-ref for Secret Manager smoke.')
  }
  const parsed = parseGcpSecretRef(ref)
  const value = run('gcloud', [
    'secrets',
    'versions',
    'access',
    parsed.version,
    '--secret',
    parsed.secret,
    '--project',
    parsed.project || project,
  ])
  if (!value) {
    throw new Error('Secret Manager smoke returned an empty secret value.')
  }
  return {
    project: parsed.project,
    secret: parsed.secret,
    version: parsed.version,
    resolved: true,
  }
}

function runRestoreReadinessSmoke(project) {
  if (boolArg('skip-restore-smoke', 'OPEN_COWORK_GCP_SKIP_RESTORE_SMOKE')) return null
  const sqlInstance = argOrEnv('sql-instance', 'OPEN_COWORK_GCP_SQL_INSTANCE')
  if (!sqlInstance) {
    throw new Error('Set OPEN_COWORK_GCP_SQL_INSTANCE or pass --sql-instance for restore-readiness smoke. Set OPEN_COWORK_GCP_SKIP_RESTORE_SMOKE=true only for pre-database surface checks.')
  }
  const raw = run('gcloud', [
    'sql',
    'instances',
    'describe',
    sqlInstance,
    ...projectArgs(project),
    '--format=json(settings.backupConfiguration.enabled,settings.backupConfiguration.pointInTimeRecoveryEnabled)',
  ])
  const parsed = raw ? JSON.parse(raw) : {}
  const backupConfiguration = parsed?.settings?.backupConfiguration || {}
  if (backupConfiguration.enabled !== true) {
    throw new Error(`Cloud SQL instance ${sqlInstance} must have automated backups enabled before production smoke passes.`)
  }
  const pointInTimeRecoveryEnabled = backupConfiguration.pointInTimeRecoveryEnabled === true
  if (!pointInTimeRecoveryEnabled && !boolArg('allow-no-pitr', 'OPEN_COWORK_GCP_ALLOW_NO_PITR')) {
    throw new Error(`Cloud SQL instance ${sqlInstance} must have point-in-time recovery enabled, or set OPEN_COWORK_GCP_ALLOW_NO_PITR=true for a non-production exception.`)
  }
  return {
    sqlInstance,
    backupsEnabled: true,
    pointInTimeRecoveryEnabled,
  }
}

function main() {
  requireGcloud()
  const project = argOrEnv('project', 'OPEN_COWORK_GCP_PROJECT')
    || run('gcloud', ['config', 'get-value', 'project']).replace(/\r?\n/g, '').trim()
  if (!project || project === '(unset)') {
    throw new Error('Set OPEN_COWORK_GCP_PROJECT or configure gcloud project.')
  }
  const results = {
    cloud: runCloudSmoke(),
    objectStore: runGcsSmoke(project),
    secretManager: runSecretSmoke(project),
    restoreReadiness: runRestoreReadinessSmoke(project),
  }
  const report = { ok: true, project, results }
  const output = boolArg('redacted', 'OPEN_COWORK_GCP_REDACT_OUTPUT')
    ? { redacted: true, ...redactGcpEvidence(report) }
    : { redacted: false, ...report }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`[gcp-smoke] ${formatError(error)}\n`)
  process.exit(1)
}
