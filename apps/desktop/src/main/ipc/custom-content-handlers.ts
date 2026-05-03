import { randomUUID } from 'crypto'
import { resolve } from 'path'
import type { CustomMcpConfig, CustomMcpTestResult, CustomSkillConfig, RuntimeContextOptions, ScopedArtifactRef } from '@open-cowork/shared'
import type { IpcHandlerContext } from './context.ts'
import { listCustomMcps, listCustomSkills, readSkillBundleDirectory, removeCustomMcp, removeCustomSkill, saveCustomMcp, saveCustomSkill } from '../native-customizations.ts'
import { validateCustomMcpStdioCommand } from '../mcp-stdio-policy.ts'
import { resolveCustomMcpRuntimeEntryForRuntime } from '../runtime-mcp.ts'
import { log } from '../logger.ts'
import { getBrandName } from '../config-loader.ts'
import { VALID_OPENCODE_SKILL_NAME } from '../skill-bundle-validation.ts'
import { assertCustomSkillContent } from '../custom-content-limits.ts'

const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

function validateName(name: string, type: string) {
  if (!name || !VALID_NAME.test(name)) {
    throw new Error(`Invalid ${type} name: "${name}". Use alphanumeric characters, hyphens, and underscores only (max 64 chars).`)
  }
}

function validateSkillName(name: string) {
  if (!name || !VALID_OPENCODE_SKILL_NAME.test(name)) {
    throw new Error(`Invalid skill name: "${name}". Use 1-64 lowercase letters, numbers, and single hyphens only.`)
  }
}

function resolveCustomContext(context: IpcHandlerContext, options?: RuntimeContextOptions) {
  return {
    ...options,
    directory: context.resolveContextDirectory(options),
  }
}

