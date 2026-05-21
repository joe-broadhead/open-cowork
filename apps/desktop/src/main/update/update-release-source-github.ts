import type { UpdateReleaseSourceDescriptor } from '@open-cowork/shared'
import type { UpdateReleaseSourceConfig } from '../config-types.ts'
import { parseGithubRepo } from './update-version.ts'
import { normalizeUpdateChannel } from './update-release-source-generic.ts'

export type GithubReleaseSourceConfig = Extract<UpdateReleaseSourceConfig, { kind: 'github-releases' }>

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

function normalizeGithubOwnerRepo(owner?: string | null, repo?: string | null) {
  const normalizedOwner = owner?.trim()
  const normalizedRepo = repo?.trim()
  if (!normalizedOwner || !normalizedRepo) return null
  if (!GITHUB_OWNER_PATTERN.test(normalizedOwner) || !GITHUB_REPO_PATTERN.test(normalizedRepo)) return null
  return { owner: normalizedOwner, repo: normalizedRepo }
}

export function resolveGithubReleaseSourceInput(input: {
  config?: GithubReleaseSourceConfig
  brandingHelpUrl?: string | null
}): { owner: string; repo: string; channel: string; label: string; token: string | null } | null {
  const channel = normalizeUpdateChannel(input.config?.channel || 'latest')
  if (!channel) return null
  const label = input.config?.label?.trim() || 'GitHub Releases'
  const token = input.config?.auth?.kind === 'github-token' && input.config.auth.token?.trim()
    ? input.config.auth.token.trim()
    : null

  const owner = input.config?.owner?.trim()
  const repo = input.config?.repo?.trim()
  if (owner || repo) {
    const normalized = normalizeGithubOwnerRepo(owner, repo)
    return normalized ? { ...normalized, channel, label, token } : null
  }

  const parsed = input.brandingHelpUrl ? parseGithubRepo(input.brandingHelpUrl) : null
  const normalized = parsed ? normalizeGithubOwnerRepo(parsed.owner, parsed.repo) : null
  if (!normalized) return null
  return { ...normalized, channel, label, token }
}

export function githubReleaseSourceDescriptor(input: {
  label: string
  channel: string
  token: string | null
}): UpdateReleaseSourceDescriptor {
  return {
    kind: 'github-releases',
    label: input.label,
    channel: input.channel,
    requiresAuth: Boolean(input.token),
    authKind: input.token ? 'github-token' : 'none',
  }
}

export function githubApiReleaseUrl(owner: string, repo: string, channel: string) {
  return channel === 'latest'
    ? `https://api.github.com/repos/${owner}/${repo}/releases/latest`
    : `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(channel)}`
}

export function githubHtmlReleasesUrl(owner: string, repo: string) {
  return `https://github.com/${owner}/${repo}/releases`
}
