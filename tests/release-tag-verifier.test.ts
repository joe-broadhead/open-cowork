import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateReleaseTagPayload,
  verifyReleaseTagSignature,
} from '../scripts/verify-release-tag-signature.mjs'

function refPayload(overrides: Record<string, unknown> = {}) {
  return {
    ref: 'refs/tags/v1.2.3',
    object: {
      type: 'tag',
      sha: 'tag-object-sha',
    },
    ...overrides,
  }
}

function tagPayload(overrides: Record<string, unknown> = {}) {
  return {
    tag: 'v1.2.3',
    object: {
      type: 'commit',
      sha: 'target-commit-sha',
    },
    verification: {
      verified: true,
      reason: 'valid',
    },
    ...overrides,
  }
}

test('release tag verifier accepts annotated tags GitHub marks verified', () => {
  const result = validateReleaseTagPayload({
    tagName: 'v1.2.3',
    refPayload: refPayload(),
    tagPayload: tagPayload(),
  })

  assert.deepEqual(result, {
    tagName: 'v1.2.3',
    tagSha: 'tag-object-sha',
    targetSha: 'target-commit-sha',
    reason: 'valid',
  })
})

test('release tag verifier rejects lightweight tags', () => {
  assert.throws(
    () => validateReleaseTagPayload({
      tagName: 'v1.2.3',
      refPayload: refPayload({ object: { type: 'commit', sha: 'target-commit-sha' } }),
      tagPayload: tagPayload(),
    }),
    /must be an annotated signed tag/,
  )
})

test('release tag verifier rejects mismatched tag refs', () => {
  assert.throws(
    () => validateReleaseTagPayload({
      tagName: 'v1.2.3',
      refPayload: refPayload({ ref: 'refs/tags/v9.9.9' }),
      tagPayload: tagPayload(),
    }),
    /expected refs\/tags\/v1\.2\.3/,
  )
})

test('release tag verifier rejects unverified annotated tags', () => {
  assert.throws(
    () => validateReleaseTagPayload({
      tagName: 'v1.2.3',
      refPayload: refPayload(),
      tagPayload: tagPayload({ verification: { verified: false, reason: 'unsigned' } }),
    }),
    /not verified by GitHub signature verification: unsigned/,
  )
})

test('release tag verifier rejects annotated tags without GitHub verification payloads', () => {
  assert.throws(
    () => validateReleaseTagPayload({
      tagName: 'v1.2.3',
      refPayload: refPayload(),
      tagPayload: tagPayload({ verification: undefined }),
    }),
    /has no GitHub signature verification payload/,
  )
})

test('release tag verifier fetches and validates the GitHub tag object', async () => {
  const originalFetch = globalThis.fetch
  const seenPaths: string[] = []
  globalThis.fetch = (async (url) => {
    const path = String(url).replace('https://github.test', '')
    seenPaths.push(path)
    if (path === '/repos/joe-broadhead/open-cowork/git/ref/tags/v1.2.3') {
      return {
        ok: true,
        status: 200,
        json: async () => refPayload(),
        text: async () => JSON.stringify(refPayload()),
      } as Response
    }
    if (path === '/repos/joe-broadhead/open-cowork/git/tags/tag-object-sha') {
      return {
        ok: true,
        status: 200,
        json: async () => tagPayload(),
        text: async () => JSON.stringify(tagPayload()),
      } as Response
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ message: 'not found' }),
      text: async () => 'not found',
    } as Response
  }) as typeof fetch

  try {
    const result = await verifyReleaseTagSignature({
      repository: 'joe-broadhead/open-cowork',
      tagName: 'v1.2.3',
      token: 'github-token',
      apiBaseUrl: 'https://github.test',
    })

    assert.equal(result.tagSha, 'tag-object-sha')
    assert.deepEqual(seenPaths, [
      '/repos/joe-broadhead/open-cowork/git/ref/tags/v1.2.3',
      '/repos/joe-broadhead/open-cowork/git/tags/tag-object-sha',
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})
