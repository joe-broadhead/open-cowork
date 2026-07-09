import { VALID_OPENCODE_SKILL_NAME } from '@open-cowork/runtime-host/skill-bundle-validation'
import { resolveCustomMcpRuntimeEntryForRuntime } from '@open-cowork/runtime-host/runtime-mcp'
import { listCustomMcps, listCustomSkills, readSkillBundleDirectory, removeCustomMcp, removeCustomSkill, saveCustomMcp, saveCustomSkill } from '@open-cowork/runtime-host/native-customizations'
import { validateCustomMcpStdioCommand } from '@open-cowork/runtime-host/mcp-stdio-policy'
import { assertCustomMcpContentLimits, assertCustomSkillContent } from '@open-cowork/runtime-host/custom-content-limits'
import { invalidateCustomAgentCatalogCache } from '@open-cowork/runtime-host/custom-agents'
import { exportSetupBundle, importSetupBundle } from '@open-cowork/runtime-host/setup-bundle-store'
import { randomUUID } from 'crypto'
import { resolve } from 'path'
import type { CustomMcpConfig, CustomMcpTestResult, CustomSkillConfig, RuntimeContextOptions, ScopedArtifactRef } from '@open-cowork/shared'
import type { IpcHandlerContext } from './context.ts'
import {
  objectAndOptionalObjectArgs,
  objectAndOptionalStringArgs,
  objectArg,
  optionalObjectArg,
  registerIpcInvoke,
  stringAndObjectArgs,
} from './schema.ts'
import { validateCustomMcpConfig, validateCustomSkillConfig, validateRuntimeContextOptions, validateScopedArtifactRef } from './object-validators.ts'
import type { SetupBundleImportOptions } from '@open-cowork/shared'
import { log } from '@open-cowork/shared/node'
import { getBrandName } from '@open-cowork/runtime-host/config'
import { computeCustomSkillBundleDigest } from '../custom-skill-integrity.ts'
import { readWorkspaceIdOption } from '../workspace-gateway.ts'

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

function assertCloudMcpIsPortable(mcp: CustomMcpConfig): CustomMcpConfig {
  if (mcp.type !== 'http') throw new Error('Cloud custom MCPs must be remote HTTP MCPs. Local stdio MCPs stay in the Local workspace.')
  if (mcp.scope === 'project' || mcp.directory) throw new Error('Cloud custom MCPs cannot reference local project paths.')
  if (mcp.env && Object.keys(mcp.env).length > 0) throw new Error('Cloud custom MCPs cannot sync raw environment secrets.')
  if (mcp.headers && Object.keys(mcp.headers).length > 0) throw new Error('Cloud custom MCPs cannot sync raw header secrets.')
  if (mcp.allowPrivateNetwork) throw new Error('Cloud custom MCPs cannot enable private-network access from desktop metadata.')
  return {
    ...mcp,
    scope: 'machine',
    directory: null,
    env: undefined,
    headers: undefined,
    allowPrivateNetwork: false,
  }
}

function assertCloudSkillIsPortable(skill: CustomSkillConfig): CustomSkillConfig {
  if (skill.scope === 'project' || skill.directory) throw new Error('Cloud custom skills cannot reference local project paths.')
  return {
    ...skill,
    scope: 'machine',
    directory: null,
  }
}

function logUnsignedSkillBundle(action: 'add' | 'import', skill: CustomSkillConfig) {
  const digest = computeCustomSkillBundleDigest(skill)
  log('audit', `skill.${action} unsigned name=${skill.name} scope=${skill.scope} sha256=${digest}`)
  log('warn', `Saved unsigned custom skill bundle ${skill.name}; only use skill bundles from sources you trust.`)
}

