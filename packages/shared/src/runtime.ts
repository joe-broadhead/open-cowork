export interface PerfCounterSnapshot {
  kind: 'counter'
  name: string
  value: number
  updatedAt: string
}

export interface PerfDistributionSnapshot {
  kind: 'distribution'
  name: string
  unit: 'ms' | 'count'
  count: number
  samplesTracked: number
  total: number
  avg: number
  min: number
  max: number
  p50: number
  p95: number
  last: number
  slowCount: number
  updatedAt: string
}

export interface PerfSnapshot {
  capturedAt: string
  counters: PerfCounterSnapshot[]
  distributions: PerfDistributionSnapshot[]
}

export interface RuntimeStatus {
  ready: boolean
  error?: string | null
}

export interface RuntimeInputDiagnostics {
  opencodeVersion: string | null
  providerId: string | null
  providerName: string | null
  providerPackage: string | null
  modelId: string | null
  runtimeModel: string | null
  defaultProviderId: string | null
  defaultModelId: string | null
  providerSource: 'settings' | 'default' | 'fallback'
  modelSource: 'settings' | 'default' | 'fallback'
  providerOptions: Record<string, unknown>
  credentialOverrideKeys: string[]
}

export interface ToolListOptions {
  sessionId?: string
  directory?: string | null
  provider?: string | null
  model?: string | null
  // When true, probe each MCP to enumerate its method list. Default
  // false — the grid view only needs name/description per tool, and
  // probing 16 MCPs sequentially costs multi-seconds on Capabilities
  // page load. The tool-detail endpoint (`capabilities.tool(id)`)
  // passes true to populate the method table when a user actually
  // opens one tool.
  deep?: boolean
}

export interface RuntimeToolDescriptor {
  id?: string
  name?: string
  description?: string
}

export interface RuntimeContextOptions {
  sessionId?: string
  directory?: string | null
}
