import { sanitizeForExport, sanitizeLogMessage } from '@open-cowork/shared'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RAW_BYOK_KEY = ['sk', 'byokboundarysecretvalue1234567890abcdef123456'].join('-')

test('BYOK raw secrets are redacted from logs and diagnostics text', () => {
  const logLine = `cloud byok provider rejected apiKey=${RAW_BYOK_KEY}`
  assert.equal(sanitizeLogMessage(logLine).includes(RAW_BYOK_KEY), false)
  assert.equal(sanitizeForExport(`diagnostics ${logLine}`).includes(RAW_BYOK_KEY), false)
})

test('BYOK management surface is not exposed through renderer cache or gateway payload modules', () => {
  const files = [
    'packages/shared/src/index.ts',
    'apps/desktop/src/preload/index.ts',
    'apps/desktop/src/main/cloud-workspace-adapter.ts',
    'apps/desktop/src/main/cloud-workspace-cache.ts',
    'apps/gateway/src/cloud-gateway.ts',
    'apps/gateway/src/gateway-runtime.ts',
    'apps/gateway/src/event-renderer.ts',
    'apps/gateway/src/session-stream-manager.ts',
  ]

  for (const file of files) {
    const source = readFileSync(join(process.cwd(), file), 'utf8')
    assert.equal(source.toLowerCase().includes('byok'), false, `${file} must not expose BYOK payloads`)
  }
})
