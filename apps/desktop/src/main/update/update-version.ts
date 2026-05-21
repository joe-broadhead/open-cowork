import semver from 'semver'

export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
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

export function normalizeVersion(value: string): string {
  const trimmed = value.trim()
  return semver.clean(trimmed) || semver.coerce(trimmed)?.version || '0.0.0'
}

export function compareVersions(a: string, b: string): number {
  return Math.sign(semver.compare(normalizeVersion(a), normalizeVersion(b)))
}
