import assert from 'node:assert/strict'
import test from 'node:test'
import {
  auditLevelFromArgs,
  buildBulkAdvisoryPayload,
  collectInstalledPackages,
  normalizeBulkAdvisoryReport,
  summarizeAuditReport,
} from '../scripts/pnpm-audit.mjs'

test('pnpm audit policy filters explicit CVE and GHSA exceptions only', () => {
  const report = {
    advisories: {
      1: {
        id: 1,
        module_name: 'patched-soon',
        severity: 'high',
        cves: ['CVE-2026-10001'],
        github_advisory_id: 'GHSA-AAAA-BBBB-CCCC',
      },
      2: {
        id: 2,
        module_name: 'still-bad',
        severity: 'critical',
        github_advisory_id: 'GHSA-DDDD-EEEE-FFFF',
      },
      3: {
        id: 3,
        module_name: 'low-noise',
        severity: 'low',
        cves: ['CVE-2026-10002'],
      },
    },
  }

  const summary = summarizeAuditReport(report, {
    ignoreCves: new Set(['CVE-2026-10001']),
    ignoreGhsas: new Set(['GHSA-ZZZZ-ZZZZ-ZZZZ']),
  }, { auditLevel: 'moderate' })

  assert.equal(summary.ignored.length, 1)
  assert.equal(summary.failures.length, 1)
  assert.equal(summary.failures[0]?.advisory.module_name, 'still-bad')
})

test('pnpm audit argument parser supports separated and equals audit-level forms', () => {
  assert.equal(auditLevelFromArgs(['--prod', '--audit-level', 'moderate']), 'moderate')
  assert.equal(auditLevelFromArgs(['--audit-level=high']), 'high')
  assert.equal(auditLevelFromArgs([]), 'low')
})

test('pnpm audit bulk payload is built from external installed packages', () => {
  const installed = collectInstalledPackages([
    {
      dependencies: {
        '@open-cowork/shared': {
          version: '0.0.0',
          path: '/repo/packages/shared',
        },
        lodash: {
          version: '4.17.20',
          path: '/repo/node_modules/.pnpm/lodash@4.17.20/node_modules/lodash',
          dependencies: {
            minimist: {
              version: '0.0.8',
              path: '/repo/node_modules/.pnpm/minimist@0.0.8/node_modules/minimist',
            },
          },
        },
      },
      devDependencies: {
        semver: {
          version: '7.8.5',
          path: '/repo/node_modules/.pnpm/semver@7.8.5/node_modules/semver',
        },
      },
    },
  ])

  assert.deepEqual(buildBulkAdvisoryPayload(installed), {
    lodash: ['4.17.20'],
    minimist: ['0.0.8'],
    semver: ['7.8.5'],
  })
})

test('pnpm audit normalizes npm bulk advisories with installed version filtering', () => {
  const installed = new Map([
    ['lodash', new Set(['4.17.20', '4.17.21'])],
  ])
  const report = normalizeBulkAdvisoryReport({
    lodash: [
      {
        id: 1108258,
        url: 'https://github.com/advisories/GHSA-29mw-wpgm-hmr9',
        title: 'Regular Expression Denial of Service (ReDoS) in lodash',
        severity: 'moderate',
        vulnerable_versions: '>=4.0.0 <4.17.21',
      },
      {
        id: 999,
        severity: 'critical',
        vulnerable_versions: '<1.0.0',
      },
    ],
  }, installed)

  const advisories = Object.values(report.advisories)
  assert.equal(advisories.length, 1)
  assert.equal(advisories[0]?.module_name, 'lodash')
  assert.equal(advisories[0]?.github_advisory_id, 'GHSA-29MW-WPGM-HMR9')
  assert.deepEqual(advisories[0]?.findings[0]?.versions, ['4.17.20'])
})
