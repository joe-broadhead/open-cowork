// Shareable setup bundle store.
//
// The IO half of the setup export/import feature. The bundle format,
// redaction, validation, and import planning live in the pure browser-safe
// `@open-cowork/shared` (`setup-bundle.ts` + `extension-descriptor.ts`). This
// module wires that pure logic to the EXISTING install machinery — the same
// `custom-mcp-store` / `custom-skill-store` / `custom-agent-store` functions
// the per-type UIs already use — so there is one source of truth for how a
// skill / MCP / agent is written to disk.

import type { RuntimeContextOptions } from '@open-cowork/shared'
import {
  agentToExtensionDescriptor,
  buildSetupBundle,
  extensionDescriptorToAgent,
  extensionDescriptorToMcp,
  extensionDescriptorToSkill,
  mcpToExtensionDescriptor,
  planSetupBundleImport,
  skillToExtensionDescriptor,
  summarizeImportItems,
  validateSetupBundle,
  type ExtensionDescriptor,
  type SetupBundle,
  type SetupBundleImportItemPlan,
  type SetupBundleImportResult,
} from '@open-cowork/shared'
import { log } from '@open-cowork/shared/node'
import { listCustomMcps, saveCustomMcp } from './custom-mcp-store.js'
import { listCustomSkills, saveCustomSkill } from './custom-skill-store.js'
import { listCustomAgents, saveCustomAgent } from './custom-agent-store.js'
import { getCustomAgentCatalog, invalidateCustomAgentCatalogCache } from './custom-agents.js'
import { buildCustomAgentPermissionFromCatalog } from './custom-agents-utils.js'

export interface ExportSetupBundleOptions {
  context?: RuntimeContextOptions
  now?: string
  exportedBy?: string
}

// Snapshot the deployment's installed skills + custom MCPs + custom agents as a
// portable, secret-redacted bundle. Secrets (env/header values, provider
// credentials) and absolute local paths are stripped inside the shared
// descriptor converters, so nothing sensitive ever reaches the JSON.
export function exportSetupBundle(options: ExportSetupBundleOptions = {}): SetupBundle {
  const { context, now, exportedBy } = options
  const mcps = listCustomMcps(context).map((mcp) => mcpToExtensionDescriptor(mcp))
  const skills = listCustomSkills(context).map((skill) => skillToExtensionDescriptor(skill))
  const agents = listCustomAgents(context).map((agent) => agentToExtensionDescriptor(agent))
  return buildSetupBundle({ skills, mcps, agents, now, exportedBy })
}

export interface ImportSetupBundleOptions {
  context?: RuntimeContextOptions
  // Where to install. Defaults to machine scope. Project scope requires a
  // directory.
  target?: { scope: 'machine' | 'project'; directory?: string | null }
  // descriptor.id -> { secretKey -> value }. Supplies redacted secrets so an
  // item that would otherwise be reported "needs-secret" can be installed.
  secretValues?: Record<string, Record<string, string>>
  // Re-apply items whose name already exists. Defaults to false — import is
  // idempotent and never overwrites an existing item (or a secret it can't
  // supply).
  overwrite?: boolean
}

function indexDescriptors(bundle: SetupBundle): Map<string, ExtensionDescriptor> {
  const byId = new Map<string, ExtensionDescriptor>()
  for (const descriptor of [...bundle.mcps, ...bundle.skills, ...bundle.agents]) {
    byId.set(descriptor.id, descriptor)
  }
  return byId
}

// Validate + install a setup bundle. Reuses the per-type stores and reports,
// per item, what was applied / needs a secret / was skipped as a conflict.
// Only `applied` items touch disk; re-importing the same bundle is a no-op.
export async function importSetupBundle(
  rawBundle: unknown,
  options: ImportSetupBundleOptions = {},
): Promise<SetupBundleImportResult> {
  const validation = validateSetupBundle(rawBundle)
  if (!validation.ok) {
    throw new Error(validation.error)
  }
  const bundle = validation.bundle
  const { context } = options
  const target = options.target || { scope: 'machine', directory: null }
  if (target.scope === 'project' && !target.directory) {
    throw new Error('Importing a setup bundle into project scope requires a project directory.')
  }

  const existing = {
    skills: listCustomSkills(context).map((skill) => skill.name),
    mcps: listCustomMcps(context).map((mcp) => mcp.name),
    agents: listCustomAgents(context).map((agent) => agent.name),
  }
  const plan = planSetupBundleImport(bundle, {
    existing,
    secretValues: options.secretValues,
    overwrite: options.overwrite,
  })

  const byId = indexDescriptors(bundle)
  const executed: SetupBundleImportItemPlan[] = []
  let agentCatalog: Awaited<ReturnType<typeof getCustomAgentCatalog>> | null = null
  let installedAny = false

  for (const item of plan.items) {
    if (item.status !== 'applied') {
      executed.push(item)
      continue
    }
    const descriptor = byId.get(item.id)
    if (!descriptor) {
      executed.push({ ...item, status: 'skipped-unsupported', detail: 'Descriptor missing from bundle payload.', missingSecrets: [] })
      continue
    }
    const secretValues = options.secretValues?.[descriptor.id] || {}
    try {
      if (descriptor.kind === 'mcp') {
        saveCustomMcp(extensionDescriptorToMcp(descriptor, target, secretValues))
      } else if (descriptor.kind === 'skill') {
        saveCustomSkill(extensionDescriptorToSkill(descriptor, target))
      } else if (descriptor.kind === 'agent') {
        const agent = extensionDescriptorToAgent(descriptor, target)
        if (!agentCatalog) {
          agentCatalog = await getCustomAgentCatalog(
            target.scope === 'project' ? { directory: target.directory } : context,
          )
        }
        saveCustomAgent(agent, buildCustomAgentPermissionFromCatalog(agent, agentCatalog))
      } else {
        executed.push({ ...item, status: 'skipped-unsupported', detail: `Setup import does not install "${descriptor.kind}" extensions.`, missingSecrets: [] })
        continue
      }
      installedAny = true
      executed.push(item)
      log('audit', `setup_bundle.import applied kind=${descriptor.kind} name=${descriptor.name}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      executed.push({ ...item, status: 'skipped-unsupported', detail: `Install failed: ${message}`, missingSecrets: [] })
      log('error', `setup_bundle.import failed kind=${descriptor.kind} name=${descriptor.name}: ${message}`)
    }
  }

  if (installedAny) {
    invalidateCustomAgentCatalogCache()
  }

  return summarizeImportItems(bundle.version, executed)
}
