import test from 'node:test'
import assert from 'node:assert/strict'

import { validateReleaseActor } from '../scripts/verify-release-actor.mjs'
import {
  validateRequiredReleaseChecks,
  verifyReleaseChecks,
} from '../scripts/verify-release-checks.mjs'

test('release actor verifier requires an explicit allowlist', () => {
  assert.doesNotThrow(() => validateReleaseActor({
    actor: 'release-bot',
    allowedActors: 'release-bot,joe-broadhead',
  }))

  assert.throws(
    () => validateReleaseActor({
      actor: 'joe-broadhead',
      repositoryOwner: 'joe-broadhead',
    }),
    /OPEN_COWORK_RELEASE_ALLOWED_ACTORS is required/,
  )

  assert.throws(
    () => validateReleaseActor({
      actor: 'drive-by-tagger',
      allowedActors: 'release-bot,joe-broadhead',
    }),
    /not allowed/,
  )
})

test('release checks verifier requires every configured check to be successful', () => {
  assert.deepEqual(validateRequiredReleaseChecks({
    requiredChecks: 'validate,coverage',
    checkRuns: [
      { name: 'validate', status: 'completed', conclusion: 'success' },
      { name: 'coverage', status: 'completed', conclusion: 'success' },
      { name: 'release-preflight', status: 'completed', conclusion: 'success' },
    ],
  }).requiredChecks, ['validate', 'coverage'])

  assert.throws(
    () => validateRequiredReleaseChecks({
      requiredChecks: 'validate,coverage',
      checkRuns: [
        { name: 'validate', status: 'completed', conclusion: 'success' },
        { name: 'coverage', status: 'completed', conclusion: 'failure' },
      ],
    }),
    /coverage/,
  )
})

test('release checks verifier paginates commit check runs from GitHub', async () => {
  const originalFetch = globalThis.fetch
  const seenUrls: string[] = []
  globalThis.fetch = (async (url) => {
    seenUrls.push(String(url))
    const isFirstPage = String(url).endsWith('&page=1')
    return {
      ok: true,
      status: 200,
      json: async () => ({
        check_runs: isFirstPage
          ? Array.from({ length: 100 }, (_, index) => ({
              name: `non-required-${index}`,
              status: 'completed',
              conclusion: 'success',
            }))
          : [
              { name: 'validate', status: 'completed', conclusion: 'success' },
            ],
      }),
      text: async () => '',
    } as Response
  }) as typeof fetch

  try {
    await verifyReleaseChecks({
      repository: 'joe-broadhead/open-cowork',
      sha: 'abc123',
      token: 'github-token',
      apiBaseUrl: 'https://github.test',
      requiredChecks: 'validate',
    })
    assert.deepEqual(seenUrls, [
      'https://github.test/repos/joe-broadhead/open-cowork/commits/abc123/check-runs?per_page=100&page=1',
      'https://github.test/repos/joe-broadhead/open-cowork/commits/abc123/check-runs?per_page=100&page=2',
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})
