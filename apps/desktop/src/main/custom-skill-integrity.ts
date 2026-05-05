import { createHash } from 'crypto'
import type { CustomSkillConfig } from '@open-cowork/shared'

export function computeCustomSkillBundleDigest(skill: CustomSkillConfig) {
  const hash = createHash('sha256')
  hash.update('SKILL.md')
  hash.update('\0')
  hash.update(skill.content || '')

  const files = [...(skill.files || [])].sort((left, right) => left.path.localeCompare(right.path))
  for (const file of files) {
    hash.update('\0')
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.content)
  }

  return hash.digest('hex')
}
