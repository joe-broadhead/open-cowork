import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { getConfiguredSkillsFromConfig } from './config-loader.ts'
import { log } from './logger.ts'

type RuntimeSkill = {
  name?: string
}

export function compareRuntimeSkills(expectedNames: string[], runtimeSkills: RuntimeSkill[]) {
  const expected = Array.from(new Set(expectedNames.filter(Boolean))).sort((a, b) => a.localeCompare(b))
  const available = Array.from(new Set(
    runtimeSkills
      .map((skill) => skill.name || '')
      .filter(Boolean),
  )).sort((a, b) => a.localeCompare(b))
  const availableSet = new Set(available)
  const missing = expected.filter((name) => !availableSet.has(name))

  return { expected, available, missing }
}

export async function verifyRuntimeSkillCatalog(client: OpencodeClient, directory?: string | null) {
  const expectedNames = getConfiguredSkillsFromConfig().map((skill) => skill.sourceName)
  if (expectedNames.length === 0) return { expected: [], available: [], missing: [] }

  try {
    const response = await client.app.skills(directory ? { directory } : undefined, { throwOnError: true })
    const result = compareRuntimeSkills(expectedNames, response.data || [])
    if (result.missing.length > 0) {
      log('runtime', `OpenCode skill catalog missing configured skills: ${result.missing.join(', ')}`)
    }
    return result
  } catch (error) {
    log('runtime', `OpenCode skill catalog verification failed: ${error instanceof Error ? error.message : String(error)}`)
    return { expected: Array.from(new Set(expectedNames)).sort((a, b) => a.localeCompare(b)), available: [], missing: Array.from(new Set(expectedNames)).sort((a, b) => a.localeCompare(b)) }
  }
}
