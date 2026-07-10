import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertRunCommand, collectWorkflowRunScript } from '../scripts/validate-release-gates.mjs'

test('release gate validator enforces branch protection and supply-chain contracts', () => {
  const result = spawnSync(process.execPath, ['scripts/validate-release-gates.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /release gate contract validated/)
})

test('release gate validator scans newly added public deploy examples', () => {
  const fixturePath = 'deploy/private-value-scan-ci-test.env.example'
  try {
    writeFileSync(fixturePath, 'OPEN_COWORK_GATEWAY_SERVICE_TOKEN=actual-live-token\n')
    const result = spawnSync(process.execPath, ['scripts/validate-release-gates.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, /private-value-scan-ci-test\.env\.example/)
  } finally {
    if (existsSync(fixturePath)) unlinkSync(fixturePath)
  }
})

test('required-command matcher only accepts whole commands inside run: steps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-gates-run-'))
  const workflowPath = join(dir, 'ci.yml')
  try {
    // A real Lint step, an unrelated superstring step, a `defaults.run` mapping, a
    // block-scalar docker build whose command ends in a `\` line continuation, and a
    // command nested in a `$(...)` substitution inside an echo.
    writeFileSync(workflowPath, [
      'jobs:',
      '  validate:',
      '    defaults:',
      '      run:',
      '        shell: bash',
      '    steps:',
      '      - name: Lint',
      '        run: pnpm lint',
      '      - name: Dead code check',
      '        run: pnpm lint:dead-code',
      '      - name: Build cloud OCI image',
      '        run: |',
      '          image_tag="ci"',
      '          docker build -f docker/open-cowork-cloud/Dockerfile \\',
      '            -t open-cowork-cloud:ci \\',
      '            .',
      '      - name: Resolve Linux packaged executable',
      '        run: echo "path=$(node scripts/find-linux-packaged-executable.mjs)" >> "$GITHUB_OUTPUT"',
      '',
    ].join('\n'))

    // Whole-command matches succeed regardless of surrounding shell syntax.
    assert.doesNotThrow(() => assertRunCommand(workflowPath, 'pnpm lint'))
    assert.doesNotThrow(() => assertRunCommand(workflowPath, 'pnpm lint:dead-code'))
    assert.doesNotThrow(() => assertRunCommand(workflowPath, 'docker build -f docker/open-cowork-cloud/Dockerfile'))
    assert.doesNotThrow(() => assertRunCommand(workflowPath, 'node scripts/find-linux-packaged-executable.mjs'))

    // The `defaults.run` mapping and step `name:` lines are never command text.
    const script = collectWorkflowRunScript(workflowPath)
    assert.ok(!script.includes('shell: bash'))
    assert.ok(!script.includes('name: Lint'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('required-command matcher fails when a required whole step is removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-gates-run-'))
  const workflowPath = join(dir, 'ci.yml')
  try {
    // The real `pnpm lint` step is gone; only the longer `pnpm lint:dead-code` step
    // and a comment/name mention of the command remain. A superstring must not
    // satisfy a shorter requirement, so `pnpm lint` now fails the gate.
    writeFileSync(workflowPath, [
      'jobs:',
      '  validate:',
      '    steps:',
      '      # run: pnpm lint (documented but not executed)',
      '      - name: pnpm lint (only referenced in a step name)',
      '        run: pnpm lint:dead-code',
      '',
    ].join('\n'))

    assert.throws(() => assertRunCommand(workflowPath, 'pnpm lint'), /must include pnpm lint/)
    // The superstring itself is still a legitimate whole command.
    assert.doesNotThrow(() => assertRunCommand(workflowPath, 'pnpm lint:dead-code'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
