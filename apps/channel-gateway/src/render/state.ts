export type AssistantStreamRenderState = {
  sourceMessageId: string
  providerMessageId: string | null
  renderedText: string
}

export type ToolProgressRenderState = {
  toolCallId: string
  providerMessageId: string | null
  renderedSummary: string
  status: string
}

export type ArtifactRenderState = {
  artifactId: string
  providerMessageId: string | null
  renderedSequence: number
}

export type GatewaySessionRenderState = {
  assistantStreams: Map<string, AssistantStreamRenderState>
  toolProgress: Map<string, ToolProgressRenderState>
  artifacts: Map<string, ArtifactRenderState>
}

export function createGatewaySessionRenderState(): GatewaySessionRenderState {
  return {
    assistantStreams: new Map(),
    toolProgress: new Map(),
    artifacts: new Map(),
  }
}

// Cap on per-session render entries. A long-running channel session would
// otherwise accumulate one entry per assistant message / tool call / artifact
// for the lifetime of the stream — unbounded growth on the hot render path.
// set() acts as a touch (delete + re-insert moves the key to newest), so the
// evicted key is the least-recently-updated, far older than any in-flight
// stream at this size.
const MAX_RENDER_STATE_ENTRIES = 512

export function setRenderStateEntry<Value>(
  map: Map<string, Value>,
  key: string,
  value: Value,
  max = MAX_RENDER_STATE_ENTRIES,
) {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}
