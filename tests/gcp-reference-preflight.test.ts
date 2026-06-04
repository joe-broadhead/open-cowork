import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const project = 'real-project-123'
const gsaEmail = `open-cowork-cloud@${project}.iam.gserviceaccount.com`
const workloadIdentityMember = `serviceAccount:${project}.svc.id.goog[open-cowork/open-cowork-cloud]`
const requiredApis = [
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

function stubGcloudSource() {
  return `#!/usr/bin/env node
const args = process.argv.slice(2)
const project = ${JSON.stringify(project)}
const gsaEmail = ${JSON.stringify(gsaEmail)}
const workloadIdentityMember = ${JSON.stringify(workloadIdentityMember)}
const requiredApis = ${JSON.stringify(requiredApis)}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value))
}

if (args[0] === '--version') {
  process.stdout.write('Google Cloud SDK 999.0.0\\n')
} else if (args.join(' ') === 'auth list --filter=status:ACTIVE --format=value(account)') {
  process.stdout.write('operator@example.com\\n')
} else if (args[0] === 'services' && args[1] === 'list') {
  process.stdout.write(requiredApis.join('\\n') + '\\n')
} else if (args[0] === 'iam' && args[1] === 'service-accounts' && args[2] === 'describe') {
  process.stdout.write(gsaEmail + '\\n')
} else if (args[0] === 'iam' && args[1] === 'service-accounts' && args[2] === 'get-iam-policy') {
  writeJson({
    bindings: [
      {
        role: 'roles/iam.workloadIdentityUser',
        members: [workloadIdentityMember],
      },
    ],
  })
} else if (args[0] === 'storage' && args[1] === 'buckets' && args[2] === 'describe') {
  writeJson({
    location: 'US-CENTRAL1',
    versioning: { enabled: true },
  })
} else if (args[0] === 'projects' && args[1] === 'get-iam-policy') {
  if (process.env.STUB_GCLOUD_FAIL_PROJECT_POLICY === 'true') {
    process.stderr.write('permission denied for gcloud projects get-iam-policy ' + project + '\\n')
    process.exit(1)
  }
  writeJson({
    bindings: [
      {
        role: 'roles/cloudsql.client',
        members: ['serviceAccount:' + gsaEmail],
      },
      {
        role: 'roles/secretmanager.secretAccessor',
        members: ['serviceAccount:' + gsaEmail],
      },
      {
        role: 'projects/' + project + '/roles/customCoworkRole',
        members: ['serviceAccount:' + gsaEmail],
      },
    ],
  })
} else {
  process.stderr.write('unexpected gcloud args: ' + args.join(' ') + '\\n')
  process.exit(1)
}
`
}

function runPreflight(extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-gcp-preflight-'))
  try {
    const gcloudPath = join(root, 'gcloud')
    writeFileSync(gcloudPath, stubGcloudSource())
    chmodSync(gcloudPath, 0o755)
    const env: Record<string, string> = {
      PATH: `${root}${delimiter}${process.env.PATH || ''}`,
      OPEN_COWORK_GCP_PROJECT: project,
      OPEN_COWORK_GCP_REGION: 'europe-west4',
      OPEN_COWORK_GCP_GSA_EMAIL: gsaEmail,
      OPEN_COWORK_GCP_REQUIRE_GKE_IAM: 'true',
      ...extraEnv,
    }
    for (const key of ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'COMSPEC', 'PATHEXT']) {
      if (process.env[key]) env[key] = process.env[key]
    }

    return spawnSync(process.execPath, ['scripts/gcp-reference-preflight.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('GCP preflight keeps the baseline Cloud SQL IAM role when overlay roles are configured', () => {
  const result = runPreflight({
    OPEN_COWORK_GCP_REQUIRED_PROJECT_ROLES: 'roles/secretmanager.secretAccessor',
  })

  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.deepEqual(parsed.gkeIam.checkedProjectRoles, [
    'roles/cloudsql.client',
    'roles/secretmanager.secretAccessor',
  ])
  assert.deepEqual(parsed.gkeIam.missingProjectRoles, [])
})

test('GCP preflight redacts positional project IDs from IAM policy command failures', () => {
  const result = runPreflight({
    OPEN_COWORK_GCP_REDACT_OUTPUT: 'true',
    STUB_GCLOUD_FAIL_PROJECT_POLICY: 'true',
  })

  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stderr, new RegExp(project))
  assert.match(result.stderr, /projects get-iam-policy PROJECT/)
})

test('GCP preflight redacts project IDs inside custom IAM role evidence', () => {
  const result = runPreflight({
    OPEN_COWORK_GCP_REDACT_OUTPUT: 'true',
    OPEN_COWORK_GCP_REQUIRED_PROJECT_ROLES: `projects/${project}/roles/customCoworkRole`,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, new RegExp(project))
  const parsed = JSON.parse(result.stdout)
  assert.deepEqual(parsed.gkeIam.checkedProjectRoles, [
    'roles/cloudsql.client',
    'projects/PROJECT/roles/customCoworkRole',
  ])
})

test('GCP preflight redacts organization IDs inside custom IAM role errors', () => {
  const result = runPreflight({
    OPEN_COWORK_GCP_REDACT_OUTPUT: 'true',
    OPEN_COWORK_GCP_REQUIRED_PROJECT_ROLES: 'organizations/123456789/roles/customOrgRole',
  })

  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stderr, /123456789/)
  assert.match(result.stderr, /organizations\/ORG\/roles\/customOrgRole/)
})

test('GCP preflight redacts bucket locations from successful evidence', () => {
  const result = runPreflight({
    OPEN_COWORK_GCP_BUCKET: 'real-open-cowork-bucket',
    OPEN_COWORK_GCP_REDACT_OUTPUT: 'true',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /US-CENTRAL1/)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.bucket.bucket, 'OPEN_COWORK_BUCKET')
  assert.equal(parsed.bucket.location, 'LOCATION')
})
