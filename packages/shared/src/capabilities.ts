export interface CapabilityToolEntry {
  id: string
  description: string
}

export interface CapabilityTool {
  id: string
  name: string
  icon?: string
  description: string
  kind: 'mcp' | 'built-in'
  source: 'builtin' | 'custom'
  origin?: 'opencode' | 'open-cowork' | 'custom'
  scope?: 'machine' | 'project' | null
  namespace?: string | null
  patterns: string[]
  availableTools?: CapabilityToolEntry[]
  agentNames: string[]
}

export interface CapabilitySkill {
  name: string
  label: string
  description: string
  source: 'builtin' | 'custom'
  scope?: 'machine' | 'project' | null
  toolIds?: string[]
  agentNames: string[]
}

export interface CapabilitySkillBundleFile {
  path: string
}

export interface CapabilitySkillBundle {
  name: string
  source: 'builtin' | 'custom'
  scope?: 'machine' | 'project' | null
  content: string | null
  files: CapabilitySkillBundleFile[]
}
