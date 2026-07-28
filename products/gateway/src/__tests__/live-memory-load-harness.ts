import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  addLiveClient,
  clearLiveClientsForTest,
  liveClientCountForTest,
  livePrincipalCountForTest,
  liveSessionSnapshotCountForTest,
  primeSessionUpdatePayloadForTest,
} from '../live.js'
import { IncrementalSseParser, readUpstreamSseFrames, UpstreamSseParserError } from '../upstream-sse-parser.js'

const GENERATIONS = 6
const PRINCIPALS_PER_GENERATION = 30_000
const REPLAY_OVERFLOW_ATTEMPTS_PER_GENERATION = 10_000
const REPLAY_SNAPSHOTS = 1_000
const REPLAY_CLIENTS_PER_GENERATION = 16
const REPLAY_BODY = 'x'.repeat(3 * 1024)
const PARSER_OPERATIONS_PER_GENERATION = 1_000
const PARSER_CANCELLATIONS_PER_GENERATION = 128
const PARSER_LIMIT_BYTES = 4 * 1024
const EXACT_LIMIT_FRAME = new Uint8Array(PARSER_LIMIT_BYTES + 2)
EXACT_LIMIT_FRAME.fill(97, 0, PARSER_LIMIT_BYTES)
EXACT_LIMIT_FRAME[PARSER_LIMIT_BYTES] = 10
EXACT_LIMIT_FRAME[PARSER_LIMIT_BYTES + 1] = 10
const OVER_LIMIT_FRAME = new Uint8Array(PARSER_LIMIT_BYTES + 1)
OVER_LIMIT_FRAME.fill(98)

interface PhaseReport {
  generations: number
  operationsPerGeneration: number
  heapUsedBytes: number[]
  heapGrowthBytes: number
}

class SinkResponse extends EventEmitter {
  readonly socket = new EventEmitter()
  writableLength = 0
  writableEnded = false
  writableNeedDrain = false
  destroyed = false

  writeHead(_status: number, _headers: Record<string, string>): void {}

  write(_data: string): boolean {
    return true
  }

  end(_data?: string): void {
    this.writableEnded = true
  }

  destroy(): void {
    this.destroyed = true
  }
}

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-live-memory-load-'))
process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = configDir

try {
  collectGarbage()
  clearLiveClientsForTest()

  churnAuthenticatedPrincipals(-1, 10_000)
  await forceGcAndMeasure()

  const principalHeapUsedBytes: number[] = []
  for (let generation = 0; generation < GENERATIONS; generation++) {
    churnAuthenticatedPrincipals(generation, PRINCIPALS_PER_GENERATION)
    assertLiveBookkeeping(0, 0)
    principalHeapUsedBytes.push(await forceGcAndMeasure())
  }

  clearLiveClientsForTest()
  for (let index = 0; index < REPLAY_SNAPSHOTS; index++) {
    primeSessionUpdatePayloadForTest(`stable-session-${index}`, replayEvent(index, -1))
  }
  churnReplayState(-1)
  await forceGcAndMeasure()

  const replayHeapUsedBytes: number[] = []
  for (let generation = 0; generation < GENERATIONS; generation++) {
    churnReplayState(generation)
    if (liveSessionSnapshotCountForTest() !== REPLAY_SNAPSHOTS) {
      throw new Error(`replay snapshot bound changed: ${liveSessionSnapshotCountForTest()}`)
    }
    assertLiveBookkeeping(0, 0)
    replayHeapUsedBytes.push(await forceGcAndMeasure())
  }

  await churnParserState(100, 16)
  await forceGcAndMeasure()

  let exactFrames = 0
  let rejectedFrames = 0
  let cancelledStreams = 0
  const parserHeapUsedBytes: number[] = []
  for (let generation = 0; generation < GENERATIONS; generation++) {
    const result = await churnParserState(PARSER_OPERATIONS_PER_GENERATION, PARSER_CANCELLATIONS_PER_GENERATION)
    exactFrames += result.exactFrames
    rejectedFrames += result.rejectedFrames
    cancelledStreams += result.cancelledStreams
    parserHeapUsedBytes.push(await forceGcAndMeasure())
  }

  const report = {
    principalChurn: {
      generations: GENERATIONS,
      operationsPerGeneration: PRINCIPALS_PER_GENERATION,
      heapUsedBytes: principalHeapUsedBytes,
      heapGrowthBytes: retainedHeapGrowth(principalHeapUsedBytes),
      retainedClients: liveClientCountForTest(),
      retainedPrincipals: livePrincipalCountForTest(),
    },
    replayChurn: {
      generations: GENERATIONS,
      operationsPerGeneration: REPLAY_OVERFLOW_ATTEMPTS_PER_GENERATION,
      heapUsedBytes: replayHeapUsedBytes,
      heapGrowthBytes: retainedHeapGrowth(replayHeapUsedBytes),
      retainedSnapshots: liveSessionSnapshotCountForTest(),
    },
    parserChurn: {
      generations: GENERATIONS,
      operationsPerGeneration: PARSER_OPERATIONS_PER_GENERATION,
      heapUsedBytes: parserHeapUsedBytes,
      heapGrowthBytes: retainedHeapGrowth(parserHeapUsedBytes),
      exactFrames,
      rejectedFrames,
      cancelledStreams,
    },
  } satisfies Record<string, PhaseReport & Record<string, number | number[]>>

  process.stdout.write(JSON.stringify(report))
} finally {
  clearLiveClientsForTest()
  delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
  fs.rmSync(configDir, { recursive: true, force: true })
}

