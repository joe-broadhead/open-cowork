#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  return args.has(argName) || process.env[envName] === 'true'
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
  const key = `${prefix}/smoke-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
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
  }
  process.stdout.write(`${JSON.stringify({ ok: true, project, results }, null, 2)}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`[gcp-smoke] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
