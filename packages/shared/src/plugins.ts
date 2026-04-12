export interface PluginSkill {
  name: string
  description: string
  badge: 'Skill'
}

export interface PluginCredential {
  key: string
  label: string
  description: string
  placeholder?: string
  secret: boolean
  configured: boolean
}

export interface PluginApp {
  name: string
  description: string
  badge: 'App'
}

export interface Plugin {
  id: string
  name: string
  icon: string
  description: string
  longDescription?: string
  category: 'Analytics' | 'Productivity' | 'Communication' | 'Developer' | 'Custom'
  author: string
  version: string
  builtin: boolean
  installed: boolean
  apps: PluginApp[]
  skills: PluginSkill[]
  credentials?: PluginCredential[]
  allowedTools: string[]
  deniedTools: string[]
}

export const BUILTIN_PLUGINS: Plugin[] = []
