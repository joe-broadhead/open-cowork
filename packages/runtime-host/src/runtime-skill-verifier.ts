import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { getConfiguredSkillsFromConfig } from './config-loader-core.js'
import { log } from '@open-cowork/shared/node'
import { sdkErrorMessage } from './sdk-error.js'

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
    const response = await client.v2.skill.list(
      directory ? { location: { directory } } : undefined,
      { throwOnError: true },
    )
    // V2 skill.list can return { name } and/or nested metadata; accept common shapes.
    const listed = (response.data.data || []).map((skill) => {
      const record = skill as RuntimeSkill & { id?: string; source?: { name?: string } }
      return {
        name: record.name || record.id || record.source?.name || '',
      }
    })
    const result = compareRuntimeSkills(expectedNames, listed)
    // skills.paths composition already registers configured bundles for the
    // session. An empty list early in boot is usually catalog timing, not a
    // missing install — only warn when the list is non-empty but incomplete.
    if (result.missing.length > 0 && result.available.length > 0) {
      log('runtime', `OpenCode skill catalog missing configured skills: ${result.missing.join(', ')}`)
    } else if (result.missing.length > 0 && result.available.length === 0) {
      log('runtime', `OpenCode skill.list returned 0 skills (configured ${result.expected.length}); skills.paths composition remains authoritative`)
    }
    return result
  } catch (error) {
    log('runtime', `OpenCode skill catalog verification failed: ${sdkErrorMessage(error)}`)
    return { expected: Array.from(new Set(expectedNames)).sort((a, b) => a.localeCompare(b)), available: [], missing: Array.from(new Set(expectedNames)).sort((a, b) => a.localeCompare(b)) }
  }
}
