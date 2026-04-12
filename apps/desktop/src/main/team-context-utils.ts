import { TEAM_CONTEXT_PREFIX } from './team-policy.js'

export type TeamContextFinding = {
  title: string
  agent: string
  sessionId: string
  text: string
  evidence: string[]
}

export function collectAssistantTranscript(messages: any[]) {
  const transcript = messages
    .filter((item) => (item?.info?.role || item?.role) === 'assistant')
    .map((message) => ((message?.parts || []) as any[])
      .filter((part) => part?.type === 'text' && typeof part?.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim())
    .filter(Boolean)
    .join('\n\n')
    .trim()

  if (!transcript) return ''
  if (transcript.length <= 8000) return transcript
  return `Earlier branch notes omitted.\n\n${transcript.slice(-(8000 - 26)).trimStart()}`
}

function summarizeValue(value: unknown, maxLength = 500) {
  if (value == null) return ''
  const raw = typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : (() => {
          try {
            return JSON.stringify(value)
          } catch {
            return String(value)
          }
        })()

  if (raw.length <= maxLength) return raw
  return `${raw.slice(0, maxLength - 3)}...`
}

export function collectToolEvidence(messages: any[]) {
  const lines: string[] = []
  const seen = new Set<string>()

  for (const message of messages) {
    for (const part of (message?.parts || []) as any[]) {
      if (part?.type !== 'tool') continue

      const state = part?.state || {}
      const toolName = part?.tool || 'tool'
      const output = state.output ?? state.result ?? state.error ?? null
      const attachments = [
        ...((state.attachments || []) as any[]),
        ...(((part as any).attachments || []) as any[]),
      ]

      for (const attachment of attachments) {
        if (!attachment?.url) continue
        const label = attachment.filename
          ? `${attachment.filename} — ${attachment.url}`
          : attachment.url
        const line = `Artifact from ${toolName}: ${label}`
        if (!seen.has(line)) {
          seen.add(line)
          lines.push(line)
        }
      }

      const status = state.status || ''
      if (status === 'error') {
        const line = `${toolName}: error — ${summarizeValue(output || state.raw || 'Failed')}`
        if (!seen.has(line)) {
          seen.add(line)
          lines.push(line)
        }
        continue
      }

      if (output != null) {
        const line = `${toolName}: ${summarizeValue(output)}`
        if (!seen.has(line)) {
          seen.add(line)
          lines.push(line)
        }
      }

      if (lines.length >= 12) return lines
    }
  }

  return lines
}

export function buildTeamContext(findings: TeamContextFinding[]) {
  const sections = findings.map((finding, index) => [
    `## Branch ${index + 1}: ${finding.title}`,
    `Agent: ${finding.agent}`,
    `Session: ${finding.sessionId}`,
    '',
    'Assistant findings:',
    finding.text || 'No assistant summary was produced for this branch.',
    '',
    'Key tool outputs and artifacts:',
    finding.evidence.length > 0
      ? finding.evidence.map((line) => `- ${line}`).join('\n')
      : '- No tool outputs or artifacts were captured for this branch.',
  ].join('\n'))

  return [
    TEAM_CONTEXT_PREFIX,
    'Completed sub-agent findings for the current user request:',
    '',
    sections.join('\n\n'),
  ].join('\n')
}
