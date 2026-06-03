export type {
  CapabilitySkill,
  CapabilitySkillBundle,
  CapabilityTool,
} from '../contracts.js'

import type {
  CapabilitySkill,
  CapabilitySkillBundle,
  CapabilityTool,
} from '../contracts.js'
import type { CloudDomainClientContext } from './shared.js'
import { encodePath } from './shared.js'

export type CloudCapabilitiesClient = {
  listCapabilityTools(): Promise<CapabilityTool[]>
  getCapabilityTool(toolId: string): Promise<CapabilityTool | null>
  listCapabilitySkills(): Promise<CapabilitySkill[]>
  getCapabilitySkillBundle(skillName: string): Promise<CapabilitySkillBundle | null>
  readCapabilitySkillBundleFile(skillName: string, filePath: string): Promise<string | null>
}

export function createCloudCapabilitiesClient({ request }: CloudDomainClientContext): CloudCapabilitiesClient {
  return {
    async listCapabilityTools() {
      return (await request<{ tools: CapabilityTool[] }>('/api/capabilities/tools')).tools
    },
    async getCapabilityTool(toolId) {
      const response = await request<{ tool: CapabilityTool }>(`/api/capabilities/tools/${encodePath(toolId)}`)
      return response.tool || null
    },
    async listCapabilitySkills() {
      return (await request<{ skills: CapabilitySkill[] }>('/api/capabilities/skills')).skills
    },
    async getCapabilitySkillBundle(skillName) {
      const response = await request<{ bundle: CapabilitySkillBundle | null }>(`/api/capabilities/skills/${encodePath(skillName)}/bundle`)
      return response.bundle || null
    },
    async readCapabilitySkillBundleFile(skillName, filePath) {
      const bundle = (await request<{ bundle: CapabilitySkillBundle | null }>(`/api/capabilities/skills/${encodePath(skillName)}/bundle`)).bundle
      const file = bundle?.files.find((entry) => entry.path === filePath) as { content?: unknown } | undefined
      return typeof file?.content === 'string' ? file.content : null
    },
  }
}
