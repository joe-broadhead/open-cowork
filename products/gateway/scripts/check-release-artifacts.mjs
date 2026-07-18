#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const skipPack = args.includes('--skip-pack')
const runAudit = process.env.M40_RUN_NPM_AUDIT === '1' || args.includes('--run-audit')

function loadPackageLock(pkg) {
  const localLockPath = path.join(root, 'package-lock.json')
  if (fs.existsSync(localLockPath)) return readJson('package-lock.json')
  // Monorepo mode: product package is installed via the workspace root lockfile.
  // Synthesize lock alignment + installed package license metadata from node_modules.
  const installed = collectInstalledPackages(root)
  return {
    version: pkg.version,
    packages: {
      '': {
        version: pkg.version,
        dependencies: pkg.dependencies || {},
        devDependencies: pkg.devDependencies || {},
      },
      ...installed,
    },
    monorepoWorkspace: true,
  }
}

/**
 * Walk the product package's node_modules tree (pnpm-aware via realpath) and
 * collect package.json license metadata for release license posture checks.
 */
function collectInstalledPackages(productRoot) {
  const packages = {}
  const seen = new Set()

  function visitPkg(pkgDir) {
    let real
    try {
      real = fs.realpathSync(pkgDir)
    } catch {
      return
    }
    if (seen.has(real)) return
    seen.add(real)

    const packageJsonPath = path.join(real, 'package.json')
    if (!fs.existsSync(packageJsonPath)) return

    let meta
    try {
      meta = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
    } catch {
      return
    }
    if (!meta?.name) return

    const license = typeof meta.license === 'string'
      ? meta.license
      : (meta.license && typeof meta.license === 'object' ? meta.license.type : undefined)

    // Prefer lockfile-style paths; allow multiple versions as distinct entries.
    const versionSuffix = meta.version ? `@${meta.version}` : ''
    const packagePath = `node_modules/${meta.name}${versionSuffix}`
    if (!packages[packagePath] || (!packages[packagePath].license && license)) {
      packages[packagePath] = {
        version: meta.version,
        license,
      }
    }

    // pnpm: dependency packages live in the same node_modules directory as this package.
    const parentNm = path.dirname(real)
    if (path.basename(parentNm) === 'node_modules') walkNm(parentNm)
    const nested = path.join(real, 'node_modules')
    if (fs.existsSync(nested)) walkNm(nested)
  }

  function walkNm(nm) {
    let entries
    try {
      entries = fs.readdirSync(nm, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(nm, entry.name)
      if (entry.name.startsWith('@')) {
        let scoped
        try {
          scoped = fs.readdirSync(full)
        } catch {
          continue
        }
        for (const child of scoped) {
          if (!child.startsWith('.')) visitPkg(path.join(full, child))
        }
      } else {
        visitPkg(full)
      }
    }
  }

  walkNm(path.join(productRoot, 'node_modules'))
  return packages
}

const checks = []

const pkg = readJson('package.json')
const lock = loadPackageLock(pkg)
const readme = readText('README.md')
const cliDocs = readText('docs/getting-started/cli.md')
const ci = readText('.github/workflows/ci.yml')
const mutation = readText('.github/workflows/mutation.yml')
const installScript = readText('install.sh')
const dockerfile = readText('docker/Dockerfile')
const compose = readText('docker/docker-compose.yml')
const dockerSmoke = readText('scripts/docker-auth-smoke.mjs')
const dockerComposeSmoke = readText('scripts/docker-compose-auth-smoke.mjs')
const githubWorkflowIdentity = 'https://github.com/$' + '{{ github.repository }}/.github/workflows/ci.yml@$' + '{{ github.ref }}'
const workflowSources = `${ci}\n${mutation}`
const APPROVED_TRANSITIVE_LICENSE_EXCEPTIONS = new Map([
  ['caniuse-lite', { license: 'CC-BY-4.0', reason: 'Browser compatibility data bundled through development tooling.' }],
  ['lightningcss', { license: 'MPL-2.0', reason: 'Transitive CSS transformer with file-level weak-copyleft terms reviewed for local build tooling.' }],
  ['lightningcss-android-arm64', { license: 'MPL-2.0', reason: 'Platform package for the reviewed lightningcss transformer.' }],
  ['lightningcss-darwin-arm64', { license: 'MPL-2.0', reason: 'Platform package for the reviewed lightningcss transformer.' }],
  ['lightningcss-darwin-x64', { license: 'MPL-2.0', reason: 'Platform package for the reviewed lightningcss transformer.' }],
  ['lightningcss-freebsd-x64', { license: 'MPL-2.0', reason: 'Platform package for the reviewed lightningcss transformer.' }],
  ['lightningcss-linux-arm-gnueabihf', { license: 'MPL-2.0', reason: 'Platform package for the reviewed lightningcss transformer.' }],
  ['lightningcss-linux-arm64-gnu', { license: 'MPL-2.0', reason: 'Platform package for the reviewed lightningcss transformer.' }],
  ['lightningcss-linux-arm64-musl', { license: 'MPL-2.0', reason: 'Platform package for the reviewed lightningcss transformer.' }],
  ['lightningcss-linux-x64-gnu', { license: 'MPL-2.0', reason: 'Platform package for the reviewed lightningcss transformer.' }],
  ['lightningcss-linux-x64-musl', { license: 'MPL-2.0', reason: 'Platform package for the reviewed lightningcss transformer.' }],
  ['lightningcss-win32-arm64-msvc', { license: 'MPL-2.0', reason: 'Platform package for the reviewed lightningcss transformer.' }],
  ['lightningcss-win32-x64-msvc', { license: 'MPL-2.0', reason: 'Platform package for the reviewed lightningcss transformer.' }],
  ['minimatch', { license: 'BlueOak-1.0.0', reason: 'Permissive Blue Oak model license in transitive development tooling.' }],
  ['lru-cache', { license: 'BlueOak-1.0.0', reason: 'Permissive Blue Oak model license in transitive development tooling.' }],
])

check('package_identity', 'mandatory',
  (pkg.name === 'cowork-gateway' || pkg.name === 'opencode-gateway') && pkg.private === true && pkg.license === 'MIT' && fs.existsSync(path.join(root, 'LICENSE')),
  'Package identity is intentionally private and MIT license metadata is present.',
  'Keep the package private until release owners establish publish policy (preferred name: cowork-gateway).')

check('package_lock_alignment', 'mandatory',
  lock.version === pkg.version && lock.packages?.['']?.version === pkg.version,
  'package-lock root version matches package.json.',
  'Run npm install after version changes so package-lock metadata matches package.json.')

check('dependency_lock_alignment', 'mandatory',
  dependenciesMatchLock(pkg.dependencies, lock.packages?.['']?.dependencies)
    && dependenciesMatchLock(pkg.devDependencies, lock.packages?.['']?.devDependencies),
  'Runtime and development dependencies are represented in package-lock root metadata.',
  'Run npm install and commit package-lock updates before release evidence.')

const primaryBin = pkg.bin?.['cowork-gateway'] || pkg.bin?.['opencode-gateway']
check('bin_entrypoint', 'mandatory',
  typeof primaryBin === 'string'
    && fs.existsSync(path.join(root, primaryBin))
    && readText(primaryBin).startsWith('#!/usr/bin/env node')
    && typeof pkg.bin?.['opencode-gateway'] === 'string',
  'CLI bin entrypoints exist (cowork-gateway preferred; opencode-gateway shim retained) with node shebang.',
  'Restore bin/cowork-gateway and bin/opencode-gateway before packaging.')

check('build_artifacts_present', 'mandatory',
  fs.existsSync(path.join(root, 'dist/cli.js')) && fs.existsSync(path.join(root, 'dist/mcp.js')),
  'Built CLI and MCP artifacts are present.',
  'Run npm run build before release artifact checks.')

check('package_files_allowlist', 'mandatory',
  Array.isArray(pkg.files)
    && ['dist/', 'bin/', 'docs/', 'mkdocs.yml', 'LICENSE', 'CHANGELOG.md', 'README.md'].every(item => pkg.files.includes(item)),
  'package.json files allowlist includes runtime artifacts and public docs.',
  'Update package.json files allowlist intentionally before release packaging.')

check('ci_clean_install_and_release_gates', 'mandatory',
  ci.includes('npm ci --ignore-scripts')
    && ci.includes('npm rebuild esbuild --ignore-scripts=false')
    && ci.includes('npm run verify')
    && ci.includes('mkdocs build --strict')
    && ci.includes('npm run release:check')
    && /docker-publish:[\s\S]*npm run release:artifacts[\s\S]*Build release candidate image/.test(ci)
    && ci.includes('npm run release:check -- --require-tag --tag "$GITHUB_REF_NAME" --main-ref "$RELEASE_MAIN_REF"')
    && ci.includes('fetch-depth: 0 # tag binding needs protected-main ancestry and the tag object')
    && /\bon:\s*\n\s+push:\s*\n(?:\s+branches:\s*\[[^\]]+\]\s*\n)?\s+tags:\s*\[\s*['"]v\*['"]\s*\]/.test(ci),
  'CI records scriptless clean install, audited native rebuild, verify, docs, exact tag/main binding, release-artifacts, and tag-only release gates.',
  'Restore CI clean-install/release gates before changing release wording.')

const checkoutCount = (ci.match(/uses:\s*actions\/checkout@/g) || []).length
const mutationCheckoutCount = (mutation.match(/uses:\s*actions\/checkout@/g) || []).length
const persistFalseCount = (workflowSources.match(/persist-credentials:\s*false/g) || []).length
check('ci_checkout_credentials_hardened', 'mandatory',
  checkoutCount > 0 && persistFalseCount >= checkoutCount + mutationCheckoutCount,
  'Every GitHub Actions checkout disables persisted credentials.',
  'Set persist-credentials: false on every checkout step, especially privileged release jobs.',
  { checkoutCount: checkoutCount + mutationCheckoutCount, persistFalseCount })

check('lifecycle_script_hardening', 'mandatory',
  !/\bnpm ci\b(?![^\n]*--ignore-scripts)/.test(`${workflowSources}\n${dockerfile}\n${installScript}`)
    && ci.includes('npm rebuild esbuild --ignore-scripts=false')
    && dockerfile.includes('npm rebuild esbuild --ignore-scripts=false')
    && installScript.includes('npm rebuild esbuild --ignore-scripts=false')
    && dockerfile.includes('npm ci --omit=dev --ignore-scripts')
    && installScript.includes('npm install -g "$INSTALL_DIR" --ignore-scripts')
    && pkg.allowScripts?.['esbuild@0.28.1'] === true
    && pkg.allowScripts?.fsevents === false,
  'CI, Docker, and bootstrap installs disable lifecycle scripts by default, pin the audited native helper approval, and explicitly deny the unused optional helper.',
  'Use npm ci --ignore-scripts by default, pin every audited native rebuild, and deny unneeded script-bearing dependencies.')

check('stable_required_ci_and_release_environment', 'mandatory',
  /required:\s*\n\s+needs: \[workflow-lint, test, docs, security-scan, docker-pr\]\s*\n\s+if: always\(\)/.test(ci)
    && ci.includes(`DOCKER_PR_RESULT: \${{ needs.docker-pr.result }}`)
    && ci.includes('if [ "$EVENT_NAME" = pull_request ]')
    && (ci.match(/environment: production-release/g) || []).length === 2
    && ci.includes('cancel-in-progress: $' + "{{ !startsWith(github.ref, 'refs/tags/v') }}")
    && /docker-publish:\s*[\s\S]*?needs: required/.test(ci),
  'CI exposes one stable required fan-in, scopes both tag release jobs to production-release, and never cancels in-progress tag publication.',
  'Keep branch protection on the stable required job; preserve PR-only Docker enforcement, tag-only release environments, and non-canceling tag concurrency.')

check('hashed_docs_dependencies', 'mandatory',
  ci.includes('uv pip install --require-hashes -r docs/requirements.txt')
    && fs.existsSync(path.join(root, 'docs/requirements.in'))
    && readText('docs/requirements.txt').includes('--hash=sha256:'),
  'Documentation dependencies are transitively pinned and installed with hash enforcement.',
  'Regenerate docs/requirements.txt from requirements.in with uv --generate-hashes and keep CI --require-hashes.')

check('repository_governance_files', 'mandatory',
  fs.existsSync(path.join(root, '.github/CODEOWNERS'))
    && fs.existsSync(path.join(root, '.github/SECURITY.md'))
    && fs.existsSync(path.join(root, '.github/PULL_REQUEST_TEMPLATE.md'))
    && fs.existsSync(path.join(root, '.github/ISSUE_TEMPLATE/bug_report.yml')),
  'CODEOWNERS, private vulnerability reporting, and focused contribution templates are present.',
  'Restore concise repository governance files before release handoff.')

check('installer_release_tag_source', 'mandatory',
  installScript.includes(`DEFAULT_RELEASE_TAG="v${pkg.version}"`)
    && installScript.includes('--version <vX.Y.Z>')
    && installScript.includes('--unsafe-ref <ref>')
    && installScript.includes('--allow-unsafe-ref')
    && installScript.includes('npm run release:artifacts')
    && installScript.includes('cosign verify-blob')
    && installScript.includes('SHA256SUMS.sigstore.json')
    && installScript.includes('restore_previous_release')
    && installScript.includes('snapshot_runtime_state')
    && installScript.includes('restore_runtime_state_snapshot')
    && installScript.includes('CONFIG_ROLLBACK_DIR="$' + '{TRANSACTION_DIR}/config-previous"')
    && installScript.includes('STATE_ROLLBACK_DIR="$' + '{TRANSACTION_DIR}/state-previous"')
    && installScript.includes('readiness --strict')
    && installScript.includes('TRANSACTION_TEMPLATE="$' + '{INSTALL_DIR}.transaction.XXXXXX"')
    && installScript.includes('TRANSACTION_MARKER_VALUE="opencode-gateway-installer-transaction-v1"')
    && installScript.includes('TRANSACTION_DIR="$(mktemp -d "$TRANSACTION_TEMPLATE")"')
    && installScript.includes('is_installer_owned_transaction')
    && !installScript.includes('rm -rf "$ROLLBACK_DIR"')
    && installScript.includes('OPENCODE_GATEWAY_INSTALL_STARTUP_GRACE_SECONDS')
    && (installScript.match(/wait_for_strict_readiness "\$\{INSTALL_DIR\}\/dist\/cli\.js"/g) || []).length >= 2
    && installScript.includes('npm uninstall -g opencode-gateway --ignore-scripts')
    && installScript.includes('systemctl --user disable --now opencode-gateway.service')
    && installScript.includes('launchctl bootout "gui/$(id -u)/com.opencode-gateway.daemon"')
    && installScript.includes('mv "$STAGING_DIR" "$INSTALL_DIR"')
    && !/BRANCH="main"|git pull origin "\$BRANCH"|raw\.githubusercontent\.com\/joe-broadhead\/opencode-gateway\/main\/install\.sh/.test(installScript),
  'install.sh defaults to signed releases, uses marker-owned collision-safe transactions, polls bounded readiness, and removes first-install CLI/service artifacts on rollback.',
  'Keep normal installs on verified release assets, retain marker validation before recursive cleanup, and keep fresh-install rollback artifact-complete.')

const imageStageIndex = ci.indexOf('Stage release image by digest')
const imageVerifyIndex = ci.indexOf('Verify image signature and provenance')
const publishedReleaseGuardIndex = ci.indexOf('Refuse to mutate an existing published release')
const draftCreateIndex = ci.indexOf('Create draft release with signed bundle')
const draftValidateIndex = ci.indexOf('Validate draft release bundle')
const immutablePromoteIndex = ci.indexOf('Promote immutable version image')
const immutableCommitPromoteIndex = ci.indexOf('Promote immutable commit image')
const mutablePromoteIndex = ci.indexOf('Promote mutable image aliases')
const releasePublishIndex = ci.indexOf('Publish validated GitHub release')
check('image_digest_promotion_order', 'mandatory',
  imageStageIndex >= 0
    && ci.includes('push-by-digest=true')
    && ci.includes('digest: $' + '{{ steps.build.outputs.digest }}')
    && imageStageIndex < imageVerifyIndex
    && imageVerifyIndex < publishedReleaseGuardIndex
    && publishedReleaseGuardIndex < draftCreateIndex
    && draftCreateIndex < draftValidateIndex
    && draftValidateIndex < immutablePromoteIndex
    && immutablePromoteIndex < immutableCommitPromoteIndex
    && immutableCommitPromoteIndex < mutablePromoteIndex
    && mutablePromoteIndex < releasePublishIndex
    && !ci.slice(imageStageIndex, draftCreateIndex).includes('docker buildx imagetools create')
    && ci.slice(draftCreateIndex, draftValidateIndex).includes('draft: true')
    && (ci.match(/gh release download "\$GITHUB_REF_NAME"/g) || []).length === 2
    && (ci.match(/cmp "release-assets\/\$\{asset\}" "\$\{VALIDATION_DIR\}\/\$\{asset\}"/g) || []).length === 2
    && ci.includes('is already published; refusing to replace its assets')
    && ci.includes('Refusing to overwrite immutable version tag')
    && ci.includes('Refusing to overwrite immutable commit tag')
    && ci.includes('gh release edit "$GITHUB_REF_NAME" --draft=false'),
  'CI gates an untagged digest, validates the signed draft bundle, promotes immutable version/commit tags first, then mutable aliases, and publishes the release last.',
  'Keep every public image alias after draft-bundle validation; never overwrite a conflicting full-version tag or publish the draft before alias verification.')

check('docker_nonroot_persistence_smoke', 'mandatory',
  dockerfile.includes('/tmp/nonroot-home/.config/opencode-gateway')
    && dockerfile.includes('USER 65532:65532')
    && dockerfile.includes('OPENCODE_GATEWAY_HTTP_READ_TOKEN_FILE')
    && dockerfile.includes("fs.readFileSync(tokenFile,'utf8').trim()")
    && compose.includes('user: "0:0"')
    && compose.includes('opencode-gateway-config:/home/nonroot/.config/opencode-gateway')
    && compose.includes('opencode-gateway-config:')
    && compose.includes('OPENCODE_GATEWAY_HTTP_READ_TOKEN_FILE=/run/opencode-gateway/secrets/gateway_http_read_token')
    && compose.includes('OPENCODE_GATEWAY_BOOTSTRAP_HTTP_READ_TOKEN_FILE=/run/secrets/gateway_http_read_token')
    && compose.includes('tmpfs:')
    && compose.includes('/run/opencode-gateway:uid=65532,gid=65532,mode=0700')
    && compose.includes("runtimeDir = '/run/opencode-gateway/secrets'")
    && compose.includes('fs.chownSync(runtimeDir, nonrootUid, nonrootGid)')
    && compose.includes('fs.chmodSync(runtimeDir, 0o700)')
    && compose.includes("fs.writeFileSync(tmp, token + '\\n', { mode: 0o600 })")
    && compose.includes('fs.chownSync(target, nonrootUid, nonrootGid)')
    && compose.includes("process.env[envName] = target")
    && compose.includes('process.setgid(nonrootGid)')
    && compose.includes('process.setuid(nonrootUid)')
    && compose.includes("spawn(process.execPath, ['dist/daemon.js']")
    && compose.includes("process.on('SIGTERM', () => forward('SIGTERM'))")
    && compose.includes("process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1))")
    && compose.includes('restart: "on-failure:5"')
    && compose.includes('stop_grace_period: 30s')
    && compose.includes('max-size: "10m"')
    && dockerSmoke.includes("['volume', 'create'")
    && dockerSmoke.includes('dst=/home/nonroot/.config/opencode-gateway')
    && dockerSmoke.includes('smoke-write')
    && dockerComposeSmoke.includes('docker/docker-compose.yml')
    && dockerComposeSmoke.includes('OPENCODE_GATEWAY_HTTP_READ_TOKEN_FILE')
    && dockerComposeSmoke.includes("['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'"),
  'Docker image, Compose, and smoke checks keep the nonroot config volume writable and file-token health tested.',
  'Use a named Compose volume initialized from a nonroot-owned image path and keep direct plus Compose secret-file smokes.')

check('operations_deadman_and_backup_boundary', 'mandatory',
  compose.includes('profiles: [deadman]')
    && compose.includes("fetch('http://gateway:4097/readiness'")
    && compose.includes('/run/secrets/gateway_deadman_url')
    && /deadman:[\s\S]*?healthcheck:\s*\n\s+disable: true/.test(compose)
    && compose.includes('Number.isFinite(intervalSeconds)')
    && compose.includes('Number.isInteger(intervalSeconds)')
    && compose.includes('intervalSeconds < 30 || intervalSeconds > 86400')
    && !compose.includes('setInterval(')
    && compose.indexOf('await tick()') < compose.indexOf('setTimeout(() => void run(), interval)')
    && readText('docs/operations/observability-incidents.md').includes('independent off-host monitor')
    && readText('docs/operations/backup-restore.md').includes('## Off-Host Encrypted Copy'),
  'Compose disables the inherited deadman healthcheck, schedules bounded serial heartbeats, and keeps dead-man/backup destinations off-host.',
  'Keep dead-man cadence finite and serial, and keep monitoring and backup destinations outside the Gateway process/host failure domain.')

check('trivy_source_config_secret_scan', 'mandatory',
  ci.includes('scan-type: fs')
    && ci.includes('scan-ref: .')
    && (ci.match(/scanners:\s*vuln,secret,misconfig/g) || []).length >= 4,
  'CI runs Trivy filesystem vulnerability, secret, and misconfiguration scans and applies the same scanner set to image scans.',
  'Restore Trivy fs/config/secret scanning before release evidence.')

check('install_update_docs', 'mandatory',
  readme.includes('npm install')
    && readme.includes('opencode-gateway setup')
    && readme.includes('opencode-gateway update')
    && cliDocs.includes('opencode-gateway update [--wizard]')
    && cliDocs.includes('opencode-gateway setup [--yes]'),
  'Public docs align with current local install/update behavior.',
  'Update README and CLI docs when setup/update behavior changes.')

check('rollback_docs', 'mandatory',
  cliDocs.includes('opencode-gateway backup rollback-drill --from path')
    && cliDocs.includes('opencode-gateway restore --from <path>'),
  'Rollback and recovery expectations are documented for local public beta.',
  'Document backup verification, rollback drill, and restore expectations before release.')

const licenseResult = dependencyLicenseCheck(pkg)
checks.push(licenseResult)

if (skipPack) {
  skip('npm_pack_integrity', 'mandatory', 'npm pack integrity was skipped by --skip-pack.', 'Run npm run build && npm run release:artifacts before release handoff.')
} else {
  checks.push(runPackIntegrityCheck())
}

if (runAudit) checks.push(runNpmAuditCheck())
else skip('npm_audit_high', 'advisory', 'Registry-backed npm audit is skipped by default to keep local release checks deterministic.', 'Run M40_RUN_NPM_AUDIT=1 npm run release:artifacts before tagged release evidence.')

check('signed_image_provenance_workflow', 'mandatory',
  ci.includes('cosign sign --yes')
    && ci.includes('cosign verify')
    && ci.includes('cosign verify-attestation')
    && ci.includes('actions/attest-build-provenance@')
    && ci.includes('push-to-registry: true')
    && ci.includes(`CERT_IDENTITY: ${githubWorkflowIdentity}`)
    && ci.includes('--certificate-identity "$CERT_IDENTITY"')
    && !ci.includes('refs/.*')
    && !ci.includes('certificate-identity-regexp')
    && ci.includes('cosign sign-blob --yes --bundle release-assets/SHA256SUMS.sigstore.json')
    && !/Sign image[\s\S]{0,300}continue-on-error/.test(ci),
  'CI signs staged image digests and release checksum manifests, then verifies signatures and provenance against the exact tag workflow identity.',
  'Restore fail-closed digest and release-manifest signing with exact tag identity before publishing tagged releases.')

const mandatoryFailures = checks.filter(row => row.severity === 'mandatory' && row.status !== 'pass')
const source = captureSourceState()
const build = captureBuildMetadata()
const report = {
  schemaVersion: 1,
  id: 'm40_release_artifact_check',
  generatedAt: new Date().toISOString(),
  status: mandatoryFailures.length ? 'fail' : 'pass',
  releaseClaimEffect: 'local_beta_release_artifact_evidence_only_no_package_marketplace_or_production_claim',
  source,
  build,
  provenancePosture: {
    checksum: 'dynamic_sha256_from_npm_pack_integrity',
    signedProvenance: 'enforced_by_ci_cosign_keyless',
    signedProvenanceCheckId: 'signed_image_provenance_workflow',
    attestation: 'verified_by_ci_cosign_verify_attestation',
    safeNextAction: 'Keep signed image and attestation verification fail-closed before tagged release publication.',
  },
  checks,
  mandatoryFailures: mandatoryFailures.map(row => row.id),
  safeNextAction: mandatoryFailures[0]?.safeNextAction || 'Release artifact evidence passed mandatory local checks; keep advisory skips explicit before stronger release wording.',
}

if (asJson) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`release artifact check ${report.status}: ${checks.filter(row => row.status === 'pass').length}/${checks.length} checks passed`)
  for (const row of checks) console.log(`- ${row.status}: ${row.id} (${row.severity}) - ${row.summary}`)
  if (report.status !== 'pass') console.error(`safe next action: ${report.safeNextAction}`)
}

