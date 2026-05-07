const DEFAULT_API_BASE_URL = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'

function fail(message) {
  throw new Error(message)
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${name} is required.`)
  }
  return value.trim()
}

export function validateReleaseTagPayload(input) {
  const tagName = requiredString(input?.tagName, 'tagName')
  const refPayload = input?.refPayload
  const tagPayload = input?.tagPayload

  if (!refPayload || typeof refPayload !== 'object') {
    fail('GitHub tag ref payload is missing or invalid.')
  }
  if (!tagPayload || typeof tagPayload !== 'object') {
    fail('GitHub annotated tag payload is missing or invalid.')
  }

  const expectedRef = `refs/tags/${tagName}`
  if (refPayload.ref !== expectedRef) {
    fail(`GitHub returned tag ref ${String(refPayload.ref || '')}, expected ${expectedRef}.`)
  }

  if (refPayload.object?.type !== 'tag') {
    fail(`Release tag ${tagName} must be an annotated signed tag; lightweight tags are not accepted.`)
  }

  if (tagPayload.tag !== tagName) {
    fail(`GitHub returned annotated tag ${String(tagPayload.tag || '')}, expected ${tagName}.`)
  }

  const verification = tagPayload.verification
  if (!verification || typeof verification !== 'object') {
    fail(`Release tag ${tagName} has no GitHub signature verification payload.`)
  }

  if (verification.verified !== true) {
    const reason = typeof verification.reason === 'string' && verification.reason.length > 0
      ? verification.reason
      : 'unknown reason'
    fail(`Release tag ${tagName} is not verified by GitHub signature verification: ${reason}.`)
  }

  return {
    tagName,
    tagSha: refPayload.object.sha,
    targetSha: tagPayload.object?.sha,
    reason: verification.reason || 'valid',
  }
}

async function githubJson(path, token, apiBaseUrl = DEFAULT_API_BASE_URL) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
  })

  if (!response.ok) {
    const body = await response.text()
    fail(`GitHub API request failed (${response.status}) for ${path}: ${body.slice(0, 500)}`)
  }

  return response.json()
}

export async function verifyReleaseTagSignature(options) {
  const repository = requiredString(options?.repository, 'repository')
  const tagName = requiredString(options?.tagName, 'tagName')
  const token = requiredString(options?.token, 'token')
  const apiBaseUrl = options?.apiBaseUrl || DEFAULT_API_BASE_URL

  const [owner, repo] = repository.split('/')
  if (!owner || !repo || repository.split('/').length !== 2) {
    fail(`repository must be in owner/name form, got ${repository}.`)
  }

  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const refPayload = await githubJson(`${repoPath}/git/ref/tags/${encodeURIComponent(tagName)}`, token, apiBaseUrl)
  const tagSha = refPayload?.object?.sha
  if (typeof tagSha !== 'string' || tagSha.length === 0) {
    fail(`GitHub tag ref for ${tagName} did not include an annotated tag SHA.`)
  }
  const tagPayload = await githubJson(`${repoPath}/git/tags/${encodeURIComponent(tagSha)}`, token, apiBaseUrl)
  return validateReleaseTagPayload({ tagName, refPayload, tagPayload })
}

async function main() {
  const result = await verifyReleaseTagSignature({
    repository: process.env.GITHUB_REPOSITORY,
    tagName: process.env.GITHUB_REF_NAME,
    token: process.env.GITHUB_TOKEN,
    apiBaseUrl: process.env.GITHUB_API_URL || DEFAULT_API_BASE_URL,
  })
  process.stdout.write(`Verified signed release tag ${result.tagName} (${result.reason}).\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
