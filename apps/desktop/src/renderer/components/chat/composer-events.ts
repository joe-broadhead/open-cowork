import type { ChartArtifactSource, SessionArtifactAttachment } from '@open-cowork/shared'
import type { Attachment } from './chat-input-types'

export const COMPOSER_INSERT_EVENT = 'open-cowork:composer-insert'
export const COMPOSER_COMPOSE_EVENT = 'open-cowork:composer-compose'

export type ComposerComposeDetail = {
  text?: string
  attachments?: Attachment[]
  replaceText?: boolean
}

export function attachmentFromArtifact(payload: SessionArtifactAttachment): Attachment {
  return {
    mime: payload.mime,
    url: payload.url,
    filename: payload.filename,
    preview: payload.mime.startsWith('image/') ? payload.url : undefined,
  }
}

export function dispatchComposerCompose(detail: ComposerComposeDetail) {
  window.dispatchEvent(new CustomEvent(COMPOSER_COMPOSE_EVENT, { detail }))
}

export function buildChartRerenderPrompt(chart: ChartArtifactSource): string {
  const spec = JSON.stringify(chart.spec, null, 2)
  const titleLine = chart.title ? `Title: ${chart.title}\n` : ''
  return [
    'Please recreate or refine the attached chart in this thread.',
    '',
    'Use the original chart spec below as the exact source of truth.',
    '',
    `${titleLine}Format: ${chart.format}`,
    '',
    '```json',
    spec,
    '```',
  ].join('\n')
}
