import { getPublicAppConfig } from './config-loader.ts'
import { log } from './logger.ts'

export type UpdateCheckResult =
  | { status: 'ok'; currentVersion: string; latestVersion: string; hasUpdate: boolean; releaseUrl: string }
  | { status: 'error'; message: string }
  | { status: 'disabled'; message: string }

// Parse owner/repo from a GitHub URL. Returns null for anything that
// isn't github.com — downstream forks on GitLab / internal hosts
// can extend this later; for now the upstream points at github.com.
function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') return null
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length < 2) return null
    const [owner, repoRaw] = segments
    const repo = repoRaw.replace(/\.git$/, '')
    if (!owner || !repo) return null
    return { owner, repo }
  } catch {
    return null
  }
}

// Trim the leading `v` on tag names (`v0.2.0` → `0.2.0`) so comparisons
// are straightforward. Returns the cleaned string as-is if it doesn't
// start with `v`.
function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '')
}

// Compare two semver-looking strings. Returns 1 if a > b, -1 if a < b,
// 0 if equal. Tolerates pre-release suffixes by comparing the numeric
// core first. Not a full semver implementation — just enough to
// answer "is the server ahead of me?" for our tag shape.
function compareVersions(a: string, b: string): number {
  const parse = (s: string) => normalizeVersion(s).split(/[.+-]/).map((part) => Number(part) || 0)
  const left = parse(a)
  const right = parse(b)
  const len = Math.max(left.length, right.length)
  for (let i = 0; i < len; i += 1) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l > r ? 1 : -1
  }
  return 0
}

const FETCH_TIMEOUT_MS = 5000

// Package.json's `version` is load-bearing for this check — it's what
// we compare against the remote `tag_name`. We read it lazily because
// the module can be imported from test contexts where `require` isn't
// available.
async function getCurrentVersion(): Promise<string> {
  try {
    // package.json is bundled inside the asar; Electron exposes it
    // via `app.getVersion()`. Dynamic import keeps the module
    // importable from test contexts that don't load Electron.
    const electron = await import('electron')
    return electron.app?.getVersion?.() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const config = getPublicAppConfig()
  const helpUrl = config.branding.helpUrl?.trim()
  if (!helpUrl) {
    return { status: 'disabled', message: 'No helpUrl configured — downstream builds set their own update endpoint.' }
  }

  const repo = parseGithubRepo(helpUrl)
  if (!repo) {
    return {
      status: 'disabled',
      message: 'Update check only supports GitHub-hosted releases. Downstream forks can wire their own endpoint.',
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`, {
      signal: controller.signal,
      headers: {
        // Identify the client so GitHub's unauthenticated rate limit
        // bucket is at least attributable if a downstream user hits
        // it. The 60/hr limit on anonymous requests is plenty for a
        // user-initiated click.
        'User-Agent': 'open-cowork-update-check',
        'Accept': 'application/vnd.github+json',
      },
    })

    if (response.status === 404) {
      return { status: 'error', message: 'No releases published yet.' }
    }
    if (!response.ok) {
      return { status: 'error', message: `GitHub API responded with ${response.status}.` }
    }
    const body = await response.json() as { tag_name?: string; html_url?: string }
    if (!body.tag_name || !body.html_url) {
      return { status: 'error', message: 'Malformed release payload.' }
    }

    const current = await getCurrentVersion()
    const hasUpdate = compareVersions(body.tag_name, current) > 0

    log('app', `Update check: current=${current} latest=${body.tag_name} hasUpdate=${hasUpdate}`)

    return {
      status: 'ok',
      currentVersion: current,
      latestVersion: normalizeVersion(body.tag_name),
      hasUpdate,
      releaseUrl: body.html_url,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'error', message }
  } finally {
    clearTimeout(timeout)
  }
}
