import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(ROOT, 'scripts/check-release-artifacts.mjs')

describe('release artifact evidence check', () => {
  it('reports mandatory and advisory release evidence semantics without private paths', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--json', '--skip-pack'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    const report = JSON.parse(result.stdout)

    expect(result.status).not.toBe(0)
    expect(report).toMatchObject({
      schemaVersion: 1,
      id: 'm40_release_artifact_check',
      status: 'fail',
      releaseClaimEffect: 'local_beta_release_artifact_evidence_only_no_package_marketplace_or_production_claim',
    })
    expect(report.mandatoryFailures).toContain('npm_pack_integrity')
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'package_identity', severity: 'mandatory', status: 'pass' }),
      expect.objectContaining({ id: 'dependency_license_posture', severity: 'mandatory', status: 'pass' }),
      expect.objectContaining({ id: 'npm_pack_integrity', severity: 'mandatory', status: 'skipped' }),
      expect.objectContaining({ id: 'npm_audit_high', severity: 'advisory', status: 'skipped' }),
      expect.objectContaining({ id: 'signed_image_provenance_workflow', severity: 'mandatory', status: 'pass' }),
    ]))
    const license = report.checks.find((row: any) => row.id === 'dependency_license_posture')
    // Standalone npm installs report the full package-lock graph (100+). Monorepo
    // installs walk the product node_modules closure (still dozens of packages).
    expect(license.evidence.dependencyCount).toBeGreaterThan(20)
    if (license.evidence.dependencyCount > 100) {
      expect(license.evidence.exceptions).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'caniuse-lite', license: 'CC-BY-4.0' }),
        expect.objectContaining({ name: 'lightningcss', license: 'MPL-2.0' }),
        expect.objectContaining({ name: 'minimatch', license: 'BlueOak-1.0.0' }),
      ]))
    } else {
      // Monorepo: only assert exceptions that actually appear in the product tree.
      for (const row of license.evidence.exceptions || []) {
        expect(row).toEqual(expect.objectContaining({
          name: expect.any(String),
          license: expect.any(String),
          reason: expect.any(String),
        }))
      }
    }
    expect(report.safeNextAction).toMatch(/npm run (build|release:artifacts)/)
    expect(result.stdout).not.toContain(ROOT)
    expect(result.stdout).not.toMatch(/Bearer|TELEGRAM_BOT_TOKEN|WHATSAPP_ACCESS_TOKEN|OPENROUTER_API_KEY/i)
  })

  it('passes the full npm pack integrity path after a package build', () => {
    const build = spawnSync('npm', ['run', 'build'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0)

    const result = spawnSync(process.execPath, [SCRIPT, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    const report = JSON.parse(result.stdout)
    const pack = report.checks.find((row: any) => row.id === 'npm_pack_integrity')

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(report.status).toBe('pass')
    expect(report.mandatoryFailures).toEqual([])
    expect(report.provenancePosture).toMatchObject({
      signedProvenance: 'enforced_by_ci_cosign_keyless',
      signedProvenanceCheckId: 'signed_image_provenance_workflow',
    })
    expect(pack).toMatchObject({
      severity: 'mandatory',
      status: 'pass',
      evidence: {
        filename: expect.stringMatching(/^(cowork-gateway|opencode-gateway)-\d+\.\d+\.\d+.*\.tgz$/),
        fileCount: expect.any(Number),
        missing: [],
        forbidden: [],
      },
    })
    expect(pack.evidence.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(pack.evidence.fileCount).toBeGreaterThan(100)
    expect(result.stdout).not.toContain(ROOT)
    expect(result.stdout).not.toMatch(/Bearer|TELEGRAM_BOT_TOKEN|WHATSAPP_ACCESS_TOKEN|OPENROUTER_API_KEY/i)
  }, 240_000)
})
