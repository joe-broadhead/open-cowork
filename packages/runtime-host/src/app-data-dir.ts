import { getAppPathHost } from '@open-cowork/shared/node'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

let dataDirCache: string | null = null

function getUserDataRoot() {
  const override = process.env.OPEN_COWORK_USER_DATA_DIR?.trim()
  if (override) {
    return resolve(override)
  }
  try {
    return getAppPathHost()?.getPath?.('userData') || join(process.cwd(), '.open-cowork-test')
  } catch {
    return join(process.cwd(), '.open-cowork-test')
  }
}

export function getAppDataDir() {
  if (dataDirCache) return dataDirCache

  const userDataRoot = getUserDataRoot()
  mkdirSync(userDataRoot, { recursive: true })
  dataDirCache = userDataRoot
  return dataDirCache
}

export function clearAppDataDirCache() {
  dataDirCache = null
}
