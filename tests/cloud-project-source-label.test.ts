import test from 'node:test'
import assert from 'node:assert/strict'

import { cloudGitRepositoryLabel } from '../packages/shared/src/project-source.ts'

// `cloudGitRepositoryLabel` is single-sourced in @open-cowork/shared and consumed
// by BOTH the desktop thread sidebar (ThreadList.tsx) and the Cloud Web thread
// list (thread-workbench.ts) so the two apps derive the identical git project
// label. These cases pin the exact behavior both call sites previously inlined.

test('cloudGitRepositoryLabel strips the trailing .git and keeps the final path segment', () => {
  assert.equal(cloudGitRepositoryLabel('https://github.com/acme/web.git'), 'web')
  assert.equal(cloudGitRepositoryLabel('git@github.com:acme/web.git'), 'web')
  assert.equal(cloudGitRepositoryLabel('https://example.test/team/sub/project.git'), 'project')
})

test('cloudGitRepositoryLabel handles URLs without a .git suffix', () => {
  assert.equal(cloudGitRepositoryLabel('https://github.com/acme/web'), 'web')
})

test('cloudGitRepositoryLabel ignores a trailing slash', () => {
  assert.equal(cloudGitRepositoryLabel('https://github.com/acme/web/'), 'web')
  assert.equal(cloudGitRepositoryLabel('https://github.com/acme/web.git/'), 'web')
})

test('cloudGitRepositoryLabel falls back to the input when there is no path segment', () => {
  // Each caller passes its own localized fallback (e.g. "Git repository") when
  // the repositoryUrl is missing; the helper then returns it unchanged.
  assert.equal(cloudGitRepositoryLabel('Git repository'), 'Git repository')
  assert.equal(cloudGitRepositoryLabel('git repository'), 'git repository')
})
