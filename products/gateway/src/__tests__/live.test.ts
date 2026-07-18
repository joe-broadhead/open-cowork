import { afterEach, describe, expect, it } from 'vitest'
import { addLiveClient, broadcastLiveEventForTest, clearLiveClientsForTest, closeAllLiveClients, liveClientCountForTest, parseSseFrame, primeSessionUpdatePayloadForTest, sanitizeOpenCodeEventForLive } from '../live.js'

describe('opencode live events', () => {
  afterEach(() => {
    clearLiveClientsForTest()
  })

  it('parses SSE event frames', () => {
    expect(parseSseFrame('event: message.updated\ndata: {"sessionID":"ses_1"}')).toEqual({
      type: 'message.updated',
      payload: { sessionID: 'ses_1' },
    })
  })

  it('ignores empty completion frames', () => {
    expect(parseSseFrame('data: [DONE]')).toBeNull()
  })

  it('projects native OpenCode events without raw payloads for browser SSE clients', () => {
    const projected = sanitizeOpenCodeEventForLive({
      type: 'message.updated',
      payload: {
        sessionID: 'ses_safe',
        message: {
          id: 'msg_safe',
          content: 'private transcript token=operator-secret-token',
          parts: [{ text: 'private transcript' }],
        },
      },
    })

    expect(projected).toMatchObject({
      type: 'opencode_event',
      eventType: 'message.updated',
      sessionId: 'ses_safe',
      messageId: 'msg_safe',
    })
    expect(projected).not.toHaveProperty('payload')
    expect(JSON.stringify(projected)).not.toContain('operator-secret-token')
    expect(JSON.stringify(projected)).not.toContain('private transcript')
  })

  it('reflects only a local origin on the SSE stream and denies remote/absent origins', () => {
    const capture = () => {
      const res: any = { writableLength: 0, destroyed: false, writes: [] as string[], headers: undefined as any }
      res.writeHead = (_status: number, headers: any) => { res.headers = headers }
      res.write = () => true
      res.destroy = () => {}
      return res
    }
    const local = capture(); addLiveClient('local', local, 'http://127.0.0.1:4097', 4097)
    expect(local.headers['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:4097')

    // A remote origin — including an opaque origin that serializes to the literal
    // 'null' — must get the canonical loopback value it can never match, not 'null'.
    const remote = capture(); addLiveClient('remote', remote, 'https://evil.example.com', 4097)
    expect(remote.headers['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:4097')

    const absent = capture(); addLiveClient('absent', absent, undefined, 4097)
    expect(absent.headers['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:4097')
  })

  it('disconnects SSE clients whose socket buffer exceeds the backpressure cap', () => {
    const healthy = fakeSseResponse(0)
    const stalled = fakeSseResponse(2_000_000)
    addLiveClient('healthy', healthy)
    addLiveClient('stalled', stalled)
    healthy.writes.length = 0
    stalled.writes.length = 0

    broadcastLiveEventForTest({ type: 'session_update', id: 'ses_1' })
    broadcastLiveEventForTest({ type: 'session_update', id: 'ses_2' })

    expect(healthy.writes).toHaveLength(2)
    expect(stalled.writes).toHaveLength(0)
    expect(stalled.destroyed).toBe(true)

    // The stalled client was removed, so later broadcasts skip it entirely.
    stalled.writableLength = 0
    broadcastLiveEventForTest({ type: 'session_update', id: 'ses_3' })
    expect(stalled.writes).toHaveLength(0)
    expect(healthy.writes).toHaveLength(3)
  })

  it('replays cached session snapshots to a newly connected client', () => {
    primeSessionUpdatePayloadForTest('ses_1', { type: 'session_update', id: 'ses_1' })
    primeSessionUpdatePayloadForTest('ses_2', { type: 'session_update', id: 'ses_2' })

    const fresh = fakeSseResponse(0)
    addLiveClient('fresh', fresh)

    expect(fresh.writes[0]).toContain('"type":"connected"')
    expect(fresh.writes.slice(1)).toEqual([
      'data: ' + JSON.stringify({ type: 'session_update', id: 'ses_1' }) + '\n\n',
      'data: ' + JSON.stringify({ type: 'session_update', id: 'ses_2' }) + '\n\n',
    ])
  })

  it('ends every open SSE response during graceful shutdown', () => {
    const ended: string[] = []
    const response = {
      writableLength: 0,
      writeHead: () => {},
      write: () => true,
      end: (data: string) => { ended.push(data) },
    }
    addLiveClient('shutdown-client', response)
    expect(liveClientCountForTest()).toBe(1)

    closeAllLiveClients()

    expect(liveClientCountForTest()).toBe(0)
    expect(ended[0]).toContain('event: shutdown')
  })

  function fakeSseResponse(writableLength: number) {
    const res = {
      writableLength,
      destroyed: false,
      writes: [] as string[],
      writeHead: () => {},
      write: (data: string) => { res.writes.push(data); return true },
      destroy: () => { res.destroyed = true },
    }
    return res
  }
})
