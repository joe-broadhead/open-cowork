import type { UpdateReleaseSourceDescriptor } from '@open-cowork/shared'

const UPDATE_CHANNEL_PATTERN = /^[A-Za-z0-9._-]{1,80}$/

export function normalizeUpdateChannel(value?: string | null) {
  const channel = value?.trim() || 'latest'
  return UPDATE_CHANNEL_PATTERN.test(channel) ? channel : null
}

export function normalizeUpdateSourceUrl(
  value: string,
  options: { allowLocalHttp?: boolean } = {},
): string | null {
  try {
    const parsed = new URL(value)
    const isLocalHttp = parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    const allowLocalHttp = options.allowLocalHttp !== false
    if (parsed.protocol !== 'https:' && !(allowLocalHttp && isLocalHttp)) return null
    parsed.username = ''
    parsed.password = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

export function channelFileName(channel: string, platform: NodeJS.Platform = process.platform) {
  if (platform === 'darwin') return `${channel}-mac.yml`
  if (platform === 'win32') return `${channel}.yml`
  return `${channel}-linux.yml`
}

export function releaseFeedFileUrl(
  baseUrl: string,
  channel: string,
  platform: NodeJS.Platform = process.platform,
) {
  const base = new URL(baseUrl)
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  return new URL(channelFileName(channel, platform), base).toString()
}

export function genericReleaseSourceDescriptor(input: {
  label: string
  channel: string
  hasHeaders: boolean
}): UpdateReleaseSourceDescriptor {
  return {
    kind: 'generic-http',
    label: input.label,
    channel: input.channel,
    requiresAuth: input.hasHeaders,
    authKind: input.hasHeaders ? 'static-headers' : 'none',
  }
}

export function parseUpdateInfoVersion(yamlText: string): string | null {
  const match = yamlText.match(/(?:^|\n)version:\s*["']?([^"'\n\r]+)["']?/)
  return match?.[1]?.trim() || null
}
