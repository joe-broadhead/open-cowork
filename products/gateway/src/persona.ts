/**
 * Persona factory: thin productization of OpenCode-native agents for claw-style assistants.
 * Default mode is primary (chat assistant), not subagent.
 */
import { listOpenCodeAgents, upsertOpenCodeAgent, upsertOpenCodeSkill, type OpenCodeAgentInput } from './opencode-assets.js'

export interface PersonaCreateInput {
  name: string
  description?: string
  prompt?: string
  model?: string
  permission?: Record<string, unknown>
  skillContent?: string
  configDir?: string
}

export class PersonaValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PersonaValidationError'
  }
}

export function createPersona(input: PersonaCreateInput): { agent: Record<string, unknown>; skill?: { name: string; path: string } } {
  const name = String(input.name || '').trim()
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new PersonaValidationError('persona name must be lowercase alphanumeric with single hyphens (1-64 chars)')
  }
  const agentInput: OpenCodeAgentInput = {
    name,
    description: input.description || `Always-on assistant persona ${name}`,
    prompt: input.prompt || `You are ${name}, a helpful always-on OpenCode assistant. Be concise and action-oriented.`,
    model: input.model,
    mode: 'primary',
    permission: input.permission,
    configDir: input.configDir,
  }
  const agent = upsertOpenCodeAgent(agentInput)
  let skill: { name: string; path: string } | undefined
  if (input.skillContent?.trim()) {
    skill = upsertOpenCodeSkill({
      name,
      content: input.skillContent.includes('---')
        ? input.skillContent
        : `---\nname: ${name}\ndescription: Persona skill for ${name}\n---\n\n${input.skillContent.trim()}\n`,
      configDir: input.configDir,
    })
  }
  return { agent, skill }
}

export function listPersonas(configDir?: string): Array<{ name: string; mode?: string; description?: string }> {
  const agents = listOpenCodeAgents(configDir)
  return Object.entries(agents)
    .map(([name, value]) => {
      const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
      return {
        name,
        mode: typeof row['mode'] === 'string' ? row['mode'] : undefined,
        description: typeof row['description'] === 'string' ? row['description'] : undefined,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
