import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

describe('domain boundary contracts', () => {
  it('keeps operator action semantics in the canonical registry, not forked in provider adapters', () => {
    const text = read('src/channels/telegram.ts')
    for (const term of ["case '/status'", "case '/bind'", "case '/project'"]) {
      expect(text, `telegram adapter must not fork ${term}`).not.toContain(term)
    }
  })

  it('keeps readiness free of raw security denial probe values', () => {
    const text = read('src/readiness.ts')
    for (const term of ['HTTP_RAW_SECRET_PROBE', 'CHANNEL_RAW_PRIVATE_PROBE', 'SECRET_RAW_VALUE_PROBE']) {
      expect(text, `readiness must expose share-safe drift status only, not ${term}`).not.toContain(term)
    }
  })

  it('keeps observability snapshot assembly behind the snapshot boundary', () => {
    for (const file of ['src/daemon-routes/system.ts', 'src/mission-data.ts', 'src/incident-bundle.ts']) {
      const text = read(file)
      expect(text).toContain('observability-snapshot')
      expect(text).not.toMatch(/\bbuildTraceCorrelationIndex\b/)
      expect(text).not.toMatch(/\bevaluateObservabilitySLOs\b/)
      expect(text).not.toMatch(/\blistWorkEvents\b/)
      expect(text).not.toMatch(/\blistChannelBindings\b/)
    }
  })

  it('keeps channel-failure SLO detection centralized', () => {
    for (const file of ['src/evidence-export.ts', 'src/incident-bundle.ts', 'src/daemon-routes/system.ts', 'src/mission-data.ts']) {
      expect(read(file)).not.toContain('channel|telegram|whatsapp|discord')
    }
    expect(read('src/observability-contract.ts')).toContain('countChannelFailureEvents')
  })

  it('keeps operational redaction patterns in one helper module', () => {
    for (const file of ['src/evidence-export.ts', 'src/incident-bundle.ts']) {
      const text = read(file)
      expect(text).toContain('operational-redaction')
      expect(text).not.toContain('SESSION_ID_TEXT_PATTERN')
      expect(text).not.toContain('PRIVATE_TEXT_PATTERN')
      expect(text).not.toContain('PHONE_LIKE_PATTERN')
      expect(text).not.toContain('CHANNEL_TARGET_TEXT_PATTERN')
    }
  })
})

function read(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf-8')
}