function churnAuthenticatedPrincipals(generation: number, count: number): void {
  for (let index = 0; index < count; index++) {
    const sequence = Math.max(0, generation + 1) * PRINCIPALS_PER_GENERATION + index
    const id = `principal-churn-${generation}-${index}`
    const lifecycle = new EventEmitter()
    const response = new SinkResponse()
    const admission = addLiveClient(id, response, undefined, undefined, {
      lifecycle,
      limits: { maxClients: 1, maxClientsPerPrincipal: 1 },
      principal: `http-token:${sequence.toString(16).padStart(24, '0')}`,
    })
    if (!admission.accepted) throw new Error(`authenticated principal was rejected at ${generation}:${index}`)
    lifecycle.emit('close')
  }
}

function churnReplayState(generation: number): void {
  for (let index = 0; index < REPLAY_SNAPSHOTS; index++) {
    primeSessionUpdatePayloadForTest(`stable-session-${index}`, replayEvent(index, generation))
  }
  for (let index = 0; index < REPLAY_OVERFLOW_ATTEMPTS_PER_GENERATION; index++) {
    primeSessionUpdatePayloadForTest(`overflow-${generation}-${index}`, replayEvent(index, generation))
  }
  for (let index = 0; index < REPLAY_CLIENTS_PER_GENERATION; index++) {
    const id = `replay-client-${generation}-${index}`
    const lifecycle = new EventEmitter()
    const response = new SinkResponse()
    const admission = addLiveClient(id, response, undefined, undefined, {
      lifecycle,
      principal: `http-token:replay-${index.toString(16).padStart(17, '0')}`,
    })
    if (!admission.accepted) throw new Error(`replay client was rejected at ${generation}:${index}`)
    lifecycle.emit('close')
  }
}

function replayEvent(index: number, generation: number): Record<string, unknown> {
  return {
    type: 'session_update',
    id: `stable-session-${index}`,
    generation,
    body: REPLAY_BODY,
  }
}

function assertLiveBookkeeping(clients: number, principals: number): void {
  if (liveClientCountForTest() !== clients || livePrincipalCountForTest() !== principals) {
    throw new Error(`live bookkeeping leaked: clients=${liveClientCountForTest()} principals=${livePrincipalCountForTest()}`)
  }
}

async function churnParserState(
  operations: number,
  cancellations: number,
): Promise<{ exactFrames: number; rejectedFrames: number; cancelledStreams: number }> {
  let exactFrames = 0
  let rejectedFrames = 0
  let cancelledStreams = 0
  const limits = { maxBufferedBytes: PARSER_LIMIT_BYTES, maxEventBytes: PARSER_LIMIT_BYTES }

  for (let index = 0; index < operations; index++) {
    const exact = new IncrementalSseParser(limits)
    exact.consume(EXACT_LIMIT_FRAME, () => { exactFrames++ })
    if (exact.bufferedBytes !== 0) throw new Error(`exact-limit parser retained ${exact.bufferedBytes} bytes`)
    exact.dispose()

    const overLimit = new IncrementalSseParser(limits)
    try {
      overLimit.consume(OVER_LIMIT_FRAME, () => {})
      throw new Error('over-limit parser accepted a delimiter-free frame')
    } catch (err) {
      if (!(err instanceof UpstreamSseParserError) || err.code !== 'UPSTREAM_SSE_BUFFER_LIMIT') throw err
      rejectedFrames++
    }
    if (overLimit.bufferedBytes !== 0) throw new Error(`over-limit parser retained ${overLimit.bufferedBytes} bytes`)
    overLimit.dispose()
  }

  for (let index = 0; index < cancellations; index++) {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(OVER_LIMIT_FRAME)
      },
      cancel() {
        cancelled = true
      },
    })
    try {
      await readUpstreamSseFrames(body, limits, () => {})
      throw new Error('over-limit stream completed without rejection')
    } catch (err) {
      if (!(err instanceof UpstreamSseParserError) || err.code !== 'UPSTREAM_SSE_BUFFER_LIMIT') throw err
    }
    if (!cancelled) throw new Error('over-limit stream was not cancelled')
    cancelledStreams++
  }

  return { exactFrames, rejectedFrames, cancelledStreams }
}

function collectGarbage(): void {
  if (typeof globalThis.gc !== 'function') throw new Error('live memory load harness requires --expose-gc')
  globalThis.gc()
}

async function forceGcAndMeasure(): Promise<number> {
  await new Promise<void>(resolve => setImmediate(resolve))
  collectGarbage()
  await new Promise<void>(resolve => setImmediate(resolve))
  collectGarbage()
  return process.memoryUsage().heapUsed
}

function retainedHeapGrowth(samples: number[]): number {
  return Math.max(...samples) - Math.min(...samples)
}
