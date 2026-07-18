import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest, getConfig, getConfigPath, updateConfig } from '../../config.js'
import { discordChannel, verifyDiscordSignature } from '../../channels/discord.js'
import { mapWhatsAppMessages, whatsappChannel } from '../../channels/whatsapp.js'
import { __telegramTest, telegramChannel } from '../../channels/telegram.js'

// Fuzz the untrusted external-input parsers. Adversarial / malformed / truncated
// inputs must fail CLOSED: the parser rejects or defaults, never throws an
// unhandled error, never crashes the handler, and never leaks a configured
// secret. Real product entry points are used (not reimplementations).

const SEED = Number(process.env['FAST_CHECK_SEED']) || 0xf0e1
// Distinctive secrets planted in config; no parser output may echo them back.
const WHATSAPP_APP_SECRET = 'fuzz-whatsapp-app-secret-DO-NOT-LEAK'
const DISCORD_PUBLIC_KEY = '0'.repeat(64) // 32-byte hex; structurally valid, never matches

// A recursive arbitrary that produces deeply-nested, wrong-typed, adversarial
// JSON-ish objects to stress the optional-chaining / String() coercion paths.
const adversarialValue: fc.Arbitrary<unknown> = fc.letrec(tie => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constantFrom(null, undefined, '', 0, -1, NaN, Infinity, true, false, '__proto__', '{}', '[]'),
    fc.string(),
    fc.integer(),
    fc.double({ noNaN: false }),
    fc.array(tie('node'), { maxLength: 4 }),
    fc.dictionary(fc.string({ maxLength: 8 }), tie('node'), { maxKeys: 4 }),
  ),
})).node

describe('external-input parser fuzzing', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-fuzz-'))
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('config file parser fails closed on arbitrary raw bytes', () => {
    fc.assert(
      fc.property(fc.string(), raw => {
        fs.writeFileSync(getConfigPath(), raw)
        clearConfigCacheForTest()
        try {
          const config = getConfig()
          // Parsed successfully (valid JSON object): must be structurally sound.
          expect(config).toBeTruthy()
          expect(Number.isInteger(config.httpPort)).toBe(true)
        } catch (err) {
          // Rejected: must be a clear, non-empty Error (fail closed), and the
          // original bytes are never mutated on disk.
          expect(err).toBeInstanceOf(Error)
          expect(String((err as Error).message)).toContain('invalid')
          expect(fs.readFileSync(getConfigPath(), 'utf-8')).toBe(raw)
        }
      }),
      { seed: SEED, numRuns: 120 },
    )
  })

  it('mapWhatsAppMessages never throws and only emits well-formed messages', () => {
    fc.assert(
      fc.property(adversarialValue, payload => {
        const messages = mapWhatsAppMessages(payload)
        expect(Array.isArray(messages)).toBe(true)
        for (const msg of messages) {
          expect(msg.provider).toBe('whatsapp')
          expect(typeof msg.chatId).toBe('string')
          expect(msg.chatId.length).toBeGreaterThan(0)
          expect(typeof msg.text).toBe('string')
          expect(msg.text.length).toBeGreaterThan(0)
          expect(typeof msg.timestamp).toBe('string')
          expect(Number.isNaN(Date.parse(msg.timestamp))).toBe(false)
        }
      }),
      { seed: SEED, numRuns: 150 },
    )
  })

  it('whatsapp signature verification fails closed on adversarial headers/bodies', () => {
    updateConfig({ channels: { whatsapp: { appSecret: WHATSAPP_APP_SECRET } } } as never)
    clearConfigCacheForTest()
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), fc.string(), (header, body) => {
        const result = whatsappChannel.verifySignature(header, body)
        // Random header can never be a valid HMAC over the body.
        expect(result).toBe(false)
      }),
      { seed: SEED, numRuns: 120 },
    )
  })

  it('discord signature verification never throws and rejects garbage', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), fc.string(), (key, sig, ts, body) => {
        const result = verifyDiscordSignature(key, sig, ts, body)
        expect(typeof result).toBe('boolean')
        expect(result).toBe(false)
      }),
      { seed: SEED, numRuns: 120 },
    )
  })

  it('telegram inbound handler never throws and only dispatches well-formed messages', async () => {
    const received: unknown[] = []
    telegramChannel.onMessage(async msg => {
      received.push(msg)
    })
    await fc.assert(
      fc.asyncProperty(adversarialValue, fc.oneof(fc.string(), fc.constant(undefined)), async (update, text) => {
        received.length = 0
        const rawMessage = (update as { message?: unknown } | null)?.message ?? update
        // The real poll loop calls handleInboundMessage(update, message, text, from).
        await __telegramTest.handleInboundMessage(update, rawMessage, text as string, undefined)
        // Every dispatched message (if any) is a structurally valid ChannelMessage.
        for (const msg of received as Array<Record<string, unknown>>) {
          expect(msg['provider']).toBe('telegram')
          expect(typeof msg['chatId']).toBe('string')
          expect(typeof msg['text']).toBe('string')
          expect(typeof msg['messageId'] === 'string' || msg['messageId'] === undefined).toBe(true)
          expect(typeof msg['timestamp']).toBe('string')
        }
      }),
      { seed: SEED, numRuns: 120 },
    )
  })

  it('discord interaction webhook fails closed and never leaks the public key', async () => {
    updateConfig({ channels: { discord: { enabled: true, publicKey: DISCORD_PUBLIC_KEY } } } as never)
    clearConfigCacheForTest()
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.dictionary(fc.constantFrom('x-signature-ed25519', 'x-signature-timestamp', 'content-type'), fc.string(), { maxKeys: 3 }),
        async (rawBody, headers) => {
          const response = await discordChannel.handleInteraction(rawBody, headers)
          expect(response).toBeTruthy()
          expect(typeof response.status).toBe('number')
          // Without a valid Ed25519 signature the request is rejected (401) and
          // never reaches inbound handling.
          expect(response.status).toBe(401)
          const serialized = JSON.stringify(response)
          expect(serialized).not.toContain(DISCORD_PUBLIC_KEY)
        },
      ),
      { seed: SEED, numRuns: 80 },
    )
  })
})