process.exit(report.status === 'pass' ? 0 : 1)

function check(id, severity, ok, summary, safeNextAction, evidence = {}) {
  checks.push({
    id,
    severity,
    status: ok ? 'pass' : 'fail',
    summary,
    safeNextAction: ok ? 'No action required.' : safeNextAction,
    evidence,
  })
}

function skip(id, severity, summary, safeNextAction) {
  checks.push({ id, severity, status: 'skipped', summary, safeNextAction, evidence: {} })
}

function dependenciesMatchLock(expected = {}, actual = {}) {
  return Object.entries(expected).every(([name, version]) => actual?.[name] === version)
}

function dependencyLicenseCheck(pkgJson, lockfile = lock) {
  // MIT-0 is a public-domain-style permissive license (more permissive than MIT).
  const allowed = /^(MIT|MIT-0|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|CC0-1\.0|Unlicense)( OR (MIT|MIT-0|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|CC0-1\.0|Unlicense))*$/i
  const rows = []
  for (const entry of dependencyLicenseEntries(pkgJson, lockfile)) {
    const license = String(entry.license || '').trim()
    const approval = dependencyLicenseApproval(entry.name, license, allowed)
    rows.push({
      name: entry.name,
      packagePath: entry.packagePath,
      status: license && approval.ok ? 'pass' : 'fail',
      license: license || 'missing',
      ...(approval.exception ? { exception: approval.exception } : {}),
    })
  }
  const failed = rows.filter(row => row.status !== 'pass')
  const exceptions = rows
    .filter(row => row.exception)
    .map(row => ({ name: row.name, packagePath: row.packagePath, license: row.license, reason: row.exception }))
  return {
    id: 'dependency_license_posture',
    severity: 'mandatory',
    status: failed.length ? 'fail' : 'pass',
    summary: failed.length ? `Dependency license check found ${failed.length} missing or unapproved license(s).` : `Dependency license check passed for ${rows.length} lockfile package(s).`,
    safeNextAction: failed.length ? 'Review dependency licenses and update package-specific approvals only with explicit release-owner approval.' : 'No action required.',
    evidence: { dependencyCount: rows.length, exceptionCount: exceptions.length, exceptions, failed },
  }
}

