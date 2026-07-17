// Leaf module for the SSE transport limits. These constants used to live in the
// http-server god module, which created a value-import cycle: channel-delivery-sse.ts
// imported SSE_MAX_BUFFERED_BYTES *from* http-server.ts, while http-server.ts pulls the
// route handlers back in. Hoisting the transport aliases into this leaf lets both
// http-server.ts and the http-routes/* handlers import them without the cycle (ARCH
// SSE constant cycle, P3). The byte cap itself is shared with cloud projection so
// inline tool attachments cannot consume an unbounded SSE event.

// Hard cap on per-connection outbound SSE bytes buffered in Node's writable queue. A
// client that drains slower than events arrive would otherwise grow this without bound
// (heap pressure); past the cap the connection is dropped (cleanup unsubscribes on close).
export { CLOUD_SESSION_SSE_MAX_BUFFERED_BYTES as SSE_MAX_BUFFERED_BYTES } from '@open-cowork/shared'

// Bounds each SSE replay-poll read so a topic never drags an unbounded event history
// per poll; the replay hub paginates by advancing its cursor (and re-polls immediately
// when a full batch is returned), so delivery stays complete.
export const SSE_REPLAY_BATCH = 1_000

// Default concurrent browser/desktop SSE streams per org (JOE-844). Enforced by
// CloudSseStreamRegistry on every session/workspace/channel-delivery SSE route.
// Operators override via OPEN_COWORK_CLOUD_MAX_SSE_CONNECTIONS_PER_ORG.
export const DEFAULT_MAX_SSE_CONNECTIONS_PER_ORG = 200

// TCP keep-alive probe interval applied to every SSE socket so the kernel detects a
// half-open peer (gone without FIN/RST) instead of the gap only surfacing once the OS
// send buffer fills. Independent of the app-level ': keep-alive' comments, which a dead
// peer silently absorbs.
export const SSE_TCP_KEEPALIVE_MS = 30_000
