import type { UpdateReleaseSourceDescriptor } from '@open-cowork/shared'
import type { UpdateReleaseSourceConfig } from './config-types.ts'
import { parseGithubRepo } from './update-version.ts'

export type GithubReleaseSourceConfig = Extract<UpdateReleaseSourceConfig, { kind: 'github-releases' }>

export function resolveGithubReleaseSourceInput(input: {
  config?: GithubReleaseSourceConfig
  brandingHelpUrl?: string | null
}): { owner: string; repo: string; channel: string; label: string; token: string | null } | null {
  const channel = input.config?.channel?.trim() || 'latest'
  const label = input.config?.label?.trim() || 'GitHub Releases'
  const token = input.config?.auth?.kind === 'github-token' && input.config.auth.token?.trim()
    ? input.config.auth.token.trim()
    : null

  const owner = input.config?.owner?.trim()
  const repo = input.config?.repo?.trim()
  if (owner && repo) return { owner, repo, channel, label, token }

  const parsed = input.brandingHelpUrl ? parseGithubRepo(input.brandingHelpUrl) : null
  if (!parsed) return null
  return { ...parsed, channel, label, token }
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