export function registerCustomContentHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('custom:list-mcps', async (_event, options?: RuntimeContextOptions) => {
    return listCustomMcps(resolveCustomContext(context, options))
  })

  context.ipcMain.handle('custom:test-mcp', async (_event, mcp: CustomMcpConfig): Promise<CustomMcpTestResult> => {
    try {
      if (mcp.type === 'stdio') {
        validateCustomMcpStdioCommand(mcp)
      }
      if (mcp.type === 'http' && mcp.url) {
        const { evaluateHttpMcpUrlResolved } = await import('../mcp-url-policy.ts')
        const verdict = await evaluateHttpMcpUrlResolved(mcp.url, { allowPrivateNetwork: mcp.allowPrivateNetwork })
        if (!verdict.ok) {
          return { ok: false, methods: [], error: verdict.reason }
        }
      }
      const entry = await resolveCustomMcpRuntimeEntryForRuntime(mcp)
      if (!entry) {
        return {
          ok: false,
          methods: [],
          error: 'This MCP is missing the connection details needed to test it.',
        }
      }

      const methods = await context.listToolsFromMcpEntry(entry)
      return {
        ok: true,
        methods,
        error: null,
      }
    } catch (err) {
      const authRequired = mcp.type === 'http' && !mcp.headers && context.isLikelyMcpAuthError(err)
      const message = err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : 'Could not connect to this MCP.'
      context.logHandlerError(`custom:test-mcp ${mcp.name}`, err)
      return {
        ok: false,
        methods: [],
        authRequired,
        error: authRequired
          ? `This MCP appears to require OAuth. Save it, then authenticate it from ${getBrandName()}'s MCP status panel after the runtime reloads.`
          : message,
      }
    }
  })

  context.ipcMain.handle('custom:add-mcp', async (_event, mcp: CustomMcpConfig) => {
    validateName(mcp.name, 'MCP')
    const resolved = context.resolveScopedTarget(mcp) as CustomMcpConfig
    if (resolved.type === 'stdio') {
      validateCustomMcpStdioCommand(resolved)
    }
    if (resolved.type === 'http' && resolved.url) {
      const { evaluateHttpMcpUrlResolved } = await import('../mcp-url-policy.ts')
      const verdict = await evaluateHttpMcpUrlResolved(resolved.url, { allowPrivateNetwork: resolved.allowPrivateNetwork })
      if (!verdict.ok) {
        throw new Error(`Cannot save MCP: ${verdict.reason}`)
      }
    }
    try {
      saveCustomMcp(resolved)
      log('custom', `Added MCP: ${resolved.name} (${resolved.type})`)
      const { rebootRuntime } = await import('../index.ts')
      await rebootRuntime()
      return true
    } catch (err) {
      context.logHandlerError(`custom:add-mcp ${resolved.name}`, err)
      return false
    }
  })

  context.ipcMain.handle('custom:remove-mcp', async (_event, target: ScopedArtifactRef, confirmationToken?: string | null) => {
    const resolvedTarget = context.resolveScopedTarget(target)
    try {
      if (!context.consumeDestructiveConfirmation({ action: 'mcp.remove', target: resolvedTarget }, confirmationToken)) {
        throw new Error('Confirmation required before removing an MCP.')
      }
      removeCustomMcp(resolvedTarget)
      log('custom', `Removed MCP: ${resolvedTarget.name}`)
      log('audit', `mcp.remove completed ${context.describeDestructiveRequest({ action: 'mcp.remove', target: resolvedTarget })}`)
      const { rebootRuntime } = await import('../index.ts')
      await rebootRuntime()
      return true
    } catch (err) {
      context.logHandlerError(`custom:remove-mcp ${resolvedTarget.name}`, err)
      return false
    }
  })

  context.ipcMain.handle('custom:list-skills', async (_event, options?: RuntimeContextOptions) => {
    return listCustomSkills(resolveCustomContext(context, options))
  })

  context.ipcMain.handle('custom:add-skill', async (_event, skill: CustomSkillConfig) => {
    validateSkillName(skill.name)
    assertCustomSkillContent(skill.content || '')
    saveCustomSkill(context.resolveScopedTarget(skill) as CustomSkillConfig)
    log('custom', `Added skill: ${skill.name}`)
    const { rebootRuntime } = await import('../index.ts')
    await rebootRuntime()
    return true
  })

  context.ipcMain.handle('custom:select-skill-directory', async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Skill Bundle Directory',
    })
    if (result.canceled || !result.filePaths[0]) return null
    const directory = resolve(result.filePaths[0])
    const token = randomUUID()
    context.approvedSkillImportDirectories.set(token, directory)
    return { token, directory }
  })

  context.ipcMain.handle('custom:import-skill-directory', async (_event, selectionToken: string, target: ScopedArtifactRef) => {
    const resolvedTarget = context.resolveScopedTarget(target)
    const directory = context.approvedSkillImportDirectories.get(selectionToken)
    context.approvedSkillImportDirectories.delete(selectionToken)
    if (!directory) {
      throw new Error('Choose a skill bundle directory from the native file picker before importing.')
    }
    const imported = readSkillBundleDirectory(directory, resolvedTarget)
    validateSkillName(imported.name)
    assertCustomSkillContent(imported.content || '')
    const existing = listCustomSkills({ directory: imported.directory || null })
    if (existing.some((skill) => skill.name === imported.name && skill.scope === imported.scope)) {
      throw new Error(`A custom skill bundle named "${imported.name}" already exists.`)
    }
    saveCustomSkill(imported)
    log('custom', `Imported skill directory: ${imported.name}`)
    const { rebootRuntime } = await import('../index.ts')
    await rebootRuntime()
    return imported
  })

  context.ipcMain.handle('custom:remove-skill', async (_event, target: ScopedArtifactRef, confirmationToken?: string | null) => {
    const resolvedTarget = context.resolveScopedTarget(target)
    try {
      if (!context.consumeDestructiveConfirmation({ action: 'skill.remove', target: resolvedTarget }, confirmationToken)) {
        throw new Error('Confirmation required before removing a skill.')
      }
      removeCustomSkill(resolvedTarget)
      log('custom', `Removed skill: ${resolvedTarget.name}`)
      log('audit', `skill.remove completed ${context.describeDestructiveRequest({ action: 'skill.remove', target: resolvedTarget })}`)
      const { rebootRuntime } = await import('../index.ts')
      await rebootRuntime()
      return true
    } catch (err) {
      context.logHandlerError(`custom:remove-skill ${resolvedTarget.name}`, err)
      return false
    }
  })
}
