import type {
  CapabilitySkill,
  CapabilityTool,
} from '@open-cowork/shared'
import {
  getCapabilitySkillBundle,
  getCapabilityTool,
  listCapabilitySkills,
  listCapabilityTools,
} from '../../capability-catalog.ts'
import type { CloudRuntimePolicy } from '../cloud-config.ts'
import { includesAllowed } from '../session-input-validation.ts'
import type { CloudPrincipal } from '../session-service.ts'

export type CloudCapabilityServiceOptions = {
  policy: CloudRuntimePolicy
  ensurePrincipal: (principal: CloudPrincipal) => Promise<unknown> | unknown
}

export class CloudCapabilityService {
  private readonly policy: CloudRuntimePolicy
  private readonly ensurePrincipal: CloudCapabilityServiceOptions['ensurePrincipal']

  constructor(options: CloudCapabilityServiceOptions) {
    this.policy = options.policy
    this.ensurePrincipal = options.ensurePrincipal
  }

  async listCapabilityCatalog(principal: CloudPrincipal) {
    await this.ensurePrincipal(principal)
    this.assertCapabilitiesEnabled()
    const [tools, skills] = await Promise.all([
      this.listCapabilityTools(principal),
      this.listCapabilitySkills(principal),
    ])
    return { tools, skills }
  }

  async listCapabilityTools(principal: CloudPrincipal): Promise<CapabilityTool[]> {
    await this.ensurePrincipal(principal)
    this.assertCapabilitiesEnabled()
    return (await listCapabilityTools())
      .map((tool) => this.filterCapabilityTool(tool))
      .filter((tool): tool is CapabilityTool => Boolean(tool))
  }

  async getCapabilityTool(principal: CloudPrincipal, toolId: string): Promise<CapabilityTool | null> {
    await this.ensurePrincipal(principal)
    this.assertCapabilitiesEnabled()
    const tool = await getCapabilityTool(toolId)
    return tool ? this.filterCapabilityTool(tool) : null
  }

  async listCapabilitySkills(principal: CloudPrincipal): Promise<CapabilitySkill[]> {
    await this.ensurePrincipal(principal)
    this.assertCapabilitiesEnabled()
    return (await listCapabilitySkills())
      .map((skill) => this.filterCapabilitySkill(skill))
      .filter((skill): skill is CapabilitySkill => Boolean(skill))
  }

  async getCapabilitySkill(principal: CloudPrincipal, skillName: string): Promise<CapabilitySkill | null> {
    const skills = await this.listCapabilitySkills(principal)
    return skills.find((skill) => skill.name === skillName) || null
  }

  async getCapabilitySkillBundle(principal: CloudPrincipal, skillName: string) {
    const skill = await this.getCapabilitySkill(principal, skillName)
    if (!skill) return null
    return getCapabilitySkillBundle(skillName)
  }

  private assertCapabilitiesEnabled() {
    if (!this.policy.features.agents && !this.policy.features.customSkills && !this.policy.features.customMcps) {
      throw new Error('Capabilities are disabled for this cloud profile.')
    }
  }

  private filterCapabilityTool(tool: CapabilityTool): CapabilityTool | null {
    if (tool.source === 'custom' && !this.policy.features.customMcps) return null
    if (!includesAllowed(tool.id, this.policy.allowedTools)) return null
    if (tool.kind === 'mcp' && !includesAllowed(tool.namespace || tool.id, this.policy.allowedMcps)) return null
    return {
      ...tool,
      agentNames: this.policy.features.agents
        ? this.filterAgentNames(tool.agentNames)
        : [],
    }
  }

  private filterCapabilitySkill(skill: CapabilitySkill): CapabilitySkill | null {
    if (skill.source === 'custom' && !this.policy.features.customSkills) return null
    if (this.policy.allowedTools && skill.toolIds?.length) {
      const hasAllowedTool = skill.toolIds.some((toolId) => this.policy.allowedTools?.includes(toolId))
      if (!hasAllowedTool) return null
    }
    return {
      ...skill,
      agentNames: this.policy.features.agents
        ? this.filterAgentNames(skill.agentNames)
        : [],
    }
  }

  private filterAgentNames(agentNames: string[]) {
    return this.policy.allowedAgents
      ? agentNames.filter((agentName) => this.policy.allowedAgents?.includes(agentName))
      : agentNames
  }
}