function stableSkillFiles(skill: CustomSkillConfig) {
  return (skill.files || [])
    .map((file) => ({ path: file.path, content: file.content }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

function skillContentChanged(existing: CustomSkillConfig | null, next: CustomSkillConfig) {
  if (!existing) return true
  return existing.content !== next.content
    || JSON.stringify(stableSkillFiles(existing)) !== JSON.stringify(stableSkillFiles(next))
}

async function confirmUnsignedSkillWrite(
  context: IpcHandlerContext,
  action: 'add' | 'import',
  skill: CustomSkillConfig,
) {
  const confirmed = await context.requestNativeConfirmation({
    title: action === 'import' ? 'Import unsigned skill bundle?' : 'Save unsigned skill bundle?',
    message: action === 'import'
      ? 'Import this unsigned skill bundle?'
      : 'Save this unsigned skill bundle?',
    detail: `Custom skills change agent instructions and can request tool access. Only continue if you wrote or trust this bundle.\n\nSkill: ${skill.name}\nScope: ${skill.scope}${skill.directory ? `\nProject: ${skill.directory}` : ''}`,
    confirmLabel: action === 'import' ? 'Import' : 'Save',
  })
  log('audit', `skill.${action} unsigned ${confirmed ? 'confirmed' : 'cancelled'} name=${skill.name} scope=${skill.scope}`)
  return confirmed
}

export function registerCustomContentHandlers(context: IpcHandlerContext) {
  registerIpcInvoke(context, 'custom:list-mcps', optionalObjectArg<RuntimeContextOptions>('runtime context options', validateRuntimeContextOptions), async (_event, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      return context.workspaceGateway.listCloudCustomMcps(_event, workspaceId)
    }
    return listCustomMcps(resolveCustomContext(context, options))
  })

  registerIpcInvoke(context, 'custom:test-mcp', objectArg<CustomMcpConfig>('custom MCP', validateCustomMcpConfig), async (_event, mcp): Promise<CustomMcpTestResult> => {
    try {
      assertCustomMcpContentLimits(mcp)
      const workspaceId = readWorkspaceIdOption(mcp)
      if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
        assertCloudMcpIsPortable(mcp)
        return {
          ok: false,
          methods: [],
          authRequired: false,
          error: 'Cloud MCP connection testing runs in the cloud worker and is not available from desktop yet.',
        }
      }
      if (mcp.type === 'stdio') {
        validateCustomMcpStdioCommand(mcp)
      }
      if (mcp.type === 'http' && mcp.url) {
        const { evaluateHttpMcpUrlResolved } = await import('@open-cowork/runtime-host/mcp-url-policy')
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

  registerIpcInvoke(context, 'custom:add-mcp', objectArg<CustomMcpConfig>('custom MCP', validateCustomMcpConfig), async (_event, mcp) => {
    validateName(mcp.name, 'MCP')
    assertCustomMcpContentLimits(mcp)
    const workspaceId = readWorkspaceIdOption(mcp)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      const portable = assertCloudMcpIsPortable(mcp)
      return context.workspaceGateway.saveCloudCustomMcp(_event, portable, workspaceId)
    }
    const resolved = context.resolveScopedTarget(mcp) as CustomMcpConfig
    if (resolved.type === 'stdio') {
      validateCustomMcpStdioCommand(resolved)
    }
    if (resolved.type === 'http' && resolved.url) {
      const { evaluateHttpMcpUrlResolved } = await import('@open-cowork/runtime-host/mcp-url-policy')
      const verdict = await evaluateHttpMcpUrlResolved(resolved.url, { allowPrivateNetwork: resolved.allowPrivateNetwork })
      if (!verdict.ok) {
        throw new Error(`Cannot save MCP: ${verdict.reason}`)
      }
    }
    try {
      saveCustomMcp(resolved)
      invalidateCustomAgentCatalogCache()
      if (resolved.allowPrivateNetwork === true) {
        log('audit', `mcp.allowPrivateNetwork enabled name=${resolved.name} scope=${resolved.scope || 'machine'}`)
      }
      log('custom', `Added MCP: ${resolved.name} (${resolved.type})`)
      const { rebootRuntime } = await import('../index.ts')
      await rebootRuntime()
      return true
    } catch (err) {
      context.logHandlerError(`custom:add-mcp ${resolved.name}`, err)
      return false
    }
  })

  registerIpcInvoke(context, 'custom:remove-mcp', objectAndOptionalStringArgs<ScopedArtifactRef>('custom MCP target', 'confirmation token', validateScopedArtifactRef), async (_event, target, confirmationToken) => {
    const workspaceId = readWorkspaceIdOption(target)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      if (!context.consumeDestructiveConfirmation({ action: 'mcp.remove', target }, confirmationToken)) {
        throw new Error('Confirmation required before removing an MCP.')
      }
      return context.workspaceGateway.removeCloudCustomMcp(_event, target, workspaceId)
    }
    const resolvedTarget = context.resolveScopedTarget(target)
    try {
      if (!context.consumeDestructiveConfirmation({ action: 'mcp.remove', target: resolvedTarget }, confirmationToken)) {
        throw new Error('Confirmation required before removing an MCP.')
      }
      removeCustomMcp(resolvedTarget)
      invalidateCustomAgentCatalogCache()
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

  registerIpcInvoke(context, 'custom:list-skills', optionalObjectArg<RuntimeContextOptions>('runtime context options', validateRuntimeContextOptions), async (_event, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      return context.workspaceGateway.listCloudCustomSkills(_event, workspaceId)
    }
    return listCustomSkills(resolveCustomContext(context, options))
  })

  registerIpcInvoke(context, 'custom:add-skill', objectArg<CustomSkillConfig>('custom skill', validateCustomSkillConfig), async (_event, skill) => {
    validateSkillName(skill.name)
    assertCustomSkillContent(skill.content || '')
    const workspaceId = readWorkspaceIdOption(skill)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      const portable = assertCloudSkillIsPortable(skill)
      return context.workspaceGateway.saveCloudCustomSkill(_event, portable, workspaceId)
    }
    const resolved = context.resolveScopedTarget(skill) as CustomSkillConfig
    const existing = listCustomSkills({ directory: resolved.directory || null })
      .find((entry) => entry.name === resolved.name && entry.scope === resolved.scope) || null
    if (skillContentChanged(existing, resolved)) {
      const confirmed = await confirmUnsignedSkillWrite(context, 'add', resolved)
      if (!confirmed) return false
    }
    saveCustomSkill(resolved)
    invalidateCustomAgentCatalogCache()
    logUnsignedSkillBundle('add', resolved)
    log('custom', `Added skill: ${resolved.name}`)
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

  registerIpcInvoke(context, 'custom:import-skill-directory', stringAndObjectArgs<ScopedArtifactRef>('selection token', 'skill import target', {}, validateScopedArtifactRef), async (_event, selectionToken, target) => {
    const workspaceId = readWorkspaceIdOption(target)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      throw new Error('Importing local skill directories into Cloud workspaces is not supported.')
    }
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
    const confirmed = await confirmUnsignedSkillWrite(context, 'import', imported)
    if (!confirmed) return null
    saveCustomSkill(imported)
    invalidateCustomAgentCatalogCache()
    logUnsignedSkillBundle('import', imported)
    log('custom', `Imported skill directory: ${imported.name}`)
    const { rebootRuntime } = await import('../index.ts')
    await rebootRuntime()
    return imported
  })

  registerIpcInvoke(context, 'custom:remove-skill', objectAndOptionalStringArgs<ScopedArtifactRef>('custom skill target', 'confirmation token', validateScopedArtifactRef), async (_event, target, confirmationToken) => {
    const workspaceId = readWorkspaceIdOption(target)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      if (!context.consumeDestructiveConfirmation({ action: 'skill.remove', target }, confirmationToken)) {
        throw new Error('Confirmation required before removing a skill.')
      }
      return context.workspaceGateway.removeCloudCustomSkill(_event, target, workspaceId)
    }
    const resolvedTarget = context.resolveScopedTarget(target)
    try {
      if (!context.consumeDestructiveConfirmation({ action: 'skill.remove', target: resolvedTarget }, confirmationToken)) {
        throw new Error('Confirmation required before removing a skill.')
      }
      removeCustomSkill(resolvedTarget)
      invalidateCustomAgentCatalogCache()
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

  registerIpcInvoke(context, 'custom:export-setup-bundle', optionalObjectArg<RuntimeContextOptions>('runtime context options', validateRuntimeContextOptions), async (_event, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      throw new Error('Exporting a setup bundle is only supported for the Local workspace.')
    }
    return exportSetupBundle({ context: resolveCustomContext(context, options), exportedBy: getBrandName() })
  })

  registerIpcInvoke(context, 'custom:import-setup-bundle', objectAndOptionalObjectArgs<Record<string, unknown>, SetupBundleImportOptions>('setup bundle', 'import options'), async (_event, bundle, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      throw new Error('Importing a setup bundle is only supported for the Local workspace.')
    }
    const requestedTarget = options?.target
    const target = requestedTarget?.scope === 'project'
      ? { scope: 'project' as const, directory: context.resolveContextDirectory({ directory: requestedTarget.directory ?? null }) }
      : { scope: 'machine' as const, directory: null }
    if (target.scope === 'project' && !target.directory) {
      throw new Error('Importing a setup bundle into project scope requires an active project directory.')
    }
    const result = await importSetupBundle(bundle, {
      target,
      secretValues: options?.secretValues,
      overwrite: options?.overwrite,
    })
    if (result.appliedCount > 0) {
      invalidateCustomAgentCatalogCache()
      log('custom', `Imported setup bundle: ${result.appliedCount} applied, ${result.needsSecretCount} need secrets, ${result.skippedCount} skipped.`)
      const { rebootRuntime } = await import('../index.ts')
      await rebootRuntime()
    }
    return result
  })
}
