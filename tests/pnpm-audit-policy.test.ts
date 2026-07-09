import assert from 'node:assert/strict'
import test from 'node:test'
import {
  auditLevelFromArgs,
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
