import { VALID_OPENCODE_SKILL_NAME } from '@open-cowork/runtime-host/skill-bundle-validation'
import { resolveCustomMcpRuntimeEntryForRuntime } from '@open-cowork/runtime-host/runtime-mcp'
import { listCustomMcps, listCustomSkills, readSkillBundleDirectory, removeCustomMcp, removeCustomSkill, saveCustomMcp, saveCustomSkill } from '@open-cowork/runtime-host/native-customizations'
import { validateCustomMcpStdioCommand } from '@open-cowork/runtime-host/mcp-stdio-policy'
import { assertCustomMcpContentLimits, assertCustomSkillContent } from '@open-cowork/runtime-host/custom-content-limits'
import { invalidateCustomAgentCatalogCache } from '@open-cowork/runtime-host/custom-agents'
import { exportSetupBundle, importSetupBundle } from '@open-cowork/runtime-host/setup-bundle-store'
import {
  buildProductMcpLink,
  probeProductMcpLinks,
  type ProductMcpLinkKind,
  type ProductMcpLinkResult,
  type ProductMcpProbe,
} from '@open-cowork/runtime-host/product-mcp-link'
import { randomUUID } from 'crypto'
import { resolve } from 'path'
import type { CustomMcpConfig, CustomMcpTestResult, CustomSkillConfig, RuntimeContextOptions, ScopedArtifactRef } from '@open-cowork/shared'
import type { IpcHandlerContext } from './context.ts'
import {
  noIpcArgs,
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

// JOE-839: bound pending native-picker tokens. Abandoned pickers would otherwise
// retain realpaths for the process lifetime (same FIFO pattern as permission-tracker).
export const MAX_APPROVED_SKILL_IMPORT_DIRECTORIES = 64

export function rememberApprovedSkillImportDirectory(
  map: Map<string, string>,
  token: string,
  directory: string,
  maxEntries = MAX_APPROVED_SKILL_IMPORT_DIRECTORIES,
) {
  if (map.has(token)) map.delete(token)
  map.set(token, directory)
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value
    if (typeof oldest !== 'string') break
    map.delete(oldest)
  }
}

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
    rememberApprovedSkillImportDirectory(context.approvedSkillImportDirectories, token, directory)
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

  // JOE-909: optional Gateway / Wiki soft links (never pre-enabled in public config).
  registerIpcInvoke(context, 'custom:product-mcp-probe', noIpcArgs, async (): Promise<ProductMcpProbe[]> => {
    const linkedNames = listCustomMcps().map((entry) => entry.name)
    return probeProductMcpLinks({ linkedNames })
  })

  registerIpcInvoke(
    context,
    'custom:product-mcp-link',
    objectArg<ProductMcpLinkIpcRequest>('product MCP link request', validateProductMcpLinkRequest),
    async (_event, request): Promise<ProductMcpLinkResult & { saved?: boolean }> => {
      const result = buildProductMcpLink({
        kind: request.kind,
        command: request.command,
        gatewayDaemonUrl: request.gatewayDaemonUrl,
        tokenFile: request.tokenFile,
        wikiRoot: request.wikiRoot,
      })
      if (!result.ok) return result

      try {
        assertCustomMcpContentLimits(result.customMcp)
        validateCustomMcpStdioCommand(result.customMcp)
        saveCustomMcp(result.customMcp)
        invalidateCustomAgentCatalogCache()
        log('custom', `Linked product MCP: ${result.name}`)
        log('audit', `product-mcp.link kind=${request.kind} name=${result.name}`)
        const { rebootRuntime } = await import('../index.ts')
        await rebootRuntime()
        return { ...result, saved: true }
      } catch (err) {
        context.logHandlerError(`custom:product-mcp-link ${result.name}`, err)
        return {
          ok: false,
          code: 'unsupported',
          message: err instanceof Error ? err.message : String(err),
          installHint: 'Fix the MCP configuration and retry.',
        }
      }
    },
  )
}

type ProductMcpLinkIpcRequest = {
  kind: ProductMcpLinkKind
  command?: string
  gatewayDaemonUrl?: string
  tokenFile?: string
  wikiRoot?: string
}

function validateProductMcpLinkRequest(
  record: Record<string, unknown>,
  _channel: string,
  _label: string,
): ProductMcpLinkIpcRequest {
  const kind = record.kind
  if (kind !== 'gateway' && kind !== 'wiki') {
    throw new Error('Product MCP link kind must be gateway or wiki.')
  }
  const optional = (key: string) => {
    const value = record[key]
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string') throw new Error(`${key} must be a string when provided.`)
    if (value.length > 4096) throw new Error(`${key} is too long.`)
    return value
  }
  return {
    kind,
    command: optional('command'),
    gatewayDaemonUrl: optional('gatewayDaemonUrl'),
    tokenFile: optional('tokenFile'),
    wikiRoot: optional('wikiRoot'),
  }
}


