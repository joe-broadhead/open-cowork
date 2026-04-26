import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isTrustedResolvedShellPath, isTrustedShellPath } from '../apps/desktop/src/main/shell-env.ts'

test('isTrustedShellPath accepts only known shell binaries', () => {
  const trustedShell = ['/bin/sh', '/bin/bash', '/bin/zsh'].find((candidate) => isTrustedShellPath(candidate))
  assert.ok(trustedShell, 'expected at least one trusted shell path on the host')

  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-shell-'))
  const fakeShell = join(tempRoot, 'zsh')
  writeFileSync(fakeShell, '#!/bin/sh\nenv -0\n')

  try {
    assert.equal(isTrustedShellPath(trustedShell), true)
    assert.equal(isTrustedShellPath(fakeShell), false)
    assert.equal(isTrustedShellPath(null), false)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('isTrustedResolvedShellPath accepts known nix store shell names', () => {
  assert.equal(isTrustedResolvedShellPath('/nix/store/abc123-zsh-5.9/bin/zsh'), true)
  assert.equal(isTrustedResolvedShellPath('/nix/store/abc123-fish-3.7/bin/fish'), false)
})
