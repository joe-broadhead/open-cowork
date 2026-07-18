import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest, getConfig, getConfigPath } from '../../config.js'

// Property: normalization is total over arbitrary partial configs. Every input
// either (a) throws a *clear* validation Error with a non-empty message, or
// (b) returns a structurally valid normalized config with bounded numeric
// fields. It must never throw a non-Error, and never return a malformed config.

const SEED = Number(process.env['FAST_CHECK_SEED']) || 0xc0ff
const PROPERTY_TEST_TIMEOUT_MS = 60_000

// A grab-bag of config-shaped fragments biased to actually reach the
// normalizers (bounded integers, enums, profile maps) plus adversarial values.
const scalarArb = fc.oneof(
  fc.integer(),
  fc.double({ noNaN: false }),
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(-1),
  fc.constant(0),
  fc.constant(999999999),
)

const partialConfigArb = fc.record(
  {
    opencodeUrl: fc.oneof(fc.webUrl(), fc.string(), scalarArb),
    httpPort: scalarArb,
    heartbeat: fc.oneof(fc.record({ intervalMs: scalarArb }), scalarArb),
    channelSync: fc.oneof(
      fc.record({ enabled: fc.boolean(), intervalMs: scalarArb, providerBackoffMs: scalarArb, maxDeliveryAttempts: scalarArb }, { requiredKeys: [] }),
      scalarArb,
    ),
    security: fc.oneof(fc.object({ maxDepth: 2 }), scalarArb),
    governance: fc.oneof(fc.object({ maxDepth: 2 }), scalarArb),
    storage: fc.oneof(fc.record({ backend: fc.oneof(fc.constantFrom('sqlite', 'nonsense'), scalarArb) }, { requiredKeys: [] }), scalarArb),
    scheduler: fc.oneof(fc.object({ maxDepth: 2 }), scalarArb),
    profiles: fc.oneof(fc.dictionary(fc.string({ maxLength: 12 }), fc.object({ maxDepth: 2 }), { maxKeys: 3 }), scalarArb),
    channels: fc.oneof(fc.object({ maxDepth: 2 }), scalarArb),
  },
  { requiredKeys: [] },
)

describe('config normalization (property)', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-config-prop-'))
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    clearConfigCacheForTest()
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    clearConfigCacheForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('never throws unexpectedly; yields a clear error or a valid normalized config', () => {
    fc.assert(
      fc.property(partialConfigArb, raw => {
        fs.mkdirSync(testDir, { recursive: true })
        fs.writeFileSync(getConfigPath(), JSON.stringify(raw))
        clearConfigCacheForTest()

        let config: ReturnType<typeof getConfig> | undefined
        try {
          config = getConfig()
        } catch (err) {
          // Fail-closed contract: must be a real Error with a human-readable
          // message, never a bare throw / TypeError from unchecked access.
          expect(err).toBeInstanceOf(Error)
          expect(String((err as Error).message).length).toBeGreaterThan(0)
          return
        }

        // Returned config must be structurally sound with bounded fields.
        expect(config).toBeTruthy()
        expect(Number.isInteger(config.httpPort)).toBe(true)
        expect(config.httpPort).toBeGreaterThanOrEqual(1)
        expect(config.httpPort).toBeLessThanOrEqual(65535)
        expect(config.heartbeat.intervalMs).toBeGreaterThanOrEqual(1000)
        expect(config.channelSync.intervalMs).toBeGreaterThanOrEqual(1000)
        expect(config.channelSync.maxDeliveryAttempts).toBeGreaterThanOrEqual(1)
        expect(typeof config.opencodeUrl).toBe('string')
        expect(config.opencodeUrl.length).toBeGreaterThan(0)
        expect(config.profiles && typeof config.profiles).toBe('object')
      }),
      { seed: SEED, numRuns: 120 },
    )
  }, PROPERTY_TEST_TIMEOUT_MS)
})