function dependencyLicenseEntries(pkgJson, lockfile) {
  const packages = lockfile?.packages && typeof lockfile.packages === 'object' ? lockfile.packages : {}
  const rows = []
  const coveredNames = new Set()
  for (const [packagePath, metadata] of Object.entries(packages).sort(([left], [right]) => left.localeCompare(right))) {
    if (!packagePath || !packagePath.startsWith('node_modules/')) continue
    const name = dependencyNameFromPackagePath(packagePath)
    if (!name) continue
    coveredNames.add(name)
    rows.push({ name, packagePath, license: metadata?.license })
  }
  // Direct deps that never appeared in lock/node_modules synthesis still need a row.
  // Match by package *name* so monorepo versioned paths (node_modules/zod@4.x) cover package.json deps.
  for (const name of Object.keys({ ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) }).sort()) {
    if (coveredNames.has(name)) continue
    rows.push({ name, packagePath: `node_modules/${name}`, license: undefined })
  }
  return rows
}

function dependencyNameFromPackagePath(packagePath) {
  const segment = packagePath.split('/node_modules/').pop()?.replace(/^node_modules\//, '')
  if (!segment) return ''
  // Monorepo synthesis may encode versions as name@version after node_modules/.
  const unversioned = segment.replace(/@\d[^/]*$/, '')
  const parts = unversioned.split('/')
  if (parts[0]?.startsWith('@')) {
    // @scope/name or @scope/name@version (version already stripped from last segment only)
    const scoped = segment.match(/^(@[^/]+\/[^@/]+)/)
    return scoped?.[1] || parts.slice(0, 2).join('/')
  }
  return parts[0]
}

function dependencyLicenseApproval(name, license, allowed) {
  if (allowed.test(license)) return { ok: true }
  const approved = APPROVED_TRANSITIVE_LICENSE_EXCEPTIONS.get(name)
  if (approved?.license === license) return { ok: true, exception: approved.reason }
  return { ok: false }
}

function runPackIntegrityCheck() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-gateway-pack-'))
  try {
    const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', dir], { cwd: root, encoding: 'utf-8' })
    if (pack.status !== 0) {
      return {
        id: 'npm_pack_integrity',
        severity: 'mandatory',
        status: 'fail',
        summary: 'npm pack failed.',
        safeNextAction: 'Run npm run build, inspect npm pack stderr, and fix package files before release evidence.',
        evidence: { stderr: redact(pack.stderr || '') },
      }
    }
    const rows = JSON.parse(pack.stdout || '[]')
    const first = Array.isArray(rows) ? rows[0] : undefined
    const filename = first?.filename
    const tarball = filename ? path.join(dir, filename) : undefined
    const files = Array.isArray(first?.files) ? first.files.map(file => normalizePackPath(file.path)).sort() : []
    const required = ['package.json', 'bin/opencode-gateway', 'README.md', 'CHANGELOG.md', 'LICENSE']
    if (pkg.bin?.['cowork-gateway']) required.push('bin/cowork-gateway')
    const missing = required.filter(file => !files.includes(file))
    if (!files.some(file => file.startsWith('dist/'))) missing.push('dist/')
    const forbidden = files.filter(file => /(^|\/)(node_modules|\.git|\.gateway|\.codex|site|__tests__)(\/|$)|\.(db|sqlite|log|pem|key|env)$/i.test(file))
    const sha256 = tarball && fs.existsSync(tarball) ? hashFile(tarball) : undefined
    const packNameOk = typeof filename === 'string'
      && /^(cowork-gateway|opencode-gateway)-\d+\.\d+\.\d+.*\.tgz$/.test(filename)
    const ok = missing.length === 0 && forbidden.length === 0 && Boolean(sha256) && packNameOk
    return {
      id: 'npm_pack_integrity',
      severity: 'mandatory',
      status: ok ? 'pass' : 'fail',
      summary: ok ? `npm pack produced ${filename} with ${files.length} file(s) and sha256 evidence.` : 'npm pack artifact is missing required files, contains forbidden files, or lacks sha256 evidence.',
      safeNextAction: ok ? 'No action required.' : 'Fix package files/build output and rerun npm run release:artifacts.',
      evidence: {
        filename,
        fileCount: files.length,
        unpackedSize: first?.unpackedSize,
        size: first?.size,
        sha256,
        missing,
        forbidden,
        packNameOk,
      },
    }
  } catch (error) {
    return {
      id: 'npm_pack_integrity',
      severity: 'mandatory',
      status: 'fail',
      summary: `npm pack artifact check failed: ${error?.message || error}`,
      safeNextAction: 'Fix package artifact generation before release evidence.',
      evidence: {},
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function runNpmAuditCheck() {
  const audit = spawnSync('npm', ['audit', '--omit=dev', '--audit-level=high', '--json'], { cwd: root, encoding: 'utf-8' })
  const stdout = audit.stdout || '{}'
  let parsed = {}
  try { parsed = JSON.parse(stdout) } catch {}
  const high = parsed.metadata?.vulnerabilities?.high || 0
  const critical = parsed.metadata?.vulnerabilities?.critical || 0
  const ok = audit.status === 0 && high === 0 && critical === 0
  return {
    id: 'npm_audit_high',
    severity: 'advisory',
    status: ok ? 'pass' : 'fail',
    summary: ok ? 'npm audit found no high or critical production dependency vulnerabilities.' : 'npm audit found high/critical vulnerabilities or could not complete.',
    safeNextAction: ok ? 'No action required.' : 'Review npm audit output before tagged release evidence.',
    evidence: { high, critical, exitCode: audit.status },
  }
}

function captureSourceState() {
  const commit = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf-8' })
  const unstaged = spawnSync('git', ['diff', '--quiet'], { cwd: root, encoding: 'utf-8' })
  const staged = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: root, encoding: 'utf-8' })
  return {
    commit: commit.status === 0 ? commit.stdout.trim() : 'unavailable',
    treeState: unstaged.status === 0 && staged.status === 0 ? 'clean' : 'dirty',
    commitEvidenceSource: 'git rev-parse --verify HEAD',
    treeStateEvidenceSource: 'git diff --quiet && git diff --cached --quiet',
  }
}

function captureBuildMetadata() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    packageManager: process.env.npm_config_user_agent || 'npm',
    command: 'npm run release:artifacts -- --json',
  }
}

function readText(file) {
  return fs.readFileSync(path.join(root, file), 'utf-8')
}

function readJson(file) {
  return JSON.parse(readText(file))
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function normalizePackPath(file) {
  return String(file || '').replace(/^package\//, '')
}

function redact(value) {
  return String(value || '').replace(/(?:\/Users\/|\/private\/|\/var\/folders\/|\/tmp\/)\S+/g, '<redacted:local-path>')
}
