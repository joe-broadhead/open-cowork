import { existsSync, statSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import type { CustomMcpConfig } from '@open-cowork/shared'

const ALLOWED_BARE_COMMANDS = new Set([
  'node',
  'npx',
  'npm',
  'pnpm',
  'bun',
  'bunx',
  'python',
  'python3',
  'uv',
  'uvx',
  'deno',
  'go',
  'ruby',
  'java',
  'docker',
  'podman',
])

function hasPathSeparator(value: string) {
  return value.includes('/') || value.includes('\\')
}

function existingFile(path: string) {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function resolveProjectRelativePath(command: string, directory?: string | null) {
  if (!directory) return null
  const root = resolve(directory)
  const candidate = resolve(root, command)
  if (!candidate.startsWith(root)) return null
  return candidate
}

export function validateCustomMcpStdioCommand(custom: Pick<CustomMcpConfig, 'name' | 'scope' | 'directory' | 'command'>) {
  const command = custom.command?.trim() || ''
  if (!command) {
    throw new Error(`Local MCP "${custom.name}" requires a command.`)
  }

  if (!hasPathSeparator(command) && !isAbsolute(command)) {
    if (!ALLOWED_BARE_COMMANDS.has(command)) {
      throw new Error(
        `Local MCP "${custom.name}" uses "${command}", which is not an allowed bare command. ` +
        `Use a supported runtime like node, npx, python, uv, bun, or provide an absolute executable path.`,
      )
    }
    return
  }

  if (isAbsolute(command)) {
    if (!existingFile(command)) {
      throw new Error(`Local MCP "${custom.name}" points to an executable path that does not exist.`)
    }
    return
  }

  const resolved = resolveProjectRelativePath(command, custom.scope === 'project' ? custom.directory : null)
  if (!resolved) {
    throw new Error(
      `Local MCP "${custom.name}" uses a relative command path that must stay inside the selected project.`,
    )
  }
  if (!existingFile(resolved)) {
    throw new Error(
      `Local MCP "${custom.name}" uses a relative command path that does not point to an existing file.`,
    )
  }
}
