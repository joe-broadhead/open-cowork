const DEFAULT_API_BASE_URL = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'
const DEFAULT_REQUIRED_CHECKS = [
  'validate',
  'cloud-gates',
  'macos-build',
  'linux-package',
  'windows-package',
  'docs',
  'coverage',
  'analyze (javascript-typescript)',
]
const TRUSTED_CHECK_APP_SLUG = 'github-actions'
const CHECK_RUNS_PAGE_SIZE = 100
const MAX_CHECK_RUN_PAGES = 20

function splitCsv(value, fallback = []) {
  const entries = String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return entries.length > 0 ? entries : fallback
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required.`)
  }
  return value.trim()
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
    throw new Error(`GitHub API request failed (${response.status}) for ${path}: ${body.slice(0, 500)}`)
  }

  return response.json()
}

export function validateRequiredReleaseChecks(input) {
  const requiredChecks = splitCsv(input?.requiredChecks, DEFAULT_REQUIRED_CHECKS)
  const checkRuns = Array.isArray(input?.checkRuns) ? input.checkRuns : []
  const successful = new Set(
    checkRuns
      .filter((run) => run?.status === 'completed' && run?.conclusion === 'success')
      .filter((run) => run?.app?.slug === TRUSTED_CHECK_APP_SLUG)
      .map((run) => String(run.name || '').trim())
      .filter(Boolean),
  )
  const missing = requiredChecks.filter((name) => !successful.has(name))
  if (missing.length > 0) {
    throw new Error(`Release commit is missing successful required checks from the ${TRUSTED_CHECK_APP_SLUG} app: ${missing.join(', ')}.`)
  }
  return { requiredChecks, successfulChecks: Array.from(successful).sort() }
}

export async function verifyReleaseChecks(options) {
  const repository = requiredString(options?.repository, 'repository')
  const sha = requiredString(options?.sha, 'sha')
  const token = requiredString(options?.token, 'token')
  const apiBaseUrl = options?.apiBaseUrl || DEFAULT_API_BASE_URL
  const [owner, repo] = repository.split('/')
  if (!owner || !repo || repository.split('/').length !== 2) {
    throw new Error(`repository must be in owner/name form, got ${repository}.`)
  }
  const checkRuns = []
  for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page += 1) {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=${CHECK_RUNS_PAGE_SIZE}&page=${page}`
    const payload = await githubJson(path, token, apiBaseUrl)
    const pageRuns = Array.isArray(payload?.check_runs) ? payload.check_runs : []
    checkRuns.push(...pageRuns)
    if (pageRuns.length < CHECK_RUNS_PAGE_SIZE) break
    if (page === MAX_CHECK_RUN_PAGES) {
      throw new Error(`Release commit has more than ${MAX_CHECK_RUN_PAGES * CHECK_RUNS_PAGE_SIZE} check runs; tighten OPEN_COWORK_RELEASE_REQUIRED_CHECKS or reduce duplicated checks.`)
    }
  }
  return validateRequiredReleaseChecks({
    requiredChecks: options?.requiredChecks,
    checkRuns,
  })
}

async function main() {
  const result = await verifyReleaseChecks({
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    token: process.env.GITHUB_TOKEN,
    apiBaseUrl: process.env.GITHUB_API_URL || DEFAULT_API_BASE_URL,
    requiredChecks: process.env.OPEN_COWORK_RELEASE_REQUIRED_CHECKS,
  })
  process.stdout.write(`Verified release commit checks: ${result.requiredChecks.join(', ')}.\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
