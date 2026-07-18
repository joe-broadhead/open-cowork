import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf-8')
const githubWorkflowIdentity = 'https://github.com/$' + '{{ github.repository }}/.github/workflows/ci.yml@$' + '{{ github.ref }}'

describe('release CI and Docker hardening', () => {
  it('keeps GitHub Actions checkout, npm lifecycle, release, provenance, and Trivy gates hardened', () => {
    const ci = read('.github/workflows/ci.yml')
    const mutation = read('.github/workflows/mutation.yml')
    const dockerfile = read('docker/Dockerfile')
    const install = read('install.sh')
    const workflows = `${ci}\n${mutation}`
    const checkoutCount = workflows.match(/uses:\s*actions\/checkout@/g)?.length ?? 0
    const persistFalseCount = workflows.match(/persist-credentials:\s*false/g)?.length ?? 0

    expect(checkoutCount).toBeGreaterThan(0)
    expect(persistFalseCount).toBeGreaterThanOrEqual(checkoutCount)
    expect(`${workflows}\n${dockerfile}\n${install}`).not.toMatch(/\bnpm ci\b(?![^\n]*--ignore-scripts)/)
    expect(ci).toContain('npm rebuild esbuild --ignore-scripts=false')
    expect(dockerfile).toContain('npm rebuild esbuild --ignore-scripts=false')
    expect(install).toContain('npm rebuild esbuild --ignore-scripts=false')
    expect(JSON.parse(read('package.json')).allowScripts).toEqual({ 'esbuild@0.28.1': true, fsevents: false })
    expect(ci).toMatch(/docker-publish:[\s\S]*npm run release:artifacts[\s\S]*Build release candidate image/)
    expect(ci).toContain(`CERT_IDENTITY: ${githubWorkflowIdentity}`)
    expect(ci).toContain('--certificate-identity "$CERT_IDENTITY"')
    expect(ci).not.toContain('refs/.*')
    expect(ci).not.toContain('certificate-identity-regexp')
    expect(ci).toContain('scan-type: fs')
    expect(ci.match(/scanners:\s*vuln,secret,misconfig/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
    expect(ci).toContain('npm run release:check -- --require-tag --tag "$GITHUB_REF_NAME" --main-ref "$RELEASE_MAIN_REF"')
    expect(ci).toMatch(/required:\s*\n\s+needs: \[workflow-lint, test, docs, security-scan, docker-pr\]\s*\n\s+if: always\(\)/)
    expect(ci).toContain(`DOCKER_PR_RESULT: \${{ needs.docker-pr.result }}`)
    expect(ci).toContain('if [ "$EVENT_NAME" = pull_request ]')
    expect(ci.match(/environment: production-release/g)?.length).toBe(2)
    expect(ci).toMatch(/docker-pr:[\s\S]*?if: github\.event_name == 'pull_request'/)
    expect(ci).toContain('cancel-in-progress: $' + "{{ !startsWith(github.ref, 'refs/tags/v') }}")
  })

  it('keeps install.sh on tagged releases unless the unsafe development hatch is explicit', () => {
    const pkg = JSON.parse(read('package.json'))
    const install = read('install.sh')

    expect(install).toContain(`DEFAULT_RELEASE_TAG="v${pkg.version}"`)
    expect(install).toContain('--version <vX.Y.Z>')
    expect(install).toContain('--unsafe-ref <ref>')
    expect(install).toContain('--allow-unsafe-ref')
    expect(install).toContain('tagged release evidence path')
    expect(install).toContain('npm run release:artifacts')
    expect(install).toContain('cosign verify-blob')
    expect(install).toContain('SHA256SUMS.sigstore.json')
    expect(install).toContain('mv "$STAGING_DIR" "$INSTALL_DIR"')
    expect(install).toContain('restore_previous_release')
    expect(install).toContain('TRANSACTION_TEMPLATE="$' + '{INSTALL_DIR}.transaction.XXXXXX"')
    expect(install).toContain('TRANSACTION_MARKER_VALUE="opencode-gateway-installer-transaction-v1"')
    expect(install).toContain('TRANSACTION_DIR="$(mktemp -d "$TRANSACTION_TEMPLATE")"')
    expect(install).toContain('is_installer_owned_transaction')
    expect(install).not.toContain('rm -rf "$ROLLBACK_DIR"')
    expect(install).toContain('OPENCODE_GATEWAY_INSTALL_STARTUP_GRACE_SECONDS')
    expect(install).toContain('wait_for_strict_readiness')
    expect(install.match(/wait_for_strict_readiness "\$\{INSTALL_DIR\}\/dist\/cli\.js"/g)?.length).toBeGreaterThanOrEqual(2)
    expect(install).toContain('npm uninstall -g opencode-gateway --ignore-scripts')
    expect(install).toContain('systemctl --user disable --now opencode-gateway.service')
    expect(install).toContain('launchctl bootout "gui/$(id -u)/com.opencode-gateway.daemon"')
    expect(install).toContain(`release \${INSTALL_REF} is absent or incomplete`)
    expect(install).not.toMatch(/BRANCH="main"|git pull origin "\$BRANCH"|raw\.githubusercontent\.com\/joe-broadhead\/opencode-gateway\/main\/install\.sh/)
  })

  it('accepts only the bounded installer startup grace', () => {
    const run = (grace: string) => spawnSync('bash', ['install.sh', '--dry-run', '--yes', '--version', 'v1.3.0'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, OPENCODE_GATEWAY_INSTALL_STARTUP_GRACE_SECONDS: grace },
    })

    for (const grace of ['9', '301', '1.5', 'Infinity']) {
      const result = run(grace)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('must be an integer from 10 through 300')
    }
    for (const grace of ['10', '300']) {
      const result = run(grace)
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('Dry run - no changes will be made')
    }
  })

  it('validates a draft release bundle before immutable and mutable image promotion', () => {
    const ci = read('.github/workflows/ci.yml')
    const stage = ci.indexOf('Stage release image by digest')
    const verifyImage = ci.indexOf('Verify image signature and provenance')
    const publishedGuard = ci.indexOf('Refuse to mutate an existing published release')
    const createDraft = ci.indexOf('Create draft release with signed bundle')
    const validateDraft = ci.indexOf('Validate draft release bundle')
    const immutable = ci.indexOf('Promote immutable version image')
    const immutableCommit = ci.indexOf('Promote immutable commit image')
    const mutable = ci.indexOf('Promote mutable image aliases')
    const publish = ci.indexOf('Publish validated GitHub release')

    expect(stage).toBeGreaterThan(0)
    expect(ci).toContain('push-by-digest=true')
    expect(ci).toContain('digest: $' + '{{ steps.build.outputs.digest }}')
    for (const gate of ['Smoke staged digest', 'Scan staged digest for vulnerabilities', 'Sign image (cosign keyless)', 'Attest image provenance', 'Verify image signature and provenance']) {
      expect(ci.indexOf(gate)).toBeGreaterThan(stage)
      expect(ci.indexOf(gate)).toBeLessThan(createDraft)
    }
    expect(verifyImage).toBeLessThan(createDraft)
    expect(publishedGuard).toBeLessThan(createDraft)
    expect(createDraft).toBeLessThan(validateDraft)
    expect(validateDraft).toBeLessThan(immutable)
    expect(immutable).toBeLessThan(immutableCommit)
    expect(immutableCommit).toBeLessThan(mutable)
    expect(mutable).toBeLessThan(publish)
    expect(ci.slice(stage, createDraft)).not.toContain('docker buildx imagetools create')
    expect(ci.slice(createDraft, validateDraft)).toContain('draft: true')
    expect(ci.match(/gh release download "\$GITHUB_REF_NAME"/g)?.length).toBe(2)
    expect(ci.match(/cmp "release-assets\/\$\{asset\}" "\$\{VALIDATION_DIR\}\/\$\{asset\}"/g)?.length).toBe(2)
    expect(ci).toContain('is already published; refusing to replace its assets')
    expect(ci).toContain('Refusing to overwrite immutable version tag')
    expect(ci).toContain('Refusing to overwrite immutable commit tag')
    expect(ci).toContain('cosign sign-blob --yes --bundle release-assets/SHA256SUMS.sigstore.json')
    expect(ci).toContain('docker buildx imagetools create --prefer-index=false --tag "$VERSION_TAG" "$IMAGE_REF"')
    expect(ci).toContain('gh release edit "$GITHUB_REF_NAME" --draft=false')
  })

  it('keeps Compose persistence writable for the nonroot image and covered by smoke', () => {
    const dockerfile = read('docker/Dockerfile')
    const compose = read('docker/docker-compose.yml')
    const smoke = read('scripts/docker-auth-smoke.mjs')
    const composeSmoke = read('scripts/docker-compose-auth-smoke.mjs')
    const dockerDocs = read('docs/operations/docker.md')
    const releaseDocs = read('docs/development/testing-release.md')

    expect(dockerfile).toContain('/tmp/nonroot-home/.config/opencode-gateway')
    expect(dockerfile).toContain('USER 65532:65532')
    expect(dockerfile).toContain('OPENCODE_GATEWAY_HTTP_READ_TOKEN_FILE')
    expect(dockerfile).toContain("fs.readFileSync(tokenFile,'utf8').trim()")
    expect(compose).toContain('user: "0:0"')
    expect(compose).toContain('opencode-gateway-config:/home/nonroot/.config/opencode-gateway')
    expect(compose).toMatch(/volumes:\s*\n\s+opencode-gateway-config:/)
    expect(compose).toContain('OPENCODE_GATEWAY_HTTP_READ_TOKEN_FILE=/run/opencode-gateway/secrets/gateway_http_read_token')
    expect(compose).toContain('OPENCODE_GATEWAY_BOOTSTRAP_HTTP_READ_TOKEN_FILE=/run/secrets/gateway_http_read_token')
    expect(compose).toContain('tmpfs:')
    expect(compose).toContain('/run/opencode-gateway:uid=65532,gid=65532,mode=0700')
    expect(compose).toContain("runtimeDir = '/run/opencode-gateway/secrets'")
    expect(compose).toContain('fs.chownSync(runtimeDir, nonrootUid, nonrootGid)')
    expect(compose).toContain('fs.chmodSync(runtimeDir, 0o700)')
    expect(compose).toContain("fs.writeFileSync(tmp, token + '\\n', { mode: 0o600 })")
    expect(compose).toContain('fs.chownSync(target, nonrootUid, nonrootGid)')
    expect(compose).toContain("process.env[envName] = target")
    expect(compose).toContain('process.setgid(nonrootGid)')
    expect(compose).toContain('process.setuid(nonrootUid)')
    expect(compose).toContain("spawn(process.execPath, ['dist/daemon.js']")
    expect(compose).toContain("process.on('SIGTERM', () => forward('SIGTERM'))")
    expect(compose).toContain("process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1))")
    expect(compose).not.toContain('OPENCODE_GATEWAY_HTTP_READ_TOKEN=${')
    expect(compose).not.toContain("process.kill(process.pid, signal)")
    expect(compose).toContain('restart: "on-failure:5"')
    expect(compose).toContain('stop_grace_period: 30s')
    expect(compose).toContain('max-size: "10m"')
    expect(compose).toContain('profiles: [deadman]')
    expect(compose).toContain("fetch('http://gateway:4097/readiness'")
    expect(compose).toMatch(/deadman:[\s\S]*?healthcheck:\s*\n\s+disable: true/)
    expect(compose).toContain('Number.isFinite(intervalSeconds)')
    expect(compose).toContain('Number.isInteger(intervalSeconds)')
    expect(compose).toContain('intervalSeconds < 30 || intervalSeconds > 86400')
    expect(compose).not.toContain('setInterval(')
    expect(compose.indexOf('await tick()')).toBeLessThan(compose.indexOf('setTimeout(() => void run(), interval)'))
    expect(smoke).toContain("['volume', 'create'")
    expect(smoke).toContain('dst=/home/nonroot/.config/opencode-gateway')
    expect(smoke).toContain('smoke-write')
    expect(composeSmoke).toContain('docker/docker-compose.yml')
    expect(composeSmoke).toContain('OPENCODE_GATEWAY_HTTP_READ_TOKEN_FILE')
    expect(composeSmoke).toContain("['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'")
    expect(dockerDocs).toContain('named volume `opencode-gateway-config`')
    expect(dockerDocs).toContain('UID/GID `65532`')
    expect(releaseDocs).toContain('Tagged CI also runs it in the `docker-publish` path')
    expect(releaseDocs).toContain('Trivy filesystem vulnerability, secret, and misconfiguration scans')
  })

  it('keeps docs dependencies fully pinned and hash-enforced', () => {
    const ci = read('.github/workflows/ci.yml')
    const input = read('docs/requirements.in')
    const lock = read('docs/requirements.txt')

    expect(ci).toContain('uv pip install --require-hashes -r docs/requirements.txt')
    expect(input).toContain('mkdocs==1.6.1')
    expect(lock).toContain('--hash=sha256:')
    expect(lock).not.toMatch(/^\s*[A-Za-z0-9_.-]+(?:\[[^\]]+\])?\s*(?:$|[<>~!]=?)/m)
  })
})
