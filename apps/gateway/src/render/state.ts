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

export type GatewaySessionRenderState = {
  assistantStreams: Map<string, AssistantStreamRenderState>
  toolProgress: Map<string, ToolProgressRenderState>
}

export function createGatewaySessionRenderState(): GatewaySessionRenderState {
  return {
    assistantStreams: new Map(),
    toolProgress: new Map(),
  }
}
