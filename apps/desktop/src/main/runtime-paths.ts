import { join, resolve } from 'path'
import { getAppDataDir } from './config-loader.ts'

export type NativeConfigScope = 'machine' | 'project'

export function getRuntimeHomeDir() {
  return join(getAppDataDir(), 'runtime-home')
}

export function getRuntimeEnvPaths() {
  const home = getRuntimeHomeDir()
  return {
    home,
    configHome: join(home, '.config'),
    dataHome: join(home, '.local', 'share'),
    cacheHome: join(home, '.cache'),
    stateHome: join(home, '.local', 'state'),
  }
}

export function getMachineOpencodeDir() {
  return join(getRuntimeEnvPaths().configHome, 'opencode')
}

export function getMachineOpencodeConfigPath() {
  return join(getMachineOpencodeDir(), 'opencode.json')
}

export function getMachineSkillsDir() {
  return join(getMachineOpencodeDir(), 'skills')
}

export function getMachineAgentsDir() {
  return join(getMachineOpencodeDir(), 'agents')
}

export function resolveProjectDirectory(directory?: string | null) {
  if (!directory) return null
  return resolve(directory)
}

export function getProjectOpencodeConfigPath(directory: string) {
  return join(resolve(directory), 'opencode.json')
}

export function getProjectSkillsDir(directory: string) {
  return join(resolve(directory), '.opencode', 'skills')
}

export function getProjectAgentsDir(directory: string) {
  return join(resolve(directory), '.opencode', 'agents')
}

export function getProjectCoworkDir(directory: string) {
  return join(resolve(directory), '.opencowork')
}

export function getProjectCoworkConfigPath(directory: string) {
  return join(getProjectCoworkDir(directory), 'config.json')
}

export function getProjectCoworkSkillsDir(directory: string) {
  return join(getProjectCoworkDir(directory), 'skills')
}

export function getProjectCoworkAgentsDir(directory: string) {
  return join(getProjectCoworkDir(directory), 'agents')
}
